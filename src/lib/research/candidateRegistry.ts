import { createHash, randomUUID } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { ExecutionLedger, TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import type { CompletedPositionOutcome } from "@/lib/trading/positionOutcomes";
import { deflatedSharpeRatio, returnMoments } from "./deflatedSharpe";

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
  mode: "SHADOW" | "REVIEW_ELIGIBLE" | "PAPER_ACTIVE" | "REJECTED";
  holdoutConsumed?: boolean;
}
export interface ResearchOutcome extends CompletedPositionOutcome {
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
    definition.labelHorizonMs, definition.holdoutId]);
}
export async function getCandidateRegistry(): Promise<CandidateDefinition[]> {
  const definitions = await getRedis().lrange(REGISTRY, 0, -1);
  const consumed = await getRedis().get<string[]>(REGISTRY + ":consumed") ?? [];
  return Promise.all(definitions.map(raw => typeof raw === "string" ? JSON.parse(raw) : raw)
    .map(async (definition: CandidateDefinition) => {
      const review = await getRedis().get<{mode:CandidateDefinition['mode']}>(REGISTRY + ':review:' + definition.candidateId);
      return { ...definition, mode:review?.mode ?? definition.mode, holdoutConsumed: consumed.includes(definition.holdoutId) };
    }));
}
export async function registerCandidate(definition: CandidateDefinition): Promise<void> {
  if (definition.mode !== "SHADOW") throw new Error("Registration starts in SHADOW; activation needs a reviewed release");
  if (!definition.candidateId || !definition.configHash || !definition.holdoutId || !definition.instrumentVersions.length ||
    !Number.isFinite(definition.registeredAtMs) || definition.registeredAtMs > Date.now() || definition.labelHorizonMs < 86400000)
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
/** Deterministic moving-block bootstrap retains short-run return dependence. */
export function blockBootstrapMean95(values: number[], seed = 20261001) {
  if (values.length < 4 || values.some(value => !Number.isFinite(value))) return null;
  let state = seed >>> 0;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  const blockSize = Math.max(2, Math.ceil(Math.sqrt(values.length))), means: number[] = [];
  for (let trial = 0; trial < 1000; trial++) {
    const sample: number[] = [];
    while (sample.length < values.length) {
      const start = Math.floor(random() * values.length);
      for (let offset = 0; offset < blockSize && sample.length < values.length; offset++) sample.push(values[(start + offset) % values.length]);
    }
    means.push(sample.reduce((a, b) => a + b, 0) / sample.length);
  }
  means.sort((a, b) => a - b);
  return { low: means[24], high: means[974], iterations: 1000, blockSize, seed };
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
  const trials = new Set(input.trials.map(candidateDefinitionHash)).size;
  const compatible = input.outcomes.filter(o =>
    definition.instrumentVersions.includes(o.instrument.instrumentVersion) && o.configHash === definition.configHash &&
    o.setupFamily === definition.family && o.strategyVersion === definition.strategyVersion &&
    o.costModelVersion === definition.costModelVersion && o.riskPolicyVersion === definition.riskPolicyVersion &&
    Number.isFinite(o.returnOnInitialMargin) && Number.isFinite(o.netPnlUsdt) &&
    o.initialRiskUsdt !== null && o.initialRiskUsdt > 0 && Number.isFinite(o.netR) &&
    Math.abs(o.netR! - o.netPnlUsdt / o.initialRiskUsdt) < 1e-8 && o.closedAtMs > o.openedAtMs &&
    Number.isFinite(o.closedAtMs) && o.closedAtMs <= Date.now());
  const historical = independentOutcomes(compatible.filter(o => o.researchOrigin === "REPLAY"), definition.labelHorizonMs);
  const forward = independentOutcomes(compatible.filter(o => o.researchOrigin === "SHADOW" &&
    o.openedAtMs >= definition.registeredAtMs), definition.labelHorizonMs);
  const folds = buildPurgedOutcomeFolds(historical, definition.labelHorizonMs);
  const testSamples = Array.from(new Map(folds.flatMap(fold => fold.test).map(o => [o.positionId, o])).values());
  const returns = testSamples.map(o => o.returnOnInitialMargin);
  const interval = blockBootstrapMean95(returns);
  const moments = returnMoments(returns);
  const sharpe = moments.sd > 0 ? deflatedSharpeRatio({ observedSharpePerPeriod: moments.mean / moments.sd,
    periods: returns.length, skew: moments.skew, kurtosis: moments.kurtosis, trials: Math.max(1, trials), independenceFactor: 1 }) : null;
  const forwardSpanMs = forward.length ? Math.max(...forward.map(o => o.closedAtMs)) - Math.min(...forward.map(o => o.openedAtMs)) : 0;
  if (!folds.length) reasons.push("INSUFFICIENT_PURGED_HISTORY");
  if (!interval || interval.low <= 0) reasons.push("NET_EXPECTANCY_NOT_ESTABLISHED");
  if (!sharpe || !sharpe.passes) reasons.push("DEFLATED_SHARPE_NOT_ESTABLISHED");
  if (forward.length < 15 || forwardSpanMs < 14 * 86400000) reasons.push("INSUFFICIENT_FORWARD_SHADOW");
  if (forward.length && forward.reduce((sum, o) => sum + o.netPnlUsdt, 0) <= 0) reasons.push("FORWARD_SHADOW_NO_EDGE");
  const stressed = [...testSamples, ...forward];
  if (!stressed.length || stressed.some(o => !Number.isFinite(o.stressedNetPnlUsdt)) ||
    stressed.reduce((sum, o) => sum + (o.stressedNetPnlUsdt ?? 0), 0) < 0) reasons.push("COST_STRESS_FAILED");
  if (!compatible.length || compatible.some(o => o.historicalCostsAvailable !== true)) reasons.push("MISSING_CRITICAL_COST_EVIDENCE");
  if (compatible.some(o => o.riskLimitBreached !== false)) reasons.push("RISK_LIMIT_EVIDENCE_FAILED");
  if (!input.feesVerified) reasons.push("UNVERIFIED_FEES");
  if (input.holdoutConsumed || definition.holdoutConsumed || input.trials.some(t => t.holdoutId === definition.holdoutId && t.holdoutConsumed))
    reasons.push("HOLDOUT_CONSUMED");
  const metrics = { trialCount: trials, compatiblePositions: compatible.length, historicalPositions: historical.length,
    folds: folds.length, testPositions: testSamples.length, netExpectancy95: interval,
    deflatedSharpe: sharpe?.deflatedSharpe ?? null, forwardPositions: forward.length, forwardSpanMs };
  const report = { eligible: reasons.length === 0, reasons, metrics, configHash: definition.configHash,
    definitionHash: candidateDefinitionHash(definition) };
  return { ...report, reportHash: hash({ report, input }) };
}

export async function recordPromotionReview(definition: CandidateDefinition, report: ReturnType<typeof evaluatePromotion>) {
  const redis = getRedis(), key = REGISTRY + ":review:" + definition.candidateId;
  await redis.set(key, { mode: report.eligible ? "REVIEW_ELIGIBLE" : "SHADOW", report, reviewedAt: new Date().toISOString() });
  await ExecutionLedger.recordBestEffort({ id: "research-review:" + report.reportHash,
    type: "RESEARCH_REVIEWED", source: "RESEARCH", payload: { candidateId: definition.candidateId, report } });
  // Eligibility is a review result. No automatic PAPER_ACTIVE transition exists.
}
