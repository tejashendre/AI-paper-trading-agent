import { Trade } from "@/lib/types";

export const RESEARCH_HARNESS_VERSION = "walk-forward-v1-2026-07-19";

interface ClosedSample {
  id: string;
  timestamp: string;
  timeMs: number;
  pnlUsd: number;
  returnFraction: number;
  asset: string;
  strategyVersion: string;
  entryMode: string;
  marketRegime: string;
}

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export interface ResearchMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number | null;
  expectancyUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPercent: number;
  tradeSharpe: number;
  deflatedSharpeProbability: number | null;
  expectancy95: ConfidenceInterval | null;
  profitFactor95: ConfidenceInterval | null;
}

export interface WalkForwardFold {
  id: string;
  train: { start: string; end: string; metrics: ResearchMetrics };
  validation: { start: string; end: string; metrics: ResearchMetrics };
  test: { start: string; end: string; metrics: ResearchMetrics };
  embargoedTrades: number;
}

export interface WalkForwardResearchReport {
  harnessVersion: string;
  generatedAt: string;
  cohortStart: string | null;
  strategyVersions: string[];
  numberOfTrials: number;
  folds: WalkForwardFold[];
  aggregateTest: ResearchMetrics;
  byAsset: Record<string, ResearchMetrics>;
  byRegime: Record<string, ResearchMetrics>;
  byEntryMode: Record<string, ResearchMetrics>;
  probabilityOfBacktestOverfit: number | null;
  readiness: {
    preliminarySampleReady: boolean;
    strongerSampleReady: boolean;
    passed: boolean;
    messages: string[];
  };
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStd(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const coefficients = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const polynomial = (((((coefficients[4] * t + coefficients[3]) * t) + coefficients[2]) * t + coefficients[1]) * t + coefficients[0]) * t;
  const erf = sign * (1 - polynomial * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function inverseNormalCdf(probability: number): number {
  const p = Math.max(1e-12, Math.min(1 - 1e-12, probability));
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function quantile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function bootstrapIntervals(samples: ClosedSample[], iterations = 500): { expectancy95: ConfidenceInterval | null; profitFactor95: ConfidenceInterval | null } {
  if (samples.length < 10) return { expectancy95: null, profitFactor95: null };
  const random = seededRandom(0x5eed2026);
  const expectancy: number[] = [];
  const profitFactors: number[] = [];

  for (let iteration = 0; iteration < iterations; iteration++) {
    const draw: ClosedSample[] = [];
    for (let index = 0; index < samples.length; index++) {
      draw.push(samples[Math.floor(random() * samples.length)]);
    }
    const pnl = draw.map((sample) => sample.pnlUsd);
    const grossProfit = pnl.reduce((sum, value) => sum + Math.max(0, value), 0);
    const grossLoss = pnl.reduce((sum, value) => sum + Math.abs(Math.min(0, value)), 0);
    expectancy.push(average(pnl));
    if (grossLoss > 0) profitFactors.push(grossProfit / grossLoss);
  }

  return {
    expectancy95: { low: quantile(expectancy, 0.025), high: quantile(expectancy, 0.975) },
    profitFactor95: profitFactors.length > 0
      ? { low: quantile(profitFactors, 0.025), high: quantile(profitFactors, 0.975) }
      : null,
  };
}

function deflatedSharpeProbability(returns: number[], numberOfTrials: number): number | null {
  if (returns.length < 20) return null;
  const mean = average(returns);
  const deviation = sampleStd(returns);
  if (deviation <= 0) return null;
  const sharpe = mean / deviation;
  const centered = returns.map((value) => value - mean);
  const skewness = average(centered.map((value) => value ** 3)) / Math.max(deviation ** 3, 1e-12);
  const kurtosis = average(centered.map((value) => value ** 4)) / Math.max(deviation ** 4, 1e-12);
  const trials = Math.max(1, numberOfTrials);
  const eulerGamma = 0.5772156649;
  const expectedMaximumSharpe = trials <= 1
    ? 0
    : (1 - eulerGamma) * inverseNormalCdf(1 - 1 / trials) + eulerGamma * inverseNormalCdf(1 - 1 / (trials * Math.E));
  const variance = Math.max(1e-12, (1 - skewness * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe) / (returns.length - 1));
  return normalCdf((sharpe - expectedMaximumSharpe) / Math.sqrt(variance));
}

function maximumDrawdown(samples: ClosedSample[], initialCapital = 10_000) {
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdownUsd = 0;
  let maxDrawdownPercent = 0;
  for (const sample of samples) {
    equity += sample.pnlUsd;
    peak = Math.max(peak, equity);
    const drawdownUsd = Math.max(0, peak - equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdownUsd);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, peak > 0 ? drawdownUsd / peak * 100 : 0);
  }
  return { maxDrawdownUsd, maxDrawdownPercent };
}

function metrics(samples: ClosedSample[], numberOfTrials: number): ResearchMetrics {
  const pnl = samples.map((sample) => sample.pnlUsd);
  const returns = samples.map((sample) => sample.returnFraction);
  const grossProfitUsd = pnl.reduce((sum, value) => sum + Math.max(0, value), 0);
  const grossLossUsd = pnl.reduce((sum, value) => sum + Math.abs(Math.min(0, value)), 0);
  const wins = pnl.filter((value) => value >= 0).length;
  const deviation = sampleStd(returns);
  const drawdown = maximumDrawdown(samples);
  const intervals = bootstrapIntervals(samples);
  return {
    trades: samples.length,
    wins,
    losses: samples.length - wins,
    winRate: samples.length > 0 ? wins / samples.length : 0,
    grossProfitUsd,
    grossLossUsd,
    profitFactor: grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0 ? null : 0,
    expectancyUsd: average(pnl),
    maxDrawdownUsd: drawdown.maxDrawdownUsd,
    maxDrawdownPercent: drawdown.maxDrawdownPercent,
    tradeSharpe: deviation > 0 ? average(returns) / deviation : 0,
    deflatedSharpeProbability: deflatedSharpeProbability(returns, numberOfTrials),
    ...intervals,
  };
}

function toSamples(trades: Trade[], cohortStart?: string, strategyVersion?: string): ClosedSample[] {
  const startMs = cohortStart ? new Date(cohortStart).getTime() : -Infinity;
  return trades
    .filter((trade) => Number.isFinite(Number(trade.pnl)))
    .map((trade) => {
      const timestamp = trade.exitTime || trade.timestamp;
      const timeMs = new Date(timestamp).getTime();
      const margin = Math.max(1, Number(trade.usdValue || 0));
      const pnlUsd = Number(trade.pnl || 0);
      const returnFraction = Number.isFinite(Number(trade.pnlPercent))
        ? Number(trade.pnlPercent) / 100
        : pnlUsd / margin;
      return {
        id: trade.id,
        timestamp,
        timeMs,
        pnlUsd,
        returnFraction,
        asset: trade.asset,
        strategyVersion: trade.strategyVersion || "legacy-unversioned",
        entryMode: trade.entryMode || "UNKNOWN",
        marketRegime: trade.marketRegime || "UNKNOWN",
      };
    })
    .filter((sample) => Number.isFinite(sample.timeMs) && sample.timeMs >= startMs)
    .filter((sample) => !strategyVersion || sample.strategyVersion === strategyVersion)
    .sort((a, b) => a.timeMs - b.timeMs);
}

function groupedMetrics(samples: ClosedSample[], key: (sample: ClosedSample) => string, trials: number): Record<string, ResearchMetrics> {
  const groups = new Map<string, ClosedSample[]>();
  for (const sample of samples) {
    const groupKey = key(sample);
    const values = groups.get(groupKey) || [];
    values.push(sample);
    groups.set(groupKey, values);
  }
  return Object.fromEntries(Array.from(groups.entries()).map(([groupKey, values]) => [groupKey, metrics(values, trials)]));
}

function probabilityOfBacktestOverfit(folds: WalkForwardFold[], samples: ClosedSample[], trials: number): number | null {
  if (trials < 2 || folds.length === 0) return null;
  const versions = Array.from(new Set(samples.map((sample) => sample.strategyVersion)));
  let evaluated = 0;
  let failed = 0;
  for (const fold of folds) {
    const validationStart = new Date(fold.validation.start).getTime();
    const validationEnd = new Date(fold.validation.end).getTime();
    const testStart = new Date(fold.test.start).getTime();
    const testEnd = new Date(fold.test.end).getTime();
    const validationByVersion = versions.map((version) => ({
      version,
      value: metrics(samples.filter((sample) => sample.strategyVersion === version && sample.timeMs >= validationStart && sample.timeMs <= validationEnd), trials).tradeSharpe,
    })).sort((a, b) => b.value - a.value);
    const champion = validationByVersion[0]?.version;
    if (!champion) continue;
    const testScores = versions.map((version) => metrics(
      samples.filter((sample) => sample.strategyVersion === version && sample.timeMs >= testStart && sample.timeMs <= testEnd),
      trials
    ).tradeSharpe).sort((a, b) => a - b);
    const championScore = metrics(samples.filter((sample) => sample.strategyVersion === champion && sample.timeMs >= testStart && sample.timeMs <= testEnd), trials).tradeSharpe;
    evaluated++;
    if (championScore < quantile(testScores, 0.5)) failed++;
  }
  return evaluated > 0 ? failed / evaluated : null;
}

export function buildWalkForwardResearchReport(input: {
  trades: Trade[];
  cohortStart?: string;
  strategyVersion?: string;
  embargoTrades?: number;
}): WalkForwardResearchReport {
  const samples = toSamples(input.trades, input.cohortStart, input.strategyVersion);
  const strategyVersions = Array.from(new Set(samples.map((sample) => sample.strategyVersion))).sort();
  const numberOfTrials = Math.max(1, strategyVersions.length);
  const embargoTrades = Math.max(1, input.embargoTrades ?? 1);
  const minimumTrain = 30;
  const validationSize = 10;
  const testSize = 10;
  const folds: WalkForwardFold[] = [];

  for (
    let trainEnd = minimumTrain;
    trainEnd + embargoTrades + validationSize + embargoTrades + testSize <= samples.length;
    trainEnd += testSize
  ) {
    const train = samples.slice(0, trainEnd);
    const validationStart = trainEnd + embargoTrades;
    const validation = samples.slice(validationStart, validationStart + validationSize);
    const testStart = validationStart + validationSize + embargoTrades;
    const test = samples.slice(testStart, testStart + testSize);
    if (train.length === 0 || validation.length === 0 || test.length === 0) continue;
    folds.push({
      id: `fold-${folds.length + 1}`,
      train: { start: train[0].timestamp, end: train[train.length - 1].timestamp, metrics: metrics(train, numberOfTrials) },
      validation: { start: validation[0].timestamp, end: validation[validation.length - 1].timestamp, metrics: metrics(validation, numberOfTrials) },
      test: { start: test[0].timestamp, end: test[test.length - 1].timestamp, metrics: metrics(test, numberOfTrials) },
      embargoedTrades: embargoTrades * 2,
    });
  }

  const testIds = new Set<string>();
  for (const fold of folds) {
    const start = new Date(fold.test.start).getTime();
    const end = new Date(fold.test.end).getTime();
    for (const sample of samples) {
      if (sample.timeMs >= start && sample.timeMs <= end) testIds.add(sample.id);
    }
  }
  const aggregateTestSamples = samples.filter((sample) => testIds.has(sample.id));
  const aggregateTest = metrics(aggregateTestSamples, numberOfTrials);
  const messages: string[] = [];
  if (samples.length < 30) messages.push(`Only ${samples.length} closed trade(s); at least 30 are required for preliminary review.`);
  if (folds.length === 0) messages.push("No complete train/validation/test fold is available yet.");
  if (aggregateTest.trades > 0 && Number(aggregateTest.profitFactor || 0) < 1.1) messages.push("Out-of-sample profit factor is below 1.10.");
  if (aggregateTest.trades > 0 && aggregateTest.expectancyUsd <= 0) messages.push("Out-of-sample expectancy is not positive.");
  if (aggregateTest.expectancy95 && aggregateTest.expectancy95.low <= 0) messages.push("The 95% bootstrap expectancy interval still includes zero or loss.");
  if (numberOfTrials < 2) messages.push("PBO is not estimable until at least two independently versioned strategies have completed trades.");

  const passed = samples.length >= 30 && folds.length > 0 && aggregateTest.trades > 0 &&
    Number(aggregateTest.profitFactor || 0) >= 1.1 && aggregateTest.expectancyUsd > 0 &&
    Boolean(aggregateTest.expectancy95 && aggregateTest.expectancy95.low > 0);

  return {
    harnessVersion: RESEARCH_HARNESS_VERSION,
    generatedAt: new Date().toISOString(),
    cohortStart: input.cohortStart || null,
    strategyVersions,
    numberOfTrials,
    folds,
    aggregateTest,
    byAsset: groupedMetrics(samples, (sample) => sample.asset, numberOfTrials),
    byRegime: groupedMetrics(samples, (sample) => sample.marketRegime, numberOfTrials),
    byEntryMode: groupedMetrics(samples, (sample) => sample.entryMode, numberOfTrials),
    probabilityOfBacktestOverfit: probabilityOfBacktestOverfit(folds, samples, numberOfTrials),
    readiness: {
      preliminarySampleReady: samples.length >= 30,
      strongerSampleReady: samples.length >= 100,
      passed,
      messages: messages.length > 0 ? messages : ["Walk-forward probation gates passed for this cohort."],
    },
  };
}
