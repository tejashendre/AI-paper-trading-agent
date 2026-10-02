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
