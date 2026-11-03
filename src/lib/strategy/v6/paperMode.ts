import type { BrainEvidenceReview } from './evidence';

/**
 * Paper-trading gate for the v6 brain.
 *
 * The strict evidence gate needs 30+ forward shadow outcomes spanning 30+ days
 * and a deflated Sharpe >= 0.95 before any asset may place a paper entry. In
 * practice that kept every asset in SHADOW indefinitely, so the paper account
 * never traded. This is a simulated account, so the default ("open") lets the
 * breakers, sizing, capacity and fenced commits govern entries. Evidence is
 * still collected and reviewed exactly as before.
 *
 * Set V6_PAPER_GATE=strict to restore the original evidence-only permission.
 */
export function paperGateOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.V6_PAPER_GATE ?? 'open').trim().toLowerCase() !== 'strict';
}

/** Modes that never permit new risk, even with the open paper gate. */
const BLOCKING_MODES = new Set(['RETIRED', 'REDUCE_ONLY', 'DISABLED']);

/**
 * Permission used by the open paper gate: a current, unexpired, run-matched
 * proof is still required (so commit fencing keeps working), but SHADOW and
 * warming modes may trade at the base risk tier.
 */
export function paperGatePermission(review: BrainEvidenceReview | undefined, nowMs: number,
  context: { runId: string; sourceHash: string; costHash: string; riskPolicyHash: string; exitPolicyHash: string }): { allowed: boolean; reason: string } {
  if (!review) return { allowed: false, reason: 'NO_EVIDENCE_PROOF' };
  if (Object.entries(context).some(([key, value]) => review[key as keyof typeof context] !== value)) return { allowed: false, reason: 'CURRENT_RUN_OR_POLICY_MISMATCH' };
  if (!Number.isFinite(nowMs) || nowMs < review.createdAtMs || nowMs >= review.expiresAtMs) return { allowed: false, reason: 'STALE_OR_FUTURE_PROOF' };
  if (BLOCKING_MODES.has(review.mode)) return { allowed: false, reason: review.mode };
  return { allowed: true, reason: review.mode === 'PAPER_ACTIVE' ? 'EXACT_EVIDENCE_QUALIFIED' : 'PAPER_GATE_OPEN' };
}
