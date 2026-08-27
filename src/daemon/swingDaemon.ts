import crypto from "crypto";
import { SwingEngine } from "../lib/swingEngine";
import { CRYPTO_EXECUTION_PROVIDER, SUPPORTED_ASSETS } from "../lib/market";
import { PortfolioManager } from "../lib/portfolio";
import { Logger } from "../lib/logger";
import { getRedis } from "../lib/redis";
import { Trade, OpenPosition, PaperMarginMode } from "../lib/types";
import { WebsocketDataMesh } from "./websocketDataMesh";
import { TradeAdmissionController } from "../lib/trading/tradeAdmission";
import { sweepSwingExits, SwingExitSweepResult } from "../lib/execution/swingLifecycle";
import { getMarketSessionState } from "../lib/trading/marketSession";
import { OpportunityJournal } from "../lib/trading/opportunityJournal";
import { LocalLearningMemory } from "../lib/trading/localLearning";
import { isEventBlackout } from "../lib/trading/eventCalendar";
import { PortfolioGuards } from "../lib/trading/portfolioGuards";
import { FeedHealthSummary } from "../lib/data/feedHealthSummary";
import { fitPaperExecutionPlanToRiskBudget } from "../lib/trading/executionCostModel";
import { evaluatePortfolioRiskBudget } from "../lib/trading/portfolioRiskBudget";
import { ExecutionLedger, TRADING_STRATEGY_VERSION } from "../lib/trading/executionLedger";
import { getAssetSpec } from "../lib/trading/assetSpecs";
import { recordEquityPoint, SWING_EQUITY_CURVE_KEY } from "../lib/execution/equityCurve";
import { consumeSwingScanRequest } from "../lib/trading/scanControl";

const ENTRY_SCAN_INTERVAL_MS = 60_000;
const EXIT_WATCHDOG_INTERVAL_MS = 5_000;

/**
 * How often the swing sleeve's equity is written to its curve.
 *
 * The exit watchdog runs every five seconds, which would fill the 2000-point
 * ring buffer in under three hours and leave nothing to compare against. The
 * curve exists to be bucketed by day, so half-hourly resolution is already far
 * more than the comparison can use.
 */
const EQUITY_SAMPLE_INTERVAL_MS = 30 * 60 * 1000;
let lastEquitySampleAt = 0;
let lastRealizedEquity: number | null = null;
const SCAN_SNAPSHOT_KEY = "swing:lastScan:ai";
const LIFETIME_STATS_KEY = "swing:lifetimeStats:ai";

type SwingScanAction = "HOLD" | "BLOCKED" | "ENTRY" | "SKIPPED" | "ERROR";
type SwingDecisionSummaryKey =
  | "NO_BIAS"
  | "WATCH_LONG"
  | "WATCH_SHORT"
  | "TRIGGER_PENDING"
  | "PROBE_ENTRY"
  | "ENTRY_READY"
  | "HIGH_ACCURACY_EXCEPTION"
  | "BLOCKED_DATA"
  | "BLOCKED_RISK"
  | "BLOCKED_SESSION"
  | "COOLDOWN"
  | "ACTIVE_POSITION"
  | "ERROR";

interface SwingScanResult {
  asset: string;
  action: SwingScanAction;
  reason: string;
  simpleStatus?: string;
  simpleReason?: string;
  nextStep?: string;
  decisionState?: string;
  score?: number;
  htfScore?: number;
  triggerScore?: number;
  marketStructureScore?: number;
  microstructureScore?: number;
  microstructureSummary?: string;
  fundingRate?: number;
  openInterest?: number;
  orderbookImbalanceRatio?: number;
  liquidityState?: string;
  dataQuality?: number;
  finalConviction?: number;
  price?: number;
  signalPrice?: number;
  slippagePercent?: number;
  stopLoss?: number;
  takeProfit?: number;
  margin?: number;
  leverage?: number;
  marginMode?: PaperMarginMode;
  marginPolicyVersion?: string;
  paperSize?: string;
  entryMode?: string;
  riskMode?: string;
  assetMode?: string;
  setupTags?: string[];
  directionBias?: string;
  learningAdjustment?: number;
  learningRules?: string[];
  entryGate?: unknown;
  portfolioGuard?: unknown;
  targetReachability?: unknown;
  netRewardRisk?: unknown;
  marketRegime?: string;
  execution?: unknown;
  portfolioBudget?: unknown;
  timestamp: string;
}

interface LifetimeScanStats {
  scanCycles: number;
  assetChecks: number;
  entrySignals: number;
  blockedOrSkipped: number;
  errors: number;
  trackedSince: string;
  lastUpdated: string;
}

const getAIPortfolio = () => PortfolioManager.getPortfolio("ai");
const updateAIPortfolio = (p: any) => PortfolioManager.updatePortfolio(p, "ai");
const logAITrade = (t: any) => PortfolioManager.logTrade(t, "ai");

const wsMesh = new WebsocketDataMesh();
wsMesh.start();

let isEntryScanning = false;
let isExitWatching = false;

// The entry scan (60s) and exit watchdog (5s) both read the portfolio from
// Redis, mutate it in memory, and write it back. The isEntryScanning /
// isExitWatching flags only stop each loop from overlapping *itself* — they
// do nothing about the two loops interleaving with each other. A long entry
// scan holding a stale snapshot could overwrite an exit the watchdog just
// performed, resurrecting the closed position and erasing its cash credit.
// Serialize every portfolio read-mutate-write cycle through this mutex.
let portfolioLock: Promise<unknown> = Promise.resolve();
function withPortfolioLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = portfolioLock.then(fn, fn);
  portfolioLock = run.catch(() => undefined);
  return run;
}
let lastSummaryLogTime = 0;
let scanSequence = 0;
let lifetimeStatsBootstrapped = false;
let localLearningBootstrapped = false;

function ensurePortfolioShape(portfolio: any) {
  portfolio.openPositions = portfolio.openPositions || {};
  portfolio.balances = portfolio.balances || {};
  portfolio.returns = portfolio.returns || [];
  portfolio.totalFeesPaid = portfolio.totalFeesPaid || 0;
  portfolio.totalExecutionCostsPaid = portfolio.totalExecutionCostsPaid || portfolio.totalFeesPaid || 0;
  portfolio.totalCarryPaid = portfolio.totalCarryPaid || 0;
}

function summarizeResults(results: SwingScanResult[]) {
  return results.reduce<Record<SwingScanAction, number>>(
    (acc, result) => {
      acc[result.action] += 1;
      return acc;
    },
    { HOLD: 0, BLOCKED: 0, ENTRY: 0, SKIPPED: 0, ERROR: 0 }
  );
}

function decisionKeyForResult(result: SwingScanResult): SwingDecisionSummaryKey {
  if (result.action === "ERROR") return "ERROR";
  if (result.action === "ENTRY") {
    if (result.decisionState === "HIGH_ACCURACY_EXCEPTION") return "HIGH_ACCURACY_EXCEPTION";
    if (result.decisionState === "PROBE_ENTRY") return "PROBE_ENTRY";
    return "ENTRY_READY";
  }
  if (result.action === "BLOCKED") return "BLOCKED_RISK";
  if (result.action === "SKIPPED") {
    const reason = result.reason.toLowerCase();
    if (reason.includes("active position")) return "ACTIVE_POSITION";
    if (reason.includes("cooling down")) return "COOLDOWN";
    if (reason.includes("market is closed") || reason.includes("session")) return "BLOCKED_SESSION";
    return "BLOCKED_SESSION";
  }

  const state = result.decisionState as SwingDecisionSummaryKey | undefined;
  if (
    state === "NO_BIAS" ||
    state === "WATCH_LONG" ||
    state === "WATCH_SHORT" ||
    state === "TRIGGER_PENDING" ||
    state === "PROBE_ENTRY" ||
    state === "ENTRY_READY" ||
    state === "HIGH_ACCURACY_EXCEPTION" ||
    state === "BLOCKED_DATA"
  ) {
    return state;
  }

  return "NO_BIAS";
}

function summarizeDecisionStates(results: SwingScanResult[]) {
  const summary: Record<SwingDecisionSummaryKey, number> = {
    NO_BIAS: 0,
    WATCH_LONG: 0,
    WATCH_SHORT: 0,
    TRIGGER_PENDING: 0,
    PROBE_ENTRY: 0,
    ENTRY_READY: 0,
    HIGH_ACCURACY_EXCEPTION: 0,
    BLOCKED_DATA: 0,
    BLOCKED_RISK: 0,
    BLOCKED_SESSION: 0,
    COOLDOWN: 0,
    ACTIVE_POSITION: 0,
    ERROR: 0,
  };

  for (const result of results) {
    summary[decisionKeyForResult(result)] += 1;
  }

  return summary;
}

function summarizeEntryBlockers(results: SwingScanResult[]) {
  const summary: Record<string, number> = {};
  for (const result of results) {
    const blocker = (result.entryGate as any)?.primaryBlocker;
    if (!blocker || blocker === "all entry gates passed") continue;
    summary[blocker] = (summary[blocker] || 0) + 1;
  }

  return Object.entries(summary)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => ({ reason, count }));
}

function compactLedgerResult(result: SwingScanResult) {
  const execution = result.execution as any;
  const portfolioBudget = result.portfolioBudget as any;
  return {
    asset: result.asset,
    action: result.action,
    reason: result.reason,
    decisionState: result.decisionState,
    htfScore: result.htfScore,
    triggerScore: result.triggerScore,
    marketStructureScore: result.marketStructureScore,
    microstructureScore: result.microstructureScore,
    dataQuality: result.dataQuality,
    finalConviction: result.finalConviction,
    price: result.price,
    signalPrice: result.signalPrice,
    stopLoss: result.stopLoss,
    takeProfit: result.takeProfit,
    paperSize: result.paperSize,
    entryMode: result.entryMode,
    assetMode: result.assetMode,
    setupTags: result.setupTags,
    marketRegime: result.marketRegime,
    learningAdjustment: result.learningAdjustment,
    entryGate: result.entryGate,
    targetReachability: result.targetReachability,
    netRewardRisk: result.netRewardRisk,
    execution: execution ? {
      modelVersion: execution.modelVersion,
      entryFillPrice: execution.entry?.fillPrice,
      targetFillPrice: execution.targetExit?.fillPrice,
      stopFillPrice: execution.stopExit?.fillPrice,
      netRewardUsd: execution.netRewardUsd,
      netLossUsd: execution.netLossUsd,
      netRewardRiskRatio: execution.netRewardRiskRatio,
      estimatedRoundTripExecutionCostUsd: execution.estimatedRoundTripExecutionCostUsd,
    } : undefined,
    portfolioBudget: portfolioBudget ? {
      approved: portfolioBudget.approved,
      reason: portfolioBudget.reason,
      policyVersion: portfolioBudget.policyVersion,
      diagnostics: portfolioBudget.diagnostics,
    } : undefined,
    timestamp: result.timestamp,
  };
}

function emptyLifetimeStats(nowIso: string): LifetimeScanStats {
  return {
    scanCycles: 0,
    assetChecks: 0,
    entrySignals: 0,
    blockedOrSkipped: 0,
    errors: 0,
    trackedSince: nowIso,
    lastUpdated: nowIso,
  };
}

async function bootstrapLifetimeStats() {
  if (lifetimeStatsBootstrapped) return;
  lifetimeStatsBootstrapped = true;

  const redis = getRedis();
  const existing = await redis.get<LifetimeScanStats>(LIFETIME_STATS_KEY);
  if (existing?.trackedSince) return;

  const nowIso = new Date().toISOString();
  const previousScan = await redis.get<any>(SCAN_SNAPSHOT_KEY).catch(() => null);
  const previousScanId = Number(previousScan?.scanId || 0);
  const previousAssetCount = Array.isArray(previousScan?.results) && previousScan.results.length > 0
    ? previousScan.results.length
    : Object.keys(SUPPORTED_ASSETS).length;

  await redis.set(LIFETIME_STATS_KEY, {
    scanCycles: previousScanId,
    assetChecks: previousScanId * previousAssetCount,
    entrySignals: 0,
    blockedOrSkipped: 0,
    errors: 0,
    trackedSince: previousScan?.startedAt || nowIso,
    lastUpdated: nowIso,
  });
}

async function bootstrapLocalLearningRules() {
  if (localLearningBootstrapped) return;
  localLearningBootstrapped = true;
  await LocalLearningMemory.rebuildRules().catch((error) => {
    Logger.warn(`[LEARNING] Bootstrap rebuild skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function updateLifetimeStats(results: SwingScanResult[]): Promise<LifetimeScanStats> {
  await bootstrapLifetimeStats();

  const redis = getRedis();
  const current = await redis.get<LifetimeScanStats>(LIFETIME_STATS_KEY).catch(() => null);
  const nowIso = new Date().toISOString();
  const summary = summarizeResults(results);
  const next = current?.trackedSince ? current : emptyLifetimeStats(nowIso);

  const updated: LifetimeScanStats = {
    scanCycles: Number(next.scanCycles || 0) + 1,
    assetChecks: Number(next.assetChecks || 0) + results.length,
    entrySignals: Number(next.entrySignals || 0) + summary.ENTRY,
    blockedOrSkipped: Number(next.blockedOrSkipped || 0) + summary.BLOCKED + summary.SKIPPED,
    errors: Number(next.errors || 0) + summary.ERROR,
    trackedSince: next.trackedSince || nowIso,
    lastUpdated: nowIso,
  };

  await redis.set(LIFETIME_STATS_KEY, updated);
  return updated;
}

async function saveScanSnapshot(
  results: SwingScanResult[],
  exitSweep: SwingExitSweepResult,
  startedAt: string,
  opportunitySweep?: { evaluated: number; pending: number }
) {
  const redis = getRedis();
  const now = Date.now();
  const startedTime = new Date(startedAt).getTime();
  const summary = summarizeResults(results);
  const decisionSummary = summarizeDecisionStates(results);
  const blockerSummary = summarizeEntryBlockers(results);
  const lifetimeStats = await updateLifetimeStats(results);

  await redis.set(
    SCAN_SNAPSHOT_KEY,
    {
      scanId: scanSequence,
      startedAt,
      completedAt: new Date().toISOString(),
      nextScanAt: new Date(now + ENTRY_SCAN_INTERVAL_MS).toISOString(),
      entryScanIntervalMs: ENTRY_SCAN_INTERVAL_MS,
      exitWatchdogIntervalMs: EXIT_WATCHDOG_INTERVAL_MS,
      durationMs: Number.isFinite(startedTime) ? now - startedTime : null,
      summary,
      decisionSummary,
      blockerSummary,
      lifetimeStats,
      exitSweep,
      opportunitySweep,
      results,
    },
    { ex: 600 }
  );
}

/**
 * Record the swing sleeve's realised equity so it can be compared against the
 * cross-sectional book. Realised rather than marked, because the book records
 * both and the comparison is only meaningful between like measures — a
 * continuously-marked series correlated against one that moves only on exits
 * would describe the two recording schedules, not the two strategies.
 *
 * Written on change, and at least once per interval regardless, so that a
 * quiet day still produces a point and the day-over-day return exists.
 */
async function sampleSwingEquity(portfolio: { initialCapital: number; totalPnl: number }) {
  const realized = portfolio.initialCapital + portfolio.totalPnl;
  if (!Number.isFinite(realized) || realized <= 0) return;

  const changed = lastRealizedEquity === null || Math.abs(realized - lastRealizedEquity) > 1e-6;
  const due = Date.now() - lastEquitySampleAt >= EQUITY_SAMPLE_INTERVAL_MS;
  if (!changed && !due) return;

  lastEquitySampleAt = Date.now();
  lastRealizedEquity = realized;
  await recordEquityPoint(SWING_EQUITY_CURVE_KEY, {
    equityUsd: realized,
    realizedEquityUsd: realized,
  }).catch(() => undefined);
}

async function runExitWatchdog() {
  if (isExitWatching) return;
  isExitWatching = true;

  try {
    await withPortfolioLock(async () => {
      const portfolioRelease = await PortfolioManager.acquireWriteLock("ai");
      if (!portfolioRelease) return;
      try {
        const portfolio = await getAIPortfolio();
        ensurePortfolioShape(portfolio);
        await sweepSwingExits(portfolio, { portfolioType: "ai", source: "EXIT_WATCHDOG" });
        await sampleSwingEquity(portfolio);
      } finally {
        await portfolioRelease();
      }
    });
  } catch (error) {
    await Logger.error(`[EXIT_WATCHDOG] Failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    isExitWatching = false;
  }
}

async function runEntryScan() {
  if (isEntryScanning) return;
  isEntryScanning = true;
  scanSequence += 1;

  let portfolioRelease: (() => Promise<void>) | null = null;
  try {
    portfolioRelease = await PortfolioManager.acquireWriteLock("ai");
  } catch (error) {
    isEntryScanning = false;
    await Logger.error(`[SWING SCAN] Portfolio lock failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!portfolioRelease) {
    isEntryScanning = false;
    return;
  }

  const startedAt = new Date().toISOString();
  const results: SwingScanResult[] = [];
  let exitSweep: SwingExitSweepResult = {
    source: "ENTRY_SCAN_PREFLIGHT",
    checked: 0,
    closed: 0,
    trailed: 0,
    signalReversals: 0,
    skipped: 0,
    errors: 0,
    timestamp: startedAt,
  };

  try {
    await bootstrapLocalLearningRules();
    const redis = getRedis();
    const portfolio = await getAIPortfolio();
    ensurePortfolioShape(portfolio);
    const recentTrades = await PortfolioManager.getTrades("ai");
    const learningRules = await LocalLearningMemory.getRules().catch(() => []);
    const feedHealth = await FeedHealthSummary.build().catch(() => null);
    const feedByAsset = new Map((feedHealth?.assets || []).map((row) => [row.asset, row]));

    exitSweep = await sweepSwingExits(portfolio, { portfolioType: "ai", source: "ENTRY_SCAN_PREFLIGHT", checkSignalReversal: true });

    const swingMargin = Object.values(portfolio.openPositions || {}).reduce((s: number, p: any) => s + (p?.usdInvested || 0), 0);
    const scalpMargin = Object.values(portfolio.scalpPositions || {}).reduce((s: number, p: any) => s + (p?.usdInvested || 0), 0);
    const estimatedEquity = portfolio.usd + swingMargin + scalpMargin;
    let peakUpdated = false;
    if (!portfolio.peakValue || estimatedEquity > portfolio.peakValue) {
      portfolio.peakValue = estimatedEquity;
      peakUpdated = true;
    }
    if (portfolio.peakValue > 0) {
      const ddPct = ((portfolio.peakValue - estimatedEquity) / portfolio.peakValue) * 100;
      if (portfolio.maxDrawdownPercent === undefined || portfolio.maxDrawdownPercent === null || ddPct > portfolio.maxDrawdownPercent) {
        portfolio.maxDrawdownPercent = ddPct;
        peakUpdated = true;
      }
    }
    if (peakUpdated) {
      await updateAIPortfolio(portfolio).catch((e: unknown) => Logger.warn(`Peak/drawdown sync failed: ${e}`));
    }

    for (const asset of Object.keys(SUPPORTED_ASSETS)) {
      const timestamp = new Date().toISOString();

      const activePosition = portfolio.openPositions?.[asset];
      if (activePosition) {
        results.push({
          asset,
          action: "SKIPPED",
          reason: "Active position already open for this asset.",
          simpleStatus: `Managing active ${activePosition.direction.toLowerCase()} trade`,
          simpleReason: activePosition.thesisStatus
            ? `Current thesis status: ${activePosition.thesisStatus.replaceAll("_", " ").toLowerCase()}. ${activePosition.thesisReason || ""}`.trim()
            : "The bot is monitoring the open trade before adding a new one.",
          nextStep: "Exit watchdog will trail profit, block unsafe scale-ins, or close the trade if the thesis fails.",
          decisionState: "ACTIVE_POSITION",
          finalConviction: activePosition.finalConviction,
          dataQuality: activePosition.dataQuality,
          price: activePosition.entryPrice,
          stopLoss: activePosition.stopLoss,
          takeProfit: activePosition.takeProfit,
          paperSize: activePosition.paperSize,
          entryMode: activePosition.entryMode,
          setupTags: activePosition.setupTags,
          timestamp,
        });
        continue;
      }

      const onCooldown = await redis.get(`swing:cooldown:${asset}`);
      if (onCooldown) {
        results.push({
          asset,
          action: "SKIPPED",
          reason: "Asset is cooling down after a recent swing exit.",
          timestamp,
        });
        continue;
      }

      const session = getMarketSessionState(asset);
      if (!session.isOpen) {
        results.push({
          asset,
          action: "SKIPPED",
          reason: session.reason,
          timestamp,
        });
        continue;
      }
      const requireHighConviction = !session.isPeakLiquidity;

      if (SUPPORTED_ASSETS[asset]?.category !== "crypto") {
        const eventCheck = isEventBlackout(asset);
        if (eventCheck.blocked) {
          results.push({
            asset,
            action: "SKIPPED",
            reason: eventCheck.reason,
            simpleStatus: "Paused for news event",
            simpleReason: eventCheck.reason,
            nextStep: "The bot will resume scanning after the event blackout window clears.",
            timestamp,
          });
          continue;
        }
      }

      const assetFeed = feedByAsset.get(asset);
      if (assetFeed && !assetFeed.safeForSwingExecution) {
        results.push({
          asset,
          action: "SKIPPED",
          reason: `Feed health blocked autonomous entry: ${assetFeed.warnings[0] || assetFeed.status}.`,
          simpleStatus: "Waiting for reliable market data",
          simpleReason: assetFeed.warnings[0] || `Feed status is ${assetFeed.status.toLowerCase()}.`,
          nextStep: "The bot will resume this asset after its candle feed becomes fresh and reliable.",
          decisionState: "BLOCKED_DATA",
          dataQuality: assetFeed.score,
          timestamp,
        });
        continue;
      }

      try {
        const swingSignal = await SwingEngine.analyze(asset);

        const requiredOffPeakConviction = swingSignal.entryMode === "CONTROLLED_PROBE" ? 68 : 72;
        if (
          swingSignal.action !== "HOLD" &&
          requireHighConviction &&
          swingSignal.finalConviction < requiredOffPeakConviction
        ) {
          results.push({
            asset,
            action: "HOLD",
            reason: `${session.reason} Conviction ${swingSignal.finalConviction} is below the ${requiredOffPeakConviction} required outside peak hours.`,
            simpleStatus: "Waiting for peak liquidity window",
            simpleReason: session.reason,
            nextStep: "The bot will enter when the peak trading session opens.",
            decisionState: swingSignal.decisionState,
            score: swingSignal.score,
            htfScore: swingSignal.htfScore,
            triggerScore: swingSignal.triggerScore,
            marketStructureScore: swingSignal.marketStructureScore,
            microstructureScore: swingSignal.microstructureScore,
            microstructureSummary: swingSignal.microstructureSummary,
            fundingRate: swingSignal.fundingRate,
            openInterest: swingSignal.openInterest,
            orderbookImbalanceRatio: swingSignal.orderbookImbalanceRatio,
            liquidityState: swingSignal.liquidityState,
            dataQuality: swingSignal.dataQuality,
            finalConviction: swingSignal.finalConviction,
            timestamp,
          });
          continue;
        }

        if (swingSignal.action === "HOLD") {
          results.push({
            asset,
            action: "HOLD",
            reason: swingSignal.reasoning,
            simpleStatus: swingSignal.simpleStatus,
            simpleReason: swingSignal.simpleReason,
            nextStep: swingSignal.nextStep,
            decisionState: swingSignal.decisionState,
            score: swingSignal.score,
            htfScore: swingSignal.htfScore,
            triggerScore: swingSignal.triggerScore,
            marketStructureScore: swingSignal.marketStructureScore,
            microstructureScore: swingSignal.microstructureScore,
            microstructureSummary: swingSignal.microstructureSummary,
            fundingRate: swingSignal.fundingRate,
            openInterest: swingSignal.openInterest,
            orderbookImbalanceRatio: swingSignal.orderbookImbalanceRatio,
            liquidityState: swingSignal.liquidityState,
            dataQuality: swingSignal.dataQuality,
            finalConviction: swingSignal.finalConviction,
            price: swingSignal.entryPrice,
            signalPrice: swingSignal.signalPrice,
            slippagePercent: swingSignal.slippagePercent,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            paperSize: swingSignal.paperSize,
            riskMode: swingSignal.riskMode,
            assetMode: swingSignal.assetMode,
            setupTags: swingSignal.setupTags,
            directionBias: swingSignal.directionBias,
            learningAdjustment: swingSignal.learningAdjustment,
            learningRules: swingSignal.learningRules,
            entryGate: swingSignal.entryGate,
            targetReachability: swingSignal.targetReachability,
            netRewardRisk: swingSignal.netRewardRisk,
            marketRegime: swingSignal.marketRegime,
            timestamp,
          });
          continue;
        }

        const cryptoAsset = SUPPORTED_ASSETS[asset]?.category === "crypto";
        const marketDataAgeMs = Date.now() - new Date(swingSignal.marketDataTimestamp).getTime();
        const marketIdentityValid = cryptoAsset
          ? swingSignal.marketDataVenue === CRYPTO_EXECUTION_PROVIDER &&
            swingSignal.marketDataInstrument === SUPPORTED_ASSETS[asset].bybitLinearSymbol &&
            Number.isFinite(marketDataAgeMs) && marketDataAgeMs >= 0 && marketDataAgeMs <= 10_000
          : swingSignal.marketDataVenue === "YAHOO" &&
            swingSignal.marketDataInstrument === SUPPORTED_ASSETS[asset].yahooTicker;
        if (!marketIdentityValid) {
          const reason = `Selected execution instrument provenance is invalid or stale (${swingSignal.marketDataProvider}/${swingSignal.marketDataInstrument}).`;
          results.push({
            asset,
            action: "BLOCKED",
            reason,
            simpleStatus: "Market venue verification blocked this trade",
            simpleReason: reason,
            nextStep: "The bot will retry after the selected instrument feed is current and internally consistent.",
            decisionState: "BLOCKED_DATA",
            dataQuality: swingSignal.dataQuality,
            finalConviction: swingSignal.finalConviction,
            timestamp,
          });
          await Logger.warn(`[SWING BLOCK] ${asset} market provenance rejected: ${reason}`);
          continue;
        }

        const isShort = swingSignal.action === "SWING_SHORT";
        const portfolioGuard = PortfolioGuards.evaluateNewSwing({
          portfolio,
          asset,
          direction: isShort ? "SHORT" : "LONG",
          dataQuality: swingSignal.dataQuality,
          finalConviction: swingSignal.finalConviction,
          setupTags: swingSignal.setupTags,
          learningRules,
        });

        if (!portfolioGuard.approved) {
          results.push({
            asset,
            action: "BLOCKED",
            reason: portfolioGuard.reason,
            simpleStatus: "Portfolio exposure blocked this trade",
            simpleReason: portfolioGuard.reason,
            nextStep: "The bot will wait for a cleaner or less crowded setup before adding risk.",
            decisionState: "BLOCKED_RISK",
            score: swingSignal.score,
            htfScore: swingSignal.htfScore,
            triggerScore: swingSignal.triggerScore,
            marketStructureScore: swingSignal.marketStructureScore,
            microstructureScore: swingSignal.microstructureScore,
            microstructureSummary: swingSignal.microstructureSummary,
            fundingRate: swingSignal.fundingRate,
            openInterest: swingSignal.openInterest,
            orderbookImbalanceRatio: swingSignal.orderbookImbalanceRatio,
            liquidityState: swingSignal.liquidityState,
            dataQuality: swingSignal.dataQuality,
            finalConviction: swingSignal.finalConviction,
            price: swingSignal.entryPrice,
            signalPrice: swingSignal.signalPrice,
            slippagePercent: swingSignal.slippagePercent,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            paperSize: swingSignal.paperSize,
            riskMode: "Protected",
            assetMode: swingSignal.assetMode,
            setupTags: swingSignal.setupTags,
            directionBias: swingSignal.directionBias,
            learningAdjustment: swingSignal.learningAdjustment,
            learningRules: swingSignal.learningRules,
            entryGate: swingSignal.entryGate,
            portfolioGuard,
            targetReachability: swingSignal.targetReachability,
            netRewardRisk: swingSignal.netRewardRisk,
            marketRegime: swingSignal.marketRegime,
            timestamp,
          });
          await Logger.warn(`[SWING BLOCK] ${asset} ${isShort ? "SHORT" : "LONG"} denied by portfolio guard: ${portfolioGuard.reason}`);
          continue;
        }

        const invalidStop = (!isShort && swingSignal.stopLoss >= swingSignal.entryPrice) ||
          (isShort && swingSignal.stopLoss <= swingSignal.entryPrice);
        if (invalidStop) {
          results.push({
            asset, action: "BLOCKED", reason: "Stop loss is on wrong side of entry price",
            simpleStatus: "Invalid stop loss", simpleReason: "Stop loss would trigger immediately — skipping.",
            nextStep: "Waiting for better data quality.", decisionState: "BLOCKED_RISK",
            score: swingSignal.score, timestamp,
          });
          await Logger.warn(`[SWING BLOCK] ${asset} invalid SL: entry=${swingSignal.entryPrice} SL=${swingSignal.stopLoss} dir=${isShort ? "SHORT" : "LONG"}`);
          continue;
        }

        const recoveryProbe = portfolioGuard.recoveryProbe === true;
        const requestedMarginUsd = recoveryProbe
          ? Math.max(100, Math.min(500, portfolio.usd * 0.05))
          : swingSignal.entryMode === "CONTROLLED_PROBE"
            ? Math.max(100, Math.min(500, portfolio.usd * 0.05))
            : undefined;
        const effectiveEntryMode = recoveryProbe ? "CONTROLLED_PROBE" : swingSignal.entryMode;
        const effectivePaperSize = recoveryProbe ? "Probe" : swingSignal.paperSize;
        const recoveryProbeReason = recoveryProbe
          ? `Local learning is cautious, so this is a smaller recovery probe instead of a full-size retry. ${portfolioGuard.reason}`
          : "";

        const admission = TradeAdmissionController.evaluate({
          portfolio,
          asset,
          direction: isShort ? "SHORT" : "LONG",
          entryPrice: swingSignal.entryPrice,
          stopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          signalScore: swingSignal.score,
          finalConviction: swingSignal.finalConviction,
          learningAdjustment: swingSignal.learningAdjustment,
          setupTags: swingSignal.setupTags,
          assetMode: swingSignal.assetMode,
          dataQuality: swingSignal.dataQuality,
          entryMode: effectiveEntryMode,
          reasoning: swingSignal.reasoning,
          strategyType: "swing",
          requestedMarginUsd,
        });

        if (!admission.approved) {
          results.push({
            asset,
            action: "BLOCKED",
            reason: admission.reason,
            simpleStatus: "Trade blocked for safety",
            simpleReason: admission.reason,
            nextStep: "The bot will wait for a safer position size or cleaner setup.",
            decisionState: "BLOCKED_RISK",
            score: swingSignal.score,
            htfScore: swingSignal.htfScore,
            triggerScore: swingSignal.triggerScore,
            marketStructureScore: swingSignal.marketStructureScore,
            microstructureScore: swingSignal.microstructureScore,
            microstructureSummary: swingSignal.microstructureSummary,
            fundingRate: swingSignal.fundingRate,
            openInterest: swingSignal.openInterest,
            orderbookImbalanceRatio: swingSignal.orderbookImbalanceRatio,
            liquidityState: swingSignal.liquidityState,
            dataQuality: swingSignal.dataQuality,
            finalConviction: swingSignal.finalConviction,
            price: swingSignal.entryPrice,
            signalPrice: swingSignal.signalPrice,
            slippagePercent: swingSignal.slippagePercent,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            paperSize: effectivePaperSize,
            riskMode: "Protected",
            assetMode: swingSignal.assetMode,
            setupTags: swingSignal.setupTags,
            directionBias: swingSignal.directionBias,
            learningAdjustment: swingSignal.learningAdjustment,
            learningRules: swingSignal.learningRules,
            entryGate: swingSignal.entryGate,
            targetReachability: swingSignal.targetReachability,
            netRewardRisk: swingSignal.netRewardRisk,
            marketRegime: swingSignal.marketRegime,
            timestamp,
          });
          await Logger.warn(`[SWING BLOCK] ${asset} ${isShort ? "SHORT" : "LONG"} denied: ${admission.reason}`);
          continue;
        }

        const fittedExecution = fitPaperExecutionPlanToRiskBudget({
          asset,
          direction: isShort ? "SHORT" : "LONG",
          entryPrice: swingSignal.entryPrice,
          stopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          amount: admission.amount,
          riskBudgetUsd: admission.riskAmountUsd,
          context: {
            assetMode: swingSignal.assetMode,
            dataQuality: swingSignal.dataQuality,
            isPeakLiquidity: session.isPeakLiquidity,
            liquidityState: swingSignal.liquidityState,
            orderbookImbalanceRatio: swingSignal.orderbookImbalanceRatio,
          },
        });
        const executionPlan = fittedExecution.plan;
        const finalRequiredMarginUsd = executionPlan.entry.notionalUsd / admission.leverage;
        const minimumExecutionRewardRisk = effectiveEntryMode === "CONTROLLED_PROBE" ? 1.5 : 1.35;
        const executionFailure = executionPlan.netRewardUsd <= 0
          ? "Modeled execution costs eliminate the target reward."
          : executionPlan.netRewardRiskRatio < minimumExecutionRewardRisk
            ? `Final modeled reward/risk ${executionPlan.netRewardRiskRatio.toFixed(2)} is below ${minimumExecutionRewardRisk.toFixed(2)}.`
            : executionPlan.netLossUsd > admission.riskAmountUsd * 1.01
              ? `Modeled stop loss $${executionPlan.netLossUsd.toFixed(2)} exceeds the approved $${admission.riskAmountUsd.toFixed(2)} risk budget.`
              : finalRequiredMarginUsd < getAssetSpec(asset).minMarginUsd
                ? `After-cost risk sizing reduced margin below the $${getAssetSpec(asset).minMarginUsd.toFixed(2)} minimum useful size.`
              : finalRequiredMarginUsd + executionPlan.entry.feeUsd > portfolio.usd
                ? "Insufficient free cash after the modeled entry fee."
                : null;

        if (executionFailure) {
          results.push({
            asset,
            action: "BLOCKED",
            reason: executionFailure,
            simpleStatus: "Execution economics blocked this trade",
            simpleReason: executionFailure,
            nextStep: "The bot will wait for a wider after-cost edge or smaller stop risk.",
            decisionState: "BLOCKED_RISK",
            score: swingSignal.score,
            htfScore: swingSignal.htfScore,
            triggerScore: swingSignal.triggerScore,
            marketStructureScore: swingSignal.marketStructureScore,
            microstructureScore: swingSignal.microstructureScore,
            dataQuality: swingSignal.dataQuality,
            finalConviction: swingSignal.finalConviction,
            price: executionPlan.entry.fillPrice,
            signalPrice: swingSignal.signalPrice,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            paperSize: effectivePaperSize,
            entryMode: effectiveEntryMode,
            assetMode: swingSignal.assetMode,
            setupTags: swingSignal.setupTags,
            directionBias: swingSignal.directionBias,
            learningAdjustment: swingSignal.learningAdjustment,
            entryGate: swingSignal.entryGate,
            targetReachability: swingSignal.targetReachability,
            netRewardRisk: swingSignal.netRewardRisk,
            marketRegime: swingSignal.marketRegime,
            execution: executionPlan,
            timestamp,
          });
          await ExecutionLedger.recordBestEffort({
            type: "ENTRY_BLOCKED",
            source: "SWING_DAEMON",
            asset,
            payload: { reason: executionFailure, signal: swingSignal, admission, executionPlan },
          });
          continue;
        }

        const portfolioBudget = evaluatePortfolioRiskBudget({
          portfolio,
          trades: recentTrades,
          asset,
          direction: isShort ? "SHORT" : "LONG",
          candidateNotionalUsd: executionPlan.entry.notionalUsd,
          candidateMaxLossUsd: executionPlan.netLossUsd,
          candidateEntryCostUsd: executionPlan.entry.totalExecutionCostUsd,
        });

        if (!portfolioBudget.approved) {
          results.push({
            asset,
            action: "BLOCKED",
            reason: portfolioBudget.reason,
            simpleStatus: "Portfolio circuit breaker blocked this trade",
            simpleReason: portfolioBudget.reason,
            nextStep: "The bot will wait for rolling turnover, loss, cost, and exposure budgets to recover.",
            decisionState: "BLOCKED_RISK",
            score: swingSignal.score,
            htfScore: swingSignal.htfScore,
            triggerScore: swingSignal.triggerScore,
            marketStructureScore: swingSignal.marketStructureScore,
            microstructureScore: swingSignal.microstructureScore,
            dataQuality: swingSignal.dataQuality,
            finalConviction: swingSignal.finalConviction,
            price: executionPlan.entry.fillPrice,
            signalPrice: swingSignal.signalPrice,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            paperSize: effectivePaperSize,
            entryMode: effectiveEntryMode,
            assetMode: swingSignal.assetMode,
            setupTags: swingSignal.setupTags,
            directionBias: swingSignal.directionBias,
            learningAdjustment: swingSignal.learningAdjustment,
            entryGate: swingSignal.entryGate,
            targetReachability: swingSignal.targetReachability,
            netRewardRisk: swingSignal.netRewardRisk,
            marketRegime: swingSignal.marketRegime,
            execution: executionPlan,
            portfolioBudget,
            timestamp,
          });
          await ExecutionLedger.recordBestEffort({
            type: "RISK_CIRCUIT_BREAKER",
            source: "SWING_DAEMON",
            asset,
            payload: { signal: swingSignal, admission, executionPlan, portfolioBudget },
          });
          continue;
        }

        const entryTradeId = crypto.randomUUID();
        await ExecutionLedger.record({
          type: "ENTRY_APPROVED",
          source: "SWING_DAEMON",
          asset,
          decisionId: entryTradeId,
          tradeId: entryTradeId,
          payload: {
            marketData: {
              signalPrice: swingSignal.signalPrice,
              livePrice: swingSignal.livePrice,
              dataQuality: swingSignal.dataQuality,
              assetMode: swingSignal.assetMode,
              liquidityState: swingSignal.liquidityState,
              marketRegime: swingSignal.marketRegime,
              provider: swingSignal.marketDataProvider,
              source: swingSignal.marketDataSource,
              venue: swingSignal.marketDataVenue,
              instrument: swingSignal.marketDataInstrument,
              timestamp: swingSignal.marketDataTimestamp,
              bid: swingSignal.marketDataBid,
              ask: swingSignal.marketDataAsk,
            },
            signal: swingSignal,
            admission,
            portfolioBudget,
            executionPlan,
          },
        });

        portfolio.usd -= finalRequiredMarginUsd + executionPlan.entry.feeUsd;
        portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + executionPlan.entry.feeUsd;
        portfolio.totalExecutionCostsPaid = (portfolio.totalExecutionCostsPaid || 0) + executionPlan.entry.totalExecutionCostUsd;

        if (!isShort) {
          portfolio.balances[asset] = (portfolio.balances[asset] || 0) + executionPlan.entry.amount;
        }

        const newPos: OpenPosition = {
          asset,
          entryPrice: executionPlan.entry.fillPrice,
          amount: executionPlan.entry.amount,
          btcAmount: executionPlan.entry.amount,
          usdInvested: finalRequiredMarginUsd,
          stopLoss: swingSignal.stopLoss,
          initialStopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          entryTime: new Date().toISOString(),
          signalScore: swingSignal.score,
          finalConviction: swingSignal.finalConviction,
          decisionState: swingSignal.decisionState,
          setupTags: swingSignal.setupTags,
          dataQuality: swingSignal.dataQuality,
          triggerScore: swingSignal.triggerScore,
          marketStructureScore: swingSignal.marketStructureScore,
          microstructureScore: swingSignal.microstructureScore,
          microstructureSummary: swingSignal.microstructureSummary,
          fundingRate: swingSignal.fundingRate,
          openInterest: swingSignal.openInterest,
          orderbookImbalanceRatio: swingSignal.orderbookImbalanceRatio,
          liquidityState: swingSignal.liquidityState,
          paperSize: effectivePaperSize,
          entryMode: effectiveEntryMode,
          reasoning: `${swingSignal.simpleStatus}. ${swingSignal.simpleReason} | ${swingSignal.reasoning} | ${recoveryProbeReason ? `${recoveryProbeReason} | ` : ""}${admission.reason}`,
          direction: isShort ? "SHORT" : "LONG",
          isScalp: false,
          entryFeePaid: executionPlan.entry.feeUsd,
          notionalUsd: executionPlan.entry.notionalUsd,
          leverageUsed: admission.leverage,
          marginMode: admission.marginMode,
          marginPolicyVersion: admission.marginPolicyVersion,
          riskAmountUsd: admission.riskAmountUsd,
          maxLossUsd: executionPlan.netLossUsd,
          admissionScore: admission.admissionScore,
          learningRiskMultiplier: admission.learningRiskMultiplier,
          learningAdjustment: swingSignal.learningAdjustment,
          setupRiskMultiplier: admission.setupRiskMultiplier,
          setupRiskReason: admission.setupRiskReason,
          strategyType: "swing",
          thesisStatus: "VALID",
          thesisReason: "Initial entry thesis is active and awaiting live follow-through.",
          lastThesisCheckTime: new Date().toISOString(),
          targetReachabilityScore: swingSignal.targetReachability?.score,
          rawTakeProfit: swingSignal.targetReachability?.rawTakeProfit,
          targetAdjustedReason: swingSignal.targetReachability?.reason,
          netRewardRiskRatio: executionPlan.netRewardRiskRatio,
          strategyVersion: TRADING_STRATEGY_VERSION,
          marketRegime: swingSignal.marketRegime,
          executionCostModelVersion: executionPlan.modelVersion,
          executionVenueModel: executionPlan.entry.venueModel,
          marketDataProvider: swingSignal.marketDataProvider,
          marketDataSource: swingSignal.marketDataSource,
          marketDataVenue: swingSignal.marketDataVenue,
          marketDataInstrument: swingSignal.marketDataInstrument,
          marketDataTimestamp: swingSignal.marketDataTimestamp,
          marketDataBid: swingSignal.marketDataBid,
          marketDataAsk: swingSignal.marketDataAsk,
          entryRequestedPrice: swingSignal.entryPrice,
          entryExecutionCostUsd: executionPlan.entry.totalExecutionCostUsd,
          entryPriceImpactCostUsd: executionPlan.entry.priceImpactCostUsd,
          assumedRoundTripExecutionCostUsd: executionPlan.estimatedRoundTripExecutionCostUsd,
          expectedNetRewardUsd: executionPlan.netRewardUsd,
          expectedNetLossUsd: executionPlan.netLossUsd,
          carryCostPaid: 0,
        };

        portfolio.openPositions[asset] = newPos;

        const entryTrade: Trade = {
          id: entryTradeId,
          timestamp: new Date().toISOString(),
          asset,
          action: isShort ? "SHORT" : "BUY",
          direction: isShort ? "SHORT" : "LONG",
          amount: executionPlan.entry.amount,
          btcAmount: executionPlan.entry.amount,
          price: executionPlan.entry.fillPrice,
          requestedPrice: swingSignal.entryPrice,
          usdValue: finalRequiredMarginUsd,
          notionalUsd: executionPlan.entry.notionalUsd,
          leverageUsed: admission.leverage,
          marginMode: admission.marginMode,
          marginPolicyVersion: admission.marginPolicyVersion,
          riskAmountUsd: admission.riskAmountUsd,
          maxLossUsd: executionPlan.netLossUsd,
          stopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          signalScore: swingSignal.score,
          finalConviction: swingSignal.finalConviction,
          decisionState: swingSignal.decisionState,
          setupTags: swingSignal.setupTags,
          dataQuality: swingSignal.dataQuality,
          triggerScore: swingSignal.triggerScore,
          marketStructureScore: swingSignal.marketStructureScore,
          microstructureScore: swingSignal.microstructureScore,
          microstructureSummary: swingSignal.microstructureSummary,
          fundingRate: swingSignal.fundingRate,
          openInterest: swingSignal.openInterest,
          orderbookImbalanceRatio: swingSignal.orderbookImbalanceRatio,
          liquidityState: swingSignal.liquidityState,
          paperSize: effectivePaperSize,
          entryMode: effectiveEntryMode,
          setupRiskMultiplier: admission.setupRiskMultiplier,
          setupRiskReason: admission.setupRiskReason,
          targetReachabilityScore: swingSignal.targetReachability?.score,
          rawTakeProfit: swingSignal.targetReachability?.rawTakeProfit,
          targetAdjustedReason: swingSignal.targetReachability?.reason,
          learningRiskMultiplier: admission.learningRiskMultiplier,
          learningAdjustment: swingSignal.learningAdjustment,
          netRewardRiskRatio: executionPlan.netRewardRiskRatio,
          strategyVersion: TRADING_STRATEGY_VERSION,
          marketRegime: swingSignal.marketRegime,
          executionCostModelVersion: executionPlan.modelVersion,
          executionVenueModel: executionPlan.entry.venueModel,
          marketDataProvider: swingSignal.marketDataProvider,
          marketDataSource: swingSignal.marketDataSource,
          marketDataVenue: swingSignal.marketDataVenue,
          marketDataInstrument: swingSignal.marketDataInstrument,
          marketDataTimestamp: swingSignal.marketDataTimestamp,
          marketDataBid: swingSignal.marketDataBid,
          marketDataAsk: swingSignal.marketDataAsk,
          entryFeeUsd: executionPlan.entry.feeUsd,
          executionCostUsd: executionPlan.entry.totalExecutionCostUsd,
          entryExecutionCostUsd: executionPlan.entry.totalExecutionCostUsd,
          spreadCostUsd: executionPlan.entry.spreadCostUsd,
          slippageCostUsd: executionPlan.entry.slippageCostUsd,
          gapCostUsd: executionPlan.entry.gapCostUsd,
          reasoning: newPos.reasoning,
        };

        await updateAIPortfolio(portfolio);
        await logAITrade(entryTrade);
        recentTrades.unshift(entryTrade);
        await ExecutionLedger.recordBestEffort({
          type: "ENTRY_FILLED",
          source: "SWING_DAEMON",
          asset,
          decisionId: entryTradeId,
          tradeId: entryTradeId,
          payload: { trade: entryTrade, position: newPos, portfolioBudget, executionPlan },
        });

        results.push({
          asset,
          action: "ENTRY",
          reason: newPos.reasoning,
          simpleStatus: swingSignal.simpleStatus,
          simpleReason: swingSignal.simpleReason,
          nextStep: swingSignal.nextStep,
          decisionState: swingSignal.decisionState,
          score: swingSignal.score,
          htfScore: swingSignal.htfScore,
          triggerScore: swingSignal.triggerScore,
          marketStructureScore: swingSignal.marketStructureScore,
          microstructureScore: swingSignal.microstructureScore,
          microstructureSummary: swingSignal.microstructureSummary,
          fundingRate: swingSignal.fundingRate,
          openInterest: swingSignal.openInterest,
          orderbookImbalanceRatio: swingSignal.orderbookImbalanceRatio,
          liquidityState: swingSignal.liquidityState,
          dataQuality: swingSignal.dataQuality,
          finalConviction: swingSignal.finalConviction,
          price: executionPlan.entry.fillPrice,
          signalPrice: swingSignal.signalPrice,
          slippagePercent: swingSignal.slippagePercent,
          stopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          margin: finalRequiredMarginUsd,
          leverage: admission.leverage,
          marginMode: admission.marginMode,
          marginPolicyVersion: admission.marginPolicyVersion,
          paperSize: effectivePaperSize,
          entryMode: effectiveEntryMode,
          riskMode: swingSignal.riskMode,
          assetMode: swingSignal.assetMode,
          setupTags: swingSignal.setupTags,
          directionBias: swingSignal.directionBias,
          learningAdjustment: swingSignal.learningAdjustment,
          learningRules: swingSignal.learningRules,
          entryGate: swingSignal.entryGate,
          targetReachability: swingSignal.targetReachability,
          netRewardRisk: swingSignal.netRewardRisk,
          marketRegime: swingSignal.marketRegime,
          execution: executionPlan,
          portfolioBudget,
          timestamp,
        });

        await Logger.info(
          `[SWING ENTRY] ${asset} ${isShort ? "SHORT" : "LONG"} @ $${executionPlan.entry.fillPrice.toLocaleString()} | Margin Mode: ${admission.marginMode} | Risk Budget: $${admission.riskAmountUsd.toFixed(2)} | Modeled Max Loss: $${executionPlan.netLossUsd.toFixed(2)} | Net R/R: ${executionPlan.netRewardRiskRatio.toFixed(2)} | Margin: $${finalRequiredMarginUsd.toFixed(2)} | Lev: ${admission.leverage}x`
        );
      } catch (error) {
        results.push({
          asset,
          action: "ERROR",
          reason: error instanceof Error ? error.message : String(error),
          timestamp,
        });
        await Logger.error(`[SWING SCAN] Scan error on ${asset}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await OpportunityJournal.recordMany(results);
    const opportunitySweep = await OpportunityJournal.evaluateDue();
    if ((opportunitySweep?.evaluated || 0) > 0) {
      await LocalLearningMemory.rebuildRules();
    }

    await saveScanSnapshot(results, exitSweep, startedAt, opportunitySweep);
    await ExecutionLedger.recordBestEffort({
      type: "SCAN_COMPLETED",
      source: "SWING_DAEMON",
      timestamp: new Date().toISOString(),
      payload: {
        scanId: scanSequence,
        startedAt,
        completedAt: new Date().toISOString(),
        summary: summarizeResults(results),
        decisionSummary: summarizeDecisionStates(results),
        blockerSummary: summarizeEntryBlockers(results),
        exitSweep,
        opportunitySweep,
        results: results.map(compactLedgerResult),
      },
    });

    if (Date.now() - lastSummaryLogTime > 60_000) {
      lastSummaryLogTime = Date.now();
      const activeCount = Object.keys(portfolio.openPositions || {}).length;
      const summary = summarizeResults(results);
      await Logger.info(
        `[SWING SCAN] Active: ${activeCount} | Entries: ${summary.ENTRY} | Holds: ${summary.HOLD} | Blocks: ${summary.BLOCKED} | Skips: ${summary.SKIPPED} | Errors: ${summary.ERROR}`
      );
    }
  } catch (error) {
    await Logger.error(`[SWING SCAN] Core loop failed: ${error instanceof Error ? error.message : String(error)}`);
    await ExecutionLedger.recordBestEffort({
      type: "SYSTEM_ERROR",
      source: "SWING_DAEMON",
      payload: { scope: "ENTRY_SCAN", error },
    });
    await saveScanSnapshot(results, exitSweep, startedAt);
  } finally {
    isEntryScanning = false;
    await portfolioRelease();
  }
}

console.log("Starting V6 Institutional HTF Swing Daemon...");
// The entry scan reads its portfolio snapshot at the very start and mutates
// it for the rest of the cycle, so the whole scan must hold the lock — not
// just the final write. Exit checks still run first inside the scan itself
// (ENTRY_SCAN_PREFLIGHT sweep), so stops are not starved while it holds it.
const runEntryScanLocked = () => withPortfolioLock(runEntryScan);
runEntryScanLocked();

const entryIntervalId = setInterval(runEntryScanLocked, ENTRY_SCAN_INTERVAL_MS);
const exitWatchdogIntervalId = setInterval(runExitWatchdog, EXIT_WATCHDOG_INTERVAL_MS);
const controlIntervalId = setInterval(async () => {
  if (isEntryScanning) return;
  try {
    const request = await consumeSwingScanRequest();
    if (!request) return;
    await Logger.info(`[SCAN CONTROL] Consuming ${request.requestedBy} request for ${request.targetAsset}.`);
    await runEntryScanLocked();
  } catch (error) {
    await Logger.error(`[SCAN CONTROL] Failed to consume scan request: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 5_000);

const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Shutting down swingDaemon gracefully...`);
  clearInterval(entryIntervalId);
  clearInterval(exitWatchdogIntervalId);
  clearInterval(controlIntervalId);
  try {
    wsMesh.stop();
  } catch {}
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
