import { createHash, randomUUID } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { ExecutionLedger, TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import type { CompletedPositionOutcome } from "@/lib/trading/positionOutcomes";
import { blockBootstrapMean95, deflatedSharpeRatio, returnMoments } from "./deflatedSharpe";
export { blockBootstrapMean95 };

export interface CandidateDefinition {
  candidateId: string;
  family: string;
  configHash: string;
  strategyVersion: string;
  instrumentVersions: string[];
  costModelVersion: string;
  riskPolicyVersion: string;
  registeredAtMs: number;
  labelHorizonMs: number;
  holdoutId: string;
  evidenceManifestHash: string;
  holdoutStartMs: number;
  holdoutEndMs: number;
  mode: "SHADOW" | "REVIEW_ELIGIBLE" | "PAPER_ACTIVE" | "REJECTED";
  holdoutConsumed?: boolean;
}
export interface ResearchOutcome extends CompletedPositionOutcome {
  evidenceManifestHash?: string;
  featureStartMs?: number;
  labelEndMs?: number;
  researchOrigin?: "PAPER" | "REPLAY" | "SHADOW";
  historicalCostsAvailable?: boolean;
  stressedNetPnlUsdt?: number;
  riskLimitBreached?: boolean;
}
const REGISTRY = `research:${TRADING_STRATEGY_VERSION}:candidates`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function candidateDefinitionHash(definition: CandidateDefinition): string {
  return hash([definition.family, definition.configHash, definition.strategyVersion,
    [...definition.instrumentVersions].sort(), definition.costModelVersion, definition.riskPolicyVersion,
    definition.labelHorizonMs, definition.holdoutId, definition.evidenceManifestHash,
    definition.holdoutStartMs, definition.holdoutEndMs, definition.registeredAtMs]);
}
function sameEvidence(a:CandidateDefinition,b:CandidateDefinition) {
  return Boolean(a.evidenceManifestHash && a.evidenceManifestHash===b.evidenceManifestHash) ||
    (a.instrumentVersions.some(v=>b.instrumentVersions.includes(v)) &&
      a.holdoutStartMs<b.holdoutEndMs && b.holdoutStartMs<a.holdoutEndMs);
}
export async function getCandidateRegistry(): Promise<CandidateDefinition[]> {
  const definitions = await getRedis().lrange(REGISTRY, 0, -1);
  const consumed = await getRedis().get<string[]>(REGISTRY + ":consumed") ?? [];
  const consumedEvidence=await getRedis().get<CandidateDefinition[]>(REGISTRY+':consumedEvidence')??[];
  return Promise.all(definitions.map(raw => typeof raw === "string" ? JSON.parse(raw) : raw)
    .map(async (definition: CandidateDefinition) => {
      const review = await getRedis().get<{mode:CandidateDefinition['mode']}>(REGISTRY + ':review:' + definition.candidateId);
      return { ...definition, mode:review?.mode ?? definition.mode,
        holdoutConsumed: consumed.includes(definition.holdoutId) || consumedEvidence.some(d=>sameEvidence(d,definition)) };
    }));
}
export async function registerCandidate(definition: CandidateDefinition): Promise<void> {
  if (definition.mode !== "SHADOW") throw new Error("Registration starts in SHADOW; activation needs a reviewed release");
  if (!definition.candidateId || !definition.configHash || !definition.holdoutId || !definition.instrumentVersions.length ||
    !Number.isFinite(definition.registeredAtMs) || definition.registeredAtMs > Date.now() || definition.labelHorizonMs < 86400000 ||
    !/^[a-f0-9]{64}$/.test(definition.evidenceManifestHash??'') || !Number.isFinite(definition.holdoutStartMs) ||
    !Number.isFinite(definition.holdoutEndMs) || definition.holdoutEndMs-definition.holdoutStartMs<definition.labelHorizonMs)
    throw new Error("Invalid preregistered candidate definition");
  const redis = getRedis(), token = randomUUID(), lock = REGISTRY + ":lock";
  if (!await redis.set(lock, token, { nx: true, ex: 30 })) throw new Error("Research registry is busy");
  let immutableDefinition = definition;
  try {
    const registry = await getCandidateRegistry();
    const existing = registry.find(value => value.candidateId === definition.candidateId);
    if (existing) immutableDefinition = { ...existing, mode:'SHADOW', holdoutConsumed:undefined };
    if (existing && candidateDefinitionHash(existing) !== candidateDefinitionHash(definition))
      throw new Error("Candidate identity is immutable; register a new trial");
    if (!existing) {
      const sameScope = registry.filter(value => value.family === definition.family &&
        JSON.stringify([...value.instrumentVersions].sort()) === JSON.stringify([...definition.instrumentVersions].sort()) &&
        value.strategyVersion === definition.strategyVersion);
      if (new Set(sameScope.map(value => value.configHash)).size >= 2 && !sameScope.some(value => value.configHash === definition.configHash))
        throw new Error("Bounded search permits one baseline and one alternate per family/instrument cycle");
      const reused = registry.some(value => value.holdoutId === definition.holdoutId &&
        candidateDefinitionHash(value) !== candidateDefinitionHash(definition));
      if (reused) {
        const consumed = await redis.get<string[]>(REGISTRY + ":consumed") ?? [];
        await redis.set(REGISTRY + ":consumed", Array.from(new Set([...consumed, definition.holdoutId])));
        const evidence=await redis.get<CandidateDefinition[]>(REGISTRY+':consumedEvidence')??[];
        await redis.set(REGISTRY+':consumedEvidence',[...evidence,definition]);
      }
      await redis.lpush(REGISTRY, JSON.stringify(definition));
    }
  } finally { await redis.compareAndDelete(lock, token); }
  // Retried registrations repair a missing ledger append using the immutable ID.
  await ExecutionLedger.recordBestEffort({ id: "candidate:" + hash(definition.candidateId),
    type: "RESEARCH_CANDIDATE_REGISTERED", source: "RESEARCH", payload: immutableDefinition });
}

export function buildPurgedOutcomeFolds(outcomes: ResearchOutcome[], horizonMs: number) {
  const samples = Array.from(new Map(outcomes.map(outcome => [outcome.positionId, outcome])).values())
    .sort((a, b) => a.openedAtMs - b.openedAtMs);
  const start = (o: ResearchOutcome) => o.featureStartMs ?? o.openedAtMs;
  const end = (o: ResearchOutcome) => Math.max(o.closedAtMs, o.labelEndMs ?? o.openedAtMs + horizonMs);
  const folds: { train: ResearchOutcome[]; validation: ResearchOutcome[]; test: ResearchOutcome[] }[] = [];
  if (!(horizonMs >= 86400000)) return folds;
  for (let trainEnd = 30; trainEnd + 22 <= samples.length; trainEnd += 10) {
    const validationRaw = samples.slice(trainEnd + 1, trainEnd + 11);
    const test = samples.slice(trainEnd + 12, trainEnd + 22);
    const validationStart = Math.min(...validationRaw.map(start)), testStart = Math.min(...test.map(start));
    const train = samples.slice(0, trainEnd).filter(o => end(o) + horizonMs <= validationStart);
    const validation = validationRaw.filter(o => end(o) + horizonMs <= testStart);
    if (train.length >= 30 && validation.length === 10 && test.length === 10) folds.push({ train, validation, test });
  }
  return folds;
}
function independentOutcomes(outcomes: ResearchOutcome[], horizonMs: number) {
  const lastEnd = new Map<string, number>();
  return Array.from(new Map(outcomes.map(o => [o.positionId, o])).values())
    .sort((a, b) => a.openedAtMs - b.openedAtMs).filter(o => {
      const key = [o.instrument.instrumentVersion, o.setupFamily, o.configHash].join(":");
      const start = o.featureStartMs ?? o.openedAtMs;
      if (!Number.isFinite(start) || start < (lastEnd.get(key) ?? -Infinity)) return false;
      lastEnd.set(key, Math.max(o.closedAtMs, o.labelEndMs ?? o.openedAtMs + horizonMs)); return true;
    });
}
export function evaluatePromotion(input: {
  definition: CandidateDefinition; outcomes: ResearchOutcome[]; trials: CandidateDefinition[];
  holdoutConsumed: boolean; feesVerified: boolean;
}) {
  const { definition } = input;
  const reasons: string[] = [];
  const registered = input.trials.some(trial => trial.candidateId === definition.candidateId &&
    candidateDefinitionHash(trial) === candidateDefinitionHash(definition));
  if (!registered) reasons.push("NOT_PREREGISTERED");
  if (!/^[a-f0-9]{64}$/.test(definition.evidenceManifestHash??'') ||
    !Number.isFinite(definition.holdoutStartMs) || !Number.isFinite(definition.holdoutEndMs))
    reasons.push('UNBOUND_EVIDENCE_MANIFEST');
  const trials = new Set(input.trials.map(candidateDefinitionHash)).size;
  // A family's own live paper results are consequences of a promotion, not
  // evidence for one; they feed demotion only.
  const compatible = input.outcomes.filter(o => o.researchOrigin !== "PAPER" &&
    definition.instrumentVersions.includes(o.instrument.instrumentVersion) && o.configHash === definition.configHash &&
    o.setupFamily === definition.family && o.strategyVersion === definition.strategyVersion &&
    o.costModelVersion === definition.costModelVersion && o.riskPolicyVersion === definition.riskPolicyVersion &&
    o.evidenceManifestHash === definition.evidenceManifestHash &&
    o.openedAtMs>=definition.holdoutStartMs && (o.labelEndMs??o.closedAtMs)<=definition.holdoutEndMs &&
    Number.isFinite(o.returnOnInitialMargin) && Number.isFinite(o.netPnlUsdt) &&
    o.initialRiskUsdt !== null && o.initialRiskUsdt > 0 && Number.isFinite(o.netR) &&
    Math.abs(o.netR! - o.netPnlUsdt / o.initialRiskUsdt) < 1e-8 && o.closedAtMs > o.openedAtMs &&
    Number.isFinite(o.closedAtMs) && o.closedAtMs <= Date.now());
  const historical = independentOutcomes(compatible.filter(o => o.researchOrigin === "REPLAY"), definition.labelHorizonMs);
  const forward = independentOutcomes(compatible.filter(o => o.researchOrigin === "SHADOW" &&
    o.openedAtMs >= definition.registeredAtMs), definition.labelHorizonMs);
  const folds = buildPurgedOutcomeFolds(historical, definition.labelHorizonMs);
  const testSamples = Array.from(new Map(folds.flatMap(fold => fold.test).map(o => [o.positionId, o])).values());
  const sharpeOf = (values: number[]) => {
    const moments = returnMoments(values);
    return moments.sd > 0 ? deflatedSharpeRatio({ observedSharpePerPeriod: moments.mean / moments.sd,
      periods: values.length, skew: moments.skew, kurtosis: moments.kurtosis, trials: Math.max(1, trials), independenceFactor: 1 }) : null;
  };
  const returns = testSamples.map(o => o.returnOnInitialMargin);
  const interval = blockBootstrapMean95(returns);
  const sharpe = sharpeOf(returns);
  const forwardSpanMs = forward.length ? Math.max(...forward.map(o => o.closedAtMs)) - Math.min(...forward.map(o => o.openedAtMs)) : 0;
  const costsObserved = (rows: ResearchOutcome[]) => rows.length > 0 && rows.every(o => o.historicalCostsAvailable === true);
  const stressHolds = (rows: ResearchOutcome[]) => rows.length > 0 && rows.every(o => Number.isFinite(o.stressedNetPnlUsdt)) &&
    rows.reduce((sum, o) => sum + (o.stressedNetPnlUsdt ?? 0), 0) >= 0;

  // Route 1: purged historical replay folds confirmed by forward shadow.
  const replayRoute: string[] = [];
  if (!folds.length) replayRoute.push("INSUFFICIENT_PURGED_HISTORY");
  if (!interval || interval.low <= 0) replayRoute.push("NET_EXPECTANCY_NOT_ESTABLISHED");
  if (!sharpe || !sharpe.passes) replayRoute.push("DEFLATED_SHARPE_NOT_ESTABLISHED");
  if (forward.length < 15 || forwardSpanMs < 14 * 86400000) replayRoute.push("INSUFFICIENT_FORWARD_SHADOW");
  if (forward.length && forward.reduce((sum, o) => sum + o.netPnlUsdt, 0) <= 0) replayRoute.push("FORWARD_SHADOW_NO_EDGE");
  if (!stressHolds([...testSamples, ...forward])) replayRoute.push("COST_STRESS_FAILED");
  if (!costsObserved(compatible)) replayRoute.push("MISSING_CRITICAL_COST_EVIDENCE");

  // Route 2: forward shadow evidence alone. It was collected after
  // preregistration, so it cannot have been fitted to; it must stand on its
  // own with twice the forward sample, the same expectancy, Sharpe and cost
  // tests, and observed costs on every sample it uses.
  const forwardReturns = forward.map(o => o.returnOnInitialMargin);
  const forwardInterval = blockBootstrapMean95(forwardReturns);
  const forwardSharpe = sharpeOf(forwardReturns);
  const forwardRoute: string[] = [];
  if (forward.length < FORWARD_ONLY_MIN_POSITIONS || forwardSpanMs < 14 * 86400000) forwardRoute.push("FORWARD_SAMPLE_TOO_SMALL");
  if (!forwardInterval || forwardInterval.low <= 0) forwardRoute.push("FORWARD_EXPECTANCY_NOT_ESTABLISHED");
  if (!forwardSharpe || !forwardSharpe.passes) forwardRoute.push("FORWARD_DEFLATED_SHARPE_NOT_ESTABLISHED");
  if (!stressHolds(forward)) forwardRoute.push("FORWARD_COST_STRESS_FAILED");
  if (!costsObserved(forward)) forwardRoute.push("FORWARD_COST_EVIDENCE_MISSING");

  if (compatible.some(o => o.riskLimitBreached !== false)) reasons.push("RISK_LIMIT_EVIDENCE_FAILED");
  if (!input.feesVerified) reasons.push("UNVERIFIED_FEES");
  if (input.holdoutConsumed || definition.holdoutConsumed || input.trials.some(t => t.holdoutConsumed &&
    (t.holdoutId===definition.holdoutId || sameEvidence(t,definition))))
    reasons.push("HOLDOUT_CONSUMED");
  const route = replayRoute.length === 0 ? "REPLAY_AND_FORWARD" : forwardRoute.length === 0 ? "FORWARD_ONLY" : null;
  if (!route) reasons.push(...replayRoute);
  const metrics = { trialCount: trials, compatiblePositions: compatible.length, historicalPositions: historical.length,
    folds: folds.length, testPositions: testSamples.length, netExpectancy95: interval,
    deflatedSharpe: sharpe?.deflatedSharpe ?? null, forwardPositions: forward.length, forwardSpanMs,
    forwardExpectancy95: forwardInterval, forwardDeflatedSharpe: forwardSharpe?.deflatedSharpe ?? null,
    route, forwardRouteReasons: forwardRoute, forwardRequiredPositions: FORWARD_ONLY_MIN_POSITIONS,
    forwardRequiredSpanMs: 14 * 86400000 };
  const report = { eligible: reasons.length === 0, reasons, metrics, configHash: definition.configHash,
    definitionHash: candidateDefinitionHash(definition) };
  return { ...report, reportHash: hash({ report, input }) };
}

/** Live paper loss budget for a promoted family, in initial-risk units. */
export const PAPER_LOSS_BUDGET_R = 6;
/** Forward-only promotion needs twice the forward sample the replay route needs. */
export const FORWARD_ONLY_MIN_POSITIONS = 30;

/**
 * Whether live paper results contradict the evidence that promoted a family:
 * the cumulative loss reaches the R budget or, with enough positions, the 95%
 * block-bootstrap upper bound of the mean net R is below zero.
 */
export function evaluateDemotion(paperOutcomes: ResearchOutcome[]) {
  const rows = Array.from(new Map(paperOutcomes.map(o => [o.positionId, o])).values())
    .filter(o => Number.isFinite(o.netR)).sort((a, b) => a.openedAtMs - b.openedAtMs);
  const totalR = rows.reduce((sum, o) => sum + (o.netR as number), 0);
  const interval = blockBootstrapMean95(rows.map(o => o.netR as number));
  const reasons: string[] = [];
  if (totalR <= -PAPER_LOSS_BUDGET_R) reasons.push(`PAPER_LOSS_BUDGET: ${totalR.toFixed(2)}R lost over ${rows.length} live position(s)`);
  if (rows.length >= 15 && interval && interval.high < 0) reasons.push(`PAPER_EDGE_NEGATIVE: 95% upper bound ${interval.high.toFixed(3)}R`);
  return { demote: reasons.length > 0, reasons, metrics: { positions: rows.length, totalR, meanR95: interval } };
}

/**
 * Record a review and move the candidate autonomously (owner decision,
 * 2026-10-02): eligible evidence promotes SHADOW to PAPER_ACTIVE, and live
 * paper results that contradict it demote to REJECTED, which is final for
 * that configuration. Every transition is written to the ledger.
 */
export async function recordPromotionReview(definition: CandidateDefinition, report: ReturnType<typeof evaluatePromotion>,
  paperOutcomes: ResearchOutcome[] = [], promotionEvidence?: Parameters<typeof evaluatePromotion>[0]) {
  const redis = getRedis(), key = REGISTRY + ":review:" + definition.candidateId;
  const previous = (await redis.get<{ mode?: CandidateDefinition["mode"] }>(key).catch(() => null))?.mode ?? "SHADOW";
  let mode: CandidateDefinition["mode"] = previous === "REJECTED" ? "REJECTED" : previous === "PAPER_ACTIVE" ? "PAPER_ACTIVE"
    : report.eligible ? "PAPER_ACTIVE" : "SHADOW";
  const demotion = mode === "PAPER_ACTIVE" ? evaluateDemotion(paperOutcomes) : null;
  if (demotion?.demote) mode = "REJECTED";
  const reviewedAt = new Date().toISOString();
  await redis.set(key, { mode, report, demotion, reviewedAt });
  await ExecutionLedger.recordBestEffort({ id: "research-review:" + report.reportHash,
    type: "RESEARCH_REVIEWED", source: "RESEARCH", payload: { candidateId: definition.candidateId, report } });
  if (mode !== previous && (mode === "PAPER_ACTIVE" || mode === "REJECTED")) {
    await ExecutionLedger.recordBestEffort({ id: `research-${mode}:${definition.candidateId}`,
      type: mode === "PAPER_ACTIVE" ? "RESEARCH_PROMOTED" : "RESEARCH_DEMOTED", source: "RESEARCH",
      payload: { candidateId: definition.candidateId, family: definition.family, instrumentVersions: definition.instrumentVersions,
        from: previous, to: mode, route: report.metrics.route, demotion, reviewedAt,
        reportHash: report.reportHash, definitionHash: report.definitionHash,
        // Freeze inputs only on a rare transition, never on hourly reviews.
        promotionEvidence: mode === 'PAPER_ACTIVE' ? promotionEvidence : undefined,
        paperEvidence: mode === 'REJECTED' ? paperOutcomes : undefined } });
  }
  return mode;
}
