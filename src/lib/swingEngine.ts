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

export class SwingEngine {
  /**
   * Analyzes an asset for higher-timeframe swing opportunities (15m, 1h, 4h).
   * Swings focus on robust structural moves, immune to 1m noise.
   */
  static async analyze(assetKey: string = "BTC"): Promise<SwingSignal> {
    try {
      const assetMode = getAssetMode(assetKey);
      // 1. Fetch multi-timeframe candles (Higher Timeframes)
      const [candles1mResult, candles5mResult, candles15m, candles1h, candles4h, livePriceResult] = await Promise.all([
        MarketService.getCandles("1m", 80, assetKey).catch(() => [] as Candle[]),
        MarketService.getCandles("5m", 80, assetKey).catch(() => [] as Candle[]),
        MarketService.getCandles("15m", 100, assetKey),
        MarketService.getCandles("1h", 100, assetKey),
        MarketService.getCandles("4h", 100, assetKey),
        MarketService.getCurrentPrice(assetKey).catch(() => 0)
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
      const setupTags = [...details, ...trigger.tags];
      const learning = await LocalLearningMemory.getAdjustment(assetKey, setupTags);
      const triggerScore = trigger.score;
      const dataScore = Math.round(dataQuality / 5);
      const riskRewardScore = 10;
      const finalConviction = Math.max(0, Math.min(100, Math.round(htfScore * 2.2 + triggerScore * 1.4 + dataScore + riskRewardScore + learning.adjustment)));
      const slippagePercent = signalPrice > 0 ? Math.abs(livePrice - signalPrice) / signalPrice * 100 : 0;
      const allowedSlippage = assetMode === "REALTIME_FAST" ? 0.25 : 0.15;
      const slippageOk = slippagePercent <= allowedSlippage;
      const normalEntry = !learning.watchOnly && htfScore >= 14 && triggerScore >= (assetMode === "REALTIME_FAST" ? 14 : 8) && finalConviction >= 60 && dataQuality >= 60 && slippageOk;
      const exceptionEntry = !learning.watchOnly && htfScore >= 8 && htfScore < 14 && assetMode === "REALTIME_FAST" && triggerScore >= 24 && dataQuality >= 85 && finalConviction >= 75 && slippageOk;
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
          reasoning: `${simpleStateText(decisionState, bestDirection)}. HTF score ${htfScore}, trigger score ${triggerScore}, data quality ${dataQuality}. ${trigger.reason}${learning.adjustment ? ` Learning adjustment ${learning.adjustment}.` : ""}`,
          score: htfScore,
          expectedMove: bestDirection === "NEUTRAL" ? 0 : expectedMovePercent,
          htfScore,
          triggerScore,
          dataQuality,
          finalConviction,
          decisionState,
          simpleStatus: simpleStateText(decisionState, bestDirection),
          simpleReason: decisionState === "BLOCKED_DATA"
            ? "The bot does not trust the current market data enough to trade."
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
          reasoning: `HTF Confluence ${finalScore}. Signals: ${details.join(" | ")}. ${trigger.reason} Expected spread ${expectedMovePercent.toFixed(2)}%${learning.adjustment ? `. Learning adjustment ${learning.adjustment}` : ""}`,
        score: finalScore,
        expectedMove: expectedMovePercent,
        htfScore,
        triggerScore,
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
      };
    } catch (err) {
      return emptySignal(assetKey, `Swing scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
