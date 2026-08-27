/**
 * Whether a second strategy is worth running alongside the first.
 *
 * The instinct when one signal looks fragile is to add another good-looking
 * signal. That instinct is wrong, and expensively so: two strategies that are
 * 0.8 correlated are close to one strategy carrying twice the operational
 * surface area. What matters is not how attractive a candidate looks on its
 * own but how little it moves with what you already have. A weaker,
 * genuinely uncorrelated sleeve improves a book more than a stronger
 * correlated one.
 *
 * This module implements that selection rule. It is deliberately written
 * against two arbitrary return series rather than against any particular
 * strategy, so it can grade a candidate before the candidate is built — and
 * so it can be pointed at the two sleeves this system already runs, which
 * nobody had ever compared.
 */

export interface SleeveSeries {
  name: string;
  /** Equity observations, any cadence, oldest first. */
  points: Array<{ at: string; equityUsd: number }>;
}

export interface SleeveComparison {
  nameA: string;
  nameB: string;
  /** Calendar days on which both sleeves recorded a return. */
  overlappingPeriods: number;
  correlation: number | null;
  sharpeA: number;
  sharpeB: number;
  /** Sharpe of an equal-risk blend of the two. */
  blendedSharpe: number;
  /** blendedSharpe / max(sharpeA, sharpeB). Above 1.0 the pair is worth running. */
  diversificationGain: number | null;
  verdict: "INSUFFICIENT_OVERLAP" | "REDUNDANT" | "MARGINAL" | "DIVERSIFYING";
  explanation: string;
}

/** Below this many shared days, a correlation is not worth quoting. */
export const MIN_OVERLAP = 20;

/** Above this correlation a second sleeve is mostly duplicating the first. */
export const REDUNDANT_CORRELATION = 0.6;

/** Below this, the pair is genuinely diversifying. */
export const DIVERSIFYING_CORRELATION = 0.3;

/**
 * Daily returns, keyed by calendar day.
 *
 * The two sleeves record on completely different schedules — the book marks
 * every rebalance, the swing engine whenever a position closes — so pairing
 * raw observations would produce a correlation that describes the sampling
 * rather than the strategies. Collapsing to one closing equity per day and
 * differencing that gives both sleeves the same clock.
 */
function toDailyReturns(points: Array<{ at: string; equityUsd: number }>): Map<string, number> {
  const closeByDay = new Map<string, { at: string; equityUsd: number }>();
  for (const point of points) {
    if (!(point.equityUsd > 0)) continue;
    const day = point.at.slice(0, 10);
    const held = closeByDay.get(day);
    if (!held || point.at > held.at) closeByDay.set(day, point);
  }

  const days = [...closeByDay.keys()].sort();
  const out = new Map<string, number>();
  for (let i = 1; i < days.length; i++) {
    const prior = closeByDay.get(days[i - 1])!.equityUsd;
    const current = closeByDay.get(days[i])!.equityUsd;
    if (!(prior > 0)) continue;
    // Gaps are left as gaps rather than interpolated. A sleeve that recorded
    // nothing for a week did not earn a flat return over it; we simply do not
    // know, and inventing zeros would drag every correlation toward zero.
    out.set(days[i], current / prior - 1);
  }
  return out;
}

function moments(xs: number[]): { mean: number; sd: number } {
  const n = xs.length;
  if (n === 0) return { mean: 0, sd: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, sd: Math.sqrt(variance) };
}

export function pearson(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const ma = moments(a);
  const mb = moments(b);
  if (!(ma.sd > 0) || !(mb.sd > 0)) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - ma.mean) * (b[i] - mb.mean);
  return sum / ((a.length - 1) * ma.sd * mb.sd);
}

export function compareSleeves(a: SleeveSeries, b: SleeveSeries): SleeveComparison {
  const ra = toDailyReturns(a.points);
  const rb = toDailyReturns(b.points);

  const sharedKeys = [...ra.keys()].filter((k) => rb.has(k)).sort();
  const xs = sharedKeys.map((k) => ra.get(k)!);
  const ys = sharedKeys.map((k) => rb.get(k)!);

  const base = {
    nameA: a.name,
    nameB: b.name,
    overlappingPeriods: sharedKeys.length,
  };

  if (sharedKeys.length < MIN_OVERLAP) {
    return {
      ...base,
      correlation: null,
      sharpeA: 0,
      sharpeB: 0,
      blendedSharpe: 0,
      diversificationGain: null,
      verdict: "INSUFFICIENT_OVERLAP",
      explanation:
        `${a.name} and ${b.name} share only ${sharedKeys.length} day(s) of overlapping history; ` +
        `${MIN_OVERLAP} are needed before a correlation between them means anything.`,
    };
  }

  const ma = moments(xs);
  const mb = moments(ys);
  const correlation = pearson(xs, ys);

  // Per-day Sharpe, deliberately not annualised. Annualising would multiply
  // both sides by the same constant without changing the comparison, while
  // implying more precision than 20-odd days of history supports.
  const sharpeA = ma.sd > 0 ? ma.mean / ma.sd : 0;
  const sharpeB = mb.sd > 0 ? mb.mean / mb.sd : 0;

  // Equal-risk blend: scale each sleeve to unit volatility before combining,
  // so the comparison is about correlation rather than about which sleeve
  // happens to be sized larger.
  const blend = xs.map((x, i) => (ma.sd > 0 ? x / ma.sd : 0) + (mb.sd > 0 ? ys[i] / mb.sd : 0));
  const mBlend = moments(blend);
  const blendedSharpe = mBlend.sd > 0 ? mBlend.mean / mBlend.sd : 0;

  const best = Math.max(sharpeA, sharpeB);
  const diversificationGain = best > 0 ? blendedSharpe / best : null;

  let verdict: SleeveComparison["verdict"];
  let explanation: string;
  const corr = correlation ?? 0;

  if (corr >= REDUNDANT_CORRELATION) {
    verdict = "REDUNDANT";
    explanation =
      `${a.name} and ${b.name} move together ${(corr * 100).toFixed(0)}% of the time across ` +
      `${sharedKeys.length} shared days. Running both is close to running one strategy with twice ` +
      `the moving parts; a bad stretch for one is a bad stretch for the other.`;
  } else if (corr > DIVERSIFYING_CORRELATION) {
    verdict = "MARGINAL";
    explanation =
      `${a.name} and ${b.name} correlate at ${corr.toFixed(2)} over ${sharedKeys.length} shared days. ` +
      `There is some independence here, but not enough for the second sleeve to carry the book through ` +
      `a bad run in the first.`;
  } else {
    verdict = "DIVERSIFYING";
    explanation =
      `${a.name} and ${b.name} correlate at ${corr.toFixed(2)} over ${sharedKeys.length} shared days, ` +
      `which is low enough to matter. An equal-risk blend scores ` +
      `${diversificationGain !== null ? `${diversificationGain.toFixed(2)}x` : "n/a"} the better sleeve alone. ` +
      `Worth running both even if one is individually weaker.`;
  }

  return {
    ...base,
    correlation,
    sharpeA,
    sharpeB,
    blendedSharpe,
    diversificationGain,
    verdict,
    explanation,
  };
}
