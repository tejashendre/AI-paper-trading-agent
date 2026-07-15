import { Candle, IndicatorSnapshot, StatisticalMetrics } from "@/lib/types";
import { MarketService } from "./market";
import { computeAllIndicators, getLatestSnapshot } from "./indicators";
import { computeStatistics } from "./statistics";
import { LocalLearningMemory } from "./trading/localLearning";

export type SwingDecisionState =
  | "NO_BIAS"
  | "WATCH_LONG"
  | "WATCH_SHORT"
  | "TRIGGER_PENDING"
  | "PROBE_ENTRY"
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
  controlledProbeEntry: boolean;
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
  entryMode: "STANDARD" | "CONTROLLED_PROBE";
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
  targetReachability?: {
    score: number;
    rawTakeProfit: number;
    adjustedTakeProfit: number;
    rawDistance: number;
    adjustedDistance: number;
    recentP90Move: number;
    recentMaxMove: number;
    compressed: boolean;
    reason: string;
  };
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
    entryMode: "STANDARD",
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
      controlledProbeEntry: false,
      primaryBlocker: reason,
      missing: [reason],
    },
  };
}

function getAssetMode(assetKey: string): SwingSignal["assetMode"] {
  return assetKey === "BTC" || assetKey === "ETH" || assetKey === "SOL" ? "REALTIME_FAST" : "SLOW_SWING";
}

function entryThresholds(assetMode: SwingSignal["assetMode"]) {
  return {
    htf: assetMode === "REALTIME_FAST" ? 14 : 12,
    trigger: assetMode === "REALTIME_FAST" ? 14 : 8,
    exceptionTrigger: assetMode === "REALTIME_FAST" ? 24 : 12,
    exceptionConviction: assetMode === "REALTIME_FAST" ? 75 : 70,
    exceptionData: assetMode === "REALTIME_FAST" ? 85 : 68,
    probeTrigger: assetMode === "REALTIME_FAST" ? 24 : 10,
    probeConviction: assetMode === "REALTIME_FAST" ? 70 : 64,
    probeData: assetMode === "REALTIME_FAST" ? 90 : 68,
    impulseHtf: assetMode === "REALTIME_FAST" ? 8 : 10,
    impulseTrigger: assetMode === "REALTIME_FAST" ? 17 : 10,
    impulseConviction: assetMode === "REALTIME_FAST" ? 58 : 60,
    impulseData: assetMode === "REALTIME_FAST" ? 85 : 68,
  };
}

export function scoreContinuousHtfEvidence(input: {
  livePrice: number;
  snap1h: IndicatorSnapshot;
  snap4h: IndicatorSnapshot;
  stats1h: StatisticalMetrics;
  stats4h: StatisticalMetrics;
}) {
  let buyScore = 0;
  let shortScore = 0;
  const details: string[] = [];
  const { livePrice, snap1h, snap4h, stats1h, stats4h } = input;

  const addDirectional = (bullish: boolean, points: number, label: string) => {
    if (bullish) buyScore += points;
    else shortScore += points;
    details.push(`${label} (${bullish ? "Bullish" : "Bearish"})`);
  };

  const ema4hBull = snap4h.ema9 > snap4h.ema21 && snap4h.ema21 > snap4h.ema50;
  const ema4hBear = snap4h.ema9 < snap4h.ema21 && snap4h.ema21 < snap4h.ema50;
  if (ema4hBull || ema4hBear) addDirectional(ema4hBull, 4, "4H EMA Alignment");

  const ema1hBull = snap1h.ema9 > snap1h.ema21 && snap1h.ema21 > snap1h.ema50;
  const ema1hBear = snap1h.ema9 < snap1h.ema21 && snap1h.ema21 < snap1h.ema50;
  if (ema1hBull || ema1hBear) addDirectional(ema1hBull, 3, "1H EMA Alignment");

  if (stats4h.regressionR2 >= 0.35 && stats4h.regressionSlope !== 0) {
    addDirectional(stats4h.regressionSlope > 0, 3, "4H Regression Confirmation");
  }

  if (Number.isFinite(snap1h.vwap) && snap1h.vwap > 0 && Number.isFinite(livePrice)) {
    const distance = Math.abs(livePrice - snap1h.vwap) / snap1h.vwap;
    if (distance >= 0.001) addDirectional(livePrice > snap1h.vwap, 2, "1H VWAP Control");
  }

  if (snap1h.rsi >= 54 && snap1h.rsi <= 68) {
    buyScore += 2;
    details.push("1H RSI Momentum (Bullish)");
  } else if (snap1h.rsi <= 46 && snap1h.rsi >= 32) {
    shortScore += 2;
    details.push("1H RSI Momentum (Bearish)");
  }

  // A weak or random 4H regression must not become directional evidence just
  // because lower-timeframe indicators happen to align.
  if (stats4h.regressionR2 < 0.15 && stats1h.regressionR2 < 0.15) {
    buyScore = Math.min(buyScore, 5);
    shortScore = Math.min(shortScore, 5);
    details.push("HTF Regression Quality Cap");
  }

  return { buyScore, shortScore, details };
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
      reason: direction === "NEUTRAL"
        ? "Live flow is neutral because there is no directional setup to confirm."
        : "Live flow is neutral because this asset is not in crypto fast mode.",
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

function percentile(values: number[], p: number): number {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const index = Math.min(clean.length - 1, Math.max(0, Math.floor((clean.length - 1) * p)));
  return clean[index];
}

function evaluateTargetReachability(input: {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  entryPrice: number;
  stopLoss: number;
  rawTakeProfit: number;
  candles1h: Candle[];
  assetMode: SwingSignal["assetMode"];
}) {
  const rawDistance = Math.abs(input.rawTakeProfit - input.entryPrice);
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  const fallback = {
    score: 70,
    rawTakeProfit: input.rawTakeProfit,
    adjustedTakeProfit: input.rawTakeProfit,
    rawDistance,
    adjustedDistance: rawDistance,
    recentP90Move: rawDistance,
    recentMaxMove: rawDistance,
    compressed: false,
    reason: "Target reachability is neutral because recent movement history is limited.",
  };

  if (
    input.direction === "NEUTRAL" ||
    !Number.isFinite(input.entryPrice) ||
    !Number.isFinite(input.stopLoss) ||
    !Number.isFinite(input.rawTakeProfit) ||
    input.entryPrice <= 0 ||
    stopDistance <= 0 ||
    rawDistance <= 0 ||
    input.candles1h.length < 36
  ) {
    return fallback;
  }

  const lookaheadBars = input.assetMode === "REALTIME_FAST" ? 8 : 12;
  const sample = input.candles1h.slice(-120);
  const excursions: number[] = [];

  for (let i = 0; i < sample.length - lookaheadBars; i++) {
    const start = sample[i];
    const future = sample.slice(i + 1, i + lookaheadBars + 1);
    if (!start || future.length === 0 || !Number.isFinite(start.close) || start.close <= 0) continue;
    const futureHigh = Math.max(...future.map((candle) => candle.high));
    const futureLow = Math.min(...future.map((candle) => candle.low));
    const favorableMove = input.direction === "LONG"
      ? futureHigh - start.close
      : start.close - futureLow;
    if (Number.isFinite(favorableMove) && favorableMove > 0) excursions.push(favorableMove);
  }

  if (excursions.length < 12) return fallback;

  const recentP90Move = percentile(excursions, 0.9);
  const recentMaxMove = Math.max(...excursions);
  const feasibleDistance = Math.max(stopDistance * 1.15, recentP90Move * 1.05);
  const hardCeiling = Math.max(feasibleDistance, recentMaxMove * 1.05);
  const adjustedDistance = rawDistance > hardCeiling ? hardCeiling : rawDistance;
  const adjustedTakeProfit = input.direction === "LONG"
    ? input.entryPrice + adjustedDistance
    : input.entryPrice - adjustedDistance;
  const ratioToP90 = recentP90Move > 0 ? rawDistance / recentP90Move : 999;
  const score = Math.max(0, Math.min(100, Math.round(100 - Math.max(0, ratioToP90 - 1) * 35)));
  const compressed = Math.abs(adjustedDistance - rawDistance) > input.entryPrice * 0.0001;
  const reason = compressed
    ? `Take-profit was compressed from ${rawDistance.toFixed(4)} to ${adjustedDistance.toFixed(4)} price-distance because recent 1h moves rarely travelled that far.`
    : `Take-profit distance is realistic versus recent 1h movement history.`;

  return {
    score,
    rawTakeProfit: input.rawTakeProfit,
    adjustedTakeProfit,
    rawDistance,
    adjustedDistance,
    recentP90Move,
    recentMaxMove,
    compressed,
    reason,
  };
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
    state === "BUY_SIDE_SWEEP_REJECTION" ||
    state === "SELL_SIDE_BREAKDOWN_CONTINUATION";
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
  if (state === "PROBE_ENTRY") return "Small paper probe approved";
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
  controlledProbeEntry: boolean;
}): EntryGateDiagnostics {
  const thresholds = entryThresholds(input.assetMode);
  const triggerThreshold = thresholds.trigger;
  const htfPassed = input.htfScore >= thresholds.htf;
  const exceptionHtfPassed = input.htfScore >= 8 && input.htfScore < thresholds.htf;
  const triggerPassed = input.triggerScore >= triggerThreshold;
  const structurePassed = input.structureAligned || input.controlledProbeEntry;
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
    controlledProbeEntry: input.controlledProbeEntry,
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

      const continuousHtf = scoreContinuousHtfEvidence({
        livePrice,
        snap1h,
        snap4h,
        stats1h,
        stats4h,
      });
      buyScore += continuousHtf.buyScore;
      shortScore += continuousHtf.shortScore;
      details.push(...continuousHtf.details);

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
        // True 8-period EMA calculation
        const weeklyCloses = candles1w.slice(-8).map((c) => c.close);
        const k = 2 / (8 + 1);
        let weeklyEma8 = weeklyCloses[0];
        for (let i = 1; i < weeklyCloses.length; i++) {
          weeklyEma8 = (weeklyCloses[i] - weeklyEma8) * k + weeklyEma8;
        }
        
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
      const allowedSlippage = assetMode === "REALTIME_FAST" ? 0.15 : 0.08;
      const slippageOk = slippagePercent <= allowedSlippage;
      
      // Structure Safety Buffer: If the market structure score is weak (< 4), demand +5 finalConviction to execute
      const requiredConviction = liquidity.score < 4 ? 65 : 60;
      
      const thresholds = entryThresholds(assetMode);
      const normalEntry = !learning.watchOnly && liquidity.aligned && microstructure.aligned && htfScore >= thresholds.htf && triggerScore >= thresholds.trigger && finalConviction >= requiredConviction && dataQuality >= 60 && slippageOk;
      const exceptionEntry = !learning.watchOnly && liquidity.aligned && microstructure.aligned && htfScore >= 8 && htfScore < thresholds.htf && triggerScore >= thresholds.exceptionTrigger && dataQuality >= thresholds.exceptionData && finalConviction >= thresholds.exceptionConviction && slippageOk;
      const controlledProbeEntry =
        !normalEntry &&
        !exceptionEntry &&
        !learning.watchOnly &&
        bestDirection !== "NEUTRAL" &&
        htfScore >= 8 &&
        triggerScore >= thresholds.probeTrigger &&
        finalConviction >= thresholds.probeConviction &&
        dataQuality >= thresholds.probeData &&
        slippageOk &&
        liquidity.state === "NEUTRAL" &&
        liquidity.score >= (assetMode === "REALTIME_FAST" ? 4 : 0) &&
        microstructure.aligned &&
        microstructure.score >= -5;
      const momentumImpulseProbeEntry =
        !normalEntry &&
        !exceptionEntry &&
        !controlledProbeEntry &&
        !learning.watchOnly &&
        bestDirection !== "NEUTRAL" &&
        htfScore >= thresholds.impulseHtf &&
        triggerScore >= thresholds.impulseTrigger &&
        finalConviction >= thresholds.impulseConviction &&
        dataQuality >= thresholds.impulseData &&
        slippageOk &&
        liquidity.score >= 4 &&
        microstructure.aligned &&
        microstructure.score >= (assetMode === "REALTIME_FAST" ? 0 : -2);
      const approvedProbeEntry = controlledProbeEntry || momentumImpulseProbeEntry;
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
        controlledProbeEntry: approvedProbeEntry,
      });
      const htfAtr = snap1h.atr;
      const currentPrice = livePrice;
      const minAtrPercent = assetMode === "REALTIME_FAST" ? 0.002 : 0.001;
      const minAtr = currentPrice * minAtrPercent;
      const safeAtr = Number.isFinite(htfAtr) && htfAtr >= minAtr ? htfAtr : minAtr;
      const expectedMovePercent = currentPrice > 0 ? (safeAtr / currentPrice) * 100 : 0;
      const stopDistance = safeAtr * 1.5;
      const takeProfitDistance = safeAtr * 3.0;
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
      const targetReachability = evaluateTargetReachability({
        direction: bestDirection,
        entryPrice: currentPrice,
        stopLoss: plannedStopLoss,
        rawTakeProfit: plannedTakeProfit,
        candles1h,
        assetMode,
      });
      const adjustedTakeProfit = targetReachability.adjustedTakeProfit;
      if (targetReachability.compressed) {
        setupTags.push("TP_COMPRESSED_TO_RECENT_RANGE");
        finalConviction = Math.max(0, Math.min(100, finalConviction + 2));
      } else if (targetReachability.score >= 75 && bestDirection !== "NEUTRAL") {
        setupTags.push("REACHABLE_TARGET");
      }

      // Require strong HTF alignment (score >= 14)
      if ((normalEntry || exceptionEntry || approvedProbeEntry) && bestDirection === "LONG") {
        action = 'SWING_BUY';
        finalScore = htfScore;
      } else if ((normalEntry || exceptionEntry || approvedProbeEntry) && bestDirection === "SHORT") {
        action = 'SWING_SHORT';
        finalScore = htfScore;
      }

      let decisionState: SwingDecisionState = "NO_BIAS";
      if (dataQuality < 50) decisionState = "BLOCKED_DATA";
      else if (approvedProbeEntry) decisionState = "PROBE_ENTRY";
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
          takeProfit: adjustedTakeProfit,
          reasoning: `${simpleStateText(decisionState, bestDirection)}. HTF score ${htfScore}, trigger score ${triggerScore}, liquidity score ${liquidity.score}, flow score ${microstructure.score}, data quality ${dataQuality}. ${trigger.reason} ${liquidity.reason} ${microstructure.reason} ${targetReachability.reason}${learning.adjustment ? ` Learning adjustment ${learning.adjustment}.` : ""}`,
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
          entryMode: "STANDARD",
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
          targetReachability,
        };
      }

      // 5. Dynamic Wide HTF Stops
      // In swing trading, ATR is larger, and we use a 1.5x / 3.0x multiplier.
      const stopLoss = plannedStopLoss;
      const takeProfit = adjustedTakeProfit;

      return {
        asset: assetKey,
        action,
        entryPrice: currentPrice,
        stopLoss,
        takeProfit,
          reasoning: `HTF Confluence ${finalScore}. Signals: ${details.join(" | ")}. ${trigger.reason} ${liquidity.reason} ${microstructure.reason} ${targetReachability.reason} Expected spread ${expectedMovePercent.toFixed(2)}%${learning.adjustment ? `. Learning adjustment ${learning.adjustment}` : ""}`,
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
        simpleReason: controlledProbeEntry
          ? "The setup is not perfect, but the bot has enough live proof to test it with a smaller paper position."
          : momentumImpulseProbeEntry
          ? "The full structure model is not perfect yet, but live momentum and volume are strong enough for a controlled paper probe."
          : exceptionEntry
          ? "The old long-term score is below the normal threshold, but live market behavior is strongly confirming the setup."
          : "Long-term direction and live entry confirmation agree.",
        nextStep: "The bot can enter with predefined stop loss, take profit, and paper position size.",
        paperSize: approvedProbeEntry ? "Probe" : paperSizeFromConviction(finalConviction),
        riskMode: dataQuality < 70 ? "Protected" : "Normal",
        entryMode: approvedProbeEntry ? "CONTROLLED_PROBE" : "STANDARD",
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
        targetReachability,
      };
    } catch (err) {
      return emptySignal(assetKey, `Swing scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
