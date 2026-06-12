import { Candle } from "@/lib/types";
import { MarketService } from "./market";
import { computeAllIndicators, getLatestSnapshot } from "./indicators";
import { computeStatistics } from "./statistics";
import { LocalLearningMemory } from "./trading/localLearning";

export type SwingDecisionState =
  | "NO_BIAS"
  | "WATCH_LONG"
  | "WATCH_SHORT"
  | "TRIGGER_PENDING"
  | "ENTRY_READY"
  | "HIGH_ACCURACY_EXCEPTION"
  | "BLOCKED_DATA";

export interface EntryGateDiagnostics {
  htfPassed: boolean;
  triggerPassed: boolean;
  structurePassed: boolean;
  microstructurePassed: boolean;
  convictionPassed: boolean;
  dataPassed: boolean;
  slippagePassed: boolean;
  learningPassed: boolean;
  normalEntry: boolean;
  exceptionEntry: boolean;
  primaryBlocker: string;
  missing: string[];
}

export type LiquidityState =
  | "NEUTRAL"
  | "SELL_SIDE_SWEEP_RECLAIM"
  | "BUY_SIDE_SWEEP_REJECTION"
  | "BUY_SIDE_BREAKOUT_CONTINUATION"
  | "SELL_SIDE_BREAKDOWN_CONTINUATION"
  | "BUYER_TRAP_RISK"
  | "SELLER_TRAP_RISK";

export interface SwingSignal {
  asset: string;
  action: 'SWING_BUY' | 'SWING_SHORT' | 'HOLD';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reasoning: string;
  score: number;
  expectedMove?: number;
  htfScore: number;
  triggerScore: number;
  marketStructureScore: number;
  microstructureScore: number;
  microstructureSummary: string;
  fundingRate?: number;
  openInterest?: number;
  orderbookImbalanceRatio?: number;
  liquidityState: LiquidityState;
  dataQuality: number;
  finalConviction: number;
  decisionState: SwingDecisionState;
  simpleStatus: string;
  simpleReason: string;
  nextStep: string;
  paperSize: "None" | "Probe" | "Normal" | "Strong" | "Heavy";
  riskMode: "Normal" | "Protected" | "Watch Only";
  assetMode: "REALTIME_FAST" | "SLOW_SWING" | "CONDITIONAL_FAST";
  setupTags: string[];
  directionBias: "LONG" | "SHORT" | "NEUTRAL";
  learningAdjustment: number;
  learningRules: string[];
  livePrice: number;
  signalPrice: number;
  slippagePercent: number;
  oldScoreOverride: boolean;
  entryGate: EntryGateDiagnostics;
}

function emptySignal(assetKey: string, reason: string): SwingSignal {
  return {
    asset: assetKey,
    action: "HOLD",
    entryPrice: 0,
    stopLoss: 0,
    takeProfit: 0,
    reasoning: reason,
    score: 0,
    expectedMove: 0,
    htfScore: 0,
    triggerScore: 0,
    marketStructureScore: 0,
    microstructureScore: 0,
    microstructureSummary: "No live flow signal available.",
    fundingRate: undefined,
    openInterest: undefined,
    orderbookImbalanceRatio: undefined,
    liquidityState: "NEUTRAL",
    dataQuality: 0,
    finalConviction: 0,
    decisionState: "BLOCKED_DATA",
    simpleStatus: "Waiting because market data is not reliable enough",
    simpleReason: reason,
    nextStep: "The bot will wait for fresh market data before considering a trade.",
    paperSize: "None",
    riskMode: "Watch Only",
    assetMode: "SLOW_SWING",
    setupTags: [],
    directionBias: "NEUTRAL",
    learningAdjustment: 0,
    learningRules: [],
    livePrice: 0,
    signalPrice: 0,
    slippagePercent: 0,
    oldScoreOverride: false,
    entryGate: {
      htfPassed: false,
      triggerPassed: false,
      structurePassed: false,
      microstructurePassed: false,
      convictionPassed: false,
      dataPassed: false,
      slippagePassed: false,
      learningPassed: false,
      normalEntry: false,
      exceptionEntry: false,
      primaryBlocker: reason,
      missing: [reason],
    },
  };
}

function getAssetMode(assetKey: string): SwingSignal["assetMode"] {
  return assetKey === "BTC" || assetKey === "ETH" || assetKey === "SOL" ? "REALTIME_FAST" : "SLOW_SWING";
}

function scoreDataQuality(assetMode: SwingSignal["assetMode"], livePrice: number, signalPrice: number, candles15m: Candle[], candles1h: Candle[], candles4h: Candle[]) {
  let score = assetMode === "REALTIME_FAST" ? 92 : 72;
  const latest15m = candles15m[candles15m.length - 1]?.time ? candles15m[candles15m.length - 1].time * 1000 : 0;
  const ageMinutes = latest15m ? (Date.now() - latest15m) / 60_000 : 999;

  if (!Number.isFinite(livePrice) || livePrice <= 0) score -= 45;
  if (candles15m.length < 80 || candles1h.length < 80 || candles4h.length < 80) score -= 20;
  if (ageMinutes > (assetMode === "REALTIME_FAST" ? 45 : 240)) score -= 20;

  const priceDistance = signalPrice > 0 ? Math.abs(livePrice - signalPrice) / signalPrice : 1;
  if (priceDistance > 0.01) score -= 15;
  if (priceDistance > 0.025) score -= 20;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreExecutionTrigger(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  assetMode: SwingSignal["assetMode"],
  livePrice: number,
  candles1m: Candle[],
  candles5m: Candle[],
  snap15mVwap: number
) {
  const tags: string[] = [];
  if (direction === "NEUTRAL") return { score: 0, tags, reason: "No directional bias to confirm." };
  if (candles1m.length < 5 || candles5m.length < 5 || !Number.isFinite(livePrice) || livePrice <= 0) {
    return { score: assetMode === "SLOW_SWING" ? 8 : 0, tags, reason: "Short-term confirmation data is limited." };
  }

  const last1m = candles1m[candles1m.length - 1];
  const prev1m = candles1m[candles1m.length - 2];
  const last5m = candles5m[candles5m.length - 1];
  const recent5m = candles5m.slice(-20);
  const avgRange = recent5m.reduce((sum, candle) => sum + Math.abs(candle.high - candle.low), 0) / Math.max(recent5m.length, 1);
  const currentRange = Math.abs(last5m.high - last5m.low);
  const volumeAverage = recent5m.reduce((sum, candle) => sum + (candle.volume || 0), 0) / Math.max(recent5m.length, 1);
  const volumeBurst = volumeAverage > 0 && last5m.volume > volumeAverage * 1.2;
  const vwapOk = direction === "LONG" ? livePrice >= snap15mVwap : livePrice <= snap15mVwap;
  const oneMinuteBreak = direction === "LONG" ? livePrice > prev1m.high : livePrice < prev1m.low;
  const fiveMinuteBody = direction === "LONG" ? last5m.close > last5m.open : last5m.close < last5m.open;
  const volatilityExpansion = avgRange > 0 && currentRange > avgRange * 1.1;

  let score = assetMode === "REALTIME_FAST" ? 4 : 2;
  if (vwapOk) {
    score += 8;
    tags.push(direction === "LONG" ? "VWAP_RECLAIM" : "VWAP_REJECTION");
  }
  if (oneMinuteBreak) {
    score += 7;
    tags.push("LIVE_BREAK_CONFIRMATION");
  }
  if (fiveMinuteBody) {
    score += 5;
    tags.push("5M_DIRECTIONAL_BODY");
  }
  if (volumeBurst) {
    score += 5;
    tags.push("VOLUME_BURST");
  }
  if (volatilityExpansion) {
    score += 4;
    tags.push("VOLATILITY_EXPANSION");
  }

  const reason = tags.length > 0
    ? `Live trigger evidence: ${tags.join(", ")}.`
    : "Live trigger is not confirmed yet.";

  return { score: Math.max(0, Math.min(30, score)), tags, reason };
}

function scoreCryptoMicrostructure(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  assetMode: SwingSignal["assetMode"],
  orderbook: Awaited<ReturnType<typeof MarketService.getOrderbookImbalance>> | null,
  sensors: Awaited<ReturnType<typeof MarketService.getDeepSensors>> | null
): { score: number; aligned: boolean; tags: string[]; reason: string } {
  const tags: string[] = [];
  if (assetMode !== "REALTIME_FAST" || direction === "NEUTRAL") {
    return {
      score: 0,
      aligned: true,
      tags,
      reason: "Live flow is neutral because this asset is not in crypto fast mode.",
    };
  }

  let score = 0;
  const ratio = Number(orderbook?.imbalanceRatio || 1);
  const fundingRate = Number(sensors?.fundingRate);
  const hasOpenInterest = Number.isFinite(Number(sensors?.openInterest)) && Number(sensors?.openInterest) > 0;

  if (Number.isFinite(ratio)) {
    if (direction === "LONG") {
      if (ratio >= 1.25) {
        score += 5;
        tags.push("BID_PRESSURE_SUPPORTS_LONG");
      } else if (ratio <= 0.8) {
        score -= 6;
        tags.push("ASK_PRESSURE_AGAINST_LONG");
      }
    } else if (direction === "SHORT") {
      if (ratio <= 0.8) {
        score += 5;
        tags.push("ASK_PRESSURE_SUPPORTS_SHORT");
      } else if (ratio >= 1.25) {
        score -= 6;
        tags.push("BID_PRESSURE_AGAINST_SHORT");
      }
    }
  }

  if (Number.isFinite(fundingRate)) {
    if (direction === "LONG" && fundingRate < -0.0002) {
      score += 2;
      tags.push("FUNDING_SUPPORTS_LONG_SQUEEZE");
    } else if (direction === "LONG" && fundingRate > 0.0008) {
      score -= 3;
      tags.push("CROWDED_LONG_FUNDING");
    } else if (direction === "SHORT" && fundingRate > 0.0002) {
      score += 2;
      tags.push("FUNDING_SUPPORTS_SHORT_PRESSURE");
    } else if (direction === "SHORT" && fundingRate < -0.0008) {
      score -= 3;
      tags.push("CROWDED_SHORT_FUNDING");
    }
  }

  if (hasOpenInterest) {
    score += 1;
    tags.push("OPEN_INTEREST_SENSOR_ONLINE");
  }

  const boundedScore = Math.max(-10, Math.min(10, Math.round(score)));
  const aligned = boundedScore > -6;
  const reason = tags.length > 0
    ? `Crypto live-flow evidence: ${tags.join(", ")}.`
    : "Crypto live-flow evidence is neutral.";

  return { score: boundedScore, aligned, tags, reason };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function slope(values: number[]): number {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  return first !== 0 ? (last - first) / first : 0;
}

function scoreMarketStructureLiquidity(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  livePrice: number,
  candles15m: Candle[],
  candles1h: Candle[]
): { score: number; aligned: boolean; state: LiquidityState; tags: string[]; reason: string } {
  const tags: string[] = [];
  if (direction === "NEUTRAL") {
    return { score: 0, aligned: true, state: "NEUTRAL", tags, reason: "No directional market-structure bias yet." };
  }
  if (candles15m.length < 30 || candles1h.length < 12 || !Number.isFinite(livePrice) || livePrice <= 0) {
    return { score: 0, aligned: true, state: "NEUTRAL", tags, reason: "Market-structure data is limited, so liquidity alignment is neutral." };
  }

  const last15m = candles15m[candles15m.length - 1];
  const recent15m = candles15m.slice(Math.max(0, candles15m.length - 42), candles15m.length - 2);
  const recentHigh = Math.max(...recent15m.map((candle) => candle.high));
  const recentLow = Math.min(...recent15m.map((candle) => candle.low));
  const avgVolume = average(recent15m.map((candle) => candle.volume || 0));
  const range = Math.max(last15m.high - last15m.low, Number.EPSILON);
  const closeLocation = (last15m.close - last15m.low) / range;
  const oneHourSlope = slope(candles1h.slice(-24).map((candle) => candle.close));
  const trendAligned = direction === "LONG" ? oneHourSlope >= 0 : oneHourSlope <= 0;
  const volumeExpansion = avgVolume > 0 && (last15m.volume || 0) > avgVolume * 1.15;

  let score = 0;
  let state: LiquidityState = "NEUTRAL";

  if (trendAligned) {
    score += 4;
    tags.push("STRUCTURE_ALIGNED");
  } else {
    score -= 5;
    tags.push("STRUCTURE_AGAINST_TREND");
  }

  if (volumeExpansion) {
    score += 3;
    tags.push("VOLUME_CONFIRMED_STRUCTURE");
  }

  if (direction === "LONG") {
    const sellSideSweepReclaim = last15m.low < recentLow && last15m.close > recentLow && closeLocation >= 0.55;
    const buySideBreakout = last15m.close > recentHigh && volumeExpansion && closeLocation >= 0.6;
    const buyerTrapRisk = last15m.high > recentHigh && last15m.close < recentHigh && closeLocation <= 0.45;

    if (sellSideSweepReclaim) {
      score += 8;
      state = "SELL_SIDE_SWEEP_RECLAIM";
      tags.push("SELL_SIDE_LIQUIDITY_RECLAIM");
    } else if (buySideBreakout) {
      score += 6;
      state = "BUY_SIDE_BREAKOUT_CONTINUATION";
      tags.push("BUY_SIDE_BREAKOUT_CONTINUATION");
    } else if (buyerTrapRisk) {
      score -= 16;
      state = "BUYER_TRAP_RISK";
      tags.push("LIQUIDITY_TRAP_RISK");
    }
  } else {
    const buySideSweepReject = last15m.high > recentHigh && last15m.close < recentHigh && closeLocation <= 0.45;
    const sellSideBreakdown = last15m.close < recentLow && volumeExpansion && closeLocation <= 0.4;
    const sellerTrapRisk = last15m.low < recentLow && last15m.close > recentLow && closeLocation >= 0.55;

    if (buySideSweepReject) {
      score += 8;
      state = "BUY_SIDE_SWEEP_REJECTION";
      tags.push("BUY_SIDE_LIQUIDITY_REJECTION");
    } else if (sellSideBreakdown) {
      score += 6;
      state = "SELL_SIDE_BREAKDOWN_CONTINUATION";
      tags.push("SELL_SIDE_BREAKDOWN_CONTINUATION");
    } else if (sellerTrapRisk) {
      score -= 16;
      state = "SELLER_TRAP_RISK";
      tags.push("LIQUIDITY_TRAP_RISK");
    }
  }

  const boundedScore = Math.max(-16, Math.min(18, Math.round(score)));
  const permittedState =
    state === "SELL_SIDE_SWEEP_RECLAIM" ||
    state === "BUY_SIDE_BREAKOUT_CONTINUATION" ||
    state === "BUY_SIDE_SWEEP_REJECTION";
  const aligned = permittedState && boundedScore >= 2;
  const reason = aligned
    ? `Market structure is ${state === "NEUTRAL" ? "neutral" : state.toLowerCase().replace(/_/g, " ")} with liquidity score ${boundedScore}.`
    : `Market structure warns of ${state.toLowerCase().replace(/_/g, " ")}; waiting to avoid a trap trade.`;

  return { score: boundedScore, aligned, state, tags, reason };
}

function paperSizeFromConviction(conviction: number): SwingSignal["paperSize"] {
  if (conviction >= 90) return "Heavy";
  if (conviction >= 80) return "Strong";
  if (conviction >= 70) return "Normal";
  if (conviction >= 60) return "Probe";
  return "None";
}

function simpleStateText(state: SwingDecisionState, direction: "LONG" | "SHORT" | "NEUTRAL") {
  if (state === "ENTRY_READY") return "Trade setup confirmed";
  if (state === "HIGH_ACCURACY_EXCEPTION") return "Special high-confidence setup";
  if (state === "WATCH_LONG") return "Watching for a buy setup";
  if (state === "WATCH_SHORT") return "Watching for a short setup";
  if (state === "TRIGGER_PENDING") return "Almost ready, waiting for final confirmation";
  if (state === "BLOCKED_DATA") return "Waiting because market data is not reliable enough";
  return direction === "SHORT" ? "No clear short opportunity yet" : direction === "LONG" ? "No clear buy opportunity yet" : "No clear opportunity yet";
}

function buildEntryGateDiagnostics(input: {
  assetMode: SwingSignal["assetMode"];
  htfScore: number;
  triggerScore: number;
  finalConviction: number;
  dataQuality: number;
  slippageOk: boolean;
  structureAligned: boolean;
  microstructureAligned: boolean;
  learningWatchOnly: boolean;
  normalEntry: boolean;
  exceptionEntry: boolean;
}): EntryGateDiagnostics {
  const triggerThreshold = input.assetMode === "REALTIME_FAST" ? 14 : 8;
  const htfPassed = input.htfScore >= 14;
  const exceptionHtfPassed = input.htfScore >= 8 && input.htfScore < 14;
  const triggerPassed = input.triggerScore >= triggerThreshold;
  const structurePassed = input.structureAligned;
  const microstructurePassed = input.microstructureAligned;
  const convictionPassed = input.finalConviction >= 60;
  const dataPassed = input.dataQuality >= 60;
  const learningPassed = !input.learningWatchOnly;
  const missing: string[] = [];

  if (!learningPassed) missing.push("local learning has this pattern in watch-only mode");
  if (!dataPassed) missing.push("market data quality is below the live-trading minimum");
  if (!input.slippageOk) missing.push("live price moved too far from the signal candle");
  if (!structurePassed) missing.push("market structure and liquidity are not aligned with the trade direction");
  if (!microstructurePassed) missing.push("live order-book or funding flow is against the setup");
  if (!htfPassed && !exceptionHtfPassed) missing.push("higher-timeframe evidence is still too weak");
  if (!triggerPassed) missing.push("short-term trigger is not confirmed yet");
  if (!convictionPassed) missing.push("final conviction is below the entry minimum");

  return {
    htfPassed,
    triggerPassed,
    structurePassed,
    microstructurePassed,
    convictionPassed,
    dataPassed,
    slippagePassed: input.slippageOk,
    learningPassed,
    normalEntry: input.normalEntry,
    exceptionEntry: input.exceptionEntry,
    primaryBlocker: missing[0] || "all entry gates passed",
    missing,
  };
}

export class SwingEngine {
  /**
   * Analyzes an asset for higher-timeframe swing opportunities (15m, 1h, 4h).
   * Swings focus on robust structural moves, immune to 1m noise.
   */
  static async analyze(assetKey: string = "BTC"): Promise<SwingSignal> {
    try {
      const assetMode = getAssetMode(assetKey);
      // 1. Fetch multi-timeframe candles (Higher Timeframes)
      const [candles1mResult, candles5mResult, candles15m, candles1h, candles4h, candles1w, livePriceResult, orderbookResult, deepSensors] = await Promise.all([
        MarketService.getCandles("1m", 80, assetKey).catch(() => [] as Candle[]),
        MarketService.getCandles("5m", 80, assetKey).catch(() => [] as Candle[]),
        MarketService.getCandles("15m", 100, assetKey),
        MarketService.getCandles("1h", 100, assetKey),
        MarketService.getCandles("4h", 100, assetKey),
        MarketService.getWeeklyCandles(20, assetKey).catch(() => [] as Candle[]),
        MarketService.getCurrentPrice(assetKey).catch(() => 0),
        assetMode === "REALTIME_FAST" ? MarketService.getOrderbookImbalance(assetKey).catch(() => null) : Promise.resolve(null),
        assetMode === "REALTIME_FAST" ? MarketService.getDeepSensors(assetKey).catch(() => null) : Promise.resolve(null)
      ]);

      if (candles15m.length === 0 || candles1h.length === 0 || candles4h.length === 0) {
        return emptySignal(assetKey, "Insufficient historical data");
      }

      // Compute indicators
      const ind15m = computeAllIndicators(candles15m);
      const ind1h = computeAllIndicators(candles1h);
      const ind4h = computeAllIndicators(candles4h);

      const snap15m = getLatestSnapshot(candles15m, ind15m);
      const snap1h = getLatestSnapshot(candles1h, ind1h);
      const snap4h = getLatestSnapshot(candles4h, ind4h);

      computeStatistics(candles15m, snap15m, ind15m.atr);
      const stats1h = computeStatistics(candles1h, snap1h, ind1h.atr);
      const stats4h = computeStatistics(candles4h, snap4h, ind4h.atr);
      
      const signalPrice = snap15m.price;
      const livePrice = Number(livePriceResult) > 0 ? Number(livePriceResult) : signalPrice;
      const dataQuality = scoreDataQuality(assetMode, livePrice, signalPrice, candles15m, candles1h, candles4h);

      // 2. Regime Filter Setup (Based on 1H structural data)
      const isMeanReverting = stats1h.hurstExponent < 0.55;
      const isVolatilitySqueeze = stats1h.volatilityPercentile < 30;

      // 3. Quantitative Confluence Signal Calculations
      let buyScore = 0;
      let shortScore = 0;
      const details: string[] = [];

      // A. HTF Z-Score Reversion (1H)
      const zScore1h = stats1h.priceZScore;
      if (isMeanReverting) {
        if (zScore1h < -2.5) {
          buyScore += 10;
          details.push(`1H Z-Score Oversold (${zScore1h.toFixed(2)}) + Mean Reversion`);
        } else if (zScore1h > 2.5) {
          shortScore += 10;
          details.push(`1H Z-Score Overbought (${zScore1h.toFixed(2)}) + Mean Reversion`);
        }
      }

      // B. Structural Momentum Breakout (4H)
      if (stats4h.hurstExponent > 0.60) {
        if (stats4h.regressionSlope > 0 && stats1h.priceZScore < 1.0) {
          buyScore += 8;
          details.push(`4H Structural Uptrend (Hurst: ${stats4h.hurstExponent.toFixed(2)})`);
        } else if (stats4h.regressionSlope < 0 && stats1h.priceZScore > -1.0) {
          shortScore += 8;
          details.push(`4H Structural Downtrend (Hurst: ${stats4h.hurstExponent.toFixed(2)})`);
        }
      }

      // C. HTF Volatility Squeeze Breakout
      if (stats4h.volatilityPercentile < 20 && stats1h.volatilityPercentile > 40) {
        if (stats1h.regressionSlope > 0) {
          buyScore += 6;
          details.push("HTF Volatility Squeeze Breakout (Bullish)");
        } else {
          shortScore += 6;
          details.push("HTF Volatility Squeeze Breakout (Bearish)");
        }
      }

      // D. Institutional VWAP Deviations (15m execution trigger)
      const vwapDeviation = (livePrice - snap15m.vwap) / snap15m.vwap;
      if (isMeanReverting) {
        if (vwapDeviation < -0.015) { // 1.5% below VWAP is extreme for 15m
          buyScore += 5;
          details.push("Extreme HTF VWAP Deviation (Oversold)");
        } else if (vwapDeviation > 0.015) {
          shortScore += 5;
          details.push("Extreme HTF VWAP Deviation (Overbought)");
        }
      }

      // 4. Determine Action
      let action: 'SWING_BUY' | 'SWING_SHORT' | 'HOLD' = 'HOLD';
      let finalScore = 0;
      const bestDirection: "LONG" | "SHORT" | "NEUTRAL" = buyScore > shortScore ? "LONG" : shortScore > buyScore ? "SHORT" : "NEUTRAL";
      const htfScore = Math.max(buyScore, shortScore);
      const trigger = scoreExecutionTrigger(bestDirection, assetMode, livePrice, candles1mResult, candles5mResult, snap15m.vwap);
      const liquidity = scoreMarketStructureLiquidity(bestDirection, livePrice, candles15m, candles1h);
      const microstructure = scoreCryptoMicrostructure(bestDirection, assetMode, orderbookResult, deepSensors);
      const setupTags = [...details, ...trigger.tags, ...liquidity.tags, ...microstructure.tags];
      const learning = await LocalLearningMemory.getAdjustment(assetKey, setupTags);
      const triggerScore = trigger.score;
      const dataScore = Math.round(dataQuality / 5);
      const riskRewardScore = 10;
      let finalConviction = Math.max(0, Math.min(100, Math.round(htfScore * 2.2 + triggerScore * 1.4 + liquidity.score + microstructure.score + dataScore + riskRewardScore + learning.adjustment)));
      
      // Weekly bias adjustment
      let weeklyBiasAdjustment = 0;
      if (candles1w.length >= 8) {
        const weeklyCloses = candles1w.slice(-8).map((c) => c.close);
        const weeklyEma8 = weeklyCloses.reduce((sum, v) => sum + v, 0) / weeklyCloses.length;
        const weeklyTrend = livePrice > weeklyEma8 ? "BULLISH" : "BEARISH";

        if (bestDirection === "LONG" && weeklyTrend === "BULLISH") {
          weeklyBiasAdjustment = 5;
        } else if (bestDirection === "SHORT" && weeklyTrend === "BEARISH") {
          weeklyBiasAdjustment = 5;
        } else if (bestDirection !== "NEUTRAL") {
          weeklyBiasAdjustment = -8;
        }
      }
      finalConviction = Math.max(0, Math.min(100, finalConviction + weeklyBiasAdjustment));
      
      const slippagePercent = signalPrice > 0 ? Math.abs(livePrice - signalPrice) / signalPrice * 100 : 0;
      const allowedSlippage = assetMode === "REALTIME_FAST" ? 0.25 : 0.60;
      const slippageOk = slippagePercent <= allowedSlippage;
      const normalEntry = !learning.watchOnly && liquidity.aligned && microstructure.aligned && htfScore >= 14 && triggerScore >= (assetMode === "REALTIME_FAST" ? 14 : 8) && finalConviction >= 60 && dataQuality >= 60 && slippageOk;
      const exceptionEntry = !learning.watchOnly && liquidity.aligned && microstructure.aligned && htfScore >= 8 && htfScore < 14 && assetMode === "REALTIME_FAST" && triggerScore >= 24 && dataQuality >= 85 && finalConviction >= 75 && slippageOk;
      const entryGate = buildEntryGateDiagnostics({
        assetMode,
        htfScore,
        triggerScore,
        finalConviction,
        dataQuality,
        slippageOk,
        structureAligned: liquidity.aligned,
        microstructureAligned: microstructure.aligned,
        learningWatchOnly: learning.watchOnly,
        normalEntry,
        exceptionEntry,
      });
      const htfAtr = snap1h.atr;
      const currentPrice = livePrice;
      const expectedMovePercent = currentPrice > 0 ? (htfAtr / currentPrice) * 100 : 0;
      const stopDistance = htfAtr * 1.5;
      const takeProfitDistance = htfAtr * 3.0;
      const plannedStopLoss = bestDirection === "LONG"
        ? currentPrice - stopDistance
        : bestDirection === "SHORT"
          ? currentPrice + stopDistance
          : 0;
      const plannedTakeProfit = bestDirection === "LONG"
        ? currentPrice + takeProfitDistance
        : bestDirection === "SHORT"
          ? currentPrice - takeProfitDistance
          : 0;

      // Require strong HTF alignment (score >= 14)
      if ((normalEntry || exceptionEntry) && bestDirection === "LONG") {
        action = 'SWING_BUY';
        finalScore = htfScore;
      } else if ((normalEntry || exceptionEntry) && bestDirection === "SHORT") {
        action = 'SWING_SHORT';
        finalScore = htfScore;
      }

      let decisionState: SwingDecisionState = "NO_BIAS";
      if (dataQuality < 50) decisionState = "BLOCKED_DATA";
      else if (exceptionEntry) decisionState = "HIGH_ACCURACY_EXCEPTION";
      else if (normalEntry) decisionState = "ENTRY_READY";
      else if (bestDirection === "LONG" && htfScore >= 8) decisionState = triggerScore >= 10 ? "TRIGGER_PENDING" : "WATCH_LONG";
      else if (bestDirection === "SHORT" && htfScore >= 8) decisionState = triggerScore >= 10 ? "TRIGGER_PENDING" : "WATCH_SHORT";

      if (action === 'HOLD') {
        return {
          asset: assetKey,
          action: "HOLD",
          entryPrice: livePrice,
          stopLoss: plannedStopLoss,
          takeProfit: plannedTakeProfit,
          reasoning: `${simpleStateText(decisionState, bestDirection)}. HTF score ${htfScore}, trigger score ${triggerScore}, liquidity score ${liquidity.score}, flow score ${microstructure.score}, data quality ${dataQuality}. ${trigger.reason} ${liquidity.reason} ${microstructure.reason}${learning.adjustment ? ` Learning adjustment ${learning.adjustment}.` : ""}`,
          score: htfScore,
          expectedMove: bestDirection === "NEUTRAL" ? 0 : expectedMovePercent,
          htfScore,
          triggerScore,
          marketStructureScore: liquidity.score,
          microstructureScore: microstructure.score,
          microstructureSummary: microstructure.reason,
          fundingRate: deepSensors?.fundingRate,
          openInterest: deepSensors?.openInterest,
          orderbookImbalanceRatio: orderbookResult?.imbalanceRatio,
          liquidityState: liquidity.state,
          dataQuality,
          finalConviction,
          decisionState,
          simpleStatus: simpleStateText(decisionState, bestDirection),
          simpleReason: decisionState === "BLOCKED_DATA"
            ? "The bot does not trust the current market data enough to trade."
            : !liquidity.aligned
              ? "The bot sees a possible liquidity trap or a move against the main market structure."
            : !microstructure.aligned
              ? "The bot sees live order-book or funding pressure fighting the setup."
            : htfScore < 8
              ? "The market is not showing a strong enough direction yet."
              : "The setup is being watched, but live entry confirmation is not strong enough yet.",
          nextStep: bestDirection === "LONG"
            ? "The bot will enter only if short-term price action confirms strength."
            : bestDirection === "SHORT"
              ? "The bot will enter only if short-term price action confirms weakness."
              : "The bot will keep scanning for a clearer setup.",
          paperSize: paperSizeFromConviction(finalConviction),
          riskMode: dataQuality < 70 ? "Protected" : "Normal",
          assetMode,
          setupTags,
          directionBias: bestDirection,
          learningAdjustment: learning.adjustment,
          learningRules: learning.rules.map((rule) => rule.message),
          livePrice,
          signalPrice,
          slippagePercent,
          oldScoreOverride: false,
          entryGate,
        };
      }

      // 5. Dynamic Wide HTF Stops
      // In swing trading, ATR is larger, and we use a 1.5x / 3.0x multiplier.
      const stopLoss = plannedStopLoss;
      const takeProfit = plannedTakeProfit;

      return {
        asset: assetKey,
        action,
        entryPrice: currentPrice,
        stopLoss,
        takeProfit,
          reasoning: `HTF Confluence ${finalScore}. Signals: ${details.join(" | ")}. ${trigger.reason} ${liquidity.reason} ${microstructure.reason} Expected spread ${expectedMovePercent.toFixed(2)}%${learning.adjustment ? `. Learning adjustment ${learning.adjustment}` : ""}`,
        score: finalScore,
        expectedMove: expectedMovePercent,
        htfScore,
        triggerScore,
        marketStructureScore: liquidity.score,
        microstructureScore: microstructure.score,
        microstructureSummary: microstructure.reason,
        fundingRate: deepSensors?.fundingRate,
        openInterest: deepSensors?.openInterest,
        orderbookImbalanceRatio: orderbookResult?.imbalanceRatio,
        liquidityState: liquidity.state,
        dataQuality,
        finalConviction,
        decisionState,
        simpleStatus: simpleStateText(decisionState, bestDirection),
        simpleReason: exceptionEntry
          ? "The old long-term score is below the normal threshold, but live market behavior is strongly confirming the setup."
          : "Long-term direction and live entry confirmation agree.",
        nextStep: "The bot can enter with predefined stop loss, take profit, and paper position size.",
        paperSize: paperSizeFromConviction(finalConviction),
        riskMode: dataQuality < 70 ? "Protected" : "Normal",
        assetMode,
        setupTags,
        directionBias: bestDirection,
        learningAdjustment: learning.adjustment,
        learningRules: learning.rules.map((rule) => rule.message),
        livePrice,
        signalPrice,
        slippagePercent,
        oldScoreOverride: exceptionEntry,
        entryGate,
      };
    } catch (err) {
      return emptySignal(assetKey, `Swing scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
