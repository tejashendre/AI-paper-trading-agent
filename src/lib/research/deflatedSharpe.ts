/**
 * Multiple-testing correction for backtested performance.
 *
 * A Sharpe ratio picked as the best of many trials is biased upward, and the
 * bias is large. Searching a hundred parameter combinations against pure noise
 * still produces a "best" result with a t-statistic around 2.6-3.0 — which is
 * roughly what the cross-sectional book reported. Quoting that number without
 * saying how many combinations were tried overstates the evidence.
 *
 * This implements the deflated Sharpe ratio of Bailey and Lopez de Prado: it
 * estimates the Sharpe you would expect from the best of N independent trials
 * under the null of no skill, then asks how confident we can be that the
 * observed Sharpe exceeds it.
 *
 * The honest caveat, stated here because it materially affects the answer:
 * parameter combinations drawn from a plateau are *not* independent. Neighbouring
 * settings share data and produce correlated results, so the effective number
 * of trials is smaller than the number run. `effectiveTrials` below applies a
 * conservative discount rather than pretending the trials were independent.
 */

/** Standard normal CDF, via a numerical error function. */
export function normalCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 — accurate to ~1e-7, far beyond what is needed.
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const EULER_MASCHERONI = 0.5772156649015329;

export interface DeflatedSharpeInput {
  /** Observed Sharpe, expressed per period (not annualised). */
  observedSharpePerPeriod: number;
  /** Number of return observations behind it. */
  periods: number;
  /** Skewness of the period returns. */
  skew: number;
  /** Kurtosis of the period returns (3 for a normal distribution). */
  kurtosis: number;
  /** How many configurations were tried before this one was chosen. */
  trials: number;
  /**
   * Fraction of trials treated as independent. Parameter plateaus produce
   * heavily correlated results, so counting every combination as a fresh test
   * would over-penalise. 0.25 is deliberately conservative in the other
   * direction than simply using `trials`.
   */
  independenceFactor?: number;
}

export interface DeflatedSharpeResult {
  observedSharpePerPeriod: number;
  annualisedSharpe: number | null;
  trials: number;
  effectiveTrials: number;
  /** Sharpe expected from the best of N trials under the null of no skill. */
  expectedMaxSharpeUnderNull: number;
  /** Probability the observed Sharpe reflects genuine skill. */
  deflatedSharpe: number;
  passes: boolean;
  verdict: string;
}

/**
 * Expected maximum of N independent standard-normal Sharpe estimates.
 * This is the bar a searched result has to clear to mean anything.
 */
export function expectedMaxSharpeUnderNull(effectiveTrials: number, periods: number): number {
  const n = Math.max(2, effectiveTrials);
  const varianceOfEstimate = 1 / Math.max(1, periods - 1);
  const gumbel =
    (1 - EULER_MASCHERONI) * normalInv(1 - 1 / n) +
    EULER_MASCHERONI * normalInv(1 - 1 / (n * Math.E));
  return Math.sqrt(varianceOfEstimate) * gumbel;
}

export function deflatedSharpeRatio(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const independence = input.independenceFactor ?? 0.25;
  const effectiveTrials = Math.max(1, Math.round(input.trials * independence));
  const benchmark = expectedMaxSharpeUnderNull(effectiveTrials, input.periods);

  const sr = input.observedSharpePerPeriod;
  const n = input.periods;
  // Bailey & Lopez de Prado: the standard error of a Sharpe estimate widens
  // with negative skew and fat tails, both of which trading returns have.
  const denominator = Math.sqrt(
    Math.max(1e-12, 1 - input.skew * sr + ((input.kurtosis - 1) / 4) * sr * sr)
  );
  const statistic = ((sr - benchmark) * Math.sqrt(Math.max(1, n - 1))) / denominator;
  const probability = normalCdf(statistic);

  const passes = probability >= 0.95;
  const verdict = passes
    ? `Deflated Sharpe ${(probability * 100).toFixed(1)}%: the result survives correction for ${input.trials} configurations tried. The edge is unlikely to be a product of the search.`
    : probability >= 0.5
      ? `Deflated Sharpe ${(probability * 100).toFixed(1)}%: below the 95% bar. After correcting for ${input.trials} configurations tried, this result is suggestive but not conclusive — the raw t-statistic overstates it.`
      : `Deflated Sharpe ${(probability * 100).toFixed(1)}%: the observed Sharpe does not clear what the best of ${effectiveTrials} effective trials would produce by chance. Treat this as unproven.`;

  return {
    observedSharpePerPeriod: sr,
    annualisedSharpe: null,
    trials: input.trials,
    effectiveTrials,
    expectedMaxSharpeUnderNull: benchmark,
    deflatedSharpe: probability,
    passes,
    verdict,
  };
}

/** Sample skewness and excess-adjusted kurtosis of a return series. */
export function returnMoments(returns: number[]): { mean: number; sd: number; skew: number; kurtosis: number } {
  const n = returns.length;
  if (n < 4) return { mean: 0, sd: 0, skew: 0, kurtosis: 3 };
  const mean = returns.reduce((s, v) => s + v, 0) / n;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return { mean, sd: 0, skew: 0, kurtosis: 3 };
  const skew = returns.reduce((s, v) => s + ((v - mean) / sd) ** 3, 0) / n;
  const kurtosis = returns.reduce((s, v) => s + ((v - mean) / sd) ** 4, 0) / n;
  return { mean, sd, skew, kurtosis };
}
