/**
 * Does the regime label actually predict anything?
 *
 * The dashboard reports a market regime — TRENDING, MEAN_REVERTING or CHOPPY —
 * derived from a Hurst exponent. It has always been displayed with the
 * authority of a measurement, and nobody has ever checked whether it carries
 * information about what happens next. A label that does not change expected
 * returns is decoration wearing the costume of a number, and it is worse than
 * nothing: it invites the reader to act on it.
 *
 * This settles the question the only way it can be settled. Bucket realised
 * period returns by the regime that was in force when the period began, and
 * test whether the buckets differ by more than sampling noise. If they do, the
 * label is worth conditioning on. If they do not, it should be deleted or
 * relabelled as descriptive.
 *
 * The comparison is Welch's t-test rather than Student's, because the buckets
 * have neither equal sizes nor equal variances — CHOPPY is usually the largest
 * bucket and TRENDING periods are the most volatile, which is exactly the
 * situation where assuming equal variance overstates significance.
 */

import { normalCdf } from "./deflatedSharpe";

export interface RegimeBucket {
  regime: string;
  periods: number;
  meanBps: number;
  sdBps: number;
  tStat: number;
  hitRate: number;
}

export type RegimeVerdict =
  | "INSUFFICIENT_DATA"
  | "REGIME_IS_DECORATIVE"
  | "REGIME_IS_INFORMATIVE";

export interface RegimeConditioningReport {
  buckets: RegimeBucket[];
  best: RegimeBucket | null;
  worst: RegimeBucket | null;
  /** Difference in mean edge between the best and worst regime, in bps. */
  spreadBps: number;
  /** Welch t-statistic for that difference. */
  welchT: number;
  /** Two-sided p-value for the difference. */
  pValue: number;
  verdict: RegimeVerdict;
  explanation: string;
}

/** Below this many observations a bucket cannot support a comparison. */
export const MIN_PERIODS_PER_BUCKET = 30;

/** Two-sided significance required before conditioning on the label. */
export const SIGNIFICANCE_P = 0.05;

function summarise(regime: string, values: number[]): RegimeBucket {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  return {
    regime,
    periods: n,
    meanBps: mean * 1e4,
    sdBps: sd * 1e4,
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    hitRate: values.filter((v) => v > 0).length / n,
  };
}

export function analyseRegimeConditioning(input: {
  /** Regime in force at the start of each period. */
  labels: string[];
  /** Fractional return of each period, same order and length as labels. */
  returns: number[];
}): RegimeConditioningReport {
  const byRegime = new Map<string, number[]>();
  const pairs = Math.min(input.labels.length, input.returns.length);
  for (let i = 0; i < pairs; i++) {
    const label = input.labels[i];
    if (!byRegime.has(label)) byRegime.set(label, []);
    byRegime.get(label)!.push(input.returns[i]);
  }

  const buckets = [...byRegime.entries()]
    .map(([regime, values]) => summarise(regime, values))
    .sort((a, b) => b.meanBps - a.meanBps);

  const usable = buckets.filter((b) => b.periods >= MIN_PERIODS_PER_BUCKET);

  if (usable.length < 2) {
    return {
      buckets,
      best: null,
      worst: null,
      spreadBps: 0,
      welchT: 0,
      pValue: 1,
      verdict: "INSUFFICIENT_DATA",
      explanation:
        `Only ${usable.length} regime bucket(s) reached ${MIN_PERIODS_PER_BUCKET} periods ` +
        `(${buckets.map((b) => `${b.regime}: ${b.periods}`).join(", ") || "none observed"}). ` +
        `At least two are needed before the label can be tested.`,
    };
  }

  const best = usable[0];
  const worst = usable[usable.length - 1];
  const spreadBps = best.meanBps - worst.meanBps;

  // Welch: the two buckets differ in size and in variance, and assuming
  // otherwise would inflate significance in exactly the direction that makes
  // a decorative label look informative.
  const seSquared = (best.sdBps ** 2) / best.periods + (worst.sdBps ** 2) / worst.periods;
  const welchT = seSquared > 0 ? spreadBps / Math.sqrt(seSquared) : 0;
  const pValue = 2 * (1 - normalCdf(Math.abs(welchT)));

  const informative = pValue < SIGNIFICANCE_P;
  const summary = usable
    .map((b) => `${b.regime} ${b.meanBps >= 0 ? "+" : ""}${b.meanBps.toFixed(1)}bps over ${b.periods} periods`)
    .join(", ");

  return {
    buckets,
    best,
    worst,
    spreadBps,
    welchT,
    pValue,
    verdict: informative ? "REGIME_IS_INFORMATIVE" : "REGIME_IS_DECORATIVE",
    explanation: informative
      ? `The label carries information: ${summary}. The gap between ${best.regime} and ${worst.regime} is ` +
        `${spreadBps.toFixed(1)}bps per period (Welch t = ${welchT.toFixed(2)}, p = ${pValue.toFixed(3)}), ` +
        `which is larger than sampling noise would produce. Conditioning on it is justified.`
      : `The label carries no information: ${summary}. The gap between ${best.regime} and ${worst.regime} is ` +
        `${spreadBps.toFixed(1)}bps per period (Welch t = ${welchT.toFixed(2)}, p = ${pValue.toFixed(3)}), ` +
        `well within what sampling noise produces. Displaying it as though it predicts something is misleading; ` +
        `it should be described as a property of recent prices, not as a forecast.`,
  };
}
