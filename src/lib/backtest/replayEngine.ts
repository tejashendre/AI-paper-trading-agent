import { computeAllIndicators } from "@/lib/indicators";
import { Candle, Portfolio } from "@/lib/types";
import { SUPPORTED_ASSETS } from "@/lib/market";
import { calculatePnlUsd, getAssetSpec } from "@/lib/trading/assetSpecs";
import { TradeAdmissionController } from "@/lib/trading/tradeAdmission";
import { estimateCarryCostUsd, estimatePaperFill, fitPaperExecutionPlanToRiskBudget } from "@/lib/trading/executionCostModel";

type ReplayDirection = "LONG" | "SHORT" | "NEUTRAL";
type ReplayExitReason = "STOP_LOSS" | "TAKE_PROFIT" | "SIGNAL_REVERSAL" | "TIME_STOP" | "END_REPLAY";

export interface ReplayInput {
  assets: Record<string, Candle[]>;
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
  staleDataTrades: number;
  scoreDistribution: Record<string, number>;
  setupStats: ReplaySetupStats[];
  assetStats: ReplayAssetStats[];
  trades: ReplayTrade[];
  errors: string[];
  acceptance: ReplayAcceptance;
}

interface ReplaySignal {
  direction: ReplayDirection;
  htfScore: number;
  triggerScore: number;
  marketStructureScore: number;
  finalConviction: number;
  setupTags: string[];
  entryReady: boolean;
  highAccuracyException: boolean;
  watched: boolean;
}

interface ActiveReplayPosition {
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
const MAX_HOLD_CANDLES = 32;
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

function scoreReplayMarketStructure(direction: ReplayDirection, window: Candle[]) {
  const tags: string[] = [];
  if (direction === "NEUTRAL" || window.length < 32) return { score: 0, aligned: true, tags };

  const last = window[window.length - 1];
  const recent = window.slice(Math.max(0, window.length - 42), window.length - 2);
  const recentHigh = Math.max(...recent.map((candle) => candle.high));
  const recentLow = Math.min(...recent.map((candle) => candle.low));
  const avgVolume = average(recent.map((candle) => candle.volume || 0));
  const closeLocation = (last.close - last.low) / Math.max(last.high - last.low, Number.EPSILON);
  const trendSlope = slope(window.slice(-24).map((candle) => candle.close));
  const trendAligned = direction === "LONG" ? trendSlope >= 0 : trendSlope <= 0;
  const volumeExpansion = avgVolume > 0 && (last.volume || 0) > avgVolume * 1.15;

  let score = trendAligned ? 4 : -5;
  tags.push(trendAligned ? "STRUCTURE_ALIGNED" : "STRUCTURE_AGAINST_TREND");
  if (volumeExpansion) {
    score += 3;
    tags.push("VOLUME_CONFIRMED_STRUCTURE");
  }

  if (direction === "LONG") {
    if (last.low < recentLow && last.close > recentLow && closeLocation >= 0.55) {
      score += 8;
      tags.push("SELL_SIDE_LIQUIDITY_RECLAIM");
    } else if (last.close > recentHigh && volumeExpansion && closeLocation >= 0.6) {
      score += 6;
      tags.push("BUY_SIDE_BREAKOUT_CONTINUATION");
    } else if (last.high > recentHigh && last.close < recentHigh && closeLocation <= 0.45) {
      score -= 16;
      tags.push("LIQUIDITY_TRAP_RISK");
    }
  } else if (last.high > recentHigh && last.close < recentHigh && closeLocation <= 0.45) {
    score += 8;
    tags.push("BUY_SIDE_LIQUIDITY_REJECTION");
  } else if (last.close < recentLow && volumeExpansion && closeLocation <= 0.4) {
    score += 6;
    tags.push("SELL_SIDE_BREAKDOWN_CONTINUATION");
  } else if (last.low < recentLow && last.close > recentLow && closeLocation >= 0.55) {
    score -= 16;
    tags.push("LIQUIDITY_TRAP_RISK");
  }

  const boundedScore = Math.max(-16, Math.min(18, Math.round(score)));
  const hasPermittedEvent = tags.some((tag) =>
    tag === "SELL_SIDE_LIQUIDITY_RECLAIM" ||
    tag === "BUY_SIDE_BREAKOUT_CONTINUATION" ||
    tag === "BUY_SIDE_LIQUIDITY_REJECTION" ||
    tag === "SELL_SIDE_BREAKDOWN_CONTINUATION"
  );
  return { score: boundedScore, aligned: hasPermittedEvent && boundedScore >= 4 && !tags.includes("LIQUIDITY_TRAP_RISK") && !tags.includes("STRUCTURE_AGAINST_TREND"), tags };
}

function buildSignal(asset: string, candles: Candle[], index: number): ReplaySignal {
  const window = candles.slice(0, index + 1);
  const indicators = computeAllIndicators(window);
  const last = window[window.length - 1];
  const prev = window[window.length - 2];
  const recent = window.slice(-24);
  const closes = recent.map((candle) => candle.close);
  const recentVolume = average(recent.slice(0, -1).map((candle) => candle.volume || 0));
  const volumeBurst = recentVolume > 0 && last.volume > recentVolume * 1.2;
  const trendSlope = slope(closes);

  const ema21 = finite(indicators.ema21[index]);
  const ema50 = finite(indicators.ema50[index]);
  const ema200 = finite(indicators.ema200[index]);
  const rsi = finite(indicators.rsi[index], 50);
  const vwap = finite(indicators.vwap[index], last.close);
  const atr = finite(indicators.atr[index], last.close * 0.01);

  let longScore = 0;
  let shortScore = 0;
  const tags: string[] = [];

  if (ema21 > ema50 && ema50 > ema200 && trendSlope > 0) {
    longScore += 8;
    tags.push("HTF_TREND_BREAKOUT");
  }
  if (ema21 < ema50 && ema50 < ema200 && trendSlope < 0) {
    shortScore += 8;
    tags.push("HTF_TREND_BREAKOUT");
  }
  if (last.close > vwap && rsi > 52 && rsi < 72) {
    longScore += 6;
    tags.push("VWAP_RECLAIM");
  }
  if (last.close < vwap && rsi < 48 && rsi > 28) {
    shortScore += 6;
    tags.push("VWAP_REJECTION");
  }
  if (volumeBurst) {
    longScore += last.close >= last.open ? 3 : 0;
    shortScore += last.close < last.open ? 3 : 0;
    tags.push("VOLUME_BURST");
  }
  if (Math.abs(last.close - last.open) > atr * 0.35) {
    tags.push("VOLATILITY_EXPANSION");
  }

  const direction: ReplayDirection = longScore > shortScore ? "LONG" : shortScore > longScore ? "SHORT" : "NEUTRAL";
  const htfScore = Math.max(longScore, shortScore);

  let triggerScore = direction === "NEUTRAL" ? 0 : 4;
  if (direction === "LONG" && last.close > prev.high) triggerScore += 7;
  if (direction === "SHORT" && last.close < prev.low) triggerScore += 7;
  if (direction === "LONG" && last.close > last.open) triggerScore += 5;
  if (direction === "SHORT" && last.close < last.open) triggerScore += 5;
  if (direction === "LONG" && last.close >= vwap) triggerScore += 8;
  if (direction === "SHORT" && last.close <= vwap) triggerScore += 8;
  if (volumeBurst) triggerScore += 5;
  triggerScore = Math.min(30, triggerScore);

  const structure = scoreReplayMarketStructure(direction, window);
  const dataQuality = 90;
  const riskRewardScore = 10;
  const finalConviction = Math.max(0, Math.min(100, Math.round(htfScore * 2.2 + triggerScore * 1.4 + structure.score + Math.round(dataQuality / 5) + riskRewardScore)));
  const isCrypto = SUPPORTED_ASSETS[asset]?.category === "crypto";
  const triggerThreshold = isCrypto ? 14 : 8;
  const entryReady = structure.aligned && htfScore >= 14 && triggerScore >= triggerThreshold && finalConviction >= 60;
  const highAccuracyException = structure.aligned && isCrypto && htfScore >= 8 && htfScore < 14 && triggerScore >= 24 && finalConviction >= 75;

  return {
    direction,
    htfScore,
    triggerScore,
    marketStructureScore: structure.score,
    finalConviction,
    setupTags: [...tags, ...structure.tags].length > 0 ? Array.from(new Set([...tags, ...structure.tags])) : ["UNTAGGED"],
    entryReady,
    highAccuracyException,
    watched: direction !== "NEUTRAL" && htfScore >= 8,
  };
}

function stopTake(asset: string, direction: Exclude<ReplayDirection, "NEUTRAL">, entryPrice: number, candles: Candle[], index: number) {
  const indicators = computeAllIndicators(candles.slice(0, index + 1));
  const atr = finite(indicators.atr[index], entryPrice * 0.01);
  const stopDistance = Math.max(atr * 1.5, entryPrice * (SUPPORTED_ASSETS[asset]?.category === "crypto" ? 0.004 : 0.002));
  const takeDistance = stopDistance * 2;
  return {
    stopLoss: direction === "LONG" ? entryPrice - stopDistance : entryPrice + stopDistance,
    takeProfit: direction === "LONG" ? entryPrice + takeDistance : entryPrice - takeDistance,
  };
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

  for (const [asset, rawCandles] of Object.entries(input.assets)) {
    const candles = rawCandles
      .filter((candle) => Number.isFinite(candle.time) && Number.isFinite(candle.close) && candle.close > 0)
      .sort((a, b) => a.time - b.time);

    if (candles.length < minCandles) {
      errors.push(`${asset}: only ${candles.length} candle(s), minimum ${minCandles} required.`);
      continue;
    }

    const intervalSeconds = medianIntervalSeconds(candles);
    let active: ActiveReplayPosition | null = null;

    for (let i = 80; i < candles.length; i++) {
      const candle = candles[i];
      const stale = isStaleWindow(candles, i, intervalSeconds);
      if (stale) {
        staleWindowsSkipped++;
        continue;
      }

      const signal = buildSignal(asset, candles, i);
      scoreDistribution[scoreBucket(signal.finalConviction)]++;

      if (active) {
        let exitPrice = 0;
        let exitReason: ReplayExitReason | null = null;

        const stopHit = active.direction === "LONG" ? candle.low <= active.stopLoss : candle.high >= active.stopLoss;
        const takeHit = active.direction === "LONG" ? candle.high >= active.takeProfit : candle.low <= active.takeProfit;
        const reversal = signal.direction !== "NEUTRAL" && signal.direction !== active.direction && signal.finalConviction >= 65;
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
        }

        if (exitReason) {
          const trade = closePosition(active, candle, i, exitPrice, exitReason);
          trades.push(trade);
          updatePortfolioAfterTrade(portfolio, trade);
          clearOpenPosition(portfolio, asset);
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

      if (signal.watched) {
        watchedSetups++;
        for (const setup of signal.setupTags) ensureSetup(setup).watched++;
        if (!signal.entryReady && !signal.highAccuracyException && futureFavorableMove(candles, i, signal.direction)) {
          missedOpportunities++;
          for (const setup of signal.setupTags) ensureSetup(setup).missed++;
        }
      }

      if (!active && (signal.entryReady || signal.highAccuracyException) && signal.direction !== "NEUTRAL") {
        const requestedEntryPrice = candle.close;
        const { stopLoss, takeProfit } = stopTake(asset, signal.direction, requestedEntryPrice, candles, i);
        const admission = TradeAdmissionController.evaluate({
          portfolio,
          asset,
          direction: signal.direction,
          entryPrice: requestedEntryPrice,
          stopLoss,
          takeProfit,
          signalScore: signal.htfScore,
          finalConviction: signal.finalConviction,
          setupTags: signal.setupTags,
          assetMode: ["BTC", "ETH", "SOL"].includes(asset) ? "REALTIME_FAST" : "SLOW_SWING",
          dataQuality: 100,
          reasoning: "Replay strategy admission",
          strategyType: "swing",
        });

        if (admission.approved) {
          const fittedExecution = fitPaperExecutionPlanToRiskBudget({
            asset,
            direction: signal.direction,
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
            continue;
          }
          portfolio.usd -= finalRequiredMarginUsd + executionPlan.entry.feeUsd;
          portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + executionPlan.entry.feeUsd;
          portfolio.totalExecutionCostsPaid = (portfolio.totalExecutionCostsPaid || 0) + executionPlan.entry.totalExecutionCostUsd;
          active = {
            asset,
            direction: signal.direction,
            entryIndex: i,
            entryTime: candle.time,
            entryPrice: executionPlan.entry.fillPrice,
            requestedEntryPrice,
            amount: executionPlan.entry.amount,
            marginUsd: finalRequiredMarginUsd,
            notionalUsd: executionPlan.entry.notionalUsd,
            leverage: admission.leverage,
            stopLoss,
            takeProfit,
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
    }

    if (active) {
      const finalCandle = candles[candles.length - 1];
      const trade = closePosition(active, finalCandle, candles.length - 1, finalCandle.close, "END_REPLAY");
      trades.push(trade);
      updatePortfolioAfterTrade(portfolio, trade);
      clearOpenPosition(portfolio, asset);
    }
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
