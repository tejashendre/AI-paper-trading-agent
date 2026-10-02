// ================================================================
// Bitcoin Quant Trading System — Shared Type Definitions
// Single source of truth for all modules.
// ================================================================

// Type-only: keeps the registry's runtime code out of client bundles.
import type { EconomicsModel, InstrumentRef } from "@/lib/trading/instrumentRegistry";

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

export type PaperMarginMode = 'PROBE' | 'STANDARD' | 'STRONG';

export interface StrategyProvenance {
  strategyFamily?: string;
  strategyConfigHash?: string;
  strategyDataSchemaVersion?: string;
  strategyRegime?: string;
  candidateId?: string;
  featureCutoffMs?: number;
}
export interface OpenPosition extends StrategyProvenance {
  asset: string;          // E.g., 'BTC', 'ETH', 'EURUSD', 'GOLD'
  entryPrice: number;
  amount: number;         // Sized asset amount (e.g. BTC amount, Gold ounces, Forex units)
  btcAmount: number;      // Deprecated/Compatibility helper
  usdInvested: number;
  stopLoss: number;
  /** Immutable protective stop basis used for trailing calculations. */
  initialStopLoss?: number;
  takeProfit: number;
  entryTime: string;
  signalScore: number;
  reasoning: string;
  direction: 'LONG' | 'SHORT';
  isScalp?: boolean;
  entryFeePaid?: number;
  notionalUsd?: number;
  leverageUsed?: number;
  marginMode?: PaperMarginMode;
  marginPolicyVersion?: string;
  riskAmountUsd?: number;
  maxLossUsd?: number;
  admissionScore?: number;
  learningRiskMultiplier?: number;
  learningAdjustment?: number;
  setupRiskMultiplier?: number;
  setupRiskReason?: string;
  finalConviction?: number;
  decisionState?: string;
  setupTags?: string[];
  dataQuality?: number;
  triggerScore?: number;
  marketStructureScore?: number;
  microstructureScore?: number;
  microstructureSummary?: string;
  fundingRate?: number;
  openInterest?: number;
  orderbookImbalanceRatio?: number;
  liquidityState?: string;
  paperSize?: string;
  entryMode?: 'STANDARD' | 'CONTROLLED_PROBE';
  strategyType?: 'swing' | 'manual' | 'scalp';
  highestPriceReached?: number;
  lowestPriceReached?: number;
  isTrailing?: boolean;
  scaleInCount?: number;
  partialExitCount?: number;
  lastScaleInTime?: string;
  lastPartialExitTime?: string;
  maxUnrealizedPnlUsd?: number;
  maxUnrealizedPnlTime?: string;
  thesisStatus?: 'VALID' | 'WEAKENING' | 'INVALID' | 'OPPOSITE_EDGE_CONFIRMED';
  thesisReason?: string;
  lastThesisCheckTime?: string;
  scaleInBlockedReason?: string;
  targetReachabilityScore?: number;
  rawTakeProfit?: number;
  targetAdjustedReason?: string;
  netRewardRiskRatio?: number;
  strategyVersion?: string;
  marketRegime?: 'TRENDING' | 'MEAN_REVERTING' | 'CHOPPY' | 'UNKNOWN';
  executionCostModelVersion?: string;
  executionVenueModel?: string;
  marketDataProvider?: string;
  marketDataSource?: string;
  marketDataVenue?: string;
  marketDataInstrument?: string;
  marketDataTimestamp?: string;
  marketDataBid?: number;
  marketDataAsk?: number;
  entryRequestedPrice?: number;
  entryExecutionCostUsd?: number;
  entryPriceImpactCostUsd?: number;
  assumedRoundTripExecutionCostUsd?: number;
  expectedNetRewardUsd?: number;
  expectedNetLossUsd?: number;
  carryCostPaid?: number;
  /** Stable identity shared by the entry, scale-ins and every exit leg. */
  positionId?: string;
  /**
   * Contract and economic model frozen when the position opened. Absent on
   * pre-upgrade records, which read as their legacy model; never rewritten
   * from today's registry.
   */
  instrument?: InstrumentRef;
  economicsModel?: EconomicsModel;
  /** Modeled net loss at the initial stop, fixed at entry. */
  initialRiskUsdt?: number;
  costModelVersion?: string;
  riskPolicyVersion?: string;
  /** Fields added by a state migration; deleting them restores the original record. */
  migrationAddedFields?: string[];
  /** Order book and turnover observed for the entry fill, with the capacity policy version. */
  fillLiquidity?: Record<string, unknown>;
  /** Fee schedule version the entry was costed with. */
  feeScheduleVersion?: string;
  /** Fills that changed the held quantity, for funding at each boundary. */
  quantityLegs?: Array<{ atMs: number; quantityDelta: number }>;
  /** Signed funding already booked to cash (positive received). */
  fundingBookedUsdt?: number;
  /** Booked funding already attributed to exit legs. */
  fundingAllocatedUsdt?: number;
  /** Settlement boundaries already booked; the idempotency key with positionId. */
  fundingSettledTimes?: number[];
  /** Boundaries held through whose settlement data is not yet available. */
  fundingPendingTimes?: number[];
}

/** A ledger event already reflected in persisted state and waiting to be appended. */
export interface PendingLedgerEvent {
  id: string;
  type: "FUNDING_SETTLED";
  source: string;
  asset: string;
  positionId: string;
  timestamp: string;
  payload: unknown;
}

/** A closed position whose funding boundaries are still awaiting settlement data. */
export interface FundingTail {
  positionId: string;
  asset: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  quantityLegs: Array<{ atMs: number; quantityDelta: number }>;
  settledTimes: number[];
  pendingTimes: number[];
  closedAtMs: number;
}

export interface InstrumentMigrationMarker {
  version: string;
  appliedAtMs: number;
  /** Hash of every migrated record with migration-added fields removed. */
  originalHash: string;
  previousAccountingCurrency: "USD_PROXY";
  accountingAssumption: string;
  /** Account fields this migration added. */
  addedFields: string[];
  /** Assets whose new entries wait until a provenance conflict is resolved. */
  blockedAssets: Record<string, string>;
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
  totalExecutionCostsPaid?: number; // Fees + spread/slippage/gap/carry assumptions
  totalCarryPaid?: number;
  /**
   * Unit of the cash fields. Absent means the historical nominal USD proxy.
   * "USDT" after migration is a labeled paper-account assumption, not an
   * executed currency conversion.
   */
  accountingCurrency?: "USD_PROXY" | "USDT";
  instrumentMigration?: InstrumentMigrationMarker;
  /** Written in the same object as the cash they describe, then drained to the ledger. */
  pendingLedgerEvents?: PendingLedgerEvent[];
  fundingTail?: FundingTail[];
  lastUpdated: string;
}

export interface Trade extends StrategyProvenance {
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
  finalConviction?: number;
  decisionState?: string;
  setupTags?: string[];
  dataQuality?: number;
  triggerScore?: number;
  marketStructureScore?: number;
  microstructureScore?: number;
  microstructureSummary?: string;
  fundingRate?: number;
  openInterest?: number;
  orderbookImbalanceRatio?: number;
  liquidityState?: string;
  paperSize?: string;
  entryMode?: 'STANDARD' | 'CONTROLLED_PROBE';
  setupRiskMultiplier?: number;
  setupRiskReason?: string;
  learningRiskMultiplier?: number;
  learningAdjustment?: number;
  targetReachabilityScore?: number;
  rawTakeProfit?: number;
  targetAdjustedReason?: string;
  netRewardRiskRatio?: number;
  strategyVersion?: string;
  marketRegime?: 'TRENDING' | 'MEAN_REVERTING' | 'CHOPPY' | 'UNKNOWN';
  executionCostModelVersion?: string;
  executionVenueModel?: string;
  marketDataProvider?: string;
  marketDataSource?: string;
  marketDataVenue?: string;
  marketDataInstrument?: string;
  marketDataTimestamp?: string;
  marketDataBid?: number;
  marketDataAsk?: number;
  requestedPrice?: number;
  notionalUsd?: number;
  leverageUsed?: number;
  marginMode?: PaperMarginMode;
  marginPolicyVersion?: string;
  riskAmountUsd?: number;
  maxLossUsd?: number;
  entryFeeUsd?: number;
  exitFeeUsd?: number;
  grossPnlUsd?: number;
  carryCostUsd?: number;
  executionCostUsd?: number;
  entryExecutionCostUsd?: number;
  exitExecutionCostUsd?: number;
  totalRoundTripExecutionCostUsd?: number;
  spreadCostUsd?: number;
  slippageCostUsd?: number;
  gapCostUsd?: number;
  reasoning: string;
  isPartialExit?: boolean;
  /** Position this leg belongs to; shared by entry, scale-in and exit legs. */
  positionId?: string;
  instrument?: InstrumentRef;
  economicsModel?: EconomicsModel;
  /** The position's initial risk, repeated on each leg so outcomes survive history trimming. */
  initialRiskUsdt?: number;
  riskPolicyVersion?: string;
  migrationAddedFields?: string[];
  fillLiquidity?: Record<string, unknown>;
  feeScheduleVersion?: string;
  /** Booked funding attributed to this exit leg (positive received). */
  fundingCashflowUsdt?: number;
  /** PENDING_RECONCILIATION when some boundaries still await settlement data. */
  fundingStatus?: "SETTLED" | "PENDING_RECONCILIATION";
  // Filled when position is closed:
  pnl?: number;
  pnlPercent?: number;
  entryPrice?: number;
  entryTime?: string;
  exitPrice?: number;
  exitTime?: string;
  exitReason?: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP_PROFIT' | 'BREAKEVEN_STOP' | 'SIGNAL_INVALIDATION' | 'TIME_STOP' | 'DATA_SAFETY_EXIT' | 'SIGNAL_REVERSAL' | 'MANUAL' | 'SCALP_TARGET' | 'SCALP_STOP' | 'SCALP_REVERSAL';
}

// ========================= Logging ==============================

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'TRADE';
  message: string;
  details?: unknown;
}

// ================== Free Data Mesh (Autonomous AI) ===============

/** Health status of a data feed for a given asset + timeframe. */
export type FeedHealthStatus = 'GOOD' | 'DEGRADED' | 'BAD';

/** Source that provided the market data. */
export type DataSource = 'BYBIT_LINEAR' | 'KRAKEN' | 'YAHOO' | 'COINGECKO' | 'CACHE';

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
