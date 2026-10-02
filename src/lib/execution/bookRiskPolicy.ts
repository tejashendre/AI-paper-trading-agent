import type { PerpTicker } from "@/lib/data/perpUniverse";
import type { BookPosition } from "@/lib/execution/bookRebalancer";
import { BookPlan, CROSS_SECTIONAL_STRATEGY_VERSION, RebalanceOrder } from "@/lib/strategy/crossSectionalMomentum";
import type { EquityPoint } from "@/lib/execution/equityCurve";
import { blockBootstrapMean95 } from "@/lib/research/deflatedSharpe";

/**
 * Risk state for the cross-sectional book. A halt stops new risk; it never
 * stops managing existing risk. Marking, funding, the exit watchdog and the
 * edge review run in every state.
 *
 *   ACTIVE       entries and reductions allowed
 *   ENTRY_HALT   lost edge without a breach: no new risk, reductions allowed
 *   REDUCE_ONLY  drawdown breach with open positions: staged unwind only
 *   SHADOW       breached and flat: no live trading, shadow evidence only
 */
export type BookRiskState = "ACTIVE" | "ENTRY_HALT" | "REDUCE_ONLY" | "SHADOW";

export const BOOK_RISK_POLICY_VERSION = "book-risk-v1-2026-10-01";
export const BOOK_HARD_DRAWDOWN_PERCENT = 25;
/** The verdict research must publish before a halted book may be released. */
export const PROMOTION_EVIDENCE_PASSED = "PROMOTION_EVIDENCE_PASSED";
/** Shadow periods (12h each) required before a release: fifteen days. */
export const SHADOW_EVIDENCE_MIN_PERIODS = 30;
/** The shadow book itself must not have drawn down further than this. */
export const SHADOW_EVIDENCE_MAX_DRAWDOWN_PERCENT = 15;

/**
 * Whether the capital-free shadow book has earned a release: enough periods,
 * a 95% block-bootstrap lower bound on its mean net period return above zero
 * (fees and funding are inside its equity), and a contained drawdown.
 */
export function evaluateShadowEvidence(curve: EquityPoint[]) {
  const equity = curve.map((point) => point.equityUsd).filter((value) => Number.isFinite(value) && value > 0);
  const returns = equity.slice(1).map((value, i) => value / equity[i] - 1);
  const reasons: string[] = [];
  if (returns.length < SHADOW_EVIDENCE_MIN_PERIODS) {
    reasons.push(`INSUFFICIENT_SHADOW_PERIODS: ${returns.length} of ${SHADOW_EVIDENCE_MIN_PERIODS} shadow rebalance periods`);
  }
  const interval = blockBootstrapMean95(returns);
  if (!interval || !(interval.low > 0)) {
    reasons.push(`SHADOW_EDGE_NOT_ESTABLISHED: 95% lower bound of mean period return ${interval ? (interval.low * 100).toFixed(3) + "%" : "unavailable"}`);
  }
  let peak = equity[0] ?? 0;
  let maxDrawdownPercent = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - value) / peak) * 100);
  }
  if (maxDrawdownPercent >= SHADOW_EVIDENCE_MAX_DRAWDOWN_PERCENT) {
    reasons.push(`SHADOW_DRAWDOWN: ${maxDrawdownPercent.toFixed(2)}% reached the ${SHADOW_EVIDENCE_MAX_DRAWDOWN_PERCENT}% limit`);
  }
  return {
    passed: reasons.length === 0,
    reasons,
    metrics: { periods: returns.length, meanReturn95: interval, maxDrawdownPercent },
  };
}

/**
 * Drawdown of a released book, measured from the best equity since the
 * release. The lifetime breaker keeps running alongside it.
 */
export function epochDrawdownPercent(epoch: { releaseEquityUsd: number; epochPeakEquityUsd: number }, equityUsd: number): number {
  const peak = Math.max(epoch.releaseEquityUsd, epoch.epochPeakEquityUsd);
  return peak > 0 ? Math.max(0, ((peak - equityUsd) / peak) * 100) : 0;
}
const LOST_EDGE_VERDICTS = new Set(["EDGE_GONE"]);

export interface BookRiskDecision {
  state: BookRiskState;
  allowEntries: boolean;
  allowReductions: boolean;
  reasons: string[];
}

export function evaluateBookRisk(input: {
  previous: BookRiskState;
  lifetimeMaxDrawdownPercent: number;
  currentDrawdownPercent: number;
  hasOpenPositions: boolean;
  entryDataReady: boolean;
  exitDataReady: boolean;
  edgeVerdict: string;
  releaseAuthorized: boolean;
  /**
   * Lifetime maximum drawdown already reviewed in an authorized release. The
   * lifetime figure is never reset, so only a deeper breach, or a current
   * drawdown past the breaker, reopens the incident.
   */
  breachAcknowledgedAtPercent?: number;
}): BookRiskDecision {
  const reasons: string[] = [];
  const acknowledged = input.breachAcknowledgedAtPercent ?? Number.NEGATIVE_INFINITY;
  const newBreach =
    (input.lifetimeMaxDrawdownPercent >= BOOK_HARD_DRAWDOWN_PERCENT && input.lifetimeMaxDrawdownPercent > acknowledged) ||
    input.currentDrawdownPercent >= BOOK_HARD_DRAWDOWN_PERCENT;
  const incidentOpen = newBreach || input.previous === "REDUCE_ONLY" || input.previous === "SHADOW";

  let state: BookRiskState;
  if (incidentOpen) {
    reasons.push(newBreach
      ? `DRAWDOWN_BREACH: lifetime maximum drawdown ${input.lifetimeMaxDrawdownPercent.toFixed(2)}% (current ${input.currentDrawdownPercent.toFixed(2)}%) reached the ${BOOK_HARD_DRAWDOWN_PERCENT}% breaker; recovery does not clear it`
      : "INCIDENT_OPEN: the book stays halted until a reviewed release");
    state = input.hasOpenPositions ? "REDUCE_ONLY" : "SHADOW";
    if (state === "SHADOW") {
      const evidence = input.edgeVerdict === PROMOTION_EVIDENCE_PASSED;
      // The authorized release is what acknowledges the lifetime breach. A
      // SHADOW book is flat, so its drawdown cannot recover and is not a
      // release criterion; the shadow evidence is.
      if (evidence && input.releaseAuthorized) {
        state = "ACTIVE";
        reasons.push("RELEASED: documented release authorization and promotion evidence are both present; record the acknowledged breach level");
      } else if (evidence) {
        reasons.push("ELIGIBLE_FOR_REVIEW: promotion evidence passed; a documented release authorization is still required");
      } else {
        reasons.push(`AWAITING_EVIDENCE: shadow evidence continues; release needs promotion evidence${input.releaseAuthorized ? "" : " and a documented authorization"}`);
      }
    }
  } else if (LOST_EDGE_VERDICTS.has(input.edgeVerdict)) {
    state = "ENTRY_HALT";
    reasons.push(`EDGE_LOST: verdict ${input.edgeVerdict}; no new risk, existing positions stay managed, shadow evidence continues`);
  } else {
    state = "ACTIVE";
  }

  const allowEntries = state === "ACTIVE" && input.entryDataReady;
  if (state === "ACTIVE" && !input.entryDataReady) reasons.push("ENTRY_DATA_UNAVAILABLE: no entries until market data is valid");
  const allowReductions = state !== "SHADOW" && input.hasOpenPositions && input.exitDataReady;
  if (state !== "SHADOW" && input.hasOpenPositions && !input.exitDataReady) {
    reasons.push("EXIT_DATA_UNAVAILABLE: reductions wait for valid prices; positions stay recorded and marked");
  }
  return { state, allowEntries, allowReductions, reasons };
}

/**
 * One staged step of a reduce-only unwind. Every order moves a position
 * toward zero by at most `maxParticipation` of its 24h turnover and never
 * crosses zero or opens a symbol. A position without a valid price or
 * turnover is left untouched and named in the plan's reason, to retry when
 * data returns; nothing is filled at an invented price.
 */
export function makeReduceOnlyPlan(input: {
  positions: BookPosition[];
  prices: Map<string, PerpTicker>;
  maxParticipation: number;
  equityUsd: number;
}): BookPlan {
  const orders: RebalanceOrder[] = [];
  const blocked: string[] = [];
  for (const position of input.positions) {
    const ticker = input.prices.get(position.symbol);
    const mark = ticker?.markPrice ?? Number.NaN;
    if (!ticker || !(mark > 0) || !(ticker.turnover24h > 0) || !(input.equityUsd > 0)) {
      blocked.push(`${position.symbol}: no valid price or turnover`);
      continue;
    }
    const held = Math.abs(position.quantity);
    if (held === 0) continue;
    const remaining = Math.max(0, held - (input.maxParticipation * ticker.turnover24h) / mark);
    const fromWeight = (position.quantity * mark) / input.equityUsd;
    const toWeight = remaining * mark < 1 ? 0 : (Math.sign(position.quantity) * remaining * mark) / input.equityUsd;
    orders.push({
      symbol: position.symbol,
      weightDelta: toWeight - fromWeight,
      action: toWeight === 0 ? "CLOSE" : "REDUCE",
      fromWeight,
      toWeight,
    });
  }
  const step = `${(input.maxParticipation * 100).toFixed(2)}% of 24h turnover per step`;
  return {
    strategyVersion: CROSS_SECTIONAL_STRATEGY_VERSION,
    targets: [],
    orders,
    turnover: orders.reduce((sum, order) => sum + Math.abs(order.weightDelta), 0),
    universeSize: input.positions.length,
    skipped: orders.length === 0,
    reason: `REDUCE_ONLY staged unwind (${step})${blocked.length > 0 ? `; blocked: ${blocked.join("; ")}` : ""}`,
  };
}
