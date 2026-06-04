// ================================================================
// Market World Model — The AI's Cognitive Understanding of Markets
// Transforms raw indicators + statistics + data mesh into a
// structured MarketWorldModel the AI brain can reason about.
// ================================================================

import type {
  Candle,
  FreeMarketFrame,
  IndicatorSnapshot,
  StatisticalMetrics,
  MarketWorldModel,
  MarketRegime,
  VolatilityRegime,
  DirectionalBias,
  PriceZone,
} from '@/lib/types';
import {
  computeAllIndicators,
  getLatestSnapshot,
  detectMarketStructure,
} from '@/lib/indicators';
import { computeStatistics } from '@/lib/statistics';

/**
 * Builds a MarketWorldModel from a FreeMarketFrame.
 *
 * This is the AI's structured "understanding" of the current market state.
 * It synthesizes technical indicators, statistical analysis, feed health,
 * and sentiment into a single object the autonomous brain can reason about.
 */
export function buildWorldModel(frame: FreeMarketFrame): MarketWorldModel {
  const { candles, currentPrice, asset, feedHealth, sentiment, warnings: frameWarnings, openInterest, fundingRate } = frame;

  const warnings: string[] = [...frameWarnings];

  if (candles.length < 50) {
    warnings.push(`Insufficient candle data (${candles.length} candles, need 50+)`);
  }

  // ── Compute indicators and statistics ────────────────────────
  const series = computeAllIndicators(candles);
  const snap = getLatestSnapshot(candles, series);
  const stats = computeStatistics(candles, snap, series.atr);

  // ── Regime classification ────────────────────────────────────
  const regime = classifyRegime(candles, snap, stats);

  // ── Directional bias ─────────────────────────────────────────
  const { bias, biasScore } = computeDirectionalBias(snap, stats, candles);

  // ── Volatility regime ────────────────────────────────────────
  const atrPercent = currentPrice > 0 ? (snap.atr / currentPrice) * 100 : 0;
  const volatilityRegime = classifyVolatility(atrPercent, stats.volatilityPercentile);

  // ── Trend strength ───────────────────────────────────────────
  const trendStrength = computeTrendStrength(snap, stats, candles);

  // ── Momentum score ───────────────────────────────────────────
  const momentumScore = computeMomentumScore(snap, stats);

  // ── Mean reversion signal ────────────────────────────────────
  const meanReversionSignal = computeMeanReversionSignal(snap, stats);

  // ── Support / Resistance zones ───────────────────────────────
  const priceZones = detectPriceZones(candles, currentPrice);
  const supports = priceZones.filter(z => z.type === 'SUPPORT').sort((a, b) => b.level - a.level);
  const resistances = priceZones.filter(z => z.type === 'RESISTANCE').sort((a, b) => a.level - b.level);

  const nearestSupport = supports.length > 0 ? supports[0].level : null;
  const nearestResistance = resistances.length > 0 ? resistances[0].level : null;

  // ── Key levels description ───────────────────────────────────
  const keyLevels: string[] = [];
  if (nearestSupport) keyLevels.push(`Nearest Support: $${nearestSupport.toFixed(2)}`);
  if (nearestResistance) keyLevels.push(`Nearest Resistance: $${nearestResistance.toFixed(2)}`);
  if (Number.isFinite(snap.ema200) && snap.ema200 > 0) {
    keyLevels.push(`EMA200: $${snap.ema200.toFixed(2)} (${currentPrice > snap.ema200 ? 'ABOVE' : 'BELOW'})`);
  }
  if (Number.isFinite(snap.vwap) && snap.vwap > 0) {
    keyLevels.push(`VWAP: $${snap.vwap.toFixed(2)} (${currentPrice > snap.vwap ? 'ABOVE' : 'BELOW'})`);
  }
  if (Number.isFinite(snap.bb.upper)) {
    keyLevels.push(`Bollinger Upper: $${snap.bb.upper.toFixed(2)}`);
    keyLevels.push(`Bollinger Lower: $${snap.bb.lower.toFixed(2)}`);
  }

  // ── Tradeability score ───────────────────────────────────────
  const tradeability = computeTradeability(regime, feedHealth.score, volatilityRegime, trendStrength, candles.length);

  // ── Data quality from feed health ────────────────────────────
  const dataQuality = feedHealth.score;

  // ── Sentiment ────────────────────────────────────────────────
  const sentimentScore = sentiment ? sentiment.fearGreedIndex : null;

  return {
    asset,
    currentPrice,
    openInterest,
    fundingRate,
    regime,
    directionalBias: bias,
    biasScore,
    tradeability,
    volatilityRegime,
    atrPercent,
    trendStrength,
    momentumScore,
    meanReversionSignal,
    priceZones,
    nearestSupport,
    nearestResistance,
    keyLevels,
    dataQuality,
    sentimentScore,
    hurstExponent: stats.hurstExponent,
    volatilityPercentile: stats.volatilityPercentile,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

// ── Regime Classification ──────────────────────────────────────────

function classifyRegime(
  candles: Candle[],
  snap: IndicatorSnapshot,
  stats: StatisticalMetrics
): MarketRegime {
  const hurst = stats.hurstExponent;
  const volPct = stats.volatilityPercentile;
  const r2 = stats.regressionR2;
  const slope = stats.regressionSlope;
  const rsi = snap.rsi;
  const bbWidth = Number.isFinite(snap.bb.upper) && Number.isFinite(snap.bb.lower) && snap.bb.middle > 0
    ? (snap.bb.upper - snap.bb.lower) / snap.bb.middle
    : 0;

  // Detect market structure
  const structure = detectMarketStructure(candles);

  // PANIC: Extreme selling — RSI crushed + high volatility + bearish structure
  if (rsi < 25 && volPct > 80 && structure.bos === 'BEARISH') {
    return 'PANIC';
  }

  // SQUEEZE: Bollinger bands ultra-tight + low volatility → breakout imminent
  if (bbWidth < 0.03 && volPct < 20) {
    return 'SQUEEZE';
  }

  // BREAKOUT: Break of structure + high volatility + strong trend
  if (structure.bos && volPct > 60 && r2 > 0.5) {
    return 'BREAKOUT';
  }

  // FAKEOUT_RISK: BOS but low R² (unreliable trend) or low volume
  if (structure.bos && r2 < 0.3) {
    return 'FAKEOUT_RISK';
  }

  // STRONG_TREND_UP: High Hurst + positive slope + good R² + bullish EMA stack
  if (hurst > 0.6 && slope > 0 && r2 > 0.5 && snap.ema9 > snap.ema21 && snap.ema21 > snap.ema50) {
    return 'STRONG_TREND_UP';
  }

  // STRONG_TREND_DOWN: High Hurst + negative slope + good R²
  if (hurst > 0.6 && slope < 0 && r2 > 0.5 && snap.ema9 < snap.ema21 && snap.ema21 < snap.ema50) {
    return 'STRONG_TREND_DOWN';
  }

  // WEAK_TREND_UP: Moderate trend signals
  if (hurst > 0.5 && slope > 0 && snap.price > snap.ema50) {
    return 'WEAK_TREND_UP';
  }

  // WEAK_TREND_DOWN: Moderate bearish signals
  if (hurst > 0.5 && slope < 0 && snap.price < snap.ema50) {
    return 'WEAK_TREND_DOWN';
  }

  // MEAN_REVERTING: Low Hurst
  if (hurst < 0.45) {
    return 'MEAN_REVERTING';
  }

  return 'RANDOM';
}

// ── Directional Bias ───────────────────────────────────────────────

function computeDirectionalBias(
  snap: IndicatorSnapshot,
  stats: StatisticalMetrics,
  candles: Candle[]
): { bias: DirectionalBias; biasScore: number } {
  let score = 0;

  // EMA alignment (+/- 20)
  if (snap.ema9 > snap.ema21 && snap.ema21 > snap.ema50) score += 20;
  else if (snap.ema9 < snap.ema21 && snap.ema21 < snap.ema50) score -= 20;

  // Price vs EMA200 (+/- 15)
  if (Number.isFinite(snap.ema200) && snap.ema200 > 0) {
    if (snap.price > snap.ema200) score += 15;
    else score -= 15;
  }

  // MACD (+/- 15)
  if (Number.isFinite(snap.macd.histogram)) {
    if (snap.macd.histogram > 0) score += 15;
    else score -= 15;
  }

  // RSI (+/- 15)
  if (snap.rsi > 60) score += 10;
  else if (snap.rsi > 50) score += 5;
  else if (snap.rsi < 40) score -= 10;
  else if (snap.rsi < 50) score -= 5;

  // Regression slope direction (+/- 15)
  if (stats.regressionR2 > 0.3) {
    if (stats.regressionSlope > 0) score += 15;
    else score -= 15;
  }

  // Market structure (+/- 20)
  const structure = detectMarketStructure(candles);
  if (structure.structure === 'HH') score += 20;
  else if (structure.structure === 'HL') score += 10;
  else if (structure.structure === 'LL') score -= 20;
  else if (structure.structure === 'LH') score -= 10;

  // Clamp to [-100, 100]
  score = Math.max(-100, Math.min(100, score));

  let bias: DirectionalBias;
  if (score >= 50) bias = 'STRONG_BULL';
  else if (score >= 15) bias = 'LEAN_BULL';
  else if (score <= -50) bias = 'STRONG_BEAR';
  else if (score <= -15) bias = 'LEAN_BEAR';
  else bias = 'NEUTRAL';

  return { bias, biasScore: score };
}

// ── Volatility Regime ──────────────────────────────────────────────

function classifyVolatility(atrPercent: number, volPercentile: number): VolatilityRegime {
  // Combine ATR% and percentile for robust classification
  if (atrPercent < 0.5 && volPercentile < 10) return 'ULTRA_LOW';
  if (atrPercent < 1.0 && volPercentile < 30) return 'LOW';
  if (atrPercent > 5.0 || volPercentile > 95) return 'EXTREME';
  if (atrPercent > 3.0 || volPercentile > 75) return 'HIGH';
  return 'NORMAL';
}

// ── Trend Strength ─────────────────────────────────────────────────

function computeTrendStrength(
  snap: IndicatorSnapshot,
  stats: StatisticalMetrics,
  candles: Candle[]
): number {
  let strength = 0;

  // Hurst exponent contribution (0-25)
  if (stats.hurstExponent > 0.5) {
    strength += Math.min(25, (stats.hurstExponent - 0.5) * 50);
  }

  // R² contribution (0-25)
  strength += Math.min(25, stats.regressionR2 * 25);

  // EMA alignment (0-25)
  const emaAligned = (
    (snap.ema9 > snap.ema21 && snap.ema21 > snap.ema50) ||
    (snap.ema9 < snap.ema21 && snap.ema21 < snap.ema50)
  );
  if (emaAligned) strength += 25;

  // ADX-like: consecutive higher closes or lower closes (0-25)
  if (candles.length >= 10) {
    const recent = candles.slice(-10);
    let consecutiveUp = 0;
    let consecutiveDown = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].close > recent[i - 1].close) {
        consecutiveUp++;
        consecutiveDown = 0;
      } else {
        consecutiveDown++;
        consecutiveUp = 0;
      }
    }
    strength += Math.min(25, Math.max(consecutiveUp, consecutiveDown) * 5);
  }

  return Math.min(100, Math.round(strength));
}

// ── Momentum Score ─────────────────────────────────────────────────

function computeMomentumScore(snap: IndicatorSnapshot, stats: StatisticalMetrics): number {
  let score = 0;

  // RSI contribution (-30 to +30)
  if (snap.rsi > 70) score += 25;
  else if (snap.rsi > 60) score += 15;
  else if (snap.rsi > 50) score += 5;
  else if (snap.rsi < 30) score -= 25;
  else if (snap.rsi < 40) score -= 15;
  else score -= 5;

  // MACD histogram (-30 to +30)
  if (Number.isFinite(snap.macd.histogram)) {
    if (snap.macd.histogram > 0) score += Math.min(30, snap.macd.histogram * 100);
    else score -= Math.min(30, Math.abs(snap.macd.histogram) * 100);
  }

  // StochRSI (-20 to +20)
  if (Number.isFinite(snap.stochRsi.k)) {
    if (snap.stochRsi.k > 80) score += 20;
    else if (snap.stochRsi.k > 50) score += 10;
    else if (snap.stochRsi.k < 20) score -= 20;
    else score -= 10;
  }

  // Regression slope direction (-20 to +20)
  if (stats.regressionSlope > 0) score += Math.min(20, stats.regressionSlope * 1000);
  else score -= Math.min(20, Math.abs(stats.regressionSlope) * 1000);

  return Math.max(-100, Math.min(100, Math.round(score)));
}

// ── Mean Reversion Signal ──────────────────────────────────────────

function computeMeanReversionSignal(snap: IndicatorSnapshot, stats: StatisticalMetrics): number {
  let score = 0;

  // Price Z-score: extreme negative = oversold bounce likely (+), extreme positive = overbought drop likely (-)
  if (stats.priceZScore < -2) score += 40;
  else if (stats.priceZScore < -1) score += 20;
  else if (stats.priceZScore > 2) score -= 40;
  else if (stats.priceZScore > 1) score -= 20;

  // RSI extremes
  if (snap.rsi < 30) score += 30;
  else if (snap.rsi < 40) score += 10;
  else if (snap.rsi > 70) score -= 30;
  else if (snap.rsi > 60) score -= 10;

  // Bollinger band position
  if (Number.isFinite(snap.bb.lower) && Number.isFinite(snap.bb.upper)) {
    const bbRange = snap.bb.upper - snap.bb.lower;
    if (bbRange > 0) {
      const posInBB = (snap.price - snap.bb.lower) / bbRange;
      if (posInBB < 0.1) score += 30;       // At lower band
      else if (posInBB < 0.2) score += 15;
      else if (posInBB > 0.9) score -= 30;  // At upper band
      else if (posInBB > 0.8) score -= 15;
    }
  }

  return Math.max(-100, Math.min(100, Math.round(score)));
}

// ── Support / Resistance Detection ─────────────────────────────────

function detectPriceZones(candles: Candle[], currentPrice: number): PriceZone[] {
  if (candles.length < 20) return [];

  const zones: PriceZone[] = [];
  const tolerance = currentPrice * 0.005; // 0.5% price tolerance for zone clustering

  // Collect swing highs and lows as potential zones
  const strength = 3;
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }

    if (isHigh) {
      mergeIntoZones(zones, candles[i].high, 'RESISTANCE', candles[i].time, tolerance);
    }
    if (isLow) {
      mergeIntoZones(zones, candles[i].low, 'SUPPORT', candles[i].time, tolerance);
    }
  }

  // Reclassify zones relative to current price
  for (const zone of zones) {
    if (zone.level > currentPrice) zone.type = 'RESISTANCE';
    else zone.type = 'SUPPORT';
  }

  // Sort by strength (most touches = strongest)
  zones.sort((a, b) => b.strength - a.strength);

  // Return top 6 zones
  return zones.slice(0, 6);
}

function mergeIntoZones(
  zones: PriceZone[],
  level: number,
  type: 'SUPPORT' | 'RESISTANCE',
  time: number,
  tolerance: number
): void {
  // Try to merge with existing zone within tolerance
  for (const zone of zones) {
    if (Math.abs(zone.level - level) < tolerance) {
      zone.touchCount++;
      zone.strength = Math.min(1, zone.touchCount * 0.2);
      zone.lastTouch = Math.max(zone.lastTouch, time);
      // Average the level
      zone.level = (zone.level * (zone.touchCount - 1) + level) / zone.touchCount;
      return;
    }
  }

  // New zone
  zones.push({
    level,
    type,
    strength: 0.2,
    touchCount: 1,
    lastTouch: time,
  });
}

// ── Tradeability Score ─────────────────────────────────────────────

function computeTradeability(
  regime: MarketRegime,
  dataQuality: number,
  volRegime: VolatilityRegime,
  trendStrength: number,
  candleCount: number
): number {
  let score = 50; // Base neutral

  // Data quality is critical — bad data = no trade
  if (dataQuality < 50) return Math.min(20, dataQuality);
  score += (dataQuality - 50) * 0.3; // +0 to +15

  // Regime adjustments
  switch (regime) {
    case 'STRONG_TREND_UP':
    case 'STRONG_TREND_DOWN':
      score += 25;
      break;
    case 'BREAKOUT':
      score += 15;
      break;
    case 'WEAK_TREND_UP':
    case 'WEAK_TREND_DOWN':
      score += 10;
      break;
    case 'MEAN_REVERTING':
      score += 5; // Tradeable with right strategy
      break;
    case 'SQUEEZE':
      score -= 10; // Wait for breakout
      break;
    case 'FAKEOUT_RISK':
      score -= 20;
      break;
    case 'PANIC':
      score -= 15; // Can trade but carefully
      break;
    case 'RANDOM':
      score -= 25;
      break;
  }

  // Volatility extreme = reduce tradeability
  if (volRegime === 'EXTREME') score -= 20;
  else if (volRegime === 'ULTRA_LOW') score -= 10; // No opportunity

  // Trend strength bonus
  if (trendStrength > 60) score += 10;

  // Insufficient data penalty
  if (candleCount < 100) score -= 10;
  if (candleCount < 50) score -= 20;

  return Math.max(0, Math.min(100, Math.round(score)));
}
