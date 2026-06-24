import { ASSET_CONTRACT_SPECS, getAssetSpec } from "../src/lib/trading/assetSpecs";
import { runReplay } from "../src/lib/backtest/replayEngine";
import { TradeAdmissionController } from "../src/lib/trading/tradeAdmission";
import { Candle, Portfolio } from "../src/lib/types";
import { RiskManager } from "../src/lib/riskManager";
import fs from "fs";
import path from "path";

type AuditLevel = "PASS" | "WARN" | "FAIL";

interface AuditResult {
  level: AuditLevel;
  check: string;
  detail: string;
}

interface LiveStatus {
  aiPortfolio?: {
    totalPnl?: number;
    totalTrades?: number;
    openPositions?: Record<string, unknown>;
  };
  userPortfolio?: {
    openPositions?: Record<string, unknown>;
  };
  swingScan?: {
    scanId?: number;
    completedAt?: string;
    summary?: Record<string, number>;
    decisionSummary?: Record<string, number>;
    blockerSummary?: Array<{
      reason?: string;
      count?: number;
    }>;
    exitSweep?: {
      checked?: number;
      closed?: number;
      trailed?: number;
      signalReversals?: number;
      errors?: number;
    };
    opportunitySweep?: {
      evaluated?: number;
      pending?: number;
    };
    results?: Array<{
      asset?: string;
      action?: string;
      decisionState?: string;
      simpleStatus?: string;
      score?: number;
      triggerScore?: number;
      dataQuality?: number;
      finalConviction?: number;
      paperSize?: string;
      entryGate?: {
        primaryBlocker?: string;
      };
    }>;
  };
  opportunitySummary?: {
    totalEvaluated?: number;
    favorableRate?: number;
    bestMissed?: unknown;
  };
  recentOpportunities?: unknown[];
  localLearningRules?: unknown[];
  setupPerformance?: {
    closedTradeCount?: number;
    setupCount?: number;
    bySetup?: unknown[];
    bestSetup?: unknown;
    plainFindings?: string[];
  };
  feedHealthMatrix?: {
    assets?: Array<{
      asset?: string;
      status?: string;
      score?: number;
      mode?: string;
      safeForFastExecution?: boolean;
      safeForSwingExecution?: boolean;
    }>;
    summary?: {
      good?: number;
      degraded?: number;
      bad?: number;
      fastEligible?: number;
      swingEligible?: number;
    };
  };
}

const REQUIRED_ASSETS = ["BTC", "ETH", "SOL", "EURUSD", "GBPUSD", "USDJPY", "GOLD", "OIL", "SILVER"];

function result(level: AuditLevel, check: string, detail: string): AuditResult {
  return { level, check, detail };
}

function basePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    usd: 10_000,
    btc: 0,
    balances: {
      BTC: 0,
      ETH: 0,
      SOL: 0,
      EURUSD: 0,
      GBPUSD: 0,
      USDJPY: 0,
      GOLD: 0,
      OIL: 0,
      SILVER: 0,
    },
    openPositions: {},
    openPosition: null,
    scalpPositions: {},
    peakValue: 10_000,
    initialCapital: 10_000,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    consecutiveWins: 0,
    consecutiveLosses: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    returns: [],
    totalFeesPaid: 0,
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

function auditAssetSpecs(): AuditResult[] {
  const checks: AuditResult[] = [];

  for (const asset of REQUIRED_ASSETS) {
    try {
      const spec = getAssetSpec(asset);
      checks.push(result("PASS", `asset spec: ${asset}`, `${spec.assetClass}, max leverage ${spec.maxLeverage}x, max margin ${Math.round(spec.maxMarginPercent * 100)}%.`));
    } catch (error) {
      checks.push(result("FAIL", `asset spec: ${asset}`, error instanceof Error ? error.message : String(error)));
    }
  }

  const cryptoAssets = Object.values(ASSET_CONTRACT_SPECS).filter((spec) => spec.assetClass === "crypto");
  const commodityAssets = Object.values(ASSET_CONTRACT_SPECS).filter((spec) => spec.assetClass === "commodity");
  const forexAssets = Object.values(ASSET_CONTRACT_SPECS).filter((spec) => spec.assetClass === "forex");

  const cryptoOk = cryptoAssets.every((spec) => spec.maxLeverage >= 5);
  checks.push(result(cryptoOk ? "PASS" : "FAIL", "crypto fast-mode leverage capacity", cryptoOk ? "Crypto assets can simulate stronger paper trades up to 5x." : "At least one crypto asset cannot reach the intended 5x paper-trade ceiling."));

  const commodityOk = commodityAssets.every((spec) => spec.maxLeverage <= 3);
  checks.push(result(commodityOk ? "PASS" : "WARN", "commodity slower-risk treatment", commodityOk ? "Commodities remain capped below crypto leverage." : "A commodity has crypto-like leverage; verify data quality before fast treatment."));

  const forexOk = forexAssets.every((spec) => spec.maxMarginPercent <= 0.1);
  checks.push(result(forexOk ? "PASS" : "WARN", "forex slower-risk treatment", forexOk ? "Forex starts from conservative margin caps in free-data mode." : "Forex margin caps are aggressive; verify live feed quality first."));

  return checks;
}

function auditAdmissionSizing(): AuditResult[] {
  const checks: AuditResult[] = [];
  const portfolio = basePortfolio();
  const scenarios = [
    { conviction: 58, expected: "weak/watch", maxMargin: 600 },
    { conviction: 65, expected: "probe", maxMargin: 1_300 },
    { conviction: 75, expected: "normal", maxMargin: 2_100 },
    { conviction: 85, expected: "strong", maxMargin: 2_600 },
    { conviction: 92, expected: "heavy", maxMargin: 3_100 },
  ];

  for (const scenario of scenarios) {
    const admission = TradeAdmissionController.evaluate({
      portfolio,
      asset: "BTC",
      direction: "LONG",
      entryPrice: 60_000,
      stopLoss: 59_000,
      takeProfit: 62_000,
      signalScore: 14,
      reasoning: `Audit ${scenario.expected} scenario`,
      strategyType: "swing",
      finalConviction: scenario.conviction,
    });

    const margin = admission.requiredMarginUsd;
    const marginOk = admission.approved && margin <= scenario.maxMargin;
    checks.push(result(
      marginOk ? "PASS" : "FAIL",
      `conviction sizing: ${scenario.conviction}`,
      admission.approved
        ? `${scenario.expected} scenario approved with $${margin.toFixed(2)} margin, ${admission.leverage}x leverage, and $${admission.maxLossUsd.toFixed(2)} planned max loss.`
        : `${scenario.expected} scenario rejected: ${admission.reason}`
    ));
  }

  const portfolioWithExposure = basePortfolio({
    usd: 6_500,
    openPositions: {
      ETH: {
        asset: "ETH",
        entryPrice: 1_600,
        amount: 6,
        btcAmount: 6,
        usdInvested: 2_000,
        stopLoss: 1_650,
        takeProfit: 1_500,
        entryTime: new Date().toISOString(),
        signalScore: 14,
        reasoning: "Existing audit position",
        direction: "SHORT",
      },
      SOL: {
        asset: "SOL",
        entryPrice: 140,
        amount: 40,
        btcAmount: 40,
        usdInvested: 1_500,
        stopLoss: 135,
        takeProfit: 150,
        entryTime: new Date().toISOString(),
        signalScore: 14,
        reasoning: "Existing audit position",
        direction: "LONG",
      },
    },
  });

  const capped = TradeAdmissionController.evaluate({
    portfolio: portfolioWithExposure,
    asset: "BTC",
    direction: "LONG",
    entryPrice: 60_000,
    stopLoss: 59_000,
    takeProfit: 62_000,
    signalScore: 22,
    reasoning: "Audit total margin cap",
    strategyType: "swing",
    finalConviction: 92,
  });

  const totalMarginAfter = 3_500 + capped.requiredMarginUsd;
  checks.push(result(
    capped.approved && totalMarginAfter <= 5_500.01 ? "PASS" : "FAIL",
    "total margin cap",
    capped.approved
      ? `Existing $3,500 exposure allows only $${capped.requiredMarginUsd.toFixed(2)} more margin, keeping total near the 55% paper-aggressive cap.`
      : `Trade rejected with existing exposure: ${capped.reason}`
  ));

  const duplicate = TradeAdmissionController.evaluate({
    portfolio: basePortfolio({
      openPositions: {
        BTC: {
          asset: "BTC",
          entryPrice: 60_000,
          amount: 0.03,
          btcAmount: 0.03,
          usdInvested: 1_000,
          stopLoss: 59_000,
          takeProfit: 62_000,
          entryTime: new Date().toISOString(),
          signalScore: 14,
          reasoning: "Existing BTC",
          direction: "LONG",
        },
      },
    }),
    asset: "BTC",
    direction: "SHORT",
    entryPrice: 60_000,
    stopLoss: 61_000,
    takeProfit: 58_000,
    signalScore: 18,
    reasoning: "Audit duplicate asset block",
    strategyType: "swing",
    finalConviction: 85,
  });

  checks.push(result(
    !duplicate.approved ? "PASS" : "FAIL",
    "duplicate asset block",
    !duplicate.approved ? duplicate.reason : "Controller allowed a second BTC position while BTC was already open."
  ));

  return checks;
}

function auditExitSafety(): AuditResult[] {
  const checks: AuditResult[] = [];

  const longStop = RiskManager.checkStopLossOrTakeProfit({
    asset: "GOLD",
    entryPrice: 4_185,
    amount: 0.3,
    btcAmount: 0.3,
    usdInvested: 600,
    stopLoss: 4_100,
    takeProfit: 4_250,
    entryTime: new Date().toISOString(),
    signalScore: 14,
    reasoning: "Audit long stop",
    direction: "LONG",
    strategyType: "swing",
    maxLossUsd: 25,
  }, 4_050);

  checks.push(result(
    longStop.triggered && longStop.reason === "STOP_LOSS" ? "PASS" : "FAIL",
    "long stop crossing",
    longStop.triggered
      ? `Long position closes at ${longStop.exitPrice} once price crosses stop.`
      : "Long position did not close after price crossed below stop."
  ));

  const shortStop = RiskManager.checkStopLossOrTakeProfit({
    asset: "BTC",
    entryPrice: 60_000,
    amount: 0.03,
    btcAmount: 0.03,
    usdInvested: 1_000,
    stopLoss: 61_000,
    takeProfit: 58_000,
    entryTime: new Date().toISOString(),
    signalScore: 14,
    reasoning: "Audit short stop",
    direction: "SHORT",
    strategyType: "swing",
    maxLossUsd: 30,
  }, 61_500);

  checks.push(result(
    shortStop.triggered && shortStop.reason === "STOP_LOSS" ? "PASS" : "FAIL",
    "short stop crossing",
    shortStop.triggered
      ? `Short position closes at ${shortStop.exitPrice} once price crosses stop.`
      : "Short position did not close after price crossed above stop."
  ));

  const lifecyclePath = path.join(process.cwd(), "src", "lib", "execution", "swingLifecycle.ts");
  const lifecycleSource = fs.readFileSync(lifecyclePath, "utf8");
  const stopCheckIndex = lifecycleSource.indexOf("RiskManager.checkStopLossOrTakeProfit(pos, currentLivePrice)");
  const repairIndex = lifecycleSource.indexOf("repairInvalidProtectiveStop(pos, currentLivePrice)");

  checks.push(result(
    stopCheckIndex >= 0 && repairIndex >= 0 && stopCheckIndex < repairIndex ? "PASS" : "FAIL",
    "exit lifecycle stop-before-repair order",
    stopCheckIndex >= 0 && repairIndex >= 0 && stopCheckIndex < repairIndex
      ? "Swing lifecycle checks hard stop/target before repairing protective stops."
      : "Swing lifecycle may repair a crossed stop before closing it."
  ));

  return checks;
}

function syntheticCandles(startPrice: number, drift: number, count = 260): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const startTime = 1_725_000_000;

  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i / 8) * startPrice * 0.0015;
    const impulse = i % 34 === 0 ? startPrice * 0.004 * Math.sign(drift || 1) : 0;
    const open = price;
    const close = Math.max(0.0001, open * (1 + drift) + wave + impulse);
    const high = Math.max(open, close) * (1 + 0.003 + (i % 10 === 0 ? 0.004 : 0));
    const low = Math.min(open, close) * (1 - 0.003 - (i % 13 === 0 ? 0.003 : 0));
    const volume = 1000 + (i % 21 === 0 ? 900 : 0) + Math.abs(wave) * 10;

    candles.push({
      time: startTime + i * 900,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }

  return candles;
}

function auditReplayEngine(): AuditResult[] {
  const report = runReplay({
    assets: {
      BTC: syntheticCandles(60_000, 0.0012),
      ETH: syntheticCandles(3_000, -0.0009),
      SOL: syntheticCandles(150, 0.0006),
    },
    minCandles: 180,
  });

  const checks: AuditResult[] = [];
  checks.push(result(
    report.acceptance.passed ? "PASS" : "FAIL",
    "replay acceptance gates",
    report.acceptance.messages.join(" ")
  ));
  checks.push(result(
    report.totalTrades >= 0 && Object.keys(report.scoreDistribution).length >= 5 ? "PASS" : "FAIL",
    "replay metrics coverage",
    `${report.totalTrades} replay trade(s), ${report.watchedSetups} watched setup(s), ${(report.missedOpportunityRate * 100).toFixed(1)}% missed-opportunity rate.`
  ));
  checks.push(result(
    report.setupStats.length > 0 ? "PASS" : "FAIL",
    "replay setup buckets",
    `${report.setupStats.length} setup bucket(s) recorded; top setup: ${report.setupStats[0]?.setup || "none"}.`
  ));

  return checks;
}

async function fetchLiveStatus(): Promise<LiveStatus | null> {
  const statusUrl = process.env.STATUS_URL;
  if (!statusUrl) return null;

  const headers: Record<string, string> = {};
  if (process.env.STATUS_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.STATUS_AUTH_TOKEN}`;
  }

  const response = await fetch(statusUrl, { headers });
  if (!response.ok) {
    throw new Error(`Live status request failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<LiveStatus>;
}

function auditLiveStatus(status: LiveStatus | null): AuditResult[] {
  if (!status) {
    return [result("PASS", "live status snapshot optional", "Skipped by design for local-only audits. Set STATUS_URL and STATUS_AUTH_TOKEN to include the deployed dashboard API.")];
  }

  const checks: AuditResult[] = [];
  const scan = status.swingScan;
  const results = scan?.results || [];
  const activeAi = Object.keys(status.aiPortfolio?.openPositions || {});
  const activeUser = Object.keys(status.userPortfolio?.openPositions || {});
  const opportunitySweep = scan?.opportunitySweep;
  const decisionSummary = scan?.decisionSummary || {};
  const blockerSummary = scan?.blockerSummary || [];

  checks.push(result(
    scan?.scanId && scan.scanId > 0 ? "PASS" : "FAIL",
    "live scan id",
    scan?.scanId ? `Current scan id is ${scan.scanId}, completed at ${scan.completedAt || "unknown time"}.` : "No scan id found in live status."
  ));

  checks.push(result(
    results.length >= REQUIRED_ASSETS.length ? "PASS" : "WARN",
    "per-asset scan coverage",
    `${results.length} scan rows returned for ${REQUIRED_ASSETS.length} expected assets.`
  ));

  checks.push(result(
    typeof scan?.exitSweep?.signalReversals === "number" ? "PASS" : "WARN",
    "signal reversal telemetry",
    typeof scan?.exitSweep?.signalReversals === "number"
      ? `Reversal counter available: ${scan.exitSweep.signalReversals}.`
      : "Swing scan does not expose signal reversal telemetry yet."
  ));

  const decisionTotal = Object.values(decisionSummary).reduce((sum, value) => sum + Number(value || 0), 0);
  const hasIntentKeys = ["WATCH_LONG", "WATCH_SHORT", "TRIGGER_PENDING", "NO_BIAS"].every((key) => typeof decisionSummary[key] === "number");
  checks.push(result(
    hasIntentKeys && decisionTotal >= results.length ? "PASS" : "WARN",
    "decision-state visibility",
    hasIntentKeys
      ? `${decisionTotal} decision-state count(s) exposed, including watch/trigger/no-bias states.`
      : "Swing scan does not expose spectator-friendly decision-state summary yet."
  ));

  const unclearRows = results.filter((row) => row.action === "HOLD" && !row.simpleStatus);
  checks.push(result(
    unclearRows.length === 0 ? "PASS" : "WARN",
    "spectator wording coverage",
    unclearRows.length === 0 ? "All HOLD rows include plain-language status." : `${unclearRows.length} HOLD rows are missing plain-language status.`
  ));

  const rowsWithoutGateDiagnostics = results.filter((row) => row.action === "HOLD" && !row.entryGate?.primaryBlocker);
  checks.push(result(
    rowsWithoutGateDiagnostics.length === 0 ? "PASS" : "WARN",
    "entry gate diagnostics",
    rowsWithoutGateDiagnostics.length === 0
      ? "Every HOLD row explains the main entry blocker."
      : `${rowsWithoutGateDiagnostics.length} HOLD row(s) are missing main blocker diagnostics.`
  ));

  checks.push(result(
    Array.isArray(blockerSummary) ? "PASS" : "WARN",
    "entry blocker summary",
    Array.isArray(blockerSummary)
      ? `${blockerSummary.length} top blocker reason(s) exposed for scan-level dormancy explanation.`
      : "Swing scan does not expose a top-level blocker summary."
  ));

  const entryRows = results.filter((row) => row.action === "ENTRY" || row.action === "SWING_BUY" || row.action === "SWING_SHORT");
  const riskyRows = entryRows.filter((row) => Number(row.finalConviction || 0) < 60 || Number(row.dataQuality || 0) < 60);
  checks.push(result(
    riskyRows.length === 0 ? "PASS" : "FAIL",
    "entry conviction guard",
    riskyRows.length === 0 ? "No live entry row is below conviction/data-quality minimums." : `${riskyRows.length} entry row(s) violate conviction or data-quality guard.`
  ));

  checks.push(result(
    opportunitySweep ? "PASS" : "WARN",
    "opportunity learning loop",
    opportunitySweep
      ? `${opportunitySweep.pending || 0} pending opportunity observations, ${opportunitySweep.evaluated || 0} evaluated this sweep.`
      : "No opportunity sweep metadata found."
  ));

  checks.push(result(
    activeUser.includes("BTC") ? "PASS" : "WARN",
    "user BTC preservation",
    activeUser.includes("BTC") ? "User BTC manual position is still visible." : "User BTC manual position is not currently visible."
  ));

  checks.push(result(
    activeAi.length <= 3 ? "PASS" : "WARN",
    "active AI exposure count",
    `${activeAi.length} active AI position(s): ${activeAi.length ? activeAi.join(", ") : "none"}.`
  ));

  const setupPerformance = status.setupPerformance;
  const setupRows = Array.isArray(setupPerformance?.bySetup) ? setupPerformance.bySetup.length : 0;
  checks.push(result(
    setupPerformance && setupRows > 0 ? "PASS" : "WARN",
    "setup performance summary",
    setupPerformance
      ? `${setupRows} setup bucket(s), ${setupPerformance.closedTradeCount || 0} closed AI trade sample(s), ${setupPerformance.plainFindings?.length || 0} plain finding(s).`
      : "No setup performance object found in live status."
  ));

  const feedHealth = status.feedHealthMatrix;
  const feedRows = Array.isArray(feedHealth?.assets) ? feedHealth.assets.length : 0;
  const badFeeds = (feedHealth?.assets || []).filter((asset) => asset.status === "BAD");
  checks.push(result(
    feedHealth && feedRows >= REQUIRED_ASSETS.length ? "PASS" : "FAIL",
    "feed health matrix",
    feedHealth
      ? `${feedRows} feed row(s), ${feedHealth.summary?.good || 0} good, ${feedHealth.summary?.degraded || 0} degraded, ${feedHealth.summary?.bad || 0} bad.`
      : "No feed health matrix found in live status."
  ));

  checks.push(result(
    badFeeds.length === 0 ? "PASS" : "WARN",
    "bad feed protection",
    badFeeds.length === 0 ? "No feed is currently marked BAD." : `${badFeeds.map((asset) => asset.asset).join(", ")} marked BAD; autonomous entries should stay blocked for those assets.`
  ));

  return checks;
}

function printResults(results: AuditResult[]) {
  const width = Math.max(...results.map((item) => item.level.length), 4);
  for (const item of results) {
    console.log(`${item.level.padEnd(width)}  ${item.check} - ${item.detail}`);
  }

  const failed = results.filter((item) => item.level === "FAIL").length;
  const warned = results.filter((item) => item.level === "WARN").length;
  const passed = results.filter((item) => item.level === "PASS").length;

  console.log("");
  console.log(`Summary: ${passed} passed, ${warned} warning(s), ${failed} failed.`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function main() {
  const results: AuditResult[] = [
    ...auditAssetSpecs(),
    ...auditAdmissionSizing(),
    ...auditExitSafety(),
    ...auditReplayEngine(),
  ];

  try {
    const liveStatus = await fetchLiveStatus();
    results.push(...auditLiveStatus(liveStatus));
  } catch (error) {
    results.push(result("FAIL", "live status snapshot", error instanceof Error ? error.message : String(error)));
  }

  printResults(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
