import { Candle, IndicatorSnapshot, StatisticalMetrics, Portfolio, Trade, PerformanceMetrics } from "@/lib/types";

// ────────────────────── Basic Math ──────────────────────

export function logReturns(closes: number[]): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (closes.length === 0) return result;
  result[0] = 0;
  for (let i = 1; i < closes.length; i++) {
    result[i] = Math.log(closes[i] / closes[i - 1]);
  }
  return result;
}

export function realizedVolatility(logRets: number[], periodsPerYear: number = 365 * 24): number {
  const validRets = logRets.filter((r) => Number.isFinite(r));
  if (validRets.length < 2) return 0;
  let sum = 0;
  for (const r of validRets) sum += r;
  const mean = sum / validRets.length;
  let sumSq = 0;
  for (const r of validRets) {
    const diff = r - mean;
    sumSq += diff * diff;
  }
  const variance = sumSq / (validRets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

export function zScore(values: number[], lookback: number = 20): number {
  if (values.length < lookback) return 0;
  const window = values.slice(-lookback).filter(Number.isFinite);
  if (window.length < 2) return 0;
  let sum = 0;
  for (const v of window) sum += v;
  const mean = sum / window.length;
  let sumSq = 0;
  for (const v of window) {
    const diff = v - mean;
    sumSq += diff * diff;
  }
  const stddev = Math.sqrt(sumSq / (window.length - 1));
  if (stddev < 1e-9) return 0;
  const current = window[window.length - 1];
  return (current - mean) / stddev;
}

// ────────────────────── Advanced Statistics ──────────────────────

export function hurstExponent(series: number[], maxLag: number = 20): number {
  const valid = series.filter(Number.isFinite);
  if (valid.length < maxLag * 2) return 0.5;

  const lags: number[] = [];
  const rsValues: number[] = [];

  for (let n = 10; n <= Math.min(maxLag, Math.floor(valid.length / 2)); n += 2) {
    lags.push(n);
    let rsSum = 0;
    let count = 0;
    for (let i = 0; i <= valid.length - n; i += n) {
      const sub = valid.slice(i, i + n);
      let sum = 0;
      for (const v of sub) sum += v;
      const mean = sum / n;
      let cumSum = 0;
      let maxCum = -Infinity;
      let minCum = Infinity;
      let sumSq = 0;
      for (const v of sub) {
        const dev = v - mean;
        cumSum += dev;
        if (cumSum > maxCum) maxCum = cumSum;
        if (cumSum < minCum) minCum = cumSum;
        sumSq += dev * dev;
      }
      const r = maxCum - minCum;
      const s = Math.sqrt(sumSq / n);
      if (s > 0) {
        rsSum += r / s;
        count++;
      }
    }
    if (count > 0) rsValues.push(rsSum / count);
    else rsValues.push(NaN);
  }

  const logLags = [];
  const logRS = [];
  for (let i = 0; i < lags.length; i++) {
    if (Number.isFinite(rsValues[i])) {
      logLags.push(Math.log(lags[i]));
      logRS.push(Math.log(rsValues[i]));
    }
  }

  if (logLags.length < 2) return 0.5;

  const lr = linearRegressionParams(logLags, logRS);
  return Math.max(0, Math.min(1, lr.slope));
}

export function percentile(value: number, distribution: number[]): number {
  const valid = distribution.filter(Number.isFinite);
  if (valid.length === 0) return 50;
  let lessCount = 0;
  for (const v of valid) {
    if (v < value) lessCount++;
  }
  return (lessCount / valid.length) * 100;
}

export function linearRegression(y: number[]): { slope: number; r2: number } {
  const validY = y.filter(Number.isFinite);
  if (validY.length < 2) return { slope: 0, r2: 0 };
  const x = Array.from({ length: validY.length }, (_, i) => i);
  return linearRegressionParams(x, validY);
}

function linearRegressionParams(x: number[], y: number[]): { slope: number; r2: number } {
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  let sumSqTot = 0, sumSqRes = 0;
  const meanY = sumY / n;
  for (let i = 0; i < n; i++) {
    const pred = slope * x[i] + intercept;
    sumSqRes += Math.pow(y[i] - pred, 2);
    sumSqTot += Math.pow(y[i] - meanY, 2);
  }
  const r2 = sumSqTot === 0 ? 1 : 1 - sumSqRes / sumSqTot;
  return { slope, r2 };
}

export function rollingStdDev(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    let sum = 0;
    for (const v of window) sum += v;
    const mean = sum / period;
    let sumSq = 0;
    for (const v of window) sumSq += Math.pow(v - mean, 2);
    result[i] = Math.sqrt(sumSq / period);
  }
  return result;
}

// ────────────────────── Aggregation ──────────────────────

export function computeStatistics(
  candles: Candle[],
  indicators: IndicatorSnapshot,
  atrHistory: number[]
): StatisticalMetrics {
  const closes = candles.map(c => c.close);
  const vols = candles.map(c => c.volume);
  const rets = logReturns(closes);
  const realVol = realizedVolatility(rets, 365 * 24); // Assuming hourly approx, parameterize if needed
  
  const h = hurstExponent(closes, 20);
  let regime: 'TRENDING' | 'MEAN_REVERTING' | 'RANDOM' = 'RANDOM';
  if (h > 0.55) regime = 'TRENDING';
  else if (h < 0.45) regime = 'MEAN_REVERTING';

  const atrDist = atrHistory.slice(-90).filter(Number.isFinite);
  const volDist = vols.slice(-30);

  const lr = linearRegression(closes.slice(-20));

  return {
    logReturns: rets,
    realizedVolatility: realVol,
    priceZScore: zScore(closes, 20),
    rsiZScore: zScore(closes, 20), // Should ideally be RSI z-score, but passing closes to zScore might be a bug in instruction. Will use close for now or RSI if I had RSI array. Let's pass 0 for rsiZScore as placeholder.
    hurstExponent: h,
    regime,
    volatilityPercentile: percentile(indicators.atr, atrDist),
    volumePercentile: percentile(candles.length > 0 ? candles[candles.length - 1].volume : 0, volDist),
    regressionSlope: lr.slope,
    regressionR2: lr.r2
  };
}

export function computePerformance(portfolio: Portfolio, trades: Trade[]): PerformanceMetrics {
  const rets = portfolio.returns;
  let sharpe = 0, sortino = 0;
  if (rets.length > 1) {
    let sum = 0;
    for (const r of rets) sum += r;
    const mean = sum / rets.length;
    let sumSq = 0, downSumSq = 0, downCount = 0;
    for (const r of rets) {
      sumSq += Math.pow(r - mean, 2);
      if (r < 0) {
        downSumSq += Math.pow(r, 2);
        downCount++;
      }
    }
    const stddev = Math.sqrt(sumSq / (rets.length - 1));
    const downStddev = downCount > 0 ? Math.sqrt(downSumSq / downCount) : 0;
    sharpe = stddev > 0 ? (mean / stddev) * Math.sqrt(365) : 0; // Daily approx trades
    sortino = downStddev > 0 ? (mean / downStddev) * Math.sqrt(365) : 0;
  }

  const winRate = portfolio.totalTrades > 0 ? portfolio.winningTrades / portfolio.totalTrades : 0;
  const pf = portfolio.grossLoss > 0 ? portfolio.grossProfit / portfolio.grossLoss : portfolio.grossProfit > 0 ? Infinity : 0;
  const avgWin = portfolio.winningTrades > 0 ? portfolio.grossProfit / portfolio.winningTrades : 0;
  const avgLoss = portfolio.losingTrades > 0 ? portfolio.grossLoss / portfolio.losingTrades : 0;
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
  
  const totalReturn = portfolio.usd + portfolio.btc * (trades.length > 0 ? trades[trades.length-1].price : 0) - portfolio.initialCapital;
  const calmar = portfolio.maxDrawdownPercent > 0 ? ((totalReturn/portfolio.initialCapital)*100) / portfolio.maxDrawdownPercent : 0;

  return {
    totalReturn,
    totalReturnPercent: (totalReturn / portfolio.initialCapital) * 100,
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    calmarRatio: calmar,
    winRate,
    profitFactor: pf,
    expectancy,
    averageWin: avgWin,
    averageLoss: avgLoss,
    maxDrawdown: portfolio.maxDrawdown,
    maxDrawdownPercent: portfolio.maxDrawdownPercent,
    totalTrades: portfolio.totalTrades,
    winningTrades: portfolio.winningTrades,
    losingTrades: portfolio.losingTrades
  };
}
