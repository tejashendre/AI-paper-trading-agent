import { ASSET_CONTRACT_SPECS, getAssetSpec } from "../src/lib/trading/assetSpecs";
import { runReplay } from "../src/lib/backtest/replayEngine";
import { TradeAdmissionController } from "../src/lib/trading/tradeAdmission";
import { Candle, Portfolio } from "../src/lib/types";
import { RiskManager } from "../src/lib/riskManager";
import { classifyTradeReview } from "../src/lib/trading/tradeReviewJournal";
import { PortfolioGuards } from "../src/lib/trading/portfolioGuards";
import { calculateLearningAdjustment, LocalLearningRule } from "../src/lib/trading/localLearning";
import { SetupPerformance } from "../src/lib/trading/setupPerformance";
import { hurstExponent } from "../src/lib/statistics";
import { isEventBlackout } from "../src/lib/trading/eventCalendar";
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
  tradeReviewDigest?: {
    totalReviewed?: number;
    latestLessons?: unknown[];
    byOutcome?: Record<string, number>;
  };
  aiAssetBookDigest?: {
    activeBooks?: number;
    readyBooks?: number;
    cautionBooks?: number;
    topWatchlist?: unknown[];
    books?: unknown[];
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

function auditStatisticalRegimes(): AuditResult[] {
  const trend = Array.from({ length: 160 }, (_, index) => 100 * Math.exp(index * 0.001));
  let seed = 123456789;
  let randomWalk = 100;
  const walk = [randomWalk];
  for (let index = 1; index < 240; index++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const step = (seed / 0x100000000 - 0.5) * 0.02;
    randomWalk *= Math.exp(step);
    walk.push(randomWalk);
  }
  const trendHurst = hurstExponent(trend, 20);
  const walkHurst = hurstExponent(walk, 20);

  return [result(
    trendHurst > 0.8 && walkHurst > 0.3 && walkHurst < 0.75 ? "PASS" : "FAIL",
    "Hurst regime calibration",
    `Deterministic trend H=${trendHurst.toFixed(3)}; deterministic random walk H=${walkHurst.toFixed(3)}. Random walks must not be forced to 1.0.`
  )];
}

function auditEventCalendar(): AuditResult[] {
  const fomc = isEventBlackout("GOLD", new Date("2026-07-29T17:45:00Z"));
  const boe = isEventBlackout("GBPUSD", new Date("2026-07-30T10:45:00Z"));
  const eia = isEventBlackout("OIL", new Date("2026-07-15T14:15:00Z"));
  const normalOil = isEventBlackout("OIL", new Date("2026-07-16T14:15:00Z"));

  return [result(
    fomc.blocked && boe.blocked && eia.blocked && !normalOil.blocked ? "PASS" : "FAIL",
    "current macro release guards",
    "FOMC, BOE, and recurring Wednesday EIA release windows are protected without blocking an ordinary OIL session."
  )];
}

function auditAdmissionSizing(): AuditResult[] {
  const checks: AuditResult[] = [];
  const portfolio = basePortfolio();
  const scenarios = [
    { conviction: 58, expected: "watch", maxMargin: 300 },
    { conviction: 65, expected: "probe", maxMargin: 500 },
    { conviction: 75, expected: "normal", maxMargin: 700 },
    { conviction: 85, expected: "strong", maxMargin: 850 },
    { conviction: 92, expected: "maximum approved", maxMargin: 1_000 },
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
    const marginOk = admission.approved && margin <= scenario.maxMargin + 0.01;
    checks.push(result(
      marginOk ? "PASS" : "FAIL",
      `conviction sizing: ${scenario.conviction}`,
      admission.approved
        ? `${scenario.expected} scenario approved with $${margin.toFixed(2)} margin, ${admission.leverage}x leverage, and $${admission.maxLossUsd.toFixed(2)} planned max loss.`
        : `${scenario.expected} scenario rejected: ${admission.reason}`
    ));
  }

  const normalLearning = TradeAdmissionController.evaluate({
    portfolio,
    asset: "BTC",
    direction: "LONG",
    entryPrice: 60_000,
    stopLoss: 59_000,
    takeProfit: 62_000,
    signalScore: 18,
    reasoning: "Audit normal learning risk",
    strategyType: "swing",
    finalConviction: 85,
    learningAdjustment: 0,
  });
  const reducedLearning = TradeAdmissionController.evaluate({
    portfolio,
    asset: "BTC",
    direction: "LONG",
    entryPrice: 60_000,
    stopLoss: 59_000,
    takeProfit: 62_000,
    signalScore: 18,
    reasoning: "Audit reduced learning risk",
    strategyType: "swing",
    finalConviction: 85,
    learningAdjustment: -8,
  });

  checks.push(result(
    normalLearning.approved &&
    reducedLearning.approved &&
    reducedLearning.learningRiskMultiplier === 0.6 &&
    reducedLearning.requiredMarginUsd < normalLearning.requiredMarginUsd &&
    reducedLearning.maxLossUsd < normalLearning.maxLossUsd
      ? "PASS"
      : "FAIL",
    "local learning risk reduction",
    reducedLearning.approved
      ? `A -8 learning adjustment reduced margin from $${normalLearning.requiredMarginUsd.toFixed(2)} to $${reducedLearning.requiredMarginUsd.toFixed(2)} and planned max loss from $${normalLearning.maxLossUsd.toFixed(2)} to $${reducedLearning.maxLossUsd.toFixed(2)}.`
      : `Learning-reduced trade was rejected: ${reducedLearning.reason}`
  ));

  const slowFeedAdmission = TradeAdmissionController.evaluate({
    portfolio,
    asset: "GOLD",
    direction: "LONG",
    entryPrice: 4_000,
    stopLoss: 3_960,
    takeProfit: 4_080,
    signalScore: 20,
    reasoning: "Audit cached feed sizing",
    strategyType: "swing",
    finalConviction: 92,
    assetMode: "SLOW_SWING",
  });
  const slowFeedSeparated = slowFeedAdmission.approved && slowFeedAdmission.feedRiskMultiplier === 0.65 && slowFeedAdmission.requiredMarginUsd <= 650;
  checks.push(result(
    slowFeedSeparated ? "PASS" : "FAIL",
    "cached-feed sizing separation",
    slowFeedAdmission.approved
      ? `Cached-feed GOLD is limited to $${slowFeedAdmission.requiredMarginUsd.toFixed(2)} margin at ${Math.round(slowFeedAdmission.feedRiskMultiplier * 100)}% of normal risk.`
      : `Cached-feed GOLD was rejected: ${slowFeedAdmission.reason}`
  ));

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
      ? `Existing $3,500 exposure allows only $${capped.requiredMarginUsd.toFixed(2)} more margin, keeping total near the 40% portfolio cap.`
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

  const invalidLongTarget = TradeAdmissionController.evaluate({
    portfolio,
    asset: "BTC",
    direction: "LONG",
    entryPrice: 60_000,
    stopLoss: 59_000,
    takeProfit: 58_000,
    signalScore: 18,
    reasoning: "Audit invalid long take-profit side",
    strategyType: "swing",
    finalConviction: 85,
  });

  checks.push(result(
    !invalidLongTarget.approved ? "PASS" : "FAIL",
    "take-profit side guard",
    !invalidLongTarget.approved
      ? invalidLongTarget.reason
      : "Controller allowed a LONG trade with take-profit below entry."
  ));

  const jpyFeeGuard = TradeAdmissionController.evaluate({
    portfolio,
    asset: "USDJPY",
    direction: "LONG",
    entryPrice: 160,
    stopLoss: 159,
    takeProfit: 160.1,
    signalScore: 18,
    reasoning: "Audit JPY-denominated fee guard",
    strategyType: "swing",
    finalConviction: 85,
  });
  checks.push(result(
    !jpyFeeGuard.approved && jpyFeeGuard.reason.includes("profit") ? "PASS" : "FAIL",
    "JPY fee guard uses USD PnL",
    !jpyFeeGuard.approved ? jpyFeeGuard.reason : "USDJPY trade was admitted using an unconverted JPY price move."
  ));

  return checks;
}

function auditTargetReachability(): AuditResult[] {
  const swingEnginePath = path.join(process.cwd(), "src", "lib", "swingEngine.ts");
  const swingEngineSource = fs.readFileSync(swingEnginePath, "utf8");
  const hasReachabilityModel = swingEngineSource.includes("function evaluateTargetReachability");
  const hasCompressionTag = swingEngineSource.includes("TP_COMPRESSED_TO_RECENT_RANGE");
  const hasAdjustedTarget = swingEngineSource.includes("const takeProfit = adjustedTakeProfit");

  return [
    result(
      hasReachabilityModel && hasCompressionTag && hasAdjustedTarget ? "PASS" : "FAIL",
      "take-profit reachability model",
      hasReachabilityModel && hasCompressionTag && hasAdjustedTarget
        ? "Swing targets are checked against recent 1h movement and unrealistic targets can be compressed before admission."
        : "Swing engine does not clearly adjust unrealistic take-profit targets before admission."
    ),
  ];
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

  const feeProtectedWinner = RiskManager.checkStopLossOrTakeProfit({
    asset: "BTC",
    entryPrice: 100,
    amount: 10,
    btcAmount: 10,
    usdInvested: 1_000,
    stopLoss: 95,
    initialStopLoss: 95,
    takeProfit: 110,
    entryTime: new Date().toISOString(),
    signalScore: 20,
    reasoning: "Audit fee-aware profit protection",
    direction: "LONG",
    strategyType: "swing",
    maxLossUsd: 50,
  }, 106);
  checks.push(result(
    !feeProtectedWinner.triggered && Number(feeProtectedWinner.newStopLoss || 0) > 100.2 ? "PASS" : "FAIL",
    "fee-aware swing profit lock",
    Number(feeProtectedWinner.newStopLoss || 0) > 100.2
      ? `A profitable swing now protects a net-positive stop at ${feeProtectedWinner.newStopLoss?.toFixed(4)} instead of a nominal fee-blind breakeven.`
      : "A profitable swing did not receive a fee-aware protective stop."
  ));

  const lifecyclePath = path.join(process.cwd(), "src", "lib", "execution", "swingLifecycle.ts");
  const lifecycleSource = fs.readFileSync(lifecyclePath, "utf8");
  const stopCheckIndex = lifecycleSource.indexOf("RiskManager.checkStopLossOrTakeProfit(pos, currentLivePrice)");
  const repairIndex = lifecycleSource.indexOf("repairInvalidProtectiveStop(pos, currentLivePrice)");
  const weakLossGuardIndex = lifecycleSource.indexOf("shouldCloseWeakThesisLossCompression(asset, pos, currentLivePrice)");
  const thesisReviewIndex = lifecycleSource.indexOf("const thesisReview = await reviewLiveThesis(asset, pos, currentLivePrice)");
  const signalInvalidationIndex = lifecycleSource.indexOf('"SIGNAL_INVALIDATION", result');

  checks.push(result(
    stopCheckIndex >= 0 && repairIndex >= 0 && stopCheckIndex < repairIndex ? "PASS" : "FAIL",
    "exit lifecycle stop-before-repair order",
    stopCheckIndex >= 0 && repairIndex >= 0 && stopCheckIndex < repairIndex
      ? "Swing lifecycle checks hard stop/target before repairing protective stops."
      : "Swing lifecycle may repair a crossed stop before closing it."
  ));

  checks.push(result(
    weakLossGuardIndex > thesisReviewIndex && thesisReviewIndex >= 0 ? "PASS" : "FAIL",
    "weak-thesis loss compression",
    weakLossGuardIndex > thesisReviewIndex
      ? "Swing lifecycle can close a losing AI trade early after live thesis weakens."
      : "Weak-thesis loss compression is missing or runs before live thesis review."
  ));

  checks.push(result(
    signalInvalidationIndex > weakLossGuardIndex ? "PASS" : "FAIL",
    "loss compression exit reason",
    signalInvalidationIndex > weakLossGuardIndex
      ? "Weak-thesis loss compression records SIGNAL_INVALIDATION instead of disguising the exit as a hard stop."
      : "Weak-thesis loss compression does not record an explicit signal invalidation exit reason."
  ));

  return checks;
}

function auditLearningConnections(): AuditResult[] {
  const checks: AuditResult[] = [];
  const localLearningPath = path.join(process.cwd(), "src", "lib", "trading", "localLearning.ts");
  const localLearningSource = fs.readFileSync(localLearningPath, "utf8");

  checks.push(result(
    localLearningSource.includes("TradeReviewJournal.getAssetSignals") ? "PASS" : "FAIL",
    "trade review feeds local learning",
    localLearningSource.includes("TradeReviewJournal.getAssetSignals")
      ? "Closed-trade review memory can create mild asset-level learning rules."
      : "Trade review memory is visible but not connected to local learning rules."
  ));

  checks.push(result(
    localLearningSource.includes("review:asset:") ? "PASS" : "FAIL",
    "review rule identity",
    localLearningSource.includes("review:asset:")
      ? "Trade-review rules use a distinct id namespace from opportunity/setup rules."
      : "Trade-review rules may collide with existing learning rule ids."
  ));

  const syntheticTrade = (index: number, pnl: number) => ({
    id: `oos-${index}`,
    timestamp: new Date(1_725_000_000_000 + index * 60_000).toISOString(),
    exitTime: new Date(1_725_000_000_000 + index * 60_000).toISOString(),
    asset: "BTC",
    pnl,
    setupTags: ["VWAP_REJECTION"],
  } as any);
  const unproven = SetupPerformance.build(Array.from({ length: 7 }, (_, index) => syntheticTrade(index, 10)), {});
  const proven = SetupPerformance.build(Array.from({ length: 30 }, (_, index) => syntheticTrade(index, 10)), {});
  const unprovenSetup = unproven.bySetup.find((bucket) => bucket.key === "VWAP_REJECTION");
  const provenSetup = proven.bySetup.find((bucket) => bucket.key === "VWAP_REJECTION");
  const holdoutPromotionWorks = !unprovenSetup?.promotionEligible && provenSetup?.promotionEligible === true && (provenSetup.outOfSampleTradeCount || 0) >= 8;
  checks.push(result(
    holdoutPromotionWorks ? "PASS" : "FAIL",
    "out-of-sample setup promotion",
    provenSetup?.promotionEligible
      ? `A setup earns a boost only after ${provenSetup.outOfSampleTradeCount} later closed trades validate it; a seven-trade sample remains unpromoted.`
      : "Chronological holdout evidence did not control setup promotion."
  ));

  return checks;
}

function auditProductionRegressions(): AuditResult[] {
  const read = (...segments: string[]) => fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");
  const portfolioSource = read("src", "lib", "portfolio.ts");
  const redisSource = read("src", "lib", "redis.ts");
  const learningSource = read("src", "lib", "trading", "localLearning.ts");
  const opportunitySource = read("src", "lib", "trading", "opportunityJournal.ts");
  const feedSource = read("src", "lib", "data", "feedHealthSummary.ts");
  const daemonSource = read("src", "daemon", "swingDaemon.ts");
  const websocketSource = read("src", "daemon", "websocketDataMesh.ts");
  const tradeSource = read("src", "app", "api", "trade", "route.ts");
  const swingTradeSource = read("src", "app", "api", "trade", "swing", "route.ts");
  const manualSource = read("src", "app", "api", "trade", "manual", "route.ts");
  const backtestSource = read("src", "app", "api", "backtest", "route.ts");
  const chartSource = read("src", "app", "api", "chart", "route.ts");
  const composeSource = read("docker-compose.yml");
  const deployCheckSource = read("scripts", "vps-deploy-check.sh");

  const lockSafe = redisSource.includes("compareAndDelete") && portfolioSource.includes("redis.compareAndDelete(key, token)");
  const learningVersioned = learningSource.includes('learning:v2:localRules');
  const opportunityVersioned = opportunitySource.includes('opportunity:v2:') && opportunitySource.includes("DEDUPE_SECONDS");
  const feedEnforced = feedSource.includes("KRAKEN_SPOT_WS") &&
    feedSource.includes("BYBIT_LINEAR_WS") &&
    websocketSource.includes('channel: "trade"') &&
    websocketSource.includes("publicTrade.") &&
    [daemonSource, tradeSource, swingTradeSource].every((source) => source.includes("safeForSwingExecution"));
  const publicBounds = [backtestSource, chartSource].every((source) => source.includes("parsedLimit > 1_000"));
  const manualFeeSafe = manualSource.includes("Number.isFinite(usdAmount)") &&
    manualSource.includes("const netPnl = pnl - entryFee - exitFee");
  const daemonHealth = composeSource.includes("quant-swing-daemon") && composeSource.includes("swing:lastScan:ai");
  const deploymentWaitsForHealth = deployCheckSource.includes('-ge 36') && deployCheckSource.includes('sleep 5');
  const recoverySafe = portfolioSource.includes("function isValidPortfolio") &&
    portfolioSource.includes("fs.renameSync(temporaryPath, filePath)") &&
    portfolioSource.includes("if (Array.isArray(backup))");

  return [
    result(lockSafe ? "PASS" : "FAIL", "atomic portfolio lock release", lockSafe
      ? "Redis releases a write lock only when the caller still owns its token."
      : "Portfolio lock release can delete a replacement lock after TTL expiry."),
    result(learningVersioned && opportunityVersioned ? "PASS" : "FAIL", "derived-learning state migration", learningVersioned && opportunityVersioned
      ? "Polluted learning/opportunity aggregates use versioned keys and observations are deduplicated."
      : "Derived learning state may reuse polluted production aggregates."),
    result(feedEnforced ? "PASS" : "FAIL", "dual WebSocket admission gate", feedEnforced
      ? "Both exchange freshness signals feed the daemon and API entry gates."
      : "Autonomous entry can proceed without verified realtime feed health."),
    result(publicBounds ? "PASS" : "FAIL", "public historical request bounds", publicBounds
      ? "Spectator chart and backtest requests are capped at 1,000 candles."
      : "A public historical endpoint still accepts unbounded work."),
    result(manualFeeSafe ? "PASS" : "FAIL", "manual trade finite and fee accounting", manualFeeSafe
      ? "Manual entries reject non-finite sizes and closes deduct both fee legs."
      : "Manual paper trades can corrupt balances or overstate PnL."),
    result(daemonHealth ? "PASS" : "FAIL", "daemon scan healthcheck", daemonHealth
      ? "Compose marks the daemon unhealthy when its scan snapshot disappears."
      : "Container liveness does not prove the strategy loop is advancing."),
    result(deploymentWaitsForHealth ? "PASS" : "FAIL", "deployment health readiness", deploymentWaitsForHealth
      ? "Deployment verification waits for container health instead of failing during startup."
      : "Deployment verification can fail while healthy containers are still starting."),
    result(recoverySafe ? "PASS" : "FAIL", "validated atomic recovery backups", recoverySafe
      ? "Portfolio backups are structurally validated and replaced atomically."
      : "Crash recovery can accept malformed state or expose partially written JSON."),
  ];
}

function auditPortfolioLearningGuards(): AuditResult[] {
  const checks: AuditResult[] = [];
  const severeAssetRule: LocalLearningRule = {
    id: "asset:BTC",
    scope: "asset",
    key: "BTC",
    action: "REDUCE",
    confidenceAdjustment: -12,
    message: "Audit negative-expectancy asset rule.",
    sampleSize: 40,
    favorableRate: 0.3,
    avgMove: -8,
    updatedAt: new Date().toISOString(),
  };

  const ordinaryCandidate = PortfolioGuards.evaluateNewSwing({
    portfolio: basePortfolio(),
    asset: "BTC",
    direction: "LONG",
    dataQuality: 90,
    finalConviction: 84,
    setupTags: ["VWAP_RECLAIM"],
    learningRules: [severeAssetRule],
  });
  checks.push(result(
    !ordinaryCandidate.approved ? "PASS" : "FAIL",
    "severe losing-asset admission gate",
    !ordinaryCandidate.approved
      ? "A materially losing asset cannot re-enter on ordinary conviction."
      : "A materially losing asset was allowed to re-enter without exceptional evidence."
  ));

  const exceptionalCandidate = PortfolioGuards.evaluateNewSwing({
    portfolio: basePortfolio(),
    asset: "BTC",
    direction: "LONG",
    dataQuality: 90,
    finalConviction: 92,
    setupTags: ["VWAP_RECLAIM"],
    learningRules: [severeAssetRule],
  });
  checks.push(result(
    exceptionalCandidate.approved && exceptionalCandidate.recoveryProbe ? "PASS" : "FAIL",
    "losing-asset recovery probe",
    exceptionalCandidate.approved && exceptionalCandidate.recoveryProbe
      ? "Exceptional evidence permits only a controlled recovery probe, preserving a path to relearn without full-size risk."
      : "The guard did not preserve the intended controlled recovery path."
  ));

  const conflictingSetupRule: LocalLearningRule = {
    ...severeAssetRule,
    id: "setup:VWAP_RECLAIM",
    scope: "setup",
    key: "VWAP_RECLAIM",
  };
  const doubleNegativeCandidate = PortfolioGuards.evaluateNewSwing({
    portfolio: basePortfolio(),
    asset: "BTC",
    direction: "LONG",
    dataQuality: 95,
    finalConviction: 95,
    setupTags: ["VWAP_RECLAIM"],
    learningRules: [severeAssetRule, conflictingSetupRule],
  });
  checks.push(result(
    !doubleNegativeCandidate.approved ? "PASS" : "FAIL",
    "asset-plus-setup negative expectancy gate",
    !doubleNegativeCandidate.approved
      ? "A setup is blocked when both its asset and setup history have severe negative expectancy."
      : "A doubly underperforming asset/setup combination was incorrectly allowed."
  ));

  return checks;
}

function auditLearningAggregation(): AuditResult[] {
  const now = new Date().toISOString();
  const rules: LocalLearningRule[] = [
    { id: "asset:SILVER", scope: "asset", key: "SILVER", action: "BOOST", confidenceAdjustment: 1, message: "Profitable lifetime sample", sampleSize: 16, favorableRate: 0.67, avgMove: 6.2, updatedAt: now },
    { id: "review:asset:SILVER", scope: "asset", key: "SILVER", action: "REDUCE", confidenceAdjustment: -5, message: "Weak recent exits", sampleSize: 8, favorableRate: 0.5, avgMove: -1, updatedAt: now },
    { id: "setup:VWAP_RECLAIM", scope: "setup", key: "VWAP_RECLAIM", action: "REDUCE", confidenceAdjustment: -8, message: "Weak setup", sampleSize: 20, favorableRate: 0.3, avgMove: -0.2, updatedAt: now },
    { id: "setup:VOLUME_BURST", scope: "setup", key: "VOLUME_BURST", action: "REDUCE", confidenceAdjustment: -8, message: "Weak setup", sampleSize: 20, favorableRate: 0.3, avgMove: -0.2, updatedAt: now },
    { id: "setup:VOLATILITY_EXPANSION", scope: "setup", key: "VOLATILITY_EXPANSION", action: "REDUCE", confidenceAdjustment: -8, message: "Weak setup", sampleSize: 20, favorableRate: 0.3, avgMove: -0.2, updatedAt: now },
  ];
  const silver = calculateLearningAdjustment(rules, "SILVER", ["VWAP_RECLAIM", "VOLUME_BURST", "VOLATILITY_EXPANSION"]);
  const severeAsset: LocalLearningRule = {
    id: "asset:USDJPY", scope: "asset", key: "USDJPY", action: "REDUCE", confidenceAdjustment: -12,
    message: "Severe loss sample", sampleSize: 20, favorableRate: 0.125, avgMove: -20, updatedAt: now,
  };
  const usdJpy = calculateLearningAdjustment([severeAsset], "USDJPY", []);
  const normalizedSetup = calculateLearningAdjustment([{
    id: "setup:HTF_TREND_BREAKOUT", scope: "setup", key: "HTF_TREND_BREAKOUT", action: "REDUCE",
    confidenceAdjustment: -8, message: "Weak trend setup", sampleSize: 20, favorableRate: 0.3, avgMove: -1, updatedAt: now,
  }], "OIL", ["4H Structural Uptrend (Hurst: 0.71)"]);

  return [
    result(
      silver.adjustment === -9 && !silver.watchOnly ? "PASS" : "FAIL",
      "correlated learning evidence",
      silver.adjustment === -9 && !silver.watchOnly
        ? "Overlapping asset reviews and three setup tags are bounded instead of being counted as five independent failures."
        : `Expected bounded SILVER adjustment -9 without watch-only; got ${silver.adjustment}, watch-only=${silver.watchOnly}.`
    ),
    result(
      usdJpy.adjustment === -12 && usdJpy.watchOnly ? "PASS" : "FAIL",
      "severe asset learning restriction",
      usdJpy.adjustment === -12 && usdJpy.watchOnly
        ? "Genuinely severe asset-level loss evidence still enters watch-only mode."
        : "Severe asset evidence was weakened by the aggregation fix."
    ),
    result(
      normalizedSetup.adjustment === -5 ? "PASS" : "FAIL",
      "live setup normalization",
      normalizedSetup.adjustment === -5
        ? "Descriptive live structure tags match their stable historical setup category with bounded influence."
        : `Expected normalized setup adjustment -5; got ${normalizedSetup.adjustment}.`
    ),
  ];
}

function auditTradeReviewMemory(): AuditResult[] {
  const checks: AuditResult[] = [];

  const protectedWin = classifyTradeReview({
    pnl: 65,
    peakOpenPnl: 90,
    plannedRiskUsd: 45,
    exitReason: "TRAILING_STOP_PROFIT",
    thesisStatus: "VALID",
  });

  checks.push(result(
    protectedWin.outcome === "PROFIT_PROTECTED" && protectedWin.nextAction === "KEEP_NORMAL" ? "PASS" : "FAIL",
    "trade review protected winner",
    protectedWin.outcome === "PROFIT_PROTECTED"
      ? "A trailed green close is classified as protected profit, not as a failed trade."
      : `Expected PROFIT_PROTECTED, got ${protectedWin.outcome}.`
  ));

  const riskBreach = classifyTradeReview({
    pnl: -70,
    peakOpenPnl: 0,
    plannedRiskUsd: 50,
    exitReason: "STOP_LOSS",
    thesisStatus: "WEAKENING",
  });

  checks.push(result(
    riskBreach.outcome === "RISK_BREACH" && riskBreach.nextAction === "WATCH_ONLY" ? "PASS" : "FAIL",
    "trade review risk breach",
    riskBreach.outcome === "RISK_BREACH"
      ? "An oversized loss becomes watch-only evidence for future sizing."
      : `Expected RISK_BREACH, got ${riskBreach.outcome}.`
  ));

  const thesisFailure = classifyTradeReview({
    pnl: -12,
    peakOpenPnl: 20,
    plannedRiskUsd: 50,
    exitReason: "SIGNAL_REVERSAL",
    thesisStatus: "OPPOSITE_EDGE_CONFIRMED",
  });

  checks.push(result(
    thesisFailure.outcome === "THESIS_FAILED" ? "PASS" : "FAIL",
    "trade review thesis failure",
    thesisFailure.outcome === "THESIS_FAILED"
      ? "Signal reversals are stored as thesis failures for explainability."
      : `Expected THESIS_FAILED, got ${thesisFailure.outcome}.`
  ));

  const compressedLoss = classifyTradeReview({
    pnl: -18,
    peakOpenPnl: 0,
    plannedRiskUsd: 50,
    exitReason: "SIGNAL_INVALIDATION",
    thesisStatus: "WEAKENING",
  });

  checks.push(result(
    compressedLoss.outcome === "THESIS_FAILED" && compressedLoss.nextAction === "REDUCE_SIZE" ? "PASS" : "FAIL",
    "trade review compressed loss",
    compressedLoss.outcome === "THESIS_FAILED"
      ? "Signal invalidation losses are recorded as thesis failures for future learning."
      : `Expected THESIS_FAILED, got ${compressedLoss.outcome}.`
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
    // Periodic directional impulses also carry volume so the replay fixture
    // exercises the same breakout/rejection confirmation required in live use.
    const volume = 1000 + (i % 21 === 0 ? 900 : 0) + (i % 34 === 0 ? 1800 : 0) + Math.abs(wave) * 10;

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
    report.totalTrades > 0 && Object.keys(report.scoreDistribution).length >= 5 ? "PASS" : "WARN",
    "replay metrics coverage",
    report.totalTrades > 0
      ? `${report.totalTrades} replay trade(s), ${report.watchedSetups} watched setup(s), ${(report.missedOpportunityRate * 100).toFixed(1)}% missed-opportunity rate.`
      : `${report.watchedSetups} watched setup(s), ${(report.missedOpportunityRate * 100).toFixed(1)}% missed-opportunity rate. A zero-trade replay cannot validate profitability or execution behavior.`
  ));
  const feeMathValid = report.trades.every((trade) => (
    Math.abs(trade.pnlUsd - (trade.grossPnlUsd - trade.entryFeeUsd - trade.exitFeeUsd)) < 0.000001
  ));
  const netTradePnl = report.trades.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const capitalMathValid = Math.abs(report.totalReturnUsd - netTradePnl) < 0.000001;
  checks.push(result(
    feeMathValid && capitalMathValid && report.totalTrades > 0 ? "PASS" : "FAIL",
    "replay net fee accounting",
    feeMathValid && capitalMathValid && report.totalTrades > 0
      ? "Every replay trade and final capital include both entry and exit fees exactly once."
      : "Replay fee deductions or final-capital reconciliation are inconsistent."
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
    activeUser.includes("BTC") || activeUser.length === 0 ? "PASS" : "WARN",
    "user BTC preservation",
    activeUser.includes("BTC")
      ? "User BTC manual position is still visible."
      : activeUser.length === 0
        ? "No user position is currently open, so there is no manual BTC position to preserve."
        : "User positions exist, but the historical BTC manual position is not currently visible."
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
    status.tradeReviewDigest ? "PASS" : "WARN",
    "trade review digest",
    status.tradeReviewDigest
      ? `${status.tradeReviewDigest.totalReviewed || 0} AI swing close review(s), ${status.tradeReviewDigest.latestLessons?.length || 0} latest lesson(s) exposed.`
      : "No trade review digest found in live status."
  ));

  const assetBooks = status.aiAssetBookDigest;
  const assetBookRows = Array.isArray(assetBooks?.books) ? assetBooks.books.length : 0;
  checks.push(result(
    assetBooks && assetBookRows >= REQUIRED_ASSETS.length ? "PASS" : "WARN",
    "asset-book visibility",
    assetBooks
      ? `${assetBookRows} asset book row(s), ${assetBooks.activeBooks || 0} active, ${assetBooks.readyBooks || 0} ready/close, ${assetBooks.cautionBooks || 0} needing care.`
      : "No asset-book digest found in live status."
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
    ...auditStatisticalRegimes(),
    ...auditEventCalendar(),
    ...auditAdmissionSizing(),
    ...auditTargetReachability(),
    ...auditExitSafety(),
    ...auditLearningConnections(),
    ...auditProductionRegressions(),
    ...auditPortfolioLearningGuards(),
    ...auditLearningAggregation(),
    ...auditTradeReviewMemory(),
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
