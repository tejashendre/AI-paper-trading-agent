import { createHash } from "node:crypto";
import type { BrainDefinition } from "./engine";
import { executionCostModelVersionFor, getExecutionCostProfile, type ExecutionCostProfile } from "@/lib/trading/executionCostModel";
import { feeScheduleFor, type FeeSchedule } from "@/lib/trading/assetSpecs";
import { getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";
import { deflatedSharpeRatio, returnMoments } from "@/lib/research/deflatedSharpe";

const DAY = 86_400_000;
export type BrainMode = "DISABLED" | "WARMING_UP" | "SHADOW" | "VALIDATION_READY" | "PAPER_ACTIVE" | "REDUCE_ONLY" | "RETIRED";
export type BrainRiskTier = "BASE" | "ESCALATED";
export interface BrainFrozenCosts {
  asset: string; modelVersion: string; profile: ExecutionCostProfile; feeSchedule: FeeSchedule;
  stress: { spreadMultiplier: number; slippageMultiplier: number; impactMultiplier: number;
    stopGapMultiplier: number; takerFeeMultiplier: number; fundingMultiplier: number; fundingFloorPer480Minutes: number };
}
export interface BrainFold {
  foldId: string; trainEndMs: number; validationEndMs: number; evaluationStartMs: number;
  evaluationEndMs: number; declaredAtMs: number; embargoMs: number; purged: boolean;
}
export interface BrainRegistration {
  runId: string; sourceHash: string; costHash: string; riskPolicyHash: string; exitPolicyHash: string;
  registeredAtMs: number; releasedAtMs: number; firstEvaluationAtMs: number; trialSnapshotHash: string;
  costs: BrainFrozenCosts; folds: BrainFold[];
}
export interface BrainTrial {
  trialId: string; sourceHash: string; registeredAtMs: number; kind: "LEGACY" | "INITIAL" | "CHALLENGER" | "COMPARATOR";
}
interface SourceObservation { sourceHash: string; availableAtMs: number; }
export interface BrainExecutionObservation extends SourceObservation {
  /** Modeled fill time; the spread/depth source must already be available. */
  atMs: number; halfSpreadBps: number; depthNotionalUsdt: number;
}
export interface BrainFundingObservation extends SourceObservation {
  atMs: number; actualRate: number; mark: number; intervalMinutes: number;
}
export interface BrainOutcome extends SourceObservation {
  positionId: string; identityHash: string; runId: string; origin: "HISTORICAL" | "SHADOW" | "PAPER";
  openedAtMs: number; closedAtMs: number; netR: number; stressedNetR: number; initialRiskUsdt: number;
  costHash: string; executions: BrainExecutionObservation[]; fundingIntervalMs: number;
  funding: BrainFundingObservation[]; criticalViolation: boolean; foldId?: string;
}
export interface BrainDailyReturn extends SourceObservation {
  identityHash: string; runId: string; costHash: string; dayStartMs: number;
  baseRiskFraction: number; netReturn: number;
}
export interface BrainPortfolioEvidence {
  identityHash: string; runId: string; sourceHash: string; riskFraction: number; alignedBlockMs: number;
  factorClusters: string[]; equity: { atMs: number; equityUsdt: number }[];
  unresolvedBreaker: boolean; integrityRestored: boolean;
}
export interface BrainHalt { kind: "STREAK" | "DRAWDOWN" | "INTEGRITY"; atMs: number; sourceHash: string; operatorReviewHash?: string; }
export interface BrainEvidenceInput {
  definition: BrainDefinition; registration: BrainRegistration; outcomes: BrainOutcome[];
  dailyReturns: BrainDailyReturn[]; trials: BrainTrial[]; portfolio: BrainPortfolioEvidence;
  nowMs: number; expiresAtMs: number; previousReview?: BrainEvidenceReview; halt?: BrainHalt;
  activatedAtMs?: number; escalation?: boolean;
}
export interface BrainBootstrap { low: number; high: number; mean: number; blockMs: number; blocks: number; positions: number; iterations: number; }
export interface BrainDailyStats { days: number; effectiveDays: number; sharpePerDay: number; skew: number;
  kurtosis: number; trials: number; deflatedSharpe: number; annualisedSharpe: null; }
export interface BrainEvidenceReview {
  version: "v6"; runId: string; identityHash: string; definitionHash: string; semanticHash: string;
  sourceHash: string; registrationHash: string; inputHash: string; proofHash: string;
  costHash: string; riskPolicyHash: string; exitPolicyHash: string;
  createdAtMs: number; expiresAtMs: number; mode: BrainMode; route: "HISTORICAL" | "FORWARD_ONLY" | null;
  riskTier: BrainRiskTier; historicalCount: number; forwardCount: number; paperCount: number;
  nextEligibleAtMs: number | null; historicalStats: BrainBootstrap | null; forwardStats: BrainBootstrap | null;
  paperStats: BrainBootstrap | null; dailyStats: BrainDailyStats | null; rearmed: boolean;
  reasons: string[]; halt: BrainHalt | null; savedAtMs?: number;
}
export interface EvidenceRedis {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options?: { nx?: boolean }): Promise<unknown>;
}
export interface BrainPermissionContext {
  runId: string; sourceHash?: string; costHash?: string; riskPolicyHash?: string; exitPolicyHash?: string; riskTier?: BrainRiskTier;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function evidenceHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function freezeBrainCosts(asset: string): BrainFrozenCosts {
  const instrument = getConfiguredInstrument(asset);
  return { asset, modelVersion: executionCostModelVersionFor(instrument), profile: { ...getExecutionCostProfile(asset) },
    feeSchedule: { ...feeScheduleFor(instrument) }, stress: { spreadMultiplier: 2, slippageMultiplier: 2,
      impactMultiplier: 2, stopGapMultiplier: 2, takerFeeMultiplier: 2, fundingMultiplier: 2, fundingFloorPer480Minutes: 0.0001 } };
}
export function brainEvidenceIdentity(definition: BrainDefinition, registration: BrainRegistration): string { return evidenceHash({ definition, registration }); }
const hashValid = (value: string) => /^[a-f0-9]{64}$/.test(value);
const finite = (...values: number[]) => values.every(Number.isFinite);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
function semanticHash(definition: BrainDefinition, registration: BrainRegistration): string {
  // Labels and run IDs cannot disguise the same adversely reviewed economic rule.
  return evidenceHash({ asset: definition.asset, version: definition.version, parameters: definition.parameters,
    sourceHash: registration.sourceHash, costHash: registration.costHash,
    riskPolicyHash: registration.riskPolicyHash, exitPolicyHash: registration.exitPolicyHash });
}
function proofHash(review: BrainEvidenceReview): string {
  const { proofHash: _proof, savedAtMs: _saved, ...payload } = review;
  return evidenceHash(payload);
}
function validReview(review: BrainEvidenceReview): boolean {
  return Boolean(review && typeof review === "object") && review.version === "v6" && Boolean(review.runId) &&
    [review.proofHash, review.identityHash, review.definitionHash, review.semanticHash, review.sourceHash,
      review.registrationHash, review.inputHash, review.costHash, review.riskPolicyHash, review.exitPolicyHash].every(hashValid) &&
    ["DISABLED", "WARMING_UP", "SHADOW", "VALIDATION_READY", "PAPER_ACTIVE", "REDUCE_ONLY", "RETIRED"].includes(review.mode) &&
    ["BASE", "ESCALATED"].includes(review.riskTier) && Array.isArray(review.reasons) && review.reasons.every(x => typeof x === "string") &&
    finite(review.historicalCount, review.forwardCount, review.paperCount) && proofHash(review) === review.proofHash &&
    finite(review.createdAtMs, review.expiresAtMs) && review.expiresAtMs > review.createdAtMs && review.expiresAtMs - review.createdAtMs <= DAY;
}
function validRegistration(definition: BrainDefinition, r: BrainRegistration): boolean {
  return definition.version === "v6" && Boolean(definition.asset && definition.strategyId && definition.configHash && r.runId) &&
    [r.sourceHash, r.costHash, r.riskPolicyHash, r.exitPolicyHash, r.trialSnapshotHash].every(hashValid) &&
    finite(r.registeredAtMs, r.releasedAtMs, r.firstEvaluationAtMs, definition.parameters.maxHoldMs) &&
    definition.parameters.maxHoldMs > 0 && r.releasedAtMs >= r.registeredAtMs && r.firstEvaluationAtMs >= r.registeredAtMs &&
    r.costHash === evidenceHash(r.costs) && evidenceHash(r.costs) === evidenceHash(freezeBrainCosts(definition.asset));
}
function deoverlap(rows: BrainOutcome[]): BrainOutcome[] {
  let end = -Infinity;
  return [...rows].sort((a, b) => a.closedAtMs - b.closedAtMs || a.openedAtMs - b.openedAtMs).filter(row => {
    if (row.openedAtMs < end) return false;
    end = row.closedAtMs; return true;
  });
}
/** Resample complete UTC calendar blocks, never sqrt(number of trade rows). */
export function brainNetRBootstrap(rows: BrainOutcome[], maxHoldMs: number): BrainBootstrap | null {
  if (rows.length < 15 || !finite(maxHoldMs) || maxHoldMs <= 0 || rows.some(x => !finite(x.netR))) return null;
  const blockMs = Math.ceil(maxHoldMs / DAY) * DAY;
  const grouped = new Map<number, number[]>();
  for (const row of rows) {
    const block = Math.floor(row.openedAtMs / blockMs);
    grouped.set(block, [...(grouped.get(block) ?? []), row.netR]);
  }
  const groups = [...grouped.values()];
  // Builder ruling: fewer than four independent max-hold blocks is undefined.
  if (groups.length < 4) return null;
  const means: number[] = []; let state = 20261024;
  for (let i = 0; i < 2000; i++) {
    let sum = 0, count = 0;
    for (let b = 0; b < groups.length; b++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const group = groups[Math.floor((state / 4294967296) * groups.length)];
      for (const value of group) { sum += value; count++; }
    }
    means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  return { low: means[49], high: means[1949], mean: rows.reduce((sum, x) => sum + x.netR, 0) / rows.length,
    blockMs, blocks: groups.length, positions: rows.length, iterations: 2000 };
}
function dailyStatistics(rows: BrainDailyReturn[], maxHoldMs: number, trials: number): BrainDailyStats | null {
  const values = rows.map(x => x.netReturn), n = values.length;
  if (n < 4 || values.some(x => !finite(x))) return null;
  const moments = returnMoments(values);
  if (!(moments.sd > 0) || !finite(moments.mean, moments.sd, moments.skew, moments.kurtosis)) return null;
  const centered = values.map(x => x - moments.mean), varianceSum = centered.reduce((sum, x) => sum + x * x, 0);
  let adjustment = 1;
  for (let k = 1; k <= Math.min(n - 1, Math.ceil(maxHoldMs / DAY)); k++) {
    let covariance = 0;
    for (let i = k; i < n; i++) covariance += centered[i] * centered[i - k];
    const rho = covariance / varianceSum;
    adjustment += 2 * (1 - k / n) * Math.max(0, rho);
  }
  const effectiveDays = Math.max(2, Math.min(n, n / adjustment)), sharpePerDay = moments.mean / moments.sd;
  if (effectiveDays < 4 || !finite(effectiveDays, sharpePerDay)) return null;
  const dsr = deflatedSharpeRatio({ observedSharpePerPeriod: sharpePerDay, periods: effectiveDays,
    skew: moments.skew, kurtosis: moments.kurtosis, trials, independenceFactor: 1 });
  return finite(dsr.deflatedSharpe) ? { days: n, effectiveDays, sharpePerDay, skew: moments.skew,
    kurtosis: moments.kurtosis, trials, deflatedSharpe: dsr.deflatedSharpe, annualisedSharpe: null } : null;
}
function coverage(row: BrainOutcome, nowMs: number): boolean {
  const source = (x: SourceObservation, atMs: number) => hashValid(x.sourceHash) && finite(x.availableAtMs, atMs) && x.availableAtMs >= atMs && x.availableAtMs <= nowMs;
  if (!source(row, row.closedAtMs) || !finite(row.openedAtMs, row.closedAtMs, row.netR, row.stressedNetR, row.initialRiskUsdt) ||
      row.closedAtMs <= row.openedAtMs || row.initialRiskUsdt <= 0 || row.stressedNetR > row.netR || !row.positionId || row.criticalViolation ||
      row.executions.length < 2 || !finite(row.fundingIntervalMs) || row.fundingIntervalMs <= 0) return false;
  const executions = [...row.executions].sort((a, b) => a.atMs - b.atMs);
  if (executions[0].atMs !== row.openedAtMs || executions[executions.length - 1].atMs !== row.closedAtMs || executions.some((x, i) =>
    !hashValid(x.sourceHash) || !finite(x.atMs, x.availableAtMs, x.halfSpreadBps, x.depthNotionalUsdt) ||
    x.availableAtMs < 0 || x.availableAtMs > x.atMs || x.atMs > nowMs || x.halfSpreadBps < 0 || x.depthNotionalUsdt <= 0 ||
    (i > 0 && x.atMs <= executions[i - 1].atMs))) return false;
  const expectedCount = Math.floor(row.closedAtMs / row.fundingIntervalMs) - Math.floor(row.openedAtMs / row.fundingIntervalMs);
  if (row.funding.length !== expectedCount) return false;
  const settlements = [...row.funding].sort((a, b) => a.atMs - b.atMs);
  return settlements.every((x, i) => x.atMs === (Math.floor(row.openedAtMs / row.fundingIntervalMs) + i + 1) * row.fundingIntervalMs &&
    source(x, x.atMs) && finite(x.actualRate, x.mark, x.intervalMinutes) && x.mark > 0 && x.intervalMinutes * 60_000 === row.fundingIntervalMs);
}
const span = (rows: BrainOutcome[]) => rows.length ? Math.max(...rows.map(x => x.closedAtMs)) - Math.min(...rows.map(x => x.openedAtMs)) : 0;
const stressedPass = (rows: BrainOutcome[]) => rows.length > 0 && rows.reduce((sum, x) => sum + x.stressedNetR, 0) / rows.length >= 0;

export function evaluateBrainEvidence(input: BrainEvidenceInput): BrainEvidenceReview {
  const { definition: d, registration: r, nowMs, portfolio: p } = input;
  const identityHash = brainEvidenceIdentity(d, r), semantic = semanticHash(d, r), reasons: string[] = [];
  const previous = input.previousReview;
  const previousValid = previous && validReview(previous) && previous.semanticHash === semantic;
  if (previous && !previousValid) reasons.push("INVALID_PREVIOUS_REVIEW");
  let halt = input.halt ?? (previousValid && previous.runId === r.runId && previous.mode === "REDUCE_ONLY" ? previous.halt : null);
  const maxHold = d.parameters.maxHoldMs;
  const registrationOK = validRegistration(d, r);
  if (!registrationOK) reasons.push("INVALID_REGISTRATION_OR_FROZEN_COSTS");
  if (!finite(nowMs, input.expiresAtMs) || input.expiresAtMs <= nowMs || input.expiresAtMs - nowMs > DAY || r.releasedAtMs > nowMs) reasons.push("INVALID_PROOF_EXPIRY");
  const trialsOK = new Set(input.trials.map(x => x.trialId)).size === input.trials.length && input.trials.every(x =>
    Boolean(x.trialId) && hashValid(x.sourceHash) && finite(x.registeredAtMs) && x.registeredAtMs <= r.firstEvaluationAtMs) &&
    input.trials.filter(x => x.kind === "LEGACY").length >= 30 && input.trials.filter(x => x.kind === "INITIAL").length >= 9 &&
    evidenceHash(input.trials) === r.trialSnapshotHash;
  if (!trialsOK) reasons.push("INCOMPLETE_PREREGISTERED_TRIAL_SNAPSHOT");
  const exact = (row: { identityHash: string; runId: string; costHash: string }) => row.identityHash === identityHash && row.runId === r.runId && row.costHash === r.costHash;
  const rowsOK = new Set(input.outcomes.map(x => x.positionId)).size === input.outcomes.length && input.outcomes.every(x =>
    exact(x) && coverage(x, nowMs) && (x.origin === "HISTORICAL" || x.openedAtMs >= Math.max(r.registeredAtMs, r.releasedAtMs)));
  if (!rowsOK) reasons.push("OUTCOME_IDENTITY_CLOCK_OR_COST_COVERAGE");
  const days = [...input.dailyReturns].sort((a, b) => a.dayStartMs - b.dayStartMs);
  const daysOK = days.length > 0 && days.every((x, i) => exact(x) && hashValid(x.sourceHash) && x.baseRiskFraction === 0.0025 &&
    finite(x.netReturn, x.dayStartMs, x.availableAtMs) && x.netReturn > -1 && x.dayStartMs % DAY === 0 && x.availableAtMs >= x.dayStartMs + DAY && x.availableAtMs <= nowMs &&
    (i === 0 || x.dayStartMs === days[i - 1].dayStartMs + DAY)) && input.outcomes.every(x =>
    x.openedAtMs >= days[0].dayStartMs && x.closedAtMs <= days[days.length - 1].dayStartMs + DAY);
  if (!daysOK) reasons.push("INCOMPLETE_UTC_DAILY_MARKED_RETURNS");
  const historical = deoverlap(input.outcomes.filter(x => x.origin === "HISTORICAL"));
  const forward = deoverlap(input.outcomes.filter(x => x.origin === "SHADOW"));
  const paper = deoverlap(input.outcomes.filter(x => x.origin === "PAPER"));
  const historicalStats = rowsOK ? brainNetRBootstrap(historical, maxHold) : null;
  const forwardStats = rowsOK ? brainNetRBootstrap(forward, maxHold) : null;
  const paperStats = rowsOK ? brainNetRBootstrap(paper, maxHold) : null;
  const dailyStats = daysOK && trialsOK && historical.length + forward.length + paper.length >= 15 ? dailyStatistics(days, maxHold, input.trials.length) : null;
  const portfolioOK = p.identityHash === identityHash && p.runId === r.runId && hashValid(p.sourceHash) && p.alignedBlockMs >= maxHold &&
    p.factorClusters.includes(d.riskBucket) && p.riskFraction === (input.escalation ? 0.005 : 0.0025) && p.equity.length >= 2 &&
    p.equity.every((x, i) => finite(x.atMs, x.equityUsdt) && x.atMs >= 0 && x.atMs <= nowMs && x.equityUsdt >= 0 && (i === 0 || x.atMs > p.equity[i - 1].atMs));
  if (!portfolioOK) reasons.push("INELIGIBLE_PORTFOLIO_REVIEW");
  let peak = 10_000;
  const drawdownBreach = p.equity.some(x => { peak = Math.max(peak, x.equityUsdt); return x.equityUsdt <= Math.max(9000, 0.9 * peak); });
  const folds = [...r.folds].sort((a, b) => a.evaluationStartMs - b.evaluationStartMs);
  const foldsOK = folds.length >= 2 && new Set(folds.map(x => x.foldId)).size === folds.length && folds.every((x, i) => x.purged &&
    finite(x.trainEndMs, x.validationEndMs, x.evaluationStartMs, x.evaluationEndMs, x.declaredAtMs, x.embargoMs) && x.declaredAtMs <= r.firstEvaluationAtMs &&
    x.trainEndMs < x.validationEndMs && x.validationEndMs + maxHold <= x.evaluationStartMs && x.embargoMs >= maxHold &&
    x.evaluationEndMs > x.evaluationStartMs && (i === 0 || folds[i - 1].evaluationEndMs + maxHold <= x.evaluationStartMs)) &&
    historical.every(row => folds.some(f => f.foldId === row.foldId && row.openedAtMs >= f.evaluationStartMs && row.closedAtMs <= f.evaluationEndMs)) &&
    folds.every(f => historical.some(row => row.foldId === f.foldId));
  const historicalPass = foldsOK && historical.length >= 30 && (historicalStats?.low ?? -Infinity) > 0 && stressedPass(historical) &&
    forward.length >= 15 && span(forward) >= 14 * DAY && (forwardStats?.low ?? -Infinity) > 0 && stressedPass(forward);
  const forwardPass = forward.length >= 30 && span(forward) >= 30 * DAY && (forwardStats?.low ?? -Infinity) > 0 && stressedPass(forward);
  const commonPass = registrationOK && trialsOK && rowsOK && daysOK && portfolioOK && !p.unresolvedBreaker && p.integrityRestored &&
    !drawdownBreach && (dailyStats?.deflatedSharpe ?? 0) >= 0.95 && reasons.length === 0;
  let mode: BrainMode = commonPass && (historicalPass || forwardPass) ? "PAPER_ACTIVE" : "SHADOW";
  const route = mode === "PAPER_ACTIVE" ? historicalPass ? "HISTORICAL" as const : "FORWARD_ONLY" as const : null;
  if (!route) reasons.push("ECONOMIC_QUALIFICATION_INCOMPLETE");
  const retired = previousValid && previous.mode === "RETIRED" || paper.length >= 15 && (paperStats?.high ?? Infinity) < 0;
  let rearmed = false;
  if (retired) { mode = "RETIRED"; reasons.push("EXACT_CONFIGURATION_PERMANENTLY_RETIRED"); }
  else if (drawdownBreach || previousValid && previous.runId === r.runId && previous.reasons.includes("RUN_DRAWDOWN_LATCH") || halt?.kind === "DRAWDOWN") {
    mode = "REDUCE_ONLY"; reasons.push("RUN_DRAWDOWN_LATCH");
    halt = { kind: "DRAWDOWN", atMs: halt?.atMs ?? nowMs, sourceHash: r.sourceHash };
  } else if (p.unresolvedBreaker || !p.integrityRestored || input.outcomes.some(x => x.criticalViolation || x.netR < -1.5)) {
    mode = "REDUCE_ONLY"; reasons.push("UNRESOLVED_INTEGRITY_OR_ACCOUNT_BREAKER");
    halt = halt ?? { kind: "INTEGRITY", atMs: nowMs, sourceHash: r.sourceHash };
  } else if (halt) {
    const post = deoverlap(forward.filter(x => x.openedAtMs > halt!.atMs));
    const stats = rowsOK ? brainNetRBootstrap(post, maxHold) : null;
    rearmed = hashValid(halt.sourceHash) && finite(halt.atMs) && halt.atMs <= nowMs && commonPass && post.length >= 15 && span(post) >= 14 * DAY &&
      (stats?.low ?? -Infinity) > 0 && stressedPass(post) && (halt.kind !== "INTEGRITY" || hashValid(halt.operatorReviewHash ?? ""));
    if (!rearmed) { mode = "REDUCE_ONLY"; reasons.push("POST_HALT_REVIEW_REQUIRED"); }
  }
  let riskTier: BrainRiskTier = "BASE";
  if (input.escalation) {
    const additional = deoverlap(paper.filter(x => x.openedAtMs > (input.activatedAtMs ?? Infinity)));
    const stats = rowsOK ? brainNetRBootstrap(additional, maxHold) : null;
    if (mode === "PAPER_ACTIVE" && previousValid && previous.mode === "PAPER_ACTIVE" && previous.riskTier === "BASE" && previous.savedAtMs === previous.createdAtMs &&
      finite(input.activatedAtMs ?? NaN) && input.activatedAtMs! >= previous.createdAtMs && additional.length >= 30 && span(additional) >= 30 * DAY &&
      (stats?.low ?? -Infinity) > 0 && stressedPass(additional) && !halt) riskTier = "ESCALATED";
    else { if (mode === "PAPER_ACTIVE") mode = "SHADOW"; reasons.push("SEPARATE_RISK_ESCALATION_REVIEW_REQUIRED"); }
  }
  const review: BrainEvidenceReview = { version: "v6", runId: r.runId, identityHash, definitionHash: evidenceHash(d), semanticHash: semantic,
    costHash: r.costHash, riskPolicyHash: r.riskPolicyHash, exitPolicyHash: r.exitPolicyHash,
    sourceHash: r.sourceHash, registrationHash: evidenceHash(r), inputHash: evidenceHash(input), proofHash: "", createdAtMs: nowMs, expiresAtMs: input.expiresAtMs,
    mode, route, riskTier, historicalCount: historical.length, forwardCount: forward.length, paperCount: paper.length,
    nextEligibleAtMs: forward.length ? Math.min(...forward.map(x => x.openedAtMs)) + (historicalPass ? 14 : 30) * DAY : null,
    historicalStats, forwardStats, paperStats, dailyStats, rearmed, reasons, halt: halt ? { ...halt } : null };
  review.proofHash = proofHash(review);
  return immutable(review);
}

export function brainPermission(definition: BrainDefinition, review: BrainEvidenceReview | undefined, nowMs: number, context?: BrainPermissionContext): { allowed: boolean; reason: string } {
  if (!review || !validReview(review)) return { allowed: false, reason: "NO_VALID_EVIDENCE_PROOF" };
  if (review.definitionHash !== evidenceHash(definition)) return { allowed: false, reason: "EXACT_DEFINITION_MISMATCH" };
  if (context && Object.entries(context).some(([key, value]) => review[key as keyof BrainPermissionContext] !== value)) return { allowed: false, reason: "CURRENT_RUN_OR_POLICY_MISMATCH" };
  if (!finite(nowMs) || nowMs < review.createdAtMs || nowMs >= review.expiresAtMs) return { allowed: false, reason: "STALE_OR_FUTURE_PROOF" };
  if (review.mode !== "PAPER_ACTIVE") return { allowed: false, reason: review.mode };
  if (review.riskTier === "ESCALATED" && review.savedAtMs !== review.createdAtMs) return { allowed: false, reason: "UNSAVED_ESCALATION_REVIEW" };
  return { allowed: true, reason: "EXACT_EVIDENCE_QUALIFIED" };
}
const scopeKey = (definition: BrainDefinition, r: BrainRegistration) => `brain:v6:run:${encodeURIComponent(r.runId)}:definition:${encodeURIComponent(definition.asset)}:${encodeURIComponent(definition.strategyId)}:${encodeURIComponent(definition.configHash)}`;
async function readJson<T>(redis: EvidenceRedis, key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (raw == null) return null;
  try { return (typeof raw === "string" ? JSON.parse(raw) : raw) as T; }
  catch { return null; }
}
export async function registerBrain(redis: EvidenceRedis, definition: BrainDefinition, registration: BrainRegistration): Promise<void> {
  if (!validRegistration(definition, registration)) throw new Error("Invalid frozen brain registration");
  const key = scopeKey(definition, registration), record = { definition, registration, identityHash: brainEvidenceIdentity(definition, registration), mode: "SHADOW" };
  if (await redis.get(`brain:v6:retired:${semanticHash(definition, registration)}`)) throw new Error("This economic configuration is permanently retired");
  const accepted = await redis.set(key, JSON.stringify(record), { nx: true });
  if (!accepted && evidenceHash(await readJson(redis, key)) !== evidenceHash(record)) throw new Error("Brain registration is immutable; preregister a new definition");
  await redis.set(`brain:v6:run:${encodeURIComponent(registration.runId)}:registration:${record.identityHash}`,
    JSON.stringify({ definitionHash: evidenceHash(definition), registrationHash: evidenceHash(registration), semanticHash: semanticHash(definition, registration) }), { nx: true });
}
export async function saveBrainReview(redis: EvidenceRedis, review: BrainEvidenceReview): Promise<void> {
  if (!validReview(review)) throw new Error("Invalid immutable evidence proof");
  const prefix = `brain:v6:run:${encodeURIComponent(review.runId)}`;
  const registered = await readJson<{ definitionHash: string; registrationHash: string; semanticHash: string }>(redis, `${prefix}:registration:${review.identityHash}`);
  if (!registered || registered.definitionHash !== review.definitionHash || registered.registrationHash !== review.registrationHash || registered.semanticHash !== review.semanticHash)
    throw new Error("Review requires the exact preregistered identity");
  const terminal = `brain:v6:retired:${review.semanticHash}`;
  if (review.mode !== "RETIRED" && await redis.get(terminal)) throw new Error("Retired configuration cannot reactivate");
  if (review.mode === "PAPER_ACTIVE" && await redis.get(`${prefix}:drawdown`)) throw new Error("Run drawdown is permanently latched");
  const key = `brain:v6:run:${encodeURIComponent(review.runId)}:proof:${review.proofHash}`;
  const persisted = { ...review, savedAtMs: review.createdAtMs };
  await redis.set(key, JSON.stringify(persisted), { nx: true });
  if (review.mode === "RETIRED") await redis.set(terminal, JSON.stringify(persisted), { nx: true });
  if (review.reasons.includes("RUN_DRAWDOWN_LATCH")) await redis.set(`${prefix}:drawdown`, JSON.stringify(persisted), { nx: true });
  await redis.set(`brain:v6:run:${encodeURIComponent(review.runId)}:latest:${review.identityHash}`, review.proofHash);
}
export async function readBrainReview(redis: EvidenceRedis, definition: BrainDefinition, registration: BrainRegistration): Promise<BrainEvidenceReview | null> {
  const identity = brainEvidenceIdentity(definition, registration), semantic = semanticHash(definition, registration);
  const retiredKey = `brain:v6:retired:${semantic}`;
  if (await redis.get(retiredKey) != null) {
    const retired = await readJson<BrainEvidenceReview>(redis, retiredKey);
    return retired && validReview(retired) ? immutable(retired) : null;
  }
  const prefix = `brain:v6:run:${encodeURIComponent(registration.runId)}`;
  if (await redis.get(`${prefix}:drawdown`) != null) {
    const drawdown = await readJson<BrainEvidenceReview>(redis, `${prefix}:drawdown`);
    return drawdown && validReview(drawdown) ? immutable(drawdown) : null;
  }
  const proof = await redis.get(`${prefix}:latest:${identity}`);
  if (typeof proof !== "string" || !hashValid(proof)) return null;
  const review = await readJson<BrainEvidenceReview>(redis, `${prefix}:proof:${proof}`);
  return review && validReview(review) && review.identityHash === identity && review.runId === registration.runId ? immutable(review) : null;
}
