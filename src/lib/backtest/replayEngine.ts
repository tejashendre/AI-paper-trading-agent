import { computeAllIndicators } from "@/lib/indicators";
import { Candle, OpenPosition, Portfolio } from "@/lib/types";
import { SUPPORTED_ASSETS } from "@/lib/market";
import { evaluateSwingSignal, SwingSignal } from "@/lib/swingEngine";
import { calculatePnlUsd, getAssetSpec } from "@/lib/trading/assetSpecs";
import { TradeAdmissionController } from "@/lib/trading/tradeAdmission";
import { estimateCarryCostUsd, estimatePaperFill, fitPaperExecutionPlanToRiskBudget } from "@/lib/trading/executionCostModel";
import { decideSwingExit, isOppositeEdgeConfirmed } from "@/lib/execution/exitPolicy";
import { SWING_STOP_ATR_MULTIPLE, SWING_TARGET_R_MULTIPLE } from "@/lib/swingEngine";

type ReplayDirection = "LONG" | "SHORT" | "NEUTRAL";
type ReplayExitReason = "STOP_LOSS" | "TAKE_PROFIT" | "SIGNAL_REVERSAL" | "TIME_STOP" | "END_REPLAY";

export interface ReplayInput {
  assets: Record<string, Candle[]>;
  /** Optional 1m/5m series so the short-term trigger is scored at real resolution. */
  fastCandles?: Record<string, { m1?: Candle[]; m5?: Candle[] }>;
  initialCapital?: number;
  maxHoldCandles?: number;
  minCandles?: number;
}

export interface ReplayTrade {
  asset: string;
  direction: Exclude<ReplayDirection, "NEUTRAL">;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  requestedEntryPrice: number;
  requestedExitPrice: number;
  amount: number;
  marginUsd: number;
  notionalUsd: number;
  leverage: number;
  grossPnlUsd: number;
  entryFeeUsd: number;
  exitFeeUsd: number;
  carryCostUsd: number;
  entryExecutionCostUsd: number;
  exitExecutionCostUsd: number;
  totalExecutionCostUsd: number;
  pnlUsd: number;
  pnlPercent: number;
  holdCandles: number;
  finalConviction: number;
  htfScore: number;
  triggerScore: number;
  marketStructureScore: number;
  setupTags: string[];
  exitReason: ReplayExitReason;
  executionPriceSource: "modeled.paper.fill";
}

export interface ReplaySetupStats {
  setup: string;
  trades: number;
  wins: number;
  losses: number;
  watched: number;
  missed: number;
  realizedPnl: number;
  avgPnl: number;
  winRate: number;
}

export interface ReplayAssetStats {
  asset: string;
  trades: number;
  pnlUsd: number;
  winRate: number;
}

export interface ReplayAcceptance {
  passed: boolean;
  integrityPassed: boolean;
  researchQualityPassed: boolean;
  sampleSizePassed: boolean;
  positiveAfterCostReturn: boolean;
  profitFactorPassed: boolean;
  hasExecutableTrades: boolean;
  errorsZero: boolean;
  noStaleDataTrades: boolean;
  allEntriesHaveExecutionPrice: boolean;
  scoreDistributionVisible: boolean;
  score14CannotCreateNormalSize: boolean;
  setupCategoryStatsRecorded: boolean;
  messages: string[];
}

export interface ReplayReport {
  generatedAt: string;
  initialCapital: number;
  finalCapital: number;
  totalReturnUsd: number;
  totalReturnPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  averageReturnPercent: number;
  averageHoldCandles: number;
  bestAsset: ReplayAssetStats | null;
  worstAsset: ReplayAssetStats | null;
  falsePositiveRate: number;
  missedOpportunityRate: number;
  watchedSetups: number;
  missedOpportunities: number;
  staleWindowsSkipped: number;
  triggerCoverageSkipped: number;
  staleDataTrades: number;
  scoreDistribution: Record<string, number>;
  setupStats: ReplaySetupStats[];
  assetStats: ReplayAssetStats[];
  trades: ReplayTrade[];
  errors: string[];
  acceptance: ReplayAcceptance;
}

interface ActiveReplayPosition {
  maxLossUsd?: number;
  initialStopLoss?: number;
  isTrailing?: boolean;
  peakNetPnlUsd?: number;
  highestPriceReached?: number;
  lowestPriceReached?: number;
  asset: string;
  direction: Exclude<ReplayDirection, "NEUTRAL">;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  requestedEntryPrice: number;
  amount: number;
  marginUsd: number;
  notionalUsd: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  entryFeeUsd: number;
  entryExecutionCostUsd: number;
  finalConviction: number;
  htfScore: number;
  triggerScore: number;
  marketStructureScore: number;
  setupTags: string[];
}

const INITIAL_CAPITAL = 10_000;
const MIN_CANDLES = 180;
// Backstop for positions the exit policy never resolves, not a strategy rule.
// It must sit well beyond the strategy's natural holding period: at 32 bars
// (8h) it was force-closing the median trade of a system that now holds about
// a day, which made the replay grade a time-stopped strategy nobody runs.
const MAX_HOLD_CANDLES = 192;
const SCORE_BUCKETS = ["0-19", "20-39", "40-59", "60-79", "80-100"] as const;

function emptyPortfolio(usd: number): Portfolio {
  return {
    usd,
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
    peakValue: usd,
    initialCapital: usd,
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
    totalExecutionCostsPaid: 0,
    totalCarryPaid: 0,
    lastUpdated: new Date().toISOString(),
  };
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function scoreBucket(score: number): string {
  if (score < 20) return "0-19";
  if (score < 40) return "20-39";
  if (score < 60) return "40-59";
  if (score < 80) return "60-79";
  return "80-100";
}

function medianIntervalSeconds(candles: Candle[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const gap = candles[i].time - candles[i - 1].time;
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  return gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 900;
}

function isStaleWindow(candles: Candle[], index: number, intervalSeconds: number): boolean {
  if (index <= 0) return false;
  return candles[index].time - candles[index - 1].time > intervalSeconds * 2.5;
}

function slope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - meanX) * (values[i] - meanY);
    denominator += Math.pow(i - meanX, 2);
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/** Net unrealized PnL for a replay position, on the same cost model as live. */
function replayNetPnlUsd(position: ActiveReplayPosition, price: number, nowSeconds: number): number {
  const exit = estimatePaperFill({
    asset: position.asset,
    action: position.direction === "SHORT" ? "COVER" : "SELL",
    requestedPrice: price,
    amount: position.amount,
    context: {
      reason: "MARK",
      assetMode: SUPPORTED_ASSETS[position.asset]?.category === "crypto" ? "REALTIME_FAST" : "SLOW_SWING",
      dataQuality: 100,
      isPeakLiquidity: false,
    },
  });
  const gross = calculatePnlUsd(position.asset, position.entryPrice, exit.fillPrice, position.amount, position.direction);
  const carry = estimateCarryCostUsd({
    asset: position.asset,
    notionalUsd: position.notionalUsd,
    openedAt: new Date(position.entryTime * 1000).toISOString(),
    closedAt: new Date(Math.max(nowSeconds, position.entryTime + 60) * 1000).toISOString(),
  });
  return gross - position.entryFeeUsd - exit.feeUsd - carry;
}

/** Shape a replay position as the OpenPosition the shared exit policy expects. */
function replayPositionView(position: ActiveReplayPosition): OpenPosition {
  return {
    asset: position.asset,
    entryPrice: position.entryPrice,
    amount: position.amount,
    btcAmount: position.amount,
    usdInvested: position.marginUsd,
    stopLoss: position.stopLoss,
    initialStopLoss: position.initialStopLoss ?? position.stopLoss,
    takeProfit: position.takeProfit,
    entryTime: new Date(position.entryTime * 1000).toISOString(),
    signalScore: position.htfScore,
    reasoning: "Replay validation position",
    direction: position.direction,
    maxLossUsd: position.maxLossUsd,
    finalConviction: position.finalConviction,
    highestPriceReached: position.highestPriceReached,
    lowestPriceReached: position.lowestPriceReached,
    isTrailing: position.isTrailing,
  };
}

/** Aggregate a base series into a higher timeframe, without look-ahead. */
function aggregateSeries(candles: Candle[], factor: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const slice = candles.slice(i, i + factor);
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((candle) => candle.high)),
      low: Math.min(...slice.map((candle) => candle.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((sum, candle) => sum + (candle.volume || 0), 0),
    });
  }
  return out;
}

interface ReplaySeries {
  base: Candle[];
  h1: Candle[];
  h4: Candle[];
  w1: Candle[];
  m5: Candle[];
  m1: Candle[];
}

function buildReplaySeries(base: Candle[], fast?: { m1?: Candle[]; m5?: Candle[] }): ReplaySeries {
  return {
    base,
    h1: aggregateSeries(base, 4),
    h4: aggregateSeries(base, 16),
    w1: aggregateSeries(base, 672),
    m5: fast?.m5?.length ? fast.m5 : base,
    m1: fast?.m1?.length ? fast.m1 : (fast?.m5?.length ? fast.m5 : base),
  };
}

/**
 * The last `tail` bars that are fully closed at or before `time`.
 * Binary-searches the boundary and copies only the tail: slicing the whole
 * prefix here would copy a 180k-element 1m series on every replayed bar.
 */
function closedTail(series: Candle[], time: number, barSeconds: number, tail: number): Candle[] {
  let hi = series.length;
  let lo = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].time + barSeconds <= time + 1) lo = mid + 1;
    else hi = mid;
  }
  return series.slice(Math.max(0, lo - tail), lo);
}

/**
 * The replay's signal IS the production signal. This used to be a separate
 * EMA/VWAP scorer with its own thresholds, which meant the acceptance gate
 * graded a strategy the daemon never ran.
 */
function buildSignal(asset: string, series: ReplaySeries, index: number): SwingSignal {
  const window = series.base.slice(0, index + 1);
  const last = window[window.length - 1];
  const time = last.time + 900;
  const livePrice = last.close;

  return evaluateSwingSignal({
    assetKey: asset,
    assetMode: SUPPORTED_ASSETS[asset]?.category === "crypto" ? "REALTIME_FAST" : "SLOW_SWING",
    candles1mResult: closedTail(series.m1, time, series.m1 === series.base ? 900 : 60, 80),
    candles5mResult: closedTail(series.m5, time, series.m5 === series.base ? 900 : 300, 80),
    candles15m: window.slice(-100),
    candles1h: closedTail(series.h1, time, 3600, 100),
    candles4h: closedTail(series.h4, time, 14400, 100),
    candles1w: closedTail(series.w1, time, 604800, 20),
    livePriceSnapshot: {
      price: livePrice,
      provider: "REPLAY",
      source: "HTTP",
      venue: "REPLAY",
      instrument: asset,
      updatedAt: new Date(time * 1000).toISOString(),
    },
    // Historical order-book and funding tapes are not retained, so live-flow
    // evidence is neutral here — the same state production sees when those
    // feeds are unavailable.
    orderbookResult: null,
    deepSensors: null,
    // Replay is a clean-room test of the strategy itself, so it runs without
    // accumulated learning adjustments.
    learningRules: [],
  });
}

function markOpenPosition(portfolio: Portfolio, position: ActiveReplayPosition) {
  portfolio.openPositions[position.asset] = {
    asset: position.asset,
    entryPrice: position.entryPrice,
    amount: position.amount,
    btcAmount: position.amount,
    usdInvested: position.marginUsd,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    entryTime: new Date(position.entryTime * 1000).toISOString(),
    signalScore: position.htfScore,
    reasoning: "Replay validation position",
    direction: position.direction,
    entryFeePaid: position.entryFeeUsd,
    entryRequestedPrice: position.requestedEntryPrice,
    entryExecutionCostUsd: position.entryExecutionCostUsd,
    notionalUsd: position.notionalUsd,
    leverageUsed: position.leverage,
    finalConviction: position.finalConviction,
    triggerScore: position.triggerScore,
    marketStructureScore: position.marketStructureScore,
    setupTags: position.setupTags,
    strategyType: "swing",
  };
}

function clearOpenPosition(portfolio: Portfolio, asset: string) {
  delete portfolio.openPositions[asset];
}

function updatePortfolioAfterTrade(portfolio: Portfolio, trade: ReplayTrade) {
  // Entry margin and fee were removed when the position opened. Restore the
  // margin, then settle gross PnL and the exit fee exactly once.
  portfolio.usd += trade.marginUsd + trade.grossPnlUsd - trade.exitFeeUsd - trade.carryCostUsd;
  portfolio.totalPnl += trade.pnlUsd;
  portfolio.totalTrades++;
  portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + trade.exitFeeUsd;
  portfolio.totalCarryPaid = (portfolio.totalCarryPaid || 0) + trade.carryCostUsd;
  portfolio.totalExecutionCostsPaid = (portfolio.totalExecutionCostsPaid || 0) + trade.exitExecutionCostUsd + trade.carryCostUsd;
  portfolio.returns.push(trade.pnlPercent / 100);
  if (trade.pnlUsd > 0) {
    portfolio.winningTrades++;
    portfolio.grossProfit += trade.pnlUsd;
    portfolio.consecutiveWins++;
    portfolio.consecutiveLosses = 0;
  } else {
    portfolio.losingTrades++;
    portfolio.grossLoss += Math.abs(trade.pnlUsd);
    portfolio.consecutiveLosses++;
    portfolio.consecutiveWins = 0;
  }
  portfolio.maxConsecutiveWins = Math.max(portfolio.maxConsecutiveWins, portfolio.consecutiveWins);
  portfolio.maxConsecutiveLosses = Math.max(portfolio.maxConsecutiveLosses, portfolio.consecutiveLosses);
  portfolio.peakValue = Math.max(portfolio.peakValue, portfolio.usd);
  const drawdown = portfolio.peakValue > 0 ? portfolio.peakValue - portfolio.usd : 0;
  portfolio.maxDrawdown = Math.max(portfolio.maxDrawdown, drawdown);
  portfolio.maxDrawdownPercent = portfolio.peakValue > 0 ? Math.max(portfolio.maxDrawdownPercent, (drawdown / portfolio.peakValue) * 100) : 0;
}

function closePosition(position: ActiveReplayPosition, candle: Candle, index: number, requestedExitPrice: number, reason: ReplayExitReason): ReplayTrade {
  const exit = estimatePaperFill({
    asset: position.asset,
    action: position.direction === "SHORT" ? "COVER" : "SELL",
    requestedPrice: requestedExitPrice,
    amount: position.amount,
    context: {
      reason: reason === "STOP_LOSS"
        ? "STOP_LOSS"
        : reason === "TAKE_PROFIT"
          ? "TAKE_PROFIT"
          : reason === "END_REPLAY"
            ? "END_REPLAY"
            : reason,
      assetMode: ["BTC", "ETH", "SOL"].includes(position.asset) ? "REALTIME_FAST" : "SLOW_SWING",
      dataQuality: 100,
      isPeakLiquidity: false,
    },
  });
  const grossPnlUsd = calculatePnlUsd(position.asset, position.entryPrice, exit.fillPrice, position.amount, position.direction);
  const carryCostUsd = estimateCarryCostUsd({
    asset: position.asset,
    notionalUsd: position.notionalUsd,
    openedAt: new Date(position.entryTime * 1000).toISOString(),
    closedAt: new Date(candle.time * 1000).toISOString(),
  });
  const pnlUsd = grossPnlUsd - position.entryFeeUsd - exit.feeUsd - carryCostUsd;
  return {
    asset: position.asset,
    direction: position.direction,
    entryTime: position.entryTime,
    exitTime: candle.time,
    entryPrice: position.entryPrice,
    exitPrice: exit.fillPrice,
    requestedEntryPrice: position.requestedEntryPrice,
    requestedExitPrice,
    amount: position.amount,
    marginUsd: position.marginUsd,
    notionalUsd: position.notionalUsd,
    leverage: position.leverage,
    grossPnlUsd,
    entryFeeUsd: position.entryFeeUsd,
    exitFeeUsd: exit.feeUsd,
    carryCostUsd,
    entryExecutionCostUsd: position.entryExecutionCostUsd,
    exitExecutionCostUsd: exit.totalExecutionCostUsd,
    totalExecutionCostUsd: position.entryExecutionCostUsd + exit.totalExecutionCostUsd + carryCostUsd,
    pnlUsd,
    pnlPercent: position.marginUsd > 0 ? (pnlUsd / position.marginUsd) * 100 : 0,
    holdCandles: index - position.entryIndex,
    finalConviction: position.finalConviction,
    htfScore: position.htfScore,
    triggerScore: position.triggerScore,
    marketStructureScore: position.marketStructureScore,
    setupTags: position.setupTags,
    exitReason: reason,
    executionPriceSource: "modeled.paper.fill",
  };
}

function futureFavorableMove(candles: Candle[], index: number, direction: ReplayDirection): boolean {
  if (direction === "NEUTRAL") return false;
  const entry = candles[index].close;
  const future = candles.slice(index + 1, index + 9);
  if (future.length === 0 || entry <= 0) return false;
  const threshold = 0.004;
  if (direction === "LONG") {
    return Math.max(...future.map((candle) => candle.high)) >= entry * (1 + threshold);
  }
  return Math.min(...future.map((candle) => candle.low)) <= entry * (1 - threshold);
}

function buildAcceptance(report: Omit<ReplayReport, "acceptance">): ReplayAcceptance {
  const messages: string[] = [];
  const hasExecutableTrades = report.totalTrades > 0;
  const errorsZero = report.errors.length === 0;
  const noStaleDataTrades = report.staleDataTrades === 0;
  const allEntriesHaveExecutionPrice = report.trades.every((trade) => trade.entryPrice > 0 && trade.executionPriceSource === "modeled.paper.fill");
  const scoreDistributionVisible = Object.keys(report.scoreDistribution).length === SCORE_BUCKETS.length;
  const setupCategoryStatsRecorded = report.setupStats.length > 0;

  const weakPortfolio = emptyPortfolio(INITIAL_CAPITAL);
  const weakAdmission = TradeAdmissionController.evaluate({
    portfolio: weakPortfolio,
    asset: "BTC",
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 98,
    takeProfit: 104,
    signalScore: 14,
    finalConviction: 14,
    setupTags: ["VWAP_RECLAIM", "LIVE_BREAK_CONFIRMATION"],
    reasoning: "Replay weak-score admission guard",
    strategyType: "swing",
  });
  const score14CannotCreateNormalSize = !weakAdmission.approved || weakAdmission.requiredMarginUsd <= INITIAL_CAPITAL * 0.05;
  const integrityPassed = hasExecutableTrades
    && errorsZero
    && noStaleDataTrades
    && allEntriesHaveExecutionPrice
    && scoreDistributionVisible
    && score14CannotCreateNormalSize
    && setupCategoryStatsRecorded;
  const sampleSizePassed = report.totalTrades >= 30;
  const positiveAfterCostReturn = report.totalReturnUsd > 0 && report.averageReturnPercent > 0;
  const profitFactorPassed = report.profitFactor >= 1.1;
  const researchQualityPassed = sampleSizePassed && positiveAfterCostReturn && profitFactorPassed;

  if (!hasExecutableTrades) messages.push("Replay produced no executable trades, so entry, exit, and fee accounting were not validated.");
  if (!errorsZero) messages.push(`${report.errors.length} replay error(s) detected.`);
  if (!noStaleDataTrades) messages.push(`${report.staleDataTrades} stale-data trade(s) detected.`);
  if (!allEntriesHaveExecutionPrice) messages.push("At least one entry lacked a candle-close execution price.");
  if (!scoreDistributionVisible) messages.push("Score distribution is incomplete.");
  if (!score14CannotCreateNormalSize) messages.push("Score 14 can create a normal-sized trade, which violates the sizing guard.");
  if (!setupCategoryStatsRecorded) messages.push("No setup category stats were recorded.");
  if (integrityPassed) messages.push("Replay engineering-integrity checks passed.");
  if (!sampleSizePassed) messages.push(`Research sample is too small: ${report.totalTrades} closed replay trades; at least 30 are required.`);
  if (!positiveAfterCostReturn) messages.push("Replay expectancy is not positive after modeled fills, fees, and carry.");
  if (!profitFactorPassed) messages.push(`Replay profit factor ${report.profitFactor.toFixed(2)} is below the 1.10 research minimum.`);
  if (researchQualityPassed) messages.push("Replay research-quality checks passed.");

  const passed = integrityPassed && researchQualityPassed;

  return {
    passed,
    integrityPassed,
    researchQualityPassed,
    sampleSizePassed,
    positiveAfterCostReturn,
    profitFactorPassed,
    hasExecutableTrades,
    errorsZero,
    noStaleDataTrades,
    allEntriesHaveExecutionPrice,
    scoreDistributionVisible,
    score14CannotCreateNormalSize,
    setupCategoryStatsRecorded,
    messages,
  };
}

export function runReplay(input: ReplayInput): ReplayReport {
  const initialCapital = input.initialCapital || INITIAL_CAPITAL;
  const minCandles = input.minCandles || MIN_CANDLES;
  const maxHoldCandles = input.maxHoldCandles || MAX_HOLD_CANDLES;
  const portfolio = emptyPortfolio(initialCapital);
  const trades: ReplayTrade[] = [];
  const errors: string[] = [];
  const scoreDistribution = Object.fromEntries(SCORE_BUCKETS.map((bucket) => [bucket, 0])) as Record<string, number>;
  const setupStats = new Map<string, ReplaySetupStats>();
  let watchedSetups = 0;
  let missedOpportunities = 0;
  let staleWindowsSkipped = 0;
  let triggerCoverageSkipped = 0;
  let staleDataTrades = 0;

  const ensureSetup = (setup: string): ReplaySetupStats => {
    const existing = setupStats.get(setup);
    if (existing) return existing;
    const created: ReplaySetupStats = {
      setup,
      trades: 0,
      wins: 0,
      losses: 0,
      watched: 0,
      missed: 0,
      realizedPnl: 0,
      avgPnl: 0,
      winRate: 0,
    };
    setupStats.set(setup, created);
    return created;
  };

  // Assets are replayed on one merged chronological tape rather than one after
  // another. Running them sequentially over a shared bankroll meant the third
  // asset began with whatever equity the first two happened to leave, so
  // portfolio-level rules — drawdown-scaled risk, total margin caps — were
  // being applied to a history that never existed.
  const prepared = new Map<string, {
    candles: Candle[];
    series: ReplaySeries;
    intervalSeconds: number;
    triggerCoverageFrom: number;
    active: ActiveReplayPosition | null;
  }>();

  for (const [asset, rawCandles] of Object.entries(input.assets)) {
    const candles = rawCandles
      .filter((candle) => Number.isFinite(candle.time) && Number.isFinite(candle.close) && candle.close > 0)
      .sort((a, b) => a.time - b.time);

    if (candles.length < minCandles) {
      errors.push(`${asset}: only ${candles.length} candle(s), minimum ${minCandles} required.`);
      continue;
    }

    const series = buildReplaySeries(candles, input.fastCandles?.[asset]);
    // The short-term trigger needs 1m/5m history. Where that history does not
    // reach, the trigger would score zero and every bar would look like a
    // no-entry — a silently empty sample rather than a real result. Skip those
    // bars explicitly and report the count.
    prepared.set(asset, {
      candles,
      series,
      intervalSeconds: medianIntervalSeconds(candles),
      triggerCoverageFrom: series.m1 === candles ? -Infinity : (series.m1[0]?.time ?? Infinity) + 80 * 60,
      active: null,
    });
  }

  // Mirrors cooldownSecondsForExit in swingLifecycle: a losing stop parks the
  // asset for two hours. Without it the replay re-enters immediately after
  // every loss, which is neither what production does nor a fair test of it.
  const cooldownUntil = new Map<string, number>();
  const cooldownSecondsForReplayExit = (reason: ReplayExitReason, pnlUsd: number): number => {
    if (pnlUsd >= 0) return 0;
    if (reason === "SIGNAL_REVERSAL") return 0;
    if (reason === "STOP_LOSS") return 2 * 60 * 60;
    return 60 * 60;
  };

  const tape: { asset: string; index: number; time: number }[] = [];
  for (const [asset, state] of prepared) {
    for (let i = 80; i < state.candles.length; i++) {
      tape.push({ asset, index: i, time: state.candles[i].time });
    }
  }
  tape.sort((a, b) => a.time - b.time || a.asset.localeCompare(b.asset));

  {
    for (const step of tape) {
      const asset = step.asset;
      const state = prepared.get(asset)!;
      const { candles, series, intervalSeconds, triggerCoverageFrom } = state;
      let active = state.active;
      const i = step.index;
      const candle = candles[i];
      const stale = isStaleWindow(candles, i, intervalSeconds);
      if (stale) {
        staleWindowsSkipped++;
        state.active = active;
        continue;
      }

      if (candle.time < triggerCoverageFrom) {
        triggerCoverageSkipped++;
        state.active = active;
        continue;
      }

      const signal = buildSignal(asset, series, i);
      // The engine's own vocabulary, mapped once into replay terms.
      const direction: ReplayDirection =
        signal.action === "SWING_BUY" ? "LONG" : signal.action === "SWING_SHORT" ? "SHORT" : signal.directionBias;
      const tradeDirection: ReplayDirection =
        signal.action === "SWING_BUY" ? "LONG" : signal.action === "SWING_SHORT" ? "SHORT" : "NEUTRAL";
      const entryReady: boolean = tradeDirection !== "NEUTRAL";
      const watched = direction !== "NEUTRAL" && signal.htfScore >= 8;
      scoreDistribution[scoreBucket(signal.finalConviction)]++;

      if (active) {
        let exitPrice = 0;
        let exitReason: ReplayExitReason | null = null;

        // Track the same watermarks the live position carries so the shared
        // exit policy sees identical inputs here and in the daemon.
        active.highestPriceReached = Math.max(active.highestPriceReached ?? active.entryPrice, candle.high);
        active.lowestPriceReached = Math.min(active.lowestPriceReached ?? active.entryPrice, candle.low);
        const netNow = replayNetPnlUsd(active, candle.close, candle.time);
        active.peakNetPnlUsd = Math.max(active.peakNetPnlUsd ?? 0, netNow);

        const stopHit = active.direction === "LONG" ? candle.low <= active.stopLoss : candle.high >= active.stopLoss;
        const takeHit = !active.isTrailing &&
          (active.direction === "LONG" ? candle.high >= active.takeProfit : candle.low <= active.takeProfit);
        // The shipped reversal rule, not a looser replay-local one. A bare
        // "opposite signal at 65 conviction" closes far more trades than the
        // daemon ever would.
        const reversal = isOppositeEdgeConfirmed(replayPositionView(active), signal);
        const timedOut = i - active.entryIndex >= maxHoldCandles;

        if (stopHit) {
          exitPrice = active.direction === "LONG"
            ? Math.min(active.stopLoss, candle.open)
            : Math.max(active.stopLoss, candle.open);
          exitReason = "STOP_LOSS";
        } else if (takeHit) {
          exitPrice = active.takeProfit;
          exitReason = "TAKE_PROFIT";
        } else if (reversal) {
          exitPrice = candle.close;
          exitReason = "SIGNAL_REVERSAL";
        } else if (timedOut) {
          exitPrice = candle.close;
          exitReason = "TIME_STOP";
        } else {
          const action = decideSwingExit({
            position: replayPositionView(active),
            currentPrice: candle.close,
            netPnlUsd: netNow,
            peakNetPnlUsd: active.peakNetPnlUsd ?? 0,
            oppositeEdgeConfirmed: false,
          });
          if (action.kind === "CLOSE") {
            exitPrice = candle.close;
            exitReason = action.reason === "TAKE_PROFIT" ? "TAKE_PROFIT" : "SIGNAL_REVERSAL";
          } else if (action.kind === "MOVE_STOP") {
            active.stopLoss = action.newStopLoss;
            if (action.trailing) active.isTrailing = true;
          }
        }

        if (exitReason) {
          const trade = closePosition(active, candle, i, exitPrice, exitReason);
          trades.push(trade);
          updatePortfolioAfterTrade(portfolio, trade);
          clearOpenPosition(portfolio, asset);
          const cooldown = cooldownSecondsForReplayExit(exitReason, trade.pnlUsd);
          if (cooldown > 0) cooldownUntil.set(asset, candle.time + cooldown);
          for (const setup of active.setupTags) {
            const stat = ensureSetup(setup);
            stat.trades++;
            stat.realizedPnl += trade.pnlUsd;
            if (trade.pnlUsd > 0) stat.wins++;
            else stat.losses++;
          }
          active = null;
        }
      }

      if (watched) {
        watchedSetups++;
        for (const setup of signal.setupTags) ensureSetup(setup).watched++;
        if (!entryReady && futureFavorableMove(candles, i, direction)) {
          missedOpportunities++;
          for (const setup of signal.setupTags) ensureSetup(setup).missed++;
        }
      }

      if (!active && tradeDirection !== "NEUTRAL" && candle.time >= (cooldownUntil.get(asset) ?? 0)) {
        const entryDirection: "LONG" | "SHORT" = tradeDirection;
        const requestedEntryPrice = candle.close;
        // Stop and target come from the engine that produced the signal.
        const stopLoss = signal.stopLoss;
        const takeProfit = signal.takeProfit;
        const admission = TradeAdmissionController.evaluate({
          portfolio,
          asset,
          direction: entryDirection,
          entryPrice: requestedEntryPrice,
          stopLoss,
          takeProfit,
          signalScore: signal.htfScore,
          finalConviction: signal.finalConviction,
          setupTags: signal.setupTags,
          assetMode: ["BTC", "ETH", "SOL"].includes(asset) ? "REALTIME_FAST" : "SLOW_SWING",
          dataQuality: signal.dataQuality,
          reasoning: "Replay strategy admission",
          strategyType: "swing",
          entryMode: "STANDARD",
        });

        if (admission.approved) {
          const fittedExecution = fitPaperExecutionPlanToRiskBudget({
            asset,
            direction: entryDirection,
            entryPrice: requestedEntryPrice,
            stopLoss,
            takeProfit,
            amount: admission.amount,
            riskBudgetUsd: admission.riskAmountUsd,
            context: {
              assetMode: ["BTC", "ETH", "SOL"].includes(asset) ? "REALTIME_FAST" : "SLOW_SWING",
              dataQuality: 100,
              isPeakLiquidity: false,
            },
          });
          const executionPlan = fittedExecution.plan;
          const finalRequiredMarginUsd = executionPlan.entry.notionalUsd / admission.leverage;
          if (
            executionPlan.netRewardUsd <= 0 ||
            executionPlan.netRewardRiskRatio < 1.35 ||
            executionPlan.netLossUsd > admission.riskAmountUsd * 1.01 ||
            finalRequiredMarginUsd < getAssetSpec(asset).minMarginUsd
          ) {
            state.active = active;
            continue;
          }
          portfolio.usd -= finalRequiredMarginUsd + executionPlan.entry.feeUsd;
          portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + executionPlan.entry.feeUsd;
          portfolio.totalExecutionCostsPaid = (portfolio.totalExecutionCostsPaid || 0) + executionPlan.entry.totalExecutionCostUsd;
          active = {
            asset,
            direction: entryDirection,
            entryIndex: i,
            entryTime: candle.time,
            entryPrice: executionPlan.entry.fillPrice,
            requestedEntryPrice,
            amount: executionPlan.entry.amount,
            marginUsd: finalRequiredMarginUsd,
            notionalUsd: executionPlan.entry.notionalUsd,
            leverage: admission.leverage,
            stopLoss,
            initialStopLoss: stopLoss,
            takeProfit,
            maxLossUsd: executionPlan.netLossUsd,
            entryFeeUsd: executionPlan.entry.feeUsd,
            entryExecutionCostUsd: executionPlan.entry.totalExecutionCostUsd,
            finalConviction: signal.finalConviction,
            htfScore: signal.htfScore,
            triggerScore: signal.triggerScore,
            marketStructureScore: signal.marketStructureScore,
            setupTags: signal.setupTags,
          };
          markOpenPosition(portfolio, active);
          if (stale) staleDataTrades++;
        }
      }

      state.active = active;
    }
  }

  for (const [asset, state] of prepared) {
    if (!state.active) continue;
    const finalCandle = state.candles[state.candles.length - 1];
    const trade = closePosition(state.active, finalCandle, state.candles.length - 1, finalCandle.close, "END_REPLAY");
    trades.push(trade);
    updatePortfolioAfterTrade(portfolio, trade);
    clearOpenPosition(portfolio, asset);
    state.active = null;
  }

  const grossProfit = trades.filter((trade) => trade.pnlUsd > 0).reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnlUsd < 0).reduce((sum, trade) => sum + trade.pnlUsd, 0));
  const winningTrades = trades.filter((trade) => trade.pnlUsd > 0).length;
  const losingTrades = trades.length - winningTrades;
  const byAsset = new Map<string, ReplayAssetStats>();

  for (const trade of trades) {
    const stat = byAsset.get(trade.asset) || { asset: trade.asset, trades: 0, pnlUsd: 0, winRate: 0 };
    stat.trades++;
    stat.pnlUsd += trade.pnlUsd;
    byAsset.set(trade.asset, stat);
  }

  const assetStats = Array.from(byAsset.values()).map((stat) => {
    const assetTrades = trades.filter((trade) => trade.asset === stat.asset);
    return {
      ...stat,
      winRate: assetTrades.length > 0 ? assetTrades.filter((trade) => trade.pnlUsd > 0).length / assetTrades.length : 0,
    };
  }).sort((a, b) => b.pnlUsd - a.pnlUsd);

  const setupStatsList = Array.from(setupStats.values()).map((stat) => ({
    ...stat,
    avgPnl: stat.trades > 0 ? stat.realizedPnl / stat.trades : 0,
    winRate: stat.trades > 0 ? stat.wins / stat.trades : 0,
  })).sort((a, b) => b.realizedPnl - a.realizedPnl);

  const reportBase: Omit<ReplayReport, "acceptance"> = {
    generatedAt: new Date().toISOString(),
    initialCapital,
    finalCapital: portfolio.usd,
    totalReturnUsd: portfolio.usd - initialCapital,
    totalReturnPercent: ((portfolio.usd - initialCapital) / initialCapital) * 100,
    totalTrades: trades.length,
    winningTrades,
    losingTrades,
    winRate: trades.length > 0 ? winningTrades / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdownPercent: portfolio.maxDrawdownPercent,
    averageReturnPercent: average(trades.map((trade) => trade.pnlPercent)),
    averageHoldCandles: average(trades.map((trade) => trade.holdCandles)),
    bestAsset: assetStats[0] || null,
    worstAsset: assetStats.length > 0 ? assetStats[assetStats.length - 1] : null,
    falsePositiveRate: trades.length > 0 ? losingTrades / trades.length : 0,
    missedOpportunityRate: watchedSetups > 0 ? missedOpportunities / watchedSetups : 0,
    watchedSetups,
    missedOpportunities,
    staleWindowsSkipped,
    triggerCoverageSkipped,
    staleDataTrades,
    scoreDistribution,
    setupStats: setupStatsList,
    assetStats,
    trades,
    errors,
  };

  return {
    ...reportBase,
    acceptance: buildAcceptance(reportBase),
  };
}
