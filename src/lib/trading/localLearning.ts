import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { PortfolioManager } from "@/lib/portfolio";
import { buildPositionOutcomes, CompletedPositionOutcome } from "./positionOutcomes";
import { CONFIGURED_INSTRUMENTS } from "./instrumentRegistry";
import { TRADING_STRATEGY_VERSION } from "./executionLedger";

const RULES_KEY = `learning:${TRADING_STRATEGY_VERSION}:localRules`;
export const MINIMUM_RULE_SAMPLE = 15;
export interface LearningCohort {
  instrumentVersion: string;
  dataSchemaVersion: string;
  assetClass: string;
  family: string;
  regime: string;
  direction: "LONG" | "SHORT";
  strategyVersion: string;
  configHash: string;
  costModelVersion: string;
  riskPolicyVersion: string;
}
export interface LocalLearningRule {
  id: string;
  scope: "asset" | "setup" | "global";
  key: string;
  action: "BOOST" | "REDUCE" | "WATCH_ONLY";
  confidenceAdjustment: number;
  message: string;
  sampleSize: number;
  favorableRate: number;
  /** Deprecated display alias; never used for a decision. */
  avgMove: number;
  updatedAt: string;
  cohort?: LearningCohort;
  sampleUnit?: "COMPLETED_POSITION" | "SHADOW_SETUP";
  distinctSampleCount?: number;
  netReturnFraction?: number;
  netR?: number;
  createdAt?: string;
  expiresAt?: string;
  units?: "FRACTION_AND_R";
  riskMultiplier?: number;
}
export function learningCohortKey(cohort: LearningCohort): string {
  return createHash("sha256").update(JSON.stringify([
    cohort.instrumentVersion, cohort.dataSchemaVersion, cohort.assetClass, cohort.family,
    cohort.regime, cohort.direction, cohort.strategyVersion, cohort.configHash,
    cohort.costModelVersion, cohort.riskPolicyVersion,
  ])).digest("hex");
}
export function cohortForOutcome(outcome: CompletedPositionOutcome): LearningCohort {
  return { instrumentVersion: outcome.instrument.instrumentVersion, dataSchemaVersion: outcome.dataSchemaVersion,
    assetClass: CONFIGURED_INSTRUMENTS[outcome.asset].riskClass, family: outcome.setupFamily,
    regime: outcome.regime, direction: outcome.direction, strategyVersion: outcome.strategyVersion,
    configHash: outcome.configHash, costModelVersion: outcome.costModelVersion, riskPolicyVersion: outcome.riskPolicyVersion };
}
export function calculateLearningAdjustment(
  rules: LocalLearningRule[], asset: string, setupTags: string[] = [],
  context?: { cohort: LearningCohort; nowMs?: number }
) {
  const nowMs = context?.nowMs ?? Date.now();
  const matched = context ? rules.filter(rule =>
    !!rule.cohort && learningCohortKey(rule.cohort) === learningCohortKey(context.cohort) &&
    (rule.scope !== "asset" || rule.key === asset) &&
    (rule.scope !== "setup" || setupTags.includes(rule.key)) &&
    rule.sampleUnit === "COMPLETED_POSITION" &&
    (rule.distinctSampleCount ?? 0) >= MINIMUM_RULE_SAMPLE && rule.units === "FRACTION_AND_R" &&
    Number.isFinite(rule.netReturnFraction) && Number.isFinite(rule.netR) &&
    Date.parse(rule.createdAt ?? "") <= nowMs && Date.parse(rule.expiresAt ?? "") > nowMs
  ) : [];
  // Correlated summaries of the same cohort earn one vote, never additive votes.
  const negative = matched.filter(rule => rule.confidenceAdjustment < 0);
  const adjustment = negative.length ? Math.max(-4, Math.min(...negative.map(rule => rule.confidenceAdjustment)))
    : matched.length ? Math.min(4, Math.max(...matched.map(rule => rule.confidenceAdjustment))) : 0;
  return { adjustment, watchOnly: matched.some(rule => rule.action === "WATCH_ONLY"),
    riskMultiplier: Math.max(0.5, Math.min(1, ...matched.map(rule => rule.riskMultiplier ?? 1))),
    status: matched.length ? "EVIDENCE_AVAILABLE" : "INSUFFICIENT_EVIDENCE", rules: matched.slice(0, 5) };
}
export function deriveLearningRules(outcomes: CompletedPositionOutcome[], nowMs = Date.now()): LocalLearningRule[] {
  const distinct = new Map(outcomes.map(o => [o.positionId, o]));
  const groups = new Map<string, CompletedPositionOutcome[]>();
  for (const outcome of distinct.values()) {
    if (outcome.strategyVersion !== TRADING_STRATEGY_VERSION) continue;
    if (!(outcome.initialRiskUsdt && outcome.initialRiskUsdt > 0) || !Number.isFinite(outcome.netR) ||
      !Number.isFinite(outcome.returnOnInitialMargin) || !Number.isFinite(outcome.netPnlUsdt) ||
      Math.abs(outcome.netR! - outcome.netPnlUsdt / outcome.initialRiskUsdt) > 1e-8 ||
      outcome.closedAtMs > nowMs || outcome.closedAtMs <= outcome.openedAtMs ||
      !outcome.configHash || outcome.configHash === "unversioned" || outcome.dataSchemaVersion === "legacy") continue;
    const key = learningCohortKey(cohortForOutcome(outcome));
    const group = groups.get(key) ?? [];
    group.push(outcome); groups.set(key, group);
  }
  const rules: LocalLearningRule[] = [];
  for (const [key, values] of groups) {
    // Same-instrument overlapping holds are not independent completed samples.
    const independent: CompletedPositionOutcome[] = [];
    for (const value of values.sort((a, b) => a.openedAtMs - b.openedAtMs)) {
      if (!independent.length || value.openedAtMs >= independent.at(-1)!.closedAtMs) independent.push(value);
    }
    const recent = independent.filter(o => nowMs - o.closedAtMs <= 90 * 86400000);
    if (recent.length < MINIMUM_RULE_SAMPLE) continue;
    const meanR = recent.reduce((sum, o) => sum + o.netR!, 0) / recent.length;
    const meanReturn = recent.reduce((sum, o) => sum + o.returnOnInitialMargin, 0) / recent.length;
    if (meanR === 0) continue;
    const action = meanR > 0 ? "BOOST" : "REDUCE";
    const timestamp = new Date(nowMs).toISOString();
    rules.push({ id: key, scope: "asset", key: recent[0].asset, action,
      confidenceAdjustment: action === "BOOST" ? 4 : -4,
      message: `${recent.length} independent completed positions; mean net R ${meanR.toFixed(3)}. Shadow research continues.`,
      sampleSize: recent.length, favorableRate: recent.filter(o => o.netPnlUsdt > 0).length / recent.length,
      avgMove: meanReturn, updatedAt: timestamp, cohort: cohortForOutcome(recent[0]),
      sampleUnit: "COMPLETED_POSITION", distinctSampleCount: recent.length, netReturnFraction: meanReturn,
      netR: meanR, createdAt: timestamp, expiresAt: new Date(nowMs + 7 * 86400000).toISOString(),
      units: "FRACTION_AND_R", riskMultiplier: action === "BOOST" ? 1 : 0.5 });
  }
  return rules;
}
function writeJsonBackup(value: unknown) {
  const directory = path.join(process.cwd(), "data", "learning", TRADING_STRATEGY_VERSION);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "local_learning_rules.json"), JSON.stringify(value, null, 2));
}
export class LocalLearningMemory {
  static async clearCurrentStrategyState() {
    await getRedis().del(RULES_KEY); writeJsonBackup([]);
  }
  static async rebuildRules() {
    const trades = await PortfolioManager.getTrades("ai");
    const outcomes = buildPositionOutcomes({ trades, openPositions: [] }).completed;
    const rules = deriveLearningRules(outcomes);
    const pooled = new Map<string, { assetClass: string; family: string; positions: number; netRTotal: number }>();
    for (const outcome of outcomes.filter(o => o.strategyVersion === TRADING_STRATEGY_VERSION && Number.isFinite(o.netR))) {
      const assetClass = CONFIGURED_INSTRUMENTS[outcome.asset].riskClass;
      const key = `${assetClass}:${outcome.setupFamily}`;
      const bucket = pooled.get(key) ?? { assetClass, family: outcome.setupFamily, positions: 0, netRTotal: 0 };
      bucket.positions++; bucket.netRTotal += outcome.netR!; pooled.set(key, bucket);
    }
    await getRedis().set(`learning:${TRADING_STRATEGY_VERSION}:evidence`, {
      status: rules.length ? "EVIDENCE_AVAILABLE" : "INSUFFICIENT_EVIDENCE",
      decisionUse: "EXACT_COHORT_ONLY", eligibleRules: rules.length,
      pooledDescriptive: Array.from(pooled.values()).map(b => ({ assetClass: b.assetClass, family: b.family,
        positions: b.positions, meanNetR: b.netRTotal / b.positions, decisionUse: "DESCRIPTIVE_ONLY" })),
    });
    await getRedis().set(RULES_KEY, rules); writeJsonBackup(rules); return rules;
  }
  static async getRules(): Promise<LocalLearningRule[]> {
    const cached = await getRedis().get<LocalLearningRule[]>(RULES_KEY);
    return Array.isArray(cached) ? cached : [];
  }
  static async getEvidenceStatus() {
    return await getRedis().get(`learning:${TRADING_STRATEGY_VERSION}:evidence`) ?? {
      status: "INSUFFICIENT_EVIDENCE", eligibleRules: 0, pooledDescriptive: [], decisionUse: "EXACT_COHORT_ONLY",
    };
  }
  static async getAdjustment(asset: string, setupTags: string[] = [], context?: { cohort: LearningCohort; nowMs?: number }) {
    return calculateLearningAdjustment(await this.getRules(), asset, setupTags, context);
  }
}
