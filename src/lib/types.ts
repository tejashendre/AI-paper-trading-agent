// ================================================================
// Bitcoin Quant Trading System — Shared Type Definitions
// Single source of truth for all modules.
// ================================================================

// ======================== Market Data ============================

export interface Candle {
  time: number;   // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h';

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 1 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

// ======================== Indicators =============================

export interface MACDValue {
  line: number;
  signal: number;
  histogram: number;
}

export interface BollingerValue {
  upper: number;
  middle: number;
  lower: number;
}

export interface StochRSIValue {
  k: number;
  d: number;
}

/** Latest indicator readings for a single point in time. */
export interface IndicatorSnapshot {
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  rsi: number;
  macd: MACDValue;
  bb: BollingerValue;
  atr: number;
  vwap: number;
  stochRsi: StochRSIValue;
  price: number;
}

/** Full indicator arrays aligned 1:1 with candle arrays. */
export interface IndicatorSeries {
  ema9: number[];
  ema21: number[];
  ema50: number[];
  ema200: number[];
  rsi: number[];
  macd: MACDValue[];
  bb: BollingerValue[];
  atr: number[];
  vwap: number[];
  stochRsi: StochRSIValue[];
}

// ==================== Candlestick Patterns =======================

export type PatternType =
  | 'HAMMER'
  | 'INVERTED_HAMMER'
  | 'DOJI'
  | 'BULLISH_ENGULFING'
  | 'BEARISH_ENGULFING'
  | 'MORNING_STAR'
  | 'EVENING_STAR'
  | 'THREE_WHITE_SOLDIERS'
  | 'THREE_BLACK_CROWS';

export interface CandlePattern {
  type: PatternType;
  bullish: boolean;
  strength: number;       // 0 to 1
  description: string;
}

// ======================= Statistics ==============================

export interface StatisticalMetrics {
  logReturns: number[];
  realizedVolatility: number;     // annualized
  priceZScore: number;            // current price z-score vs rolling mean
  rsiZScore: number;              // current RSI z-score vs its rolling mean
  hurstExponent: number;          // >0.55 trending, <0.45 mean-reverting
  regime: 'TRENDING' | 'MEAN_REVERTING' | 'CHOPPY';
  volatilityPercentile: number;   // 0-100, where current ATR sits in 90-day dist
  volumePercentile: number;       // 0-100, where current volume sits in 30-candle dist
  regressionSlope: number;        // OLS slope of last 20 closes
  regressionR2: number;           // R² goodness of fit
}

// ======================== Signals ================================

export interface SignalComponent {
  name: string;
  score: number;
  maxScore: number;
  fired: boolean;
  description: string;
}

export interface TimeframeSignal {
  timeframe: Timeframe;
  score: number;          // sum of fired components
  maxScore: number;       // weight ceiling for this TF
  components: SignalComponent[];
  snapshot: IndicatorSnapshot;
  statistics: StatisticalMetrics;
  patterns: CandlePattern[];
}

export interface CompositeSignal {
  totalScore: number;     // 0–100
  action: 'BUY' | 'SELL' | 'SHORT' | 'COVER' | 'HOLD';
  confidence: number;     // 0–1  (totalScore / 100)
  regime: 'TRENDING' | 'MEAN_REVERTING' | 'CHOPPY';
  timeframes: TimeframeSignal[];
  reasoning: string;
  timestamp: string;
}

// ========================== Risk ================================

export interface RiskParameters {
  positionSizeBtc: number;
  positionSizeUsd: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  riskAmount: number;       // USD at risk
  riskPercent: number;       // % of capital at risk
  kellyFraction: number;
  halfKellyFraction: number;
  var95: number;             // 95% Value at Risk in USD
}

// ==================== Position & Portfolio ========================

export interface OpenPosition {
  asset: string;          // E.g., 'BTC', 'ETH', 'EURUSD', 'GOLD'
  entryPrice: number;
  amount: number;         // Sized asset amount (e.g. BTC amount, Gold ounces, Forex units)
  btcAmount: number;      // Deprecated/Compatibility helper
  usdInvested: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: string;
  signalScore: number;
  reasoning: string;
  direction: 'LONG' | 'SHORT';
  isScalp?: boolean;
  entryFeePaid?: number;
  notionalUsd?: number;
  leverageUsed?: number;
  riskAmountUsd?: number;
  maxLossUsd?: number;
  admissionScore?: number;
  strategyType?: 'swing' | 'manual' | 'scalp';
  highestPriceReached?: number;
  lowestPriceReached?: number;
  isTrailing?: boolean;
}

export interface Portfolio {
  usd: number;
  btc: number;            // Left for baseline compatibility
  balances: Record<string, number>; // Dynamic balances: e.g. { BTC: 0.1, ETH: 1.5, GOLD: 2.4 }
  openPositions: Record<string, OpenPosition>; // Dynamic asset positions: e.g. { BTC: pos, EURUSD: pos }
  openPosition: OpenPosition | null; // Left for single legacy position fallback
  scalpPositions?: Record<string, OpenPosition>; // Decoupled high-frequency scalp positions
  peakValue: number;
  initialCapital: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnl: number;
  grossProfit: number;
  grossLoss: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  returns: number[];          // historical trade returns for Sharpe/Sortino
  totalFeesPaid?: number;     // Accumulated transaction fees paid
  lastUpdated: string;
}

export interface Trade {
  id: string;
  timestamp: string;
  asset: string;          // E.g., 'BTC', 'EURUSD'
  action: 'BUY' | 'SELL' | 'SHORT' | 'COVER' | 'SCALP_BUY' | 'SCALP_SELL' | 'SCALP_SHORT' | 'SCALP_COVER';
  direction?: 'LONG' | 'SHORT';
  amount: number;
  btcAmount: number;      // Deprecated/Compatibility helper
  price: number;
  usdValue: number;
  stopLoss: number;
  takeProfit: number;
  signalScore: number;
  reasoning: string;
  // Filled when position is closed:
  pnl?: number;
  pnlPercent?: number;
  entryPrice?: number;
  entryTime?: string;
  exitPrice?: number;
  exitTime?: string;
  exitReason?: 'STOP_LOSS' | 'TAKE_PROFIT' | 'SIGNAL_REVERSAL' | 'MANUAL' | 'SCALP_TARGET' | 'SCALP_STOP' | 'SCALP_REVERSAL';
}

// ===================== Performance ==============================

export interface PerformanceMetrics {
  totalReturn: number;
  totalReturnPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
}

// ========================= Logging ==============================

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'TRADE';
  message: string;
  details?: unknown;
}

// ===================== API Responses ============================

export interface DashboardData {
  portfolio: Portfolio;
  trades: Trade[];
  btcPrice: number;
  totalValue: number;
  performance: PerformanceMetrics;
  lastSignal: CompositeSignal | null;
  logs: LogEntry[];
}

export interface ChartData {
  candles: Candle[];
  indicators: IndicatorSeries;
  trades: { time: number; action: string; price: number }[];
}

export interface SignalSnapshot {
  composite: CompositeSignal;
  risk: RiskParameters | null;
}

// ================== Free Data Mesh (Autonomous AI) ===============

/** Health status of a data feed for a given asset + timeframe. */
export type FeedHealthStatus = 'GOOD' | 'DEGRADED' | 'BAD';

/** Source that provided the market data. */
export type DataSource = 'KRAKEN' | 'YAHOO' | 'COINGECKO' | 'CACHE';

/** Crypto market sentiment snapshot from free public APIs. */
export interface SentimentSnapshot {
  fearGreedIndex: number;          // 0-100 (0 = extreme fear, 100 = extreme greed)
  fearGreedLabel: string;          // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  timestamp: string;
  source: string;
  cacheAgeSeconds: number;
}

/** Health report for a specific asset + timeframe data feed. */
export interface FeedHealthReport {
  asset: string;
  timeframe: string;
  status: FeedHealthStatus;
  score: number;                   // 0-100, higher = healthier
  stale: boolean;
  missingCandles: number;
  duplicateCandles: number;
  zeroVolumeCandles: number;
  abnormalRangeCandles: number;
  sourceAgreementScore: number;    // 0-1, how well sources agree on price
  primarySource: DataSource;
  fallbackUsed: boolean;
  cacheAgeSeconds: number;
  apiFailureStreak: number;
  lastUpdated: string;
  warnings: string[];
}

/** Normalized market data frame with health metadata — the AI's primary input. */
export interface FreeMarketFrame {
  asset: string;
  category: 'crypto' | 'forex' | 'commodity';
  timeframe: Timeframe;
  candles: Candle[];
  currentPrice: number;
  openInterest?: number;
  fundingRate?: number;
  primarySource: DataSource;
  fallbackUsed: boolean;
  cacheAgeSeconds: number;
  stale: boolean;
  sourceAgreementScore: number;
  feedHealth: FeedHealthReport;
  warnings: string[];
  sentiment?: SentimentSnapshot;
}

// ================== Market World Model (Autonomous AI) ===========

/** Extended regime classification beyond simple trending/mean-reverting. */
export type MarketRegime =
  | 'STRONG_TREND_UP'
  | 'WEAK_TREND_UP'
  | 'STRONG_TREND_DOWN'
  | 'WEAK_TREND_DOWN'
  | 'MEAN_REVERTING'
  | 'SQUEEZE'
  | 'BREAKOUT'
  | 'PANIC'
  | 'FAKEOUT_RISK'
  | 'CHOPPY'
  | 'SCALP';

/** Volatility regime categorization. */
export type VolatilityRegime = 'ULTRA_LOW' | 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

/** Directional bias for the AI to reason about. */
export type DirectionalBias = 'STRONG_BULL' | 'LEAN_BULL' | 'NEUTRAL' | 'LEAN_BEAR' | 'STRONG_BEAR';

/** Support/resistance zone identified from price action. */
export interface PriceZone {
  level: number;
  type: 'SUPPORT' | 'RESISTANCE';
  strength: number;       // 0-1
  touchCount: number;
  lastTouch: number;      // Unix timestamp
}

/** The AI's structured understanding of the current market state. */
export interface MarketWorldModel {
  asset: string;
  currentPrice: number;
  openInterest?: number;           // Deep Sensor: Total open futures contracts
  fundingRate?: number;            // Deep Sensor: Perpetual futures funding rate
  regime: MarketRegime;
  directionalBias: DirectionalBias;
  biasScore: number;               // -100 to +100 (negative = bearish)
  tradeability: number;            // 0-100 (should the AI trade at all?)
  volatilityRegime: VolatilityRegime;
  atrPercent: number;              // ATR as percentage of price
  trendStrength: number;           // 0-100
  momentumScore: number;           // -100 to +100
  meanReversionSignal: number;     // -100 to +100 (positive = oversold bounce likely)
  priceZones: PriceZone[];
  nearestSupport: number | null;
  nearestResistance: number | null;
  keyLevels: string[];             // Human-readable level descriptions
  dataQuality: number;             // 0-100 from feed health
  sentimentScore: number | null;   // 0-100 Fear & Greed
  newsCatalyst?: {
    sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'PANIC';
    score: number;
    reasoning: string;
  };
  hurstExponent: number;
  volatilityPercentile: number;
  warnings: string[];
  generatedAt: string;
}

// ================== Autonomous Brain & Risk (Section 3) ==========

/** Immutable physics of the trading account. */
export interface RiskGovernorLimits {
  maxLeverage: number;
  maxDrawdownPercent: number;
  maxPositionSizeUsd: number;
  minStopLossPercent: number;
  maxStopLossPercent: number;
  maxDailyTrades: number;
  haltTradingIfDataBad: boolean;
}

/** The raw decision output from the LLM Brain. */
export interface BrainDecision {
  action: 'BUY' | 'SELL' | 'SHORT' | 'COVER' | 'HOLD' | 'REQUEST_DATA';
  dataRequest?: {
    timeframe: string;
    indicator?: string;
  };
  confidence: number;            // 0.0 - 1.0
  conviction: 'LOW' | 'MEDIUM' | 'HIGH';
  thesis: string;                // The AI's justification
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  suggestedSizeUsd: number | null; // AI can request a size, Risk Governor approves/denies
  timeHorizon: 'SCALP' | 'DAY' | 'SWING';
  expected15mDirection: 'UP' | 'DOWN' | 'SIDEWAYS';
  expected1hDirection: 'UP' | 'DOWN' | 'SIDEWAYS';
  expected4hDirection: 'UP' | 'DOWN' | 'SIDEWAYS';
}

/** The final, risk-approved decision ready for execution. */
export interface AutonomousDecision extends BrainDecision {
  id: string;
  asset: string;
  approvedSizeUsd: number;
  riskAdjustedStopLoss: number | null;
  riskAdjustedTakeProfit: number | null;
  blockedByRisk: boolean;
  riskBlockReason: string | null;
  timestamp: string;
}

// ================== Realistic Paper Exchange (Section 4) =========

/** Estimation of expected slippage based on volatility. */
export interface SlippageEstimate {
  expectedSlippagePercent: number;
  expectedSlippageUsd: number;
  worstCaseSlippageUsd: number;
}

/** Simulated execution fill quality. */
export type ExecutionQuality = 'PERFECT' | 'SLIPPED' | 'REJECTED_ILLIQUID' | 'GAP_THROUGH';

/** Result of a paper order fill attempt. */
export interface OrderFill {
  success: boolean;
  fillPrice: number;
  requestedPrice: number;
  slippageIncurredUsd: number;
  feeIncurredUsd: number;
  quality: ExecutionQuality;
  rejectionReason: string | null;
  timestamp: string;
}

// ================== Memory & Learning (Section 5) ================

export type DirectionExpectation = "UP" | "DOWN" | "SIDEWAYS";

export interface PredictionRecord {
  decisionId: string;
  asset: string;
  timestamp: string;
  entryPrice: number;
  action: string;
  confidence: number;
  predicted15m: DirectionExpectation;
  predicted1h: DirectionExpectation;
  predicted4h: DirectionExpectation;
  actual15m?: DirectionExpectation;
  actual1h?: DirectionExpectation;
  actual4h?: DirectionExpectation;
  price15m?: number;
  price1h?: number;
  price4h?: number;
  score15m?: number;
  score1h?: number;
  score4h?: number;
  directionScore?: number;
  calibrationScore?: number;
  resolved: boolean;
  pruned?: boolean;
  prunedReason?: string;
}

export interface PredictionScoreRecord {
  id: string;
  decisionId: string;
  asset: string;
  horizon: "15m" | "1h" | "4h";
  predicted: DirectionExpectation;
  actual: DirectionExpectation;
  score: number;
  confidence: number;
  calibrationScore: number;
  resolvedAt: string;
  action: string;
}

export interface PredictionPerformanceSummary {
  totalResolved: number;
  totalOpen: number;
  accuracy: number;
  calibrationScore: number;
  accuracy15m: number;
  accuracy1h: number;
  accuracy4h: number;
  recentCorrect: number;
  recentWrong: number;
}

/** A ledger entry representing the AI's prediction and the ultimate reality. */
export interface TradeJournalEntry {
  tradeId: string;
  asset: string;
  entryTime: string;
  exitTime: string;
  regimeAtEntry: MarketRegime;
  aiThesis: string;
  predictedDirection: 'LONG' | 'SHORT';
  actualPnlUsd: number;
  actualPnlPercent: number;
  wasPredictionCorrect: boolean;
  mistakesMade: string[];
  lessonsLearned: string[];
}

export interface DynamicParameters {
  rsiOverbought: number;      // Default: 65
  rsiOversold: number;        // Default: 40
  macdHistogramMin: number;   // Default: 0
  stochRsiOverbought: number; // Default: 85
  stochRsiOversold: number;   // Default: 15
  vwapDeviationPercent: number; // Default: 0.5
}

/** Summarized memory extracted by the reflection engine. */
export interface ReflectionSummary {
  timestamp: string;
  tradesAnalyzed: number;
  winRate: number;
  topMistake: string;
  actionableRule: string; // E.g., "Stop buying breakouts in MEAN_REVERTING regimes."
  optimizedParameters?: DynamicParameters;
}
