import crypto from "crypto";
import { SwingEngine } from "../lib/swingEngine";
import { SUPPORTED_ASSETS } from "../lib/market";
import { PortfolioManager } from "../lib/portfolio";
import { Logger } from "../lib/logger";
import { getRedis } from "../lib/redis";
import { Trade, OpenPosition } from "../lib/types";
import { WebsocketDataMesh } from "./websocketDataMesh";
import { TradeAdmissionController } from "../lib/trading/tradeAdmission";
import { sweepSwingExits, SwingExitSweepResult } from "../lib/execution/swingLifecycle";
import { getMarketSessionState } from "../lib/trading/marketSession";
import { OpportunityJournal } from "../lib/trading/opportunityJournal";
import { LocalLearningMemory } from "../lib/trading/localLearning";
import { isEventBlackout } from "../lib/trading/eventCalendar";
import { PortfolioGuards } from "../lib/trading/portfolioGuards";

const ENTRY_SCAN_INTERVAL_MS = 60_000;
const EXIT_WATCHDOG_INTERVAL_MS = 5_000;
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
let lastSummaryLogTime = 0;
let scanSequence = 0;
let lifetimeStatsBootstrapped = false;
let localLearningBootstrapped = false;

function ensurePortfolioShape(portfolio: any) {
  portfolio.openPositions = portfolio.openPositions || {};
  portfolio.balances = portfolio.balances || {};
  portfolio.returns = portfolio.returns || [];
  portfolio.totalFeesPaid = portfolio.totalFeesPaid || 0;
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

async function runExitWatchdog() {
  if (isExitWatching) return;
  isExitWatching = true;

  try {
    const portfolio = await getAIPortfolio();
    ensurePortfolioShape(portfolio);
    await sweepSwingExits(portfolio, { portfolioType: "ai", source: "EXIT_WATCHDOG" });
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
    const learningRules = await LocalLearningMemory.getRules().catch(() => []);

    exitSweep = await sweepSwingExits(portfolio, { portfolioType: "ai", source: "ENTRY_SCAN_PREFLIGHT", checkSignalReversal: true });

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
            timestamp,
          });
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
            timestamp,
          });
          await Logger.warn(`[SWING BLOCK] ${asset} ${isShort ? "SHORT" : "LONG"} denied by portfolio guard: ${portfolioGuard.reason}`);
          continue;
        }

        const admission = TradeAdmissionController.evaluate({
          portfolio,
          asset,
          direction: isShort ? "SHORT" : "LONG",
          entryPrice: swingSignal.entryPrice,
          stopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          signalScore: swingSignal.score,
          finalConviction: swingSignal.finalConviction,
          reasoning: swingSignal.reasoning,
          strategyType: "swing",
          requestedMarginUsd: swingSignal.entryMode === "CONTROLLED_PROBE"
            ? Math.max(150, Math.min(1_000, portfolio.usd * 0.10))
            : undefined,
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
            paperSize: swingSignal.paperSize,
            riskMode: "Protected",
            assetMode: swingSignal.assetMode,
            setupTags: swingSignal.setupTags,
            directionBias: swingSignal.directionBias,
            learningAdjustment: swingSignal.learningAdjustment,
            learningRules: swingSignal.learningRules,
            entryGate: swingSignal.entryGate,
            timestamp,
          });
          await Logger.warn(`[SWING BLOCK] ${asset} ${isShort ? "SHORT" : "LONG"} denied: ${admission.reason}`);
          continue;
        }

        portfolio.usd -= admission.requiredMarginUsd + admission.entryFeeUsd;
        portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + admission.entryFeeUsd;

        if (!isShort) {
          portfolio.balances[asset] = (portfolio.balances[asset] || 0) + admission.amount;
        }

        const newPos: OpenPosition = {
          asset,
          entryPrice: swingSignal.entryPrice,
          amount: admission.amount,
          btcAmount: admission.amount,
          usdInvested: admission.requiredMarginUsd,
          stopLoss: swingSignal.stopLoss,
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
          paperSize: swingSignal.paperSize,
          entryMode: swingSignal.entryMode,
          reasoning: `${swingSignal.simpleStatus}. ${swingSignal.simpleReason} | ${swingSignal.reasoning} | ${admission.reason}`,
          direction: isShort ? "SHORT" : "LONG",
          isScalp: false,
          entryFeePaid: admission.entryFeeUsd,
          notionalUsd: admission.notionalUsd,
          leverageUsed: admission.leverage,
          riskAmountUsd: admission.riskAmountUsd,
          maxLossUsd: admission.maxLossUsd,
          admissionScore: admission.admissionScore,
          strategyType: "swing",
          thesisStatus: "VALID",
          thesisReason: "Initial entry thesis is active and awaiting live follow-through.",
          lastThesisCheckTime: new Date().toISOString(),
        };

        portfolio.openPositions[asset] = newPos;

        const entryTrade: Trade = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          asset,
          action: isShort ? "SHORT" : "BUY",
          direction: isShort ? "SHORT" : "LONG",
          amount: admission.amount,
          btcAmount: admission.amount,
          price: swingSignal.entryPrice,
          usdValue: admission.requiredMarginUsd,
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
          paperSize: swingSignal.paperSize,
          entryMode: swingSignal.entryMode,
          reasoning: newPos.reasoning,
        };

        await updateAIPortfolio(portfolio);
        await logAITrade(entryTrade);

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
          price: swingSignal.entryPrice,
          signalPrice: swingSignal.signalPrice,
          slippagePercent: swingSignal.slippagePercent,
          stopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          margin: admission.requiredMarginUsd,
          leverage: admission.leverage,
          paperSize: swingSignal.paperSize,
          entryMode: swingSignal.entryMode,
          riskMode: swingSignal.riskMode,
          assetMode: swingSignal.assetMode,
          setupTags: swingSignal.setupTags,
          directionBias: swingSignal.directionBias,
          learningAdjustment: swingSignal.learningAdjustment,
          learningRules: swingSignal.learningRules,
          entryGate: swingSignal.entryGate,
          timestamp,
        });

        await Logger.info(
          `[SWING ENTRY] ${asset} ${isShort ? "SHORT" : "LONG"} @ $${swingSignal.entryPrice.toLocaleString()} | Risk Budget: $${admission.riskAmountUsd.toFixed(2)} | Max Loss: $${admission.maxLossUsd.toFixed(2)} | Margin: $${admission.requiredMarginUsd.toFixed(2)} | Lev: ${admission.leverage}x`
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
    await saveScanSnapshot(results, exitSweep, startedAt);
  } finally {
    isEntryScanning = false;
  }
}

console.log("Starting V6 Institutional HTF Swing Daemon...");
runEntryScan();

const entryIntervalId = setInterval(runEntryScan, ENTRY_SCAN_INTERVAL_MS);
const exitWatchdogIntervalId = setInterval(runExitWatchdog, EXIT_WATCHDOG_INTERVAL_MS);

const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Shutting down swingDaemon gracefully...`);
  clearInterval(entryIntervalId);
  clearInterval(exitWatchdogIntervalId);
  try {
    wsMesh.stop();
  } catch {}
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
