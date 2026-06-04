// ================================================================
// indicators.ts — Pure technical analysis indicator library
// Zero external dependencies. All math computed from raw OHLCV data.
// Every array returned is the same length as the input.
// ================================================================

import {
  Candle,
  MACDValue,
  BollingerValue,
  StochRSIValue,
  IndicatorSeries,
  IndicatorSnapshot,
  CandlePattern,
  PatternType,
} from "@/lib/types";

// ────────────────────── Helpers ──────────────────────

/** Return the last non-NaN value in an array, or NaN if none. */
function lastValid(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return NaN;
}

/** Extract closing prices from candle array. */
function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

// ────────────────────── SMA ──────────────────────

export function SMA(closes: number[], period: number): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (period <= 0 || closes.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  result[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    result[i] = sum / period;
  }
  return result;
}

// ────────────────────── EMA ──────────────────────

export function EMA(closes: number[], period: number): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (period <= 0 || closes.length < period) return result;

  // Seed: SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let ema = sum / period;
  result[period - 1] = ema;

  const alpha = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema = alpha * closes[i] + (1 - alpha) * ema;
    result[i] = ema;
  }
  return result;
}

// ────────────────────── RSI (Wilder smoothing) ──────────────────────

export function RSI(closes: number[], period: number = 14): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (period <= 0 || closes.length < period + 1) return result;

  const gains = new Array<number>(closes.length).fill(0);
  const losses = new Array<number>(closes.length).fill(0);

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = diff > 0 ? diff : 0;
    losses[i] = diff < 0 ? -diff : 0;
  }

  // First average: simple mean of first `period` gains/losses (indices 1..period)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  // Wilder smoothing for subsequent values
  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }
  return result;
}

// ────────────────────── MACD ──────────────────────

export function MACD(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  signalPeriod: number = 9
): MACDValue[] {
  const result: MACDValue[] = closes.map(() => ({
    line: NaN,
    signal: NaN,
    histogram: NaN,
  }));

  if (closes.length < slow) return result;

  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);

  // MACD line = fast EMA - slow EMA
  const macdLine: number[] = closes.map((_, i) => {
    if (Number.isFinite(emaFast[i]) && Number.isFinite(emaSlow[i])) {
      return emaFast[i] - emaSlow[i];
    }
    return NaN;
  });

  // Signal line = EMA of the MACD line values (only use finite values)
  // We need to compute EMA of macdLine starting from the first valid value
  const signalLine = new Array<number>(closes.length).fill(NaN);

  // Find first valid index in macdLine
  let firstValid = -1;
  for (let i = 0; i < macdLine.length; i++) {
    if (Number.isFinite(macdLine[i])) {
      firstValid = i;
      break;
    }
  }

  if (firstValid >= 0) {
    // Collect valid macd line values for EMA seeding
    const validMacdValues: number[] = [];
    for (let i = firstValid; i < macdLine.length; i++) {
      if (Number.isFinite(macdLine[i])) {
        validMacdValues.push(macdLine[i]);
      }
    }

    if (validMacdValues.length >= signalPeriod) {
      // Compute EMA over valid MACD values
      const emaOfMacd = EMA(validMacdValues, signalPeriod);

      // Map back to original indices
      let vIdx = 0;
      for (let i = firstValid; i < macdLine.length; i++) {
        if (Number.isFinite(macdLine[i])) {
          if (Number.isFinite(emaOfMacd[vIdx])) {
            signalLine[i] = emaOfMacd[vIdx];
          }
          vIdx++;
        }
      }
    }
  }

  for (let i = 0; i < closes.length; i++) {
    result[i] = {
      line: Number.isFinite(macdLine[i]) ? macdLine[i] : NaN,
      signal: Number.isFinite(signalLine[i]) ? signalLine[i] : NaN,
      histogram:
        Number.isFinite(macdLine[i]) && Number.isFinite(signalLine[i])
          ? macdLine[i] - signalLine[i]
          : NaN,
    };
  }

  return result;
}

// ────────────────────── Bollinger Bands ──────────────────────

export function BollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMult: number = 2
): BollingerValue[] {
  const result: BollingerValue[] = closes.map(() => ({
    upper: NaN,
    middle: NaN,
    lower: NaN,
  }));

  if (closes.length < period) return result;

  const sma = SMA(closes, period);

  for (let i = period - 1; i < closes.length; i++) {
    const mean = sma[i];
    if (!Number.isFinite(mean)) continue;

    // Rolling standard deviation
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - mean;
      sumSq += diff * diff;
    }
    const std = Math.sqrt(sumSq / period); // population stddev

    result[i] = {
      upper: mean + stdDevMult * std,
      middle: mean,
      lower: mean - stdDevMult * std,
    };
  }

  return result;
}

// ────────────────────── ATR (Wilder smoothing) ──────────────────────

export function ATR(candles: Candle[], period: number = 14): number[] {
  const result = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;

  // True Range array
  const tr = new Array<number>(candles.length).fill(0);
  tr[0] = candles[0].high - candles[0].low; // no prev close for first candle

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
  }

  // First ATR = simple mean of first `period` TRs (indices 1..period)
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += tr[i];
  }
  atr /= period;
  result[period] = atr;

  // Wilder smoothing
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }

  return result;
}

// ────────────────────── VWAP (daily-resetting) ──────────────────────

export function VWAP(candles: Candle[]): number[] {
  const result = new Array<number>(candles.length).fill(NaN);
  if (candles.length === 0) return result;

  let cumPriceVol = 0;
  let cumVol = 0;
  let currentDay = -1;

  for (let i = 0; i < candles.length; i++) {
    // Detect day boundary (using UTC date)
    const date = new Date(candles[i].time * 1000);
    const day = date.getUTCFullYear() * 10000 + date.getUTCMonth() * 100 + date.getUTCDate();

    if (day !== currentDay) {
      // Reset for new day
      cumPriceVol = 0;
      cumVol = 0;
      currentDay = day;
    }

    const typicalPrice = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumPriceVol += typicalPrice * candles[i].volume;
    cumVol += candles[i].volume;

    result[i] = cumVol > 0 ? cumPriceVol / cumVol : NaN;
  }

  return result;
}

// ────────────────────── Stochastic RSI ──────────────────────

export function StochasticRSI(
  closes: number[],
  rsiPeriod: number = 14,
  stochPeriod: number = 14,
  kPeriod: number = 3,
  dPeriod: number = 3
): StochRSIValue[] {
  const result: StochRSIValue[] = closes.map(() => ({ k: NaN, d: NaN }));

  const rsiValues = RSI(closes, rsiPeriod);

  // Compute raw stochastic RSI
  const rawStochRsi = new Array<number>(closes.length).fill(NaN);

  for (let i = 0; i < closes.length; i++) {
    if (i < stochPeriod - 1) continue;

    // Gather `stochPeriod` RSI values ending at i
    let lowest = Infinity;
    let highest = -Infinity;
    let allValid = true;

    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (!Number.isFinite(rsiValues[j])) {
        allValid = false;
        break;
      }
      lowest = Math.min(lowest, rsiValues[j]);
      highest = Math.max(highest, rsiValues[j]);
    }

    if (!allValid) continue;

    const range = highest - lowest;
    rawStochRsi[i] = range === 0 ? 0.5 : (rsiValues[i] - lowest) / range;
  }

  // K = SMA(rawStochRsi, kPeriod) × 100
  // Collect valid stochRsi values for SMA computation
  const kLine = new Array<number>(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (i < kPeriod - 1) continue;
    let sum = 0;
    let count = 0;
    let allValid = true;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (!Number.isFinite(rawStochRsi[j])) {
        allValid = false;
        break;
      }
      sum += rawStochRsi[j];
      count++;
    }
    if (allValid && count === kPeriod) {
      kLine[i] = (sum / kPeriod) * 100;
    }
  }

  // D = SMA(K, dPeriod)
  const dLine = new Array<number>(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (i < dPeriod - 1) continue;
    let sum = 0;
    let allValid = true;
    for (let j = i - dPeriod + 1; j <= i; j++) {
      if (!Number.isFinite(kLine[j])) {
        allValid = false;
        break;
      }
      sum += kLine[j];
    }
    if (allValid) {
      dLine[i] = sum / dPeriod;
    }
  }

  for (let i = 0; i < closes.length; i++) {
    result[i] = {
      k: Number.isFinite(kLine[i]) ? kLine[i] : NaN,
      d: Number.isFinite(dLine[i]) ? dLine[i] : NaN,
    };
  }

  return result;
}

// ────────────────────── Candlestick Patterns ──────────────────────

export function detectPatterns(candles: Candle[]): CandlePattern[] {
  const patterns: CandlePattern[] = [];
  if (candles.length < 1) return patterns;

  const len = candles.length;
  const curr = candles[len - 1];
  const prev = len >= 2 ? candles[len - 2] : null;
  const prevPrev = len >= 3 ? candles[len - 3] : null;

  const bodySize = (c: Candle) => Math.abs(c.close - c.open);
  const candleRange = (c: Candle) => c.high - c.low;
  const isGreen = (c: Candle) => c.close >= c.open;
  const isRed = (c: Candle) => c.close < c.open;
  const bodyTop = (c: Candle) => Math.max(c.close, c.open);
  const bodyBottom = (c: Candle) => Math.min(c.close, c.open);
  const upperWick = (c: Candle) => c.high - bodyTop(c);
  const lowerWick = (c: Candle) => bodyBottom(c) - c.low;

  // DOJI: |close-open| < 0.1 × (high-low) AND (high-low) > 0
  {
    const range = candleRange(curr);
    if (range > 0 && bodySize(curr) < 0.1 * range) {
      patterns.push({
        type: "DOJI",
        bullish: false, // neutral
        strength: 0.5,
        description: "Doji — indecision, potential reversal",
      });
    }
  }

  // HAMMER: body in upper 1/3, lower wick > 2× body, bearish prior candle
  if (prev) {
    const range = candleRange(curr);
    const body = bodySize(curr);
    if (
      range > 0 &&
      body > 0 &&
      isRed(prev) &&
      bodyBottom(curr) >= curr.low + (2 / 3) * range && // body in upper 1/3
      lowerWick(curr) > 2 * body
    ) {
      patterns.push({
        type: "HAMMER",
        bullish: true,
        strength: 0.7,
        description: "Hammer — bullish reversal after downtrend",
      });
    }
  }

  // INVERTED_HAMMER: body in lower 1/3, upper wick > 2× body, bearish prior candle
  if (prev) {
    const range = candleRange(curr);
    const body = bodySize(curr);
    if (
      range > 0 &&
      body > 0 &&
      isRed(prev) &&
      bodyTop(curr) <= curr.low + (1 / 3) * range && // body in lower 1/3
      upperWick(curr) > 2 * body
    ) {
      patterns.push({
        type: "INVERTED_HAMMER",
        bullish: true,
        strength: 0.6,
        description: "Inverted Hammer — potential bullish reversal",
      });
    }
  }

  // BULLISH_ENGULFING: prev red, current green, current body fully contains prev body
  if (prev) {
    if (
      isRed(prev) &&
      isGreen(curr) &&
      bodyBottom(curr) <= bodyBottom(prev) &&
      bodyTop(curr) >= bodyTop(prev) &&
      bodySize(curr) > bodySize(prev)
    ) {
      patterns.push({
        type: "BULLISH_ENGULFING",
        bullish: true,
        strength: 0.8,
        description: "Bullish Engulfing — strong reversal signal",
      });
    }
  }

  // BEARISH_ENGULFING: prev green, current red, current body fully contains prev body
  if (prev) {
    if (
      isGreen(prev) &&
      isRed(curr) &&
      bodyBottom(curr) <= bodyBottom(prev) &&
      bodyTop(curr) >= bodyTop(prev) &&
      bodySize(curr) > bodySize(prev)
    ) {
      patterns.push({
        type: "BEARISH_ENGULFING",
        bullish: false,
        strength: 0.8,
        description: "Bearish Engulfing — strong reversal signal",
      });
    }
  }

  // MORNING_STAR: [prevPrev] long red, [prev] small body (gap down), [curr] long green closing above [prevPrev] midpoint
  if (prev && prevPrev) {
    const ppMid = (prevPrev.open + prevPrev.close) / 2;
    const ppBody = bodySize(prevPrev);
    const pBody = bodySize(prev);
    const cBody = bodySize(curr);

    if (
      isRed(prevPrev) &&
      ppBody > 0 &&
      pBody < ppBody * 0.3 && // small body
      bodyTop(prev) < bodyBottom(prevPrev) && // gap down (or close to it)
      isGreen(curr) &&
      cBody > ppBody * 0.5 && // long green
      curr.close > ppMid // closing above midpoint
    ) {
      patterns.push({
        type: "MORNING_STAR",
        bullish: true,
        strength: 0.9,
        description: "Morning Star — strong 3-candle bullish reversal",
      });
    }
  }

  // EVENING_STAR: reverse of morning star
  if (prev && prevPrev) {
    const ppMid = (prevPrev.open + prevPrev.close) / 2;
    const ppBody = bodySize(prevPrev);
    const pBody = bodySize(prev);
    const cBody = bodySize(curr);

    if (
      isGreen(prevPrev) &&
      ppBody > 0 &&
      pBody < ppBody * 0.3 && // small body
      bodyBottom(prev) > bodyTop(prevPrev) && // gap up (or close to it)
      isRed(curr) &&
      cBody > ppBody * 0.5 && // long red
      curr.close < ppMid // closing below midpoint
    ) {
      patterns.push({
        type: "EVENING_STAR",
        bullish: false,
        strength: 0.9,
        description: "Evening Star — strong 3-candle bearish reversal",
      });
    }
  }

  // THREE_WHITE_SOLDIERS: 3 consecutive green candles, each closing higher, each opening within prior body
  if (prev && prevPrev) {
    if (
      isGreen(prevPrev) &&
      isGreen(prev) &&
      isGreen(curr) &&
      prev.close > prevPrev.close &&
      curr.close > prev.close &&
      prev.open >= bodyBottom(prevPrev) &&
      prev.open <= bodyTop(prevPrev) &&
      curr.open >= bodyBottom(prev) &&
      curr.open <= bodyTop(prev)
    ) {
      patterns.push({
        type: "THREE_WHITE_SOLDIERS",
        bullish: true,
        strength: 0.85,
        description: "Three White Soldiers — sustained bullish momentum",
      });
    }
  }

  // THREE_BLACK_CROWS: reverse of three white soldiers
  if (prev && prevPrev) {
    if (
      isRed(prevPrev) &&
      isRed(prev) &&
      isRed(curr) &&
      prev.close < prevPrev.close &&
      curr.close < prev.close &&
      prev.open >= bodyBottom(prevPrev) &&
      prev.open <= bodyTop(prevPrev) &&
      curr.open >= bodyBottom(prev) &&
      curr.open <= bodyTop(prev)
    ) {
      patterns.push({
        type: "THREE_BLACK_CROWS",
        bullish: false,
        strength: 0.85,
        description: "Three Black Crows — sustained bearish momentum",
      });
    }
  }

  return patterns;
}

// ────────────────────── Advanced Price Action & Market Structure ──────────────────────

export interface MarketStructureResult {
  bos: 'BULLISH' | 'BEARISH' | null;
  latestHigh: number;
  latestLow: number;
  structure: 'HH' | 'HL' | 'LH' | 'LL' | null;
}

export function detectMarketStructure(candles: Candle[], strength: number = 3): MarketStructureResult {
  if (candles.length < strength * 2 + 1) {
    return { bos: null, latestHigh: 0, latestLow: 0, structure: null };
  }

  let swingHighs: { idx: number; price: number }[] = [];
  let swingLows: { idx: number; price: number }[] = [];

  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i];
    
    // Check Swing High
    let isHigh = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].high >= c.high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      swingHighs.push({ idx: i, price: c.high });
    }

    // Check Swing Low
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j !== i && candles[j].low <= c.low) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      swingLows.push({ idx: i, price: c.low });
    }
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { bos: null, latestHigh: 0, latestLow: 0, structure: null };
  }

  const lastHigh = swingHighs[swingHighs.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow = swingLows[swingLows.length - 1];
  const prevLow = swingLows[swingLows.length - 2];

  let structure: 'HH' | 'HL' | 'LH' | 'LL' | null = null;
  if (lastHigh.price > prevHigh.price) {
    structure = 'HH';
  } else if (lastLow.price < prevLow.price) {
    structure = 'LL';
  } else if (lastHigh.price < prevHigh.price && lastLow.price > prevLow.price) {
    structure = 'LH';
  } else {
    structure = 'HL';
  }

  // Detect Break of Structure (BOS) on the current candle
  const currentClose = candles[candles.length - 1].close;
  let bos: 'BULLISH' | 'BEARISH' | null = null;
  if (currentClose > lastHigh.price) {
    bos = 'BULLISH';
  } else if (currentClose < lastLow.price) {
    bos = 'BEARISH';
  }

  return {
    bos,
    latestHigh: lastHigh.price,
    latestLow: lastLow.price,
    structure
  };
}

export interface FvgResult {
  fvg: 'BULLISH' | 'BEARISH' | null;
  gapSize: number;
  gapLevel: number;
}

export function detectFairValueGap(candles: Candle[]): FvgResult {
  if (candles.length < 3) {
    return { fvg: null, gapSize: 0, gapLevel: 0 };
  }

  const i = candles.length - 1;
  const c1 = candles[i - 2]; // first candle
  const c2 = candles[i - 1]; // second (impulsive) candle
  const c3 = candles[i];     // third candle

  // Bullish FVG: Low of candle 3 is higher than High of candle 1
  if (c3.low > c1.high) {
    const gapSize = c3.low - c1.high;
    const gapLevel = (c3.low + c1.high) / 2;
    return { fvg: 'BULLISH', gapSize, gapLevel };
  }

  // Bearish FVG: High of candle 3 is lower than Low of candle 1
  if (c3.high < c1.low) {
    const gapSize = c1.low - c3.high;
    const gapLevel = (c1.low + c3.high) / 2;
    return { fvg: 'BEARISH', gapSize, gapLevel };
  }

  return { fvg: null, gapSize: 0, gapLevel: 0 };
}

export interface DivergenceResult {
  divergence: 'BULLISH' | 'BEARISH' | null;
  description: string;
}

export function detectDivergence(candles: Candle[], rsiSeries: number[]): DivergenceResult {
  if (candles.length < 25 || rsiSeries.length < 25) {
    return { divergence: null, description: "" };
  }

  // Look for pivot lows/highs in price and RSI within a 25-candle window
  const len = candles.length;
  
  // Find local minima/maxima peaks
  const findPivots = (vals: number[], type: 'MIN' | 'MAX') => {
    const pivots: { idx: number; val: number }[] = [];
    for (let i = len - 22; i < len - 2; i++) {
      const v = vals[i];
      if (type === 'MIN' && v < vals[i-1] && v < vals[i+1] && v < vals[i-2] && v < vals[i+2]) {
        pivots.push({ idx: i, val: v });
      }
      if (type === 'MAX' && v > vals[i-1] && v > vals[i+1] && v > vals[i-2] && v > vals[i+2]) {
        pivots.push({ idx: i, val: v });
      }
    }
    return pivots;
  };

  const closes = candles.map(c => c.close);
  const priceLows = findPivots(closes, 'MIN');
  const priceHighs = findPivots(closes, 'MAX');

  const currentPrice = closes[len - 1];
  const currentRsi = rsiSeries[len - 1];

  // 1. Bullish Divergence: Price makes lower low, RSI makes higher low
  if (priceLows.length >= 1) {
    const lastLow = priceLows[priceLows.length - 1];
    if (currentPrice < lastLow.val) {
      const rsiAtLastLow = rsiSeries[lastLow.idx];
      if (Number.isFinite(rsiAtLastLow) && currentRsi > rsiAtLastLow) {
        return {
          divergence: 'BULLISH',
          description: 'RSI Bullish Divergence: Price Lower Low vs RSI Higher Low'
        };
      }
    }
  }

  // 2. Bearish Divergence: Price makes higher high, RSI makes lower high
  if (priceHighs.length >= 1) {
    const lastHigh = priceHighs[priceHighs.length - 1];
    if (currentPrice > lastHigh.val) {
      const rsiAtLastHigh = rsiSeries[lastHigh.idx];
      if (Number.isFinite(rsiAtLastHigh) && currentRsi < rsiAtLastHigh) {
        return {
          divergence: 'BEARISH',
          description: 'RSI Bearish Divergence: Price Higher High vs RSI Lower High'
        };
      }
    }
  }

  return { divergence: null, description: "" };
}

// ────────────────────── Institutional Order Blocks (SMC) ──────────────────────

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH';
  priceRange: { low: number; high: number };
  volume: number;
  tested: boolean;
  score: number; // strength score based on impulse size
}

/**
 * Detects institutional Order Blocks.
 * A Bullish OB is the last bearish candle before a strong bullish expansion that breaks structure.
 * A Bearish OB is the last bullish candle before a strong bearish expansion that breaks structure.
 */
export function detectOrderBlocks(candles: Candle[], lookback: number = 30): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  if (candles.length < 5) return blocks;

  const avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;

  // Look back through candles to find high-volume impulse expansions
  for (let i = candles.length - 4; i >= candles.length - lookback && i >= 1; i--) {
    const c1 = candles[i - 1]; // Potential OB candle
    const c2 = candles[i];     // First expansion candle
    const c3 = candles[i + 1]; // Second expansion candle

    const isC1Bearish = c1.close < c1.open;
    const isC1Bullish = c1.close > c1.open;

    const expansionSize = Math.abs(c3.close - c2.open);
    const c1Size = Math.abs(c1.close - c1.open);

    // 1. Detect Bullish Order Block (Last bearish candle before explosive upmove)
    if (isC1Bearish && c3.close > c1.high && expansionSize > c1Size * 2.5 && c2.volume > avgVolume * 1.3) {
      // Confirm that the block hasn't been heavily mitigated (tested) yet
      let mitigated = false;
      for (let j = i + 2; j < candles.length; j++) {
        if (candles[j].low < c1.low) {
          mitigated = true;
          break;
        }
      }

      blocks.push({
        type: 'BULLISH',
        priceRange: { low: c1.low, high: c1.high },
        volume: c1.volume,
        tested: mitigated,
        score: expansionSize / c1Size
      });
    }

    // 2. Detect Bearish Order Block (Last bullish candle before explosive downmove)
    if (isC1Bullish && c3.close < c1.low && expansionSize > c1Size * 2.5 && c2.volume > avgVolume * 1.3) {
      let mitigated = false;
      for (let j = i + 2; j < candles.length; j++) {
        if (candles[j].high > c1.high) {
          mitigated = true;
          break;
        }
      }

      blocks.push({
        type: 'BEARISH',
        priceRange: { low: c1.low, high: c1.high },
        volume: c1.volume,
        tested: mitigated,
        score: expansionSize / c1Size
      });
    }
  }

  return blocks;
}

// ────────────────────── Volume Spread Analysis (VSA) ──────────────────────

export interface VsaResult {
  signal: 'CLIMATIC_BUYING' | 'CLIMATIC_SELLING' | 'INSTITUTIONAL_ABSORPTION' | 'NO_DEMAND' | 'NO_SUPPLY' | 'NORMAL';
  strength: number; // 0 to 1
  description: string;
}

/**
 * Computes Volume Spread Analysis (VSA) on the latest candle.
 * Correlates volume relative to 20-period average with the price spread (high - low).
 */
export function detectVolumeSpread(candles: Candle[]): VsaResult {
  if (candles.length < 20) {
    return { signal: 'NORMAL', strength: 0, description: "Insufficient data for VSA" };
  }

  const curr = candles[candles.length - 1];
  const last20 = candles.slice(-20);
  
  const avgVolume = last20.reduce((sum, c) => sum + c.volume, 0) / 20;
  const avgSpread = last20.reduce((sum, c) => sum + (c.high - c.low), 0) / 20;

  const currentVolume = curr.volume;
  const currentSpread = curr.high - curr.low;

  const volRatio = currentVolume / avgVolume;
  const spreadRatio = currentSpread / avgSpread;
  const bodySize = Math.abs(curr.close - curr.open);

  const isGreen = curr.close >= curr.open;

  // 1. Climactic Volume (Ultra-high volume with wide spread at trend extremes)
  if (volRatio > 2.0 && spreadRatio > 1.8) {
    if (isGreen) {
      return {
        signal: 'CLIMATIC_BUYING',
        strength: 0.9,
        description: 'VSA Climactic Buying: Massive volume with wide spread. Warning: Institutional distribution/fakeout risk.'
      };
    } else {
      return {
        signal: 'CLIMATIC_SELLING',
        strength: 0.95,
        description: 'VSA Climactic Selling: Extreme volume with wide panic spread. Strong reversal/capitulation bounce likely.'
      };
    }
  }

  // 2. Institutional Absorption (Ultra-high volume with narrow spread/body)
  // Smart money is absorbing all orders, preventing price from moving - highly predictive of reversals.
  if (volRatio > 1.8 && bodySize < avgSpread * 0.4) {
    return {
      signal: 'INSTITUTIONAL_ABSORPTION',
      strength: 0.85,
      description: 'VSA Institutional Absorption: Extreme volume on a narrow body. Smart money is blocking price movement, heavy reversal alert.'
    };
  }

  // 3. No Demand / No Supply (Below average volume with narrow spread)
  if (volRatio < 0.65 && spreadRatio < 0.70) {
    if (isGreen) {
      return {
        signal: 'NO_DEMAND',
        strength: 0.6,
        description: 'VSA No Demand: Weak upward spread on low volume. Professional interest is absent, uptrend likely to stall.'
      };
    } else {
      return {
        signal: 'NO_SUPPLY',
        strength: 0.65,
        description: 'VSA No Supply: Price dipping on very low volume. Professional selling is absent, potential long entry trigger.'
      };
    }
  }

  return { signal: 'NORMAL', strength: 0, description: "Normal price-volume distribution" };
}

// ────────────────────── Aggregate Computation ──────────────────────

export function computeAllIndicators(candles: Candle[]): IndicatorSeries {
  const c = closes(candles);

  return {
    ema9: EMA(c, 9),
    ema21: EMA(c, 21),
    ema50: EMA(c, 50),
    ema200: EMA(c, 200),
    rsi: RSI(c, 14),
    macd: MACD(c, 12, 26, 9),
    bb: BollingerBands(c, 20, 2),
    atr: ATR(candles, 14),
    vwap: VWAP(candles),
    stochRsi: StochasticRSI(c, 14, 14, 3, 3),
  };
}

export function getLatestSnapshot(
  candles: Candle[],
  series: IndicatorSeries
): IndicatorSnapshot {
  const last = candles.length - 1;

  const safeNum = (arr: number[], idx: number): number => {
    if (idx >= 0 && idx < arr.length && Number.isFinite(arr[idx]))
      return arr[idx];
    return lastValid(arr);
  };

  const safeMacd = (arr: MACDValue[], idx: number): MACDValue => {
    for (let i = Math.min(idx, arr.length - 1); i >= 0; i--) {
      if (
        Number.isFinite(arr[i].line) &&
        Number.isFinite(arr[i].signal) &&
        Number.isFinite(arr[i].histogram)
      ) {
        return arr[i];
      }
    }
    return { line: NaN, signal: NaN, histogram: NaN };
  };

  const safeBB = (arr: BollingerValue[], idx: number): BollingerValue => {
    for (let i = Math.min(idx, arr.length - 1); i >= 0; i--) {
      if (
        Number.isFinite(arr[i].upper) &&
        Number.isFinite(arr[i].middle) &&
        Number.isFinite(arr[i].lower)
      ) {
        return arr[i];
      }
    }
    return { upper: NaN, middle: NaN, lower: NaN };
  };

  const safeStochRsi = (arr: StochRSIValue[], idx: number): StochRSIValue => {
    for (let i = Math.min(idx, arr.length - 1); i >= 0; i--) {
      if (Number.isFinite(arr[i].k) && Number.isFinite(arr[i].d)) {
        return arr[i];
      }
    }
    return { k: NaN, d: NaN };
  };

  return {
    ema9: safeNum(series.ema9, last),
    ema21: safeNum(series.ema21, last),
    ema50: safeNum(series.ema50, last),
    ema200: safeNum(series.ema200, last),
    rsi: safeNum(series.rsi, last),
    macd: safeMacd(series.macd, last),
    bb: safeBB(series.bb, last),
    atr: safeNum(series.atr, last),
    vwap: safeNum(series.vwap, last),
    stochRsi: safeStochRsi(series.stochRsi, last),
    price: candles.length > 0 ? candles[last].close : NaN,
  };
}
