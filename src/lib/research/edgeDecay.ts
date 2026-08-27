/**
 * Rolling re-validation.
 *
 * A backtest is a claim about the past. It expires. Crowding, changing fee
 * structures and shifting market regimes all erode a cross-sectional momentum
 * edge, and the way that erosion usually shows up is not a dramatic loss but a
 * slow decline in mean edge per period that a single full-sample statistic
 * hides completely — the good early months keep the average alive long after
 * the strategy has stopped working.
 *
 * This module cuts a return series into rolling windows and asks a narrower
 * question than "was this ever profitable": is the most recent window still
 * consistent with the earlier ones? It is used in two places, on purpose:
 *
 *   - offline, over replayed history, to show whether the measured edge is a
 *     stable property or an artefact of one good stretch;
 *   - live, over the book's own realised period returns, so the running system
 *     can notice its own decay instead of waiting for a human to check.
 *
 * The verdict is deliberately conservative about calling decay. Momentum has
 * long flat stretches, and a strategy that shuts itself off after every quiet
 * month would never trade.
 */

import { returnMoments } from "./deflatedSharpe";

export interface EdgeWindow {
  /** Index of the first period in this window. */
  startIndex: number;
  endIndex: number;
  /** ISO timestamps of the window bounds, when the caller supplies stamps. */
  startAt?: string;
  endAt?: string;
  periods: number;
  meanBps: number;
  tStat: number;
  /** Annualised, using the caller's period length. */
  sharpe: number;
  cumulativeReturn: number;
  hitRate: number;
}

export type EdgeVerdict =
  | "INSUFFICIENT_DATA"
  /**
   * There are enough periods to measure, and the measurement says the edge is
   * not distinguishable from zero. This is separate from decay on purpose:
   * nothing has deteriorated, there was simply never an established edge for a
   * later window to have preserved. Without this case a near-zero baseline
   * produces absurd retention ratios and a confident-sounding EDGE_STABLE.
   */
  | "NO_ESTABLISHED_EDGE"
  | "EDGE_STABLE"
  | "EDGE_WEAKENING"
  | "EDGE_GONE";

export interface EdgeDecayReport {
  windows: EdgeWindow[];
  verdict: EdgeVerdict;
  /** Mean bps per period across every window except the most recent. */
  baselineMeanBps: number;
  /** Mean bps per period in the most recent window. */
  recentMeanBps: number;
  /**
   * recentMeanBps / baselineMeanBps, or null when there is no baseline worth
   * dividing by — either not positive, or not distinguishable from zero.
   */
  retentionRatio: number | null;
  /**
   * t-statistic of the mean edge over the periods preceding the recent window.
   * This is what decides whether there is an established edge to decay from.
   */
  baselineTStat: number;
  /** Ordinary-least-squares slope of window mean edge over window index, in bps. */
  trendBpsPerWindow: number;
  /** True when the recent window is bad enough to justify standing down. */
  shouldHalt: boolean;
  explanation: string;
}

export interface EdgeDecayInput {
  /** Per-period fractional returns, oldest first. */
  returns: number[];
  /** Optional ISO timestamps, one per return, used only for labelling. */
  timestamps?: string[];
  /** Periods per rolling window. */
  windowSize: number;
  /** How far each window advances. Defaults to a quarter of the window. */
  stepSize?: number;
  /** Length of one period in hours, used to annualise Sharpe. */
  periodHours: number;
}

/**
 * Below this many windows there is nothing to compare, and a "decay" call
 * would just be noise about a short sample.
 */
export const MIN_WINDOWS_FOR_VERDICT = 4;

/** Recent edge below this fraction of baseline counts as weakening. */
export const WEAKENING_RETENTION = 0.5;

/**
 * Standing down requires the recent window to be outright negative as well as
 * far below baseline. A merely flat window is not evidence the edge is gone.
 */
export const HALT_RETENTION = 0.0;

/**
 * Two-sided 95% significance on the full series. Below this the mean edge is
 * not distinguishable from zero, and comparing windows to a baseline that is
 * itself indistinguishable from noise produces meaningless ratios.
 */
export const ESTABLISHED_EDGE_T = 2.0;

function windowStats(
  returns: number[],
  start: number,
  end: number,
  periodHours: number,
  timestamps?: string[]
): EdgeWindow {
  const slice = returns.slice(start, end);
  const n = slice.length;
  const mean = slice.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const periodsPerYear = (365 * 24) / periodHours;
  return {
    startIndex: start,
    endIndex: end - 1,
    startAt: timestamps?.[start],
    endAt: timestamps?.[end - 1],
    periods: n,
    meanBps: mean * 1e4,
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0,
    cumulativeReturn: slice.reduce((equity, r) => equity * (1 + r), 1) - 1,
    hitRate: slice.filter((r) => r > 0).length / n,
  };
}

/** Ordinary least squares slope of y against its own index. */
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den > 0 ? num / den : 0;
}

export function analyseEdgeDecay(input: EdgeDecayInput): EdgeDecayReport {
  const { returns, timestamps, windowSize, periodHours } = input;
  const step = Math.max(1, input.stepSize ?? Math.floor(windowSize / 4));

  const windows: EdgeWindow[] = [];
  for (let start = 0; start + windowSize <= returns.length; start += step) {
    windows.push(windowStats(returns, start, start + windowSize, periodHours, timestamps));
  }

  // Always include the final window, even when the step does not land on it.
  // Missing the most recent stretch would defeat the point of the exercise.
  if (returns.length >= windowSize) {
    const lastStart = returns.length - windowSize;
    if (windows.length === 0 || windows[windows.length - 1].startIndex !== lastStart) {
      windows.push(windowStats(returns, lastStart, returns.length, periodHours, timestamps));
    }
  }

  if (windows.length < MIN_WINDOWS_FOR_VERDICT) {
    return {
      windows,
      verdict: "INSUFFICIENT_DATA",
      baselineTStat: 0,
      baselineMeanBps: 0,
      recentMeanBps: windows.length > 0 ? windows[windows.length - 1].meanBps : 0,
      retentionRatio: null,
      trendBpsPerWindow: 0,
      shouldHalt: false,
      explanation:
        `Only ${windows.length} rolling window(s) of ${windowSize} periods are available; ` +
        `at least ${MIN_WINDOWS_FOR_VERDICT} are needed before decay can be distinguished from a quiet stretch.`,
    };
  }

  // Split the series at the recent window rather than judging it whole. The
  // full-sample statistic is the wrong test here: a strategy that worked and
  // then died drags its own total down, so a whole-series check would report
  // "never had an edge" precisely when it should be reporting decay.
  const splitAt = returns.length - windowSize;
  const baselineReturns = returns.slice(0, splitAt);
  const recentReturns = returns.slice(splitAt);

  const stats = (xs: number[]) => {
    const count = xs.length;
    if (count === 0) return { meanBps: 0, tStat: 0 };
    const mean = xs.reduce((a, b) => a + b, 0) / count;
    const variance = count > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (count - 1) : 0;
    const sd = Math.sqrt(variance);
    return { meanBps: mean * 1e4, tStat: sd > 0 ? mean / (sd / Math.sqrt(count)) : 0 };
  };

  const baseline = stats(baselineReturns);
  const recent = stats(recentReturns);
  const baselineMeanBps = baseline.meanBps;
  const trendBpsPerWindow = slope(windows.map((w) => w.meanBps));
  const retentionRatio = baselineMeanBps > 0 ? recent.meanBps / baselineMeanBps : null;

  let verdict: EdgeVerdict;
  let explanation: string;

  if (baseline.tStat < ESTABLISHED_EDGE_T) {
    // Nothing to decay from. Without this branch a baseline of a fraction of a
    // basis point produces retention ratios in the hundreds of percent and a
    // confident-sounding EDGE_STABLE built on noise.
    verdict = "NO_ESTABLISHED_EDGE";
    explanation =
      `Over the ${baselineReturns.length} periods before the current window the mean edge is ` +
      `${baselineMeanBps.toFixed(1)}bps with t = ${baseline.tStat.toFixed(2)}, short of the ` +
      `${ESTABLISHED_EDGE_T.toFixed(1)} needed to call it distinguishable from zero. Window averages range from ` +
      `${Math.min(...windows.map((w) => w.meanBps)).toFixed(1)}bps to ${Math.max(...windows.map((w) => w.meanBps)).toFixed(1)}bps, ` +
      `which is the spread noise alone would produce. Nothing has decayed; there is no established edge yet for the ` +
      `recent window to have preserved.`;
  } else if (retentionRatio !== null && retentionRatio <= HALT_RETENTION) {
    verdict = "EDGE_GONE";
    explanation =
      `The most recent ${windowSize} periods averaged ${recent.meanBps.toFixed(1)}bps against an established ` +
      `${baselineMeanBps.toFixed(1)}bps baseline (t = ${baseline.tStat.toFixed(2)}). Recent edge is negative and the ` +
      `window trend is ${trendBpsPerWindow >= 0 ? "+" : ""}${trendBpsPerWindow.toFixed(2)}bps per window. ` +
      `Stand the strategy down until a window comes back positive.`;
  } else if (retentionRatio !== null && retentionRatio < WEAKENING_RETENTION) {
    verdict = "EDGE_WEAKENING";
    explanation =
      `The most recent ${windowSize} periods averaged ${recent.meanBps.toFixed(1)}bps, ` +
      `${(retentionRatio * 100).toFixed(0)}% of the established ${baselineMeanBps.toFixed(1)}bps baseline. ` +
      `Still positive, so not yet grounds to stop, but the edge is thinner than the backtest assumed.`;
  } else {
    verdict = "EDGE_STABLE";
    explanation =
      `The most recent ${windowSize} periods averaged ${recent.meanBps.toFixed(1)}bps against an established ` +
      `${baselineMeanBps.toFixed(1)}bps baseline` +
      `${retentionRatio !== null ? ` (${(retentionRatio * 100).toFixed(0)}% retained)` : ""}. ` +
      `Consistent with the backtest; no sign of decay.`;
  }

  return {
    windows,
    verdict,
    baselineTStat: baseline.tStat,
    baselineMeanBps,
    recentMeanBps: recent.meanBps,
    retentionRatio: verdict === "NO_ESTABLISHED_EDGE" ? null : retentionRatio,
    trendBpsPerWindow,
    // Halting is reserved for an established edge that has turned negative.
    // An unproven strategy is not halted: the paper book exists to gather the
    // evidence that would settle the question, and freezing it prevents that.
    shouldHalt: verdict === "EDGE_GONE",
    explanation,
  };
}

/**
 * Compact ASCII plot of window edge over time, for terminal output. Kept here
 * rather than in the script so the same rendering can be reused.
 */
export function renderEdgePlot(windows: EdgeWindow[], width = 40): string[] {
  if (windows.length === 0) return [];
  const values = windows.map((w) => w.meanBps);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const zeroCol = Math.round(((0 - lo) / span) * (width - 1));

  return windows.map((w) => {
    const col = Math.round(((w.meanBps - lo) / span) * (width - 1));
    const cells: string[] = Array.from({ length: width }, (_, i) => (i === zeroCol ? "|" : " "));
    const from = Math.min(col, zeroCol);
    const to = Math.max(col, zeroCol);
    for (let i = from; i <= to; i++) cells[i] = i === zeroCol ? "|" : "#";
    const label = (w.endAt ?? `p${w.endIndex}`).slice(0, 10);
    return `  ${label.padEnd(11)}${cells.join("")}  ${w.meanBps >= 0 ? "+" : ""}${w.meanBps.toFixed(1)}bps  t=${w.tStat.toFixed(2)}`;
  });
}

/** Convenience wrapper used by the live daemon on the book's realised returns. */
export function summariseRealisedEdge(
  equityPoints: Array<{ at: string; equityUsd: number }>,
  periodHours: number,
  windowSize: number
): EdgeDecayReport {
  const sorted = [...equityPoints].sort((a, b) => a.at.localeCompare(b.at));
  const returns: number[] = [];
  const timestamps: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prior = sorted[i - 1].equityUsd;
    if (!(prior > 0)) continue;
    returns.push(sorted[i].equityUsd / prior - 1);
    timestamps.push(sorted[i].at);
  }
  const moments = returnMoments(returns);
  const report = analyseEdgeDecay({ returns, timestamps, windowSize, periodHours });
  // Surface tail shape in the explanation: a positive mean built out of one
  // outlier is not the same evidence as a positive mean built out of many.
  if (report.verdict !== "INSUFFICIENT_DATA" && moments.kurtosis > 8) {
    report.explanation += ` Returns are heavily tailed (kurtosis ${moments.kurtosis.toFixed(1)}), so window averages rest on comparatively few periods.`;
  }
  return report;
}
