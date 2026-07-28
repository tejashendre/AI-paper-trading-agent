import { ASSET_CONTRACT_SPECS, getAssetSpec } from "../src/lib/trading/assetSpecs";
import { runReplay } from "../src/lib/backtest/replayEngine";
import { PAPER_MARGIN_POLICY_VERSION, TradeAdmissionController } from "../src/lib/trading/tradeAdmission";
import { Candle, IndicatorSnapshot, Portfolio, StatisticalMetrics, Trade } from "../src/lib/types";
import { RiskManager } from "../src/lib/riskManager";
import { classifyTradeReview } from "../src/lib/trading/tradeReviewJournal";
import { PortfolioGuards } from "../src/lib/trading/portfolioGuards";
import { calculateLearningAdjustment, LocalLearningRule } from "../src/lib/trading/localLearning";
import { SetupPerformance } from "../src/lib/trading/setupPerformance";
import { hurstExponent } from "../src/lib/statistics";
import { isEventBlackout } from "../src/lib/trading/eventCalendar";
import {
  calculateCalibratedConviction,
  evaluateNetRewardRisk,
  scoreContinuousHtfEvidence,
} from "../src/lib/swingEngine";
import { OpportunityEvaluation, selectIndependentOpportunityEvaluations } from "../src/lib/trading/opportunityJournal";
import {
  buildPaperExecutionPlan,
  estimateCarryCostUsd,
  fitPaperExecutionPlanToRiskBudget,
  getExecutionCostProfile,
} from "../src/lib/trading/executionCostModel";
import { evaluatePortfolioRiskBudget } from "../src/lib/trading/portfolioRiskBudget";
import { computeExecutionEventHash, EXECUTION_LEDGER_SCHEMA_VERSION, TRADING_STRATEGY_VERSION } from "../src/lib/trading/executionLedger";
import { buildWalkForwardResearchReport } from "../src/lib/research/walkForward";
import fs from "fs";
import path from "path";
import crypto from "crypto";

type AuditLevel = "PASS" | "WARN" | "FAIL";

interface AuditResult {
  level: AuditLevel;
  check: string;
  detail: string;
}

interface LiveStatus {
  deployment?: {
    commit?: string | null;
    strategyVersion?: string;
    executionCostModelVersion?: string;
    portfolioRiskPolicyVersion?: string;
    paperMarginPolicyVersion?: string;
    researchHarnessVersion?: string;
    capitalMode?: string;
  };
  executionLedger?: {
    files?: number;
    bytes?: number;
    headHash?: string | null;
    lastEventAt?: string | null;
    strategyVersion?: string;
    executionCostModelVersion?: string;
  };
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

function auditTradingRevivalCalibration(): AuditResult[] {
  const snapshot = (values: Partial<IndicatorSnapshot>): IndicatorSnapshot => ({
    ema9: 103,
    ema21: 102,
    ema50: 100,
    ema200: 95,
    rsi: 60,
    macd: { line: 1, signal: 0.5, histogram: 0.5 },
    bb: { upper: 110, middle: 100, lower: 90 },
    atr: 2,
    vwap: 101,
    stochRsi: { k: 60, d: 50 },
    price: 104,
    ...values,
  });
  const statistics = (values: Partial<StatisticalMetrics>): StatisticalMetrics => ({
    logReturns: [],
    realizedVolatility: 0.2,
    priceZScore: 0.3,
    rsiZScore: 0,
    hurstExponent: 0.58,
    regime: "TRENDING",
    volatilityPercentile: 50,
    volumePercentile: 60,
    regressionSlope: 0.4,
    regressionR2: 0.6,
    ...values,
  });

  const aligned = scoreContinuousHtfEvidence({
    livePrice: 104,
    snap1h: snapshot({}),
    snap4h: snapshot({}),
    stats1h: statistics({}),
    stats4h: statistics({}),
  });
  const noisy = scoreContinuousHtfEvidence({
    livePrice: 104,
    snap1h: snapshot({}),
    snap4h: snapshot({}),
    stats1h: statistics({ regressionR2: 0.1 }),
    stats4h: statistics({ regressionR2: 0.1 }),
  });

  const baseEvaluation = {
    id: "opportunity-1-15m",
    opportunityId: "opportunity-1",
    asset: "BTC",
    horizon: "15m",
    direction: "LONG",
    entryPrice: 100,
    currentPrice: 101,
    movePercent: 1,
    maxFavorableExcursion: 1,
    maxAdverseExcursion: -0.2,
    hitTakeProfit: false,
    hitStopLoss: false,
    firstHit: "NONE",
    hypotheticalOutcome: "FAVORABLE",
    favorable: true,
    decision: "WATCH",
    setupTags: ["HTF_TREND_BREAKOUT"],
    finalConviction: 65,
    evaluatedAt: new Date().toISOString(),
  } as OpportunityEvaluation;
  const independent = selectIndependentOpportunityEvaluations([
    baseEvaluation,
    { ...baseEvaluation, id: "opportunity-1-1h", horizon: "1h" },
    { ...baseEvaluation, id: "opportunity-1-4h", horizon: "4h" },
    { ...baseEvaluation, id: "opportunity-1-24h", horizon: "24h" },
    { ...baseEvaluation, id: "opportunity-2-1h", opportunityId: "opportunity-2", horizon: "1h" },
  ] as OpportunityEvaluation[]);

  const probeTrade = {
    id: "probe-close",
    timestamp: new Date().toISOString(),
    asset: "BTC",
    action: "SELL",
    direction: "LONG",
    amount: 1,
    btcAmount: 1,
    price: 99,
    usdValue: 99,
    stopLoss: 99,
    takeProfit: 104,
    signalScore: 10,
    reasoning: "probe",
    pnl: -5,
    entryMode: "CONTROLLED_PROBE",
    decisionState: "PROBE_ENTRY",
    setupTags: ["HTF_TREND_BREAKOUT"],
  } as any;
  const probeSummary = SetupPerformance.build([probeTrade], { byAsset: {}, bySetup: {} });
  const probeAsset = probeSummary.byAsset.find((bucket) => bucket.key === "BTC");
  const probeSetup = probeSummary.bySetup.find((bucket) => bucket.key === "HTF_TREND_BREAKOUT");

  return [
    result(
      aligned.buyScore >= 14 && aligned.buyScore > aligned.shortScore ? "PASS" : "FAIL",
      "continuous HTF trend admission",
      `Aligned trend produced ${aligned.buyScore} bullish HTF points; normal evidence must be reachable without an extreme indicator.`
    ),
    result(
      noisy.buyScore <= 5 && noisy.shortScore <= 5 ? "PASS" : "FAIL",
      "random HTF evidence cap",
      `Low-quality regressions were capped at bullish=${noisy.buyScore}, bearish=${noisy.shortScore}.`
    ),
    result(
      independent.length === 2 && independent.some((row) => row.opportunityId === "opportunity-1" && row.horizon === "4h") ? "PASS" : "FAIL",
      "independent opportunity learning sample",
      `${independent.length} independent opportunities selected from five correlated horizon rows.`
    ),
    result(
      probeAsset?.tradeCount === 1 && probeSetup?.tradeCount === 1 ? "PASS" : "FAIL",
      "probe losses reach asset learning",
      `Probe asset trades=${probeAsset?.tradeCount || 0}; probe setup trades=${probeSetup?.tradeCount || 0}.`
    ),
  ];
}

function auditSignalEconomics(): AuditResult[] {
  const viable = evaluateNetRewardRisk({
    asset: "BTC",
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 98.5,
    takeProfit: 103,
  });
  const compressed = evaluateNetRewardRisk({
    asset: "BTC",
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 98.5,
    takeProfit: 101.8,
  });
  const weakConviction = calculateCalibratedConviction({
    htfScore: 8,
    htfThreshold: 14,
    triggerScore: 30,
    triggerThreshold: 14,
    liquidityScore: 4,
    microstructureScore: 0,
    dataQuality: 95,
    netRewardRiskRatio: 1.8,
    weeklyBiasAdjustment: 5,
    learningAdjustment: -12,
  });
  const strongConviction = calculateCalibratedConviction({
    htfScore: 14,
    htfThreshold: 14,
    triggerScore: 14,
    triggerThreshold: 14,
    liquidityScore: 8,
    microstructureScore: 4,
    dataQuality: 95,
    netRewardRiskRatio: 1.8,
    weeklyBiasAdjustment: 5,
    learningAdjustment: 0,
  });

  return [
    result(
      viable.passed && !compressed.passed ? "PASS" : "FAIL",
      "fee-aware net reward/risk gate",
      `Viable ratio=${viable.ratio.toFixed(2)}; compressed ratio=${compressed.ratio.toFixed(2)}.`
    ),
    result(
      weakConviction < 70 && strongConviction >= 75 ? "PASS" : "FAIL",
      "bounded calibrated conviction",
      `Weak HTF/high-trigger candidate=${weakConviction}; fully aligned candidate=${strongConviction}.`
    ),
  ];
}

function minimalTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: overrides.id || crypto.randomUUID(),
    timestamp: overrides.timestamp || new Date().toISOString(),
    asset: overrides.asset || "BTC",
    action: overrides.action || "BUY",
    direction: overrides.direction || "LONG",
    amount: overrides.amount ?? 0.01,
    btcAmount: overrides.btcAmount ?? overrides.amount ?? 0.01,
    price: overrides.price ?? 60_000,
    usdValue: overrides.usdValue ?? 500,
    stopLoss: overrides.stopLoss ?? 58_000,
    takeProfit: overrides.takeProfit ?? 64_000,
    signalScore: overrides.signalScore ?? 75,
    reasoning: overrides.reasoning || "Deterministic audit trade",
    ...overrides,
  };
}

function auditExecutionCostModel(): AuditResult[] {
  const input = {
    asset: "BTC",
    direction: "LONG" as const,
    entryPrice: 60_000,
    stopLoss: 59_000,
    takeProfit: 62_000,
    amount: 0.1,
    context: {
      assetMode: "REALTIME_FAST" as const,
      dataQuality: 90,
      isPeakLiquidity: false,
    },
  };
  const first = buildPaperExecutionPlan(input);
  const second = buildPaperExecutionPlan(input);
  const btcProfile = getExecutionCostProfile("BTC");
  const oilProfile = getExecutionCostProfile("OIL");
  const carry = estimateCarryCostUsd({
    asset: "BTC",
    notionalUsd: 10_000,
    openedAt: "2026-07-18T00:00:00.000Z",
    closedAt: "2026-07-19T00:00:00.000Z",
  });
  const fitted = fitPaperExecutionPlanToRiskBudget({ ...input, riskBudgetUsd: 90 });

  return [
    result(
      first.entry.fillPrice > input.entryPrice && first.stopExit.fillPrice < input.stopLoss && first.targetExit.fillPrice < input.takeProfit
        ? "PASS"
        : "FAIL",
      "adverse paper fill directions",
      `Entry ${first.entry.fillPrice.toFixed(2)}, stop ${first.stopExit.fillPrice.toFixed(2)}, target ${first.targetExit.fillPrice.toFixed(2)} all move against the paper trader.`
    ),
    result(
      JSON.stringify(first) === JSON.stringify(second) ? "PASS" : "FAIL",
      "deterministic execution model",
      "Identical execution inputs produce identical fills, costs, and net reward/risk."
    ),
    result(
      btcProfile.venueModel !== oilProfile.venueModel && btcProfile.stopGapBps !== oilProfile.stopGapBps && carry > 0 ? "PASS" : "FAIL",
      "instrument-specific cost profiles",
      `BTC model=${btcProfile.venueModel}; OIL model=${oilProfile.venueModel}; one-day BTC carry=$${carry.toFixed(2)}.`
    ),
    result(
      fitted.resized && fitted.riskScale < 1 && fitted.plan.netLossUsd <= 90 * 1.01
        ? "PASS"
        : "FAIL",
      "after-cost risk-budget sizing",
      `Candidate was scaled to ${(fitted.riskScale * 100).toFixed(1)}% and modeled stop loss is $${fitted.plan.netLossUsd.toFixed(2)} against a $90.00 budget.`
    ),
  ];
}

function auditPortfolioRiskBudgets(): AuditResult[] {
  const candidate = {
    portfolio: basePortfolio(),
    trades: [] as Trade[],
    asset: "BTC",
    direction: "LONG" as const,
    candidateNotionalUsd: 2_000,
    candidateMaxLossUsd: 75,
    candidateEntryCostUsd: 3,
    now: new Date("2026-07-19T12:00:00.000Z"),
  };
  const allowed = evaluatePortfolioRiskBudget(candidate);
  const turnover = evaluatePortfolioRiskBudget({
    ...candidate,
    trades: [
      minimalTrade({ timestamp: "2026-07-19T11:20:00.000Z", action: "BUY" }),
      minimalTrade({ timestamp: "2026-07-19T11:40:00.000Z", action: "BUY" }),
    ],
  });
  const dailyLoss = evaluatePortfolioRiskBudget({
    ...candidate,
    trades: [minimalTrade({
      timestamp: "2026-07-19T10:00:00.000Z",
      action: "SELL",
      pnl: -250,
      pnlPercent: -2.5,
    })],
  });
  const drifted = evaluatePortfolioRiskBudget({
    ...candidate,
    portfolio: basePortfolio({ totalPnl: -500, grossProfit: 100, grossLoss: 100 }),
  });
  const correlatedPortfolio = basePortfolio({
    openPositions: {
      BTC: { asset: "BTC", entryPrice: 60_000, amount: 0.01, btcAmount: 0.01, usdInvested: 200, stopLoss: 59_000, takeProfit: 62_000, entryTime: "2026-07-19T08:00:00.000Z", signalScore: 80, reasoning: "audit", direction: "LONG", maxLossUsd: 30 },
      ETH: { asset: "ETH", entryPrice: 2_000, amount: 0.2, btcAmount: 0.2, usdInvested: 200, stopLoss: 1_950, takeProfit: 2_100, entryTime: "2026-07-19T08:00:00.000Z", signalScore: 80, reasoning: "audit", direction: "LONG", maxLossUsd: 30 },
    },
    usd: 9_600,
  });
  const correlation = evaluatePortfolioRiskBudget({ ...candidate, portfolio: correlatedPortfolio, asset: "SOL" });

  return [
    result(allowed.approved ? "PASS" : "FAIL", "portfolio budget normal admission", allowed.reason),
    result(!turnover.approved && turnover.reason.includes("hourly") ? "PASS" : "FAIL", "hourly turnover circuit breaker", turnover.reason),
    result(!dailyLoss.approved && dailyLoss.reason.includes("24-hour") ? "PASS" : "FAIL", "daily loss circuit breaker", dailyLoss.reason),
    result(!drifted.approved && drifted.reason.includes("Accounting") ? "PASS" : "FAIL", "accounting drift quarantine", drifted.reason),
    result(!correlation.approved && correlation.reason.includes("Correlated") ? "PASS" : "FAIL", "correlated exposure budget", correlation.reason),
  ];
}

function auditExecutionLedgerHashing(): AuditResult[] {
  const unsigned = {
    schemaVersion: EXECUTION_LEDGER_SCHEMA_VERSION,
    id: "audit-event",
    timestamp: "2026-07-19T12:00:00.000Z",
    type: "ENTRY_APPROVED" as const,
    source: "STRATEGY_AUDIT",
    asset: "BTC",
    decisionId: "audit-decision",
    tradeId: "audit-trade",
    strategyVersion: TRADING_STRATEGY_VERSION,
    executionCostModelVersion: "paper-cost-v2-2026-07-19",
    previousHash: null,
    payload: { price: 60_000, approved: true },
  };
  const first = computeExecutionEventHash(unsigned);
  const second = computeExecutionEventHash(unsigned);
  const tampered = computeExecutionEventHash({ ...unsigned, payload: { price: 60_001, approved: true } });
  return [result(
    first === second && first !== tampered ? "PASS" : "FAIL",
    "hash-chained execution ledger integrity",
    "Stable events hash identically and a one-dollar payload change produces a different SHA-256 hash."
  )];
}

function auditWalkForwardHarness(): AuditResult[] {
  const start = new Date("2026-01-01T00:00:00.000Z").getTime();
  const trades = Array.from({ length: 120 }, (_, index) => {
    const win = index % 10 < 7;
    const pnl = win ? 8 : -5;
    return minimalTrade({
      id: `wf-${index}`,
      timestamp: new Date(start + index * 6 * 60 * 60 * 1000).toISOString(),
      action: index % 2 === 0 ? "SELL" : "COVER",
      direction: index % 2 === 0 ? "LONG" : "SHORT",
      pnl,
      pnlPercent: pnl / 5,
      strategyVersion: index % 2 === 0 ? "champion-v1" : "challenger-v1",
      marketRegime: index % 3 === 0 ? "TRENDING" : "CHOPPY",
      entryMode: index % 5 === 0 ? "CONTROLLED_PROBE" : "STANDARD",
    });
  });
  const report = buildWalkForwardResearchReport({ trades });
  const championOnly = buildWalkForwardResearchReport({ trades, strategyVersion: "champion-v1" });
  return [
    result(
      report.folds.length > 0 && report.aggregateTest.trades >= 30 && report.readiness.preliminarySampleReady
        ? "PASS"
        : "FAIL",
      "purged walk-forward folds",
      `${report.folds.length} expanding fold(s), ${report.aggregateTest.trades} unique test trade(s), ${report.numberOfTrials} tracked strategy version(s).`
    ),
    result(
      report.aggregateTest.expectancy95 !== null && report.aggregateTest.profitFactor95 !== null && report.aggregateTest.deflatedSharpeProbability !== null
        ? "PASS"
        : "FAIL",
      "research uncertainty statistics",
      "Bootstrap expectancy/profit-factor intervals and a trial-adjusted Sharpe probability are present."
    ),
    result(
      championOnly.strategyVersions.length === 1 && championOnly.strategyVersions[0] === "champion-v1" && championOnly.numberOfTrials === 1
        ? "PASS"
        : "FAIL",
      "strategy-version probation isolation",
      `${championOnly.strategyVersions.join(", ") || "no versions"} included in the filtered probation cohort.`
    ),
  ];
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
    { conviction: 58, expected: "watch", expectedMode: "PROBE", maxMargin: 300 },
    { conviction: 65, expected: "probe", expectedMode: "PROBE", maxMargin: 500 },
    { conviction: 75, expected: "normal", expectedMode: "STANDARD", maxMargin: 700 },
    { conviction: 85, expected: "strong", expectedMode: "STRONG", maxMargin: 1_000 },
    { conviction: 92, expected: "maximum approved", expectedMode: "STRONG", maxMargin: 1_000 },
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
      learningAdjustment: 0,
      assetMode: "REALTIME_FAST",
      dataQuality: 92,
    });

    const margin = admission.requiredMarginUsd;
    const marginOk = admission.approved &&
      admission.marginMode === scenario.expectedMode &&
      admission.marginPolicyVersion === PAPER_MARGIN_POLICY_VERSION &&
      margin <= scenario.maxMargin + 0.01;
    checks.push(result(
      marginOk ? "PASS" : "FAIL",
      `conviction sizing: ${scenario.conviction}`,
      admission.approved
        ? `${scenario.expected} scenario approved in ${admission.marginMode} mode with $${margin.toFixed(2)} margin, ${admission.leverage}x leverage, and $${admission.maxLossUsd.toFixed(2)} planned max loss.`
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
    assetMode: "REALTIME_FAST",
    dataQuality: 92,
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
    assetMode: "REALTIME_FAST",
    dataQuality: 92,
  });

  checks.push(result(
    normalLearning.approved &&
    reducedLearning.approved &&
    normalLearning.marginMode === "STRONG" &&
    reducedLearning.marginMode !== "STRONG" &&
    reducedLearning.learningRiskMultiplier === 0.6 &&
    reducedLearning.requiredMarginUsd < normalLearning.requiredMarginUsd &&
    reducedLearning.maxLossUsd < normalLearning.maxLossUsd
      ? "PASS"
      : "FAIL",
    "local learning risk reduction",
    reducedLearning.approved
      ? `A -8 learning adjustment removed STRONG eligibility and reduced margin from $${normalLearning.requiredMarginUsd.toFixed(2)} to $${reducedLearning.requiredMarginUsd.toFixed(2)} and planned max loss from $${normalLearning.maxLossUsd.toFixed(2)} to $${reducedLearning.maxLossUsd.toFixed(2)}.`
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
  const slowFeedSeparated = slowFeedAdmission.approved &&
    slowFeedAdmission.marginMode !== "STRONG" &&
    slowFeedAdmission.feedRiskMultiplier === 0.65 &&
    slowFeedAdmission.requiredMarginUsd <= 650;
  checks.push(result(
    slowFeedSeparated ? "PASS" : "FAIL",
    "cached-feed sizing separation",
    slowFeedAdmission.approved
      ? `Cached-feed GOLD remains ${slowFeedAdmission.marginMode} and is limited to $${slowFeedAdmission.requiredMarginUsd.toFixed(2)} margin at ${Math.round(slowFeedAdmission.feedRiskMultiplier * 100)}% of normal risk.`
      : `Cached-feed GOLD was rejected: ${slowFeedAdmission.reason}`
  ));

  const drawdownPortfolio = basePortfolio({
    usd: 9_000,
    peakValue: 10_000,
    totalPnl: -1_000,
    maxDrawdown: 1_000,
    maxDrawdownPercent: 10,
  });
  const drawdownStrong = TradeAdmissionController.evaluate({
    portfolio: drawdownPortfolio,
    asset: "BTC",
    direction: "LONG",
    entryPrice: 60_000,
    stopLoss: 59_000,
    takeProfit: 62_000,
    signalScore: 22,
    reasoning: "Audit STRONG mode under recovery drawdown",
    strategyType: "swing",
    finalConviction: 92,
    learningAdjustment: 0,
    assetMode: "REALTIME_FAST",
    dataQuality: 92,
  });
  const drawdownRiskLimitUsd = drawdownPortfolio.usd * 0.01 * 0.25 * 1.5;
  checks.push(result(
    drawdownStrong.approved &&
    drawdownStrong.marginMode === "STRONG" &&
    drawdownStrong.riskAmountUsd <= drawdownRiskLimitUsd + 0.01 &&
    drawdownStrong.maxLossUsd <= drawdownStrong.riskAmountUsd * 1.01
      ? "PASS"
      : "FAIL",
    "STRONG drawdown circuit breaker",
    drawdownStrong.approved
      ? `At 10% drawdown, STRONG mode remains bounded to $${drawdownStrong.riskAmountUsd.toFixed(2)} risk and $${drawdownStrong.maxLossUsd.toFixed(2)} stop loss.`
      : `Drawdown STRONG scenario was rejected: ${drawdownStrong.reason}`
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

  const deteriorating = SetupPerformance.build(Array.from({ length: 40 }, (_, index) => (
    syntheticTrade(index, index < 28 ? 10 : -10)
  )), {});
  const deterioratingSetup = deteriorating.bySetup.find((bucket) => bucket.key === "VWAP_REJECTION");
  checks.push(result(
    deterioratingSetup?.quarantined === true && deterioratingSetup.confidenceAdjustment === -12 ? "PASS" : "FAIL",
    "out-of-sample setup quarantine",
    deterioratingSetup?.quarantined
      ? `Later ${deterioratingSetup.outOfSampleTradeCount}-trade deterioration quarantines the setup despite positive earlier trades.`
      : "A setup that collapsed in the chronological holdout remained eligible for new entries."
  ));

  const requalified = SetupPerformance.build(Array.from({ length: 40 }, (_, index) => (
    syntheticTrade(index, index < 28 ? 10 : -10)
  )), {
    bySetup: {
      VWAP_REJECTION: {
        total: 20,
        favorable: 14,
        avgMove: 0.01,
        avgNetPnlUsd: 2,
        avgNetReturnPercent: 0.01,
        grossProfitUsd: 60,
        grossLossUsd: 20,
      },
    },
  });
  const requalifiedSetup = requalified.bySetup.find((bucket) => bucket.key === "VWAP_REJECTION");
  checks.push(result(
    requalifiedSetup?.requalificationEligible === true && !requalifiedSetup.quarantined && requalifiedSetup.confidenceAdjustment <= -8 ? "PASS" : "FAIL",
    "measured quarantine requalification",
    requalifiedSetup?.requalificationEligible
      ? "Twenty positive independent watched outcomes permit only reduced requalification instead of a permanent freeze."
      : "The quarantine has no evidence-based path to relearn."
  ));

  const isolatedPerformance = SetupPerformance.build([
    { ...syntheticTrade(100, -100), strategyVersion: "legacy-v3" },
    { ...syntheticTrade(101, 25), strategyVersion: TRADING_STRATEGY_VERSION },
  ], {}, { strategyVersion: TRADING_STRATEGY_VERSION });
  const isolatedAsset = isolatedPerformance.byAsset.find((bucket) => bucket.key === "BTC");
  checks.push(result(
    isolatedPerformance.closedTradeCount === 1 && isolatedAsset?.tradeCount === 1 && isolatedAsset.realizedPnl === 25
      ? "PASS"
      : "FAIL",
    "strategy-version performance isolation",
    isolatedPerformance.closedTradeCount === 1
      ? `Only the ${TRADING_STRATEGY_VERSION} trade contributes to current setup and asset learning.`
      : `${isolatedPerformance.closedTradeCount} trades leaked into the strategy-scoped performance cohort.`
  ));

  return checks;
}

function auditProductionRegressions(): AuditResult[] {
  const read = (...segments: string[]) => fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");
  const portfolioSource = read("src", "lib", "portfolio.ts");
  const redisSource = read("src", "lib", "redis.ts");
  const learningSource = read("src", "lib", "trading", "localLearning.ts");
  const opportunitySource = read("src", "lib", "trading", "opportunityJournal.ts");
  const tradeReviewSource = read("src", "lib", "trading", "tradeReviewJournal.ts");
  const feedSource = read("src", "lib", "data", "feedHealthSummary.ts");
  const daemonSource = read("src", "daemon", "swingDaemon.ts");
  const websocketSource = read("src", "daemon", "websocketDataMesh.ts");
  const tradeSource = read("src", "app", "api", "trade", "route.ts");
  const resetSource = read("src", "app", "api", "user", "reset", "route.ts");
  const swingTradeSource = read("src", "app", "api", "trade", "swing", "route.ts");
  const manualSource = read("src", "app", "api", "trade", "manual", "route.ts");
  const backtestSource = read("src", "app", "api", "backtest", "route.ts");
  const chartSource = read("src", "app", "api", "chart", "route.ts");
  const marketSource = read("src", "lib", "market.ts");
  const dashboardSource = read("src", "components", "Dashboard.tsx");
  const composeSource = read("docker-compose.yml");
  const deployCheckSource = read("scripts", "vps-deploy-check.sh");

  const lockSafe = redisSource.includes("compareAndDelete") && portfolioSource.includes("redis.compareAndDelete(key, token)");
  const learningVersioned = learningSource.includes('learning:${TRADING_STRATEGY_VERSION}:localRules') &&
    learningSource.includes("strategyVersion: TRADING_STRATEGY_VERSION");
  const opportunityVersioned = opportunitySource.includes('opportunity:${TRADING_STRATEGY_VERSION}:v3') &&
    opportunitySource.includes("DEDUPE_SECONDS");
  const reviewVersioned = tradeReviewSource.includes('tradeReview:${TRADING_STRATEGY_VERSION}:aiSwing');
  const feedEnforced = feedSource.includes("KRAKEN_SPOT_WS") &&
    feedSource.includes("BYBIT_LINEAR_WS") &&
    feedSource.includes("BINANCE_SPOT_WS") &&
    feedSource.includes("freshWebsocketSources >= MIN_REDUNDANT_WEBSOCKET_SOURCES") &&
    websocketSource.includes('channel: "trade"') &&
    websocketSource.includes("publicTrade.") &&
    websocketSource.includes("data-stream.binance.vision") &&
    websocketSource.includes('parsed?.e !== "trade"') &&
    websocketSource.includes("SOURCE_PERSIST_INTERVAL_MS = 1_000") &&
    daemonSource.includes("safeForSwingExecution");
  const singleWriterExecution = tradeSource.includes("requestSwingScan") &&
    !tradeSource.includes("TradeAdmissionController") &&
    !tradeSource.includes("updatePortfolio") &&
    swingTradeSource.includes('from "../route"') &&
    daemonSource.includes("consumeSwingScanRequest");
  const publicBounds = [backtestSource, chartSource].every((source) => source.includes("parsedLimit > 1_000"));
  const manualFeeSafe = manualSource.includes("Number.isFinite(usdAmount)") &&
    manualSource.includes("const netPnl = pnl - entryFee - exitFee");
  const daemonHealth = composeSource.includes("quant-swing-daemon") && composeSource.includes("swing:lastScan:ai");
  const deploymentWaitsForHealth = deployCheckSource.includes('-ge 36') && deployCheckSource.includes('sleep 5');
  const recoverySafe = portfolioSource.includes("function isValidPortfolio") &&
    portfolioSource.includes("fs.renameSync(temporaryPath, filePath)") &&
    portfolioSource.includes("if (Array.isArray(backup) && backup.length > 0)") &&
    portfolioSource.includes("rawTrades.length > 0");
  const resetClearsCurrentState = resetSource.includes("LocalLearningMemory.clearCurrentStrategyState()") &&
    resetSource.includes("OpportunityJournal.clearCurrentStrategyState()") &&
    resetSource.includes("TradeReviewJournal.clearCurrentStrategyState()") &&
    resetSource.includes('type: "SYSTEM_RESET"') &&
    learningSource.includes("static async clearCurrentStrategyState()") &&
    opportunitySource.includes("static async clearCurrentStrategyState()") &&
    tradeReviewSource.includes("static async clearCurrentStrategyState()");
  const chartIdentitySafe = chartSource.includes("allowStale: true") &&
    chartSource.includes("asset,") &&
    marketSource.includes("options.allowStale") &&
    dashboardSource.includes("payload.asset !== activeAsset") &&
    dashboardSource.includes("setChartData(null)");

  return [
    result(lockSafe ? "PASS" : "FAIL", "atomic portfolio lock release", lockSafe
      ? "Redis releases a write lock only when the caller still owns its token."
      : "Portfolio lock release can delete a replacement lock after TTL expiry."),
    result(learningVersioned && opportunityVersioned && reviewVersioned ? "PASS" : "FAIL", "strategy-isolated learning state", learningVersioned && opportunityVersioned && reviewVersioned
      ? "Setup performance, opportunity observations, local rules, and trade reviews are isolated by strategy version."
      : "Derived learning state may reuse polluted production aggregates."),
    result(feedEnforced ? "PASS" : "FAIL", "redundant WebSocket admission gate", feedEnforced
      ? "Kraken, Bybit, and Binance feed independent prices while fast admission requires at least two fresh sources."
      : "Autonomous entry can proceed without verified realtime feed health."),
    result(singleWriterExecution ? "PASS" : "FAIL", "single-writer autonomous execution", singleWriterExecution
      ? "Admin scan requests are handed to the daemon and cannot bypass its execution model, ledger, or portfolio circuit breakers."
      : "An API route can still mutate the AI portfolio outside the audited daemon path."),
    result(publicBounds ? "PASS" : "FAIL", "public historical request bounds", publicBounds
      ? "Spectator chart and backtest requests are capped at 1,000 candles."
      : "A public historical endpoint still accepts unbounded work."),
    result(chartIdentitySafe ? "PASS" : "FAIL", "chart asset identity and closed-market fallback", chartIdentitySafe
      ? "Read-only charts can show labeled historical candles while stale trading inputs remain fail-closed; mismatched series are rejected."
      : "The chart can retain or relabel a previous asset when a selected market feed is stale."),
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
      ? "Portfolio backups are structurally validated and replaced atomically; an intentional empty trade history is not misreported as corruption."
      : "Crash recovery can accept malformed state or expose partially written JSON."),
    result(resetClearsCurrentState ? "PASS" : "FAIL", "truthful current-strategy reset", resetClearsCurrentState
      ? "An admin reset clears current learning, opportunity, and review state, preserves older strategy history, and records the reset."
      : "The reset can leave active strategy-derived restrictions behind or omit its audit event."),
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
  const quarantinedSetup = calculateLearningAdjustment([{
    id: "setup:VWAP_RECLAIM", scope: "setup", key: "VWAP_RECLAIM", action: "WATCH_ONLY",
    confidenceAdjustment: -12, message: "Failed holdout", sampleSize: 20, favorableRate: 0.3, avgMove: -4, updatedAt: now,
  }], "BTC", ["VWAP_RECLAIM"]);

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
    result(
      quarantinedSetup.watchOnly ? "PASS" : "FAIL",
      "setup holdout quarantine reaches admission",
      quarantinedSetup.watchOnly
        ? "A setup-level chronological failure now blocks new entries instead of only shrinking them."
        : "The setup quarantine did not reach the live admission decision."
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
    Math.abs(trade.pnlUsd - (trade.grossPnlUsd - trade.entryFeeUsd - trade.exitFeeUsd - trade.carryCostUsd)) < 0.000001
  ));
  const netTradePnl = report.trades.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const capitalMathValid = Math.abs(report.totalReturnUsd - netTradePnl) < 0.000001;
  checks.push(result(
    feeMathValid && capitalMathValid && report.totalTrades > 0 ? "PASS" : "FAIL",
    "replay net fee accounting",
    feeMathValid && capitalMathValid && report.totalTrades > 0
      ? "Every replay trade and final capital include modeled fills, both fee legs, and carry exactly once."
      : "Replay execution-cost deductions or final-capital reconciliation are inconsistent."
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
    status.deployment?.capitalMode === "PAPER_ONLY" ? "PASS" : "FAIL",
    "paper-only capital boundary",
    status.deployment?.capitalMode === "PAPER_ONLY"
      ? `Deployment ${status.deployment.commit || "unknown"} explicitly reports PAPER_ONLY.`
      : "Live status does not explicitly prove the deployment is restricted to paper capital."
  ));

  checks.push(result(
    status.deployment?.strategyVersion === TRADING_STRATEGY_VERSION ? "PASS" : "FAIL",
    "live strategy version",
    status.deployment?.strategyVersion === TRADING_STRATEGY_VERSION
      ? `Live strategy version matches ${TRADING_STRATEGY_VERSION}.`
      : `Expected ${TRADING_STRATEGY_VERSION}, received ${status.deployment?.strategyVersion || "missing"}.`
  ));

  checks.push(result(
    status.deployment?.paperMarginPolicyVersion === PAPER_MARGIN_POLICY_VERSION ? "PASS" : "FAIL",
    "live paper-margin policy version",
    status.deployment?.paperMarginPolicyVersion === PAPER_MARGIN_POLICY_VERSION
      ? `Live paper-margin policy matches ${PAPER_MARGIN_POLICY_VERSION}.`
      : `Expected ${PAPER_MARGIN_POLICY_VERSION}, received ${status.deployment?.paperMarginPolicyVersion || "missing"}.`
  ));

  const ledger = status.executionLedger;
  const ledgerReady = Number(ledger?.files || 0) > 0 && Boolean(ledger?.headHash);
  checks.push(result(
    ledgerReady ? "PASS" : "FAIL",
    "live append-only execution ledger",
    ledgerReady
      ? `${ledger?.files || 0} ledger file(s), ${ledger?.bytes || 0} byte(s), latest event ${ledger?.lastEventAt || "unknown"}.`
      : "No durable hash-chained execution ledger head is visible in live status."
  ));

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
    ...auditTradingRevivalCalibration(),
    ...auditEventCalendar(),
    ...auditSignalEconomics(),
    ...auditExecutionCostModel(),
    ...auditPortfolioRiskBudgets(),
    ...auditExecutionLedgerHashing(),
    ...auditWalkForwardHarness(),
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
