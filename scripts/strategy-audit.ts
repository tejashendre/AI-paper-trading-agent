import { ASSET_CONTRACT_SPECS, getAssetSpec } from "../src/lib/trading/assetSpecs";
import { TradeAdmissionController } from "../src/lib/trading/tradeAdmission";
import { Portfolio } from "../src/lib/types";

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
    { conviction: 65, expected: "probe", maxMargin: 1_100 },
    { conviction: 75, expected: "normal", maxMargin: 1_600 },
    { conviction: 85, expected: "strong", maxMargin: 2_100 },
    { conviction: 92, expected: "heavy", maxMargin: 2_600 },
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
    capped.approved && totalMarginAfter <= 4_000.01 ? "PASS" : "FAIL",
    "total margin cap",
    capped.approved
      ? `Existing $3,500 exposure allows only $${capped.requiredMarginUsd.toFixed(2)} more margin, keeping total near the 40% cap.`
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
    return [result("WARN", "live status snapshot", "Skipped. Set STATUS_URL and STATUS_AUTH_TOKEN to audit the deployed dashboard API.")];
  }

  const checks: AuditResult[] = [];
  const scan = status.swingScan;
  const results = scan?.results || [];
  const activeAi = Object.keys(status.aiPortfolio?.openPositions || {});
  const activeUser = Object.keys(status.userPortfolio?.openPositions || {});
  const opportunitySweep = scan?.opportunitySweep;

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

  const unclearRows = results.filter((row) => row.action === "HOLD" && !row.simpleStatus);
  checks.push(result(
    unclearRows.length === 0 ? "PASS" : "WARN",
    "spectator wording coverage",
    unclearRows.length === 0 ? "All HOLD rows include plain-language status." : `${unclearRows.length} HOLD rows are missing plain-language status.`
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
