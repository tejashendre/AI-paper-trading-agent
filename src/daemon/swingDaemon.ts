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

const ENTRY_SCAN_INTERVAL_MS = 60_000;
const EXIT_WATCHDOG_INTERVAL_MS = 5_000;
const SCAN_SNAPSHOT_KEY = "swing:lastScan:ai";

type SwingScanAction = "HOLD" | "BLOCKED" | "ENTRY" | "SKIPPED" | "ERROR";

interface SwingScanResult {
  asset: string;
  action: SwingScanAction;
  reason: string;
  score?: number;
  price?: number;
  margin?: number;
  leverage?: number;
  timestamp: string;
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

async function saveScanSnapshot(
  results: SwingScanResult[],
  exitSweep: SwingExitSweepResult,
  startedAt: string
) {
  const redis = getRedis();
  const now = Date.now();
  const startedTime = new Date(startedAt).getTime();
  const summary = summarizeResults(results);

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
      exitSweep,
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
    skipped: 0,
    errors: 0,
    timestamp: startedAt,
  };

  try {
    const redis = getRedis();
    const portfolio = await getAIPortfolio();
    ensurePortfolioShape(portfolio);

    exitSweep = await sweepSwingExits(portfolio, { portfolioType: "ai", source: "ENTRY_SCAN_PREFLIGHT" });

    for (const asset of Object.keys(SUPPORTED_ASSETS)) {
      const timestamp = new Date().toISOString();

      if (portfolio.openPositions?.[asset]) {
        results.push({
          asset,
          action: "SKIPPED",
          reason: "Active position already open for this asset.",
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

      try {
        const swingSignal = await SwingEngine.analyze(asset);

        if (swingSignal.action === "HOLD") {
          results.push({
            asset,
            action: "HOLD",
            reason: swingSignal.reasoning,
            score: swingSignal.score,
            price: swingSignal.entryPrice,
            timestamp,
          });
          continue;
        }

        const isShort = swingSignal.action === "SWING_SHORT";
        const admission = TradeAdmissionController.evaluate({
          portfolio,
          asset,
          direction: isShort ? "SHORT" : "LONG",
          entryPrice: swingSignal.entryPrice,
          stopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          signalScore: swingSignal.score,
          reasoning: swingSignal.reasoning,
          strategyType: "swing",
        });

        if (!admission.approved) {
          results.push({
            asset,
            action: "BLOCKED",
            reason: admission.reason,
            score: swingSignal.score,
            price: swingSignal.entryPrice,
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
          reasoning: `${swingSignal.reasoning} | ${admission.reason}`,
          direction: isShort ? "SHORT" : "LONG",
          isScalp: false,
          entryFeePaid: admission.entryFeeUsd,
          notionalUsd: admission.notionalUsd,
          leverageUsed: admission.leverage,
          riskAmountUsd: admission.riskAmountUsd,
          maxLossUsd: admission.maxLossUsd,
          admissionScore: admission.admissionScore,
          strategyType: "swing",
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
          reasoning: newPos.reasoning,
        };

        await updateAIPortfolio(portfolio);
        await logAITrade(entryTrade);

        results.push({
          asset,
          action: "ENTRY",
          reason: newPos.reasoning,
          score: swingSignal.score,
          price: swingSignal.entryPrice,
          margin: admission.requiredMarginUsd,
          leverage: admission.leverage,
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

    await saveScanSnapshot(results, exitSweep, startedAt);

    if (Date.now() - lastSummaryLogTime > 300_000) {
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
