import fs from "fs";
import path from "path";
import { getRedis } from "@/lib/redis";
import { PortfolioManager } from "@/lib/portfolio";
import { OpportunityJournal } from "./opportunityJournal";
import { normalizeSetupTags, SetupPerformance, SetupPerformanceBucket } from "./setupPerformance";
import { TradeReviewJournal, TradeReviewAssetSignal } from "./tradeReviewJournal";
import { TRADING_STRATEGY_VERSION } from "./executionLedger";

const RULES_KEY = `learning:${TRADING_STRATEGY_VERSION}:localRules`;

/** Minimum closed observations before local learning may form a rule. */
export const MINIMUM_RULE_SAMPLE = 15;

export interface LocalLearningRule {
  id: string;
  scope: "asset" | "setup" | "global";
  key: string;
  action: "BOOST" | "REDUCE" | "WATCH_ONLY";
  confidenceAdjustment: number;
  message: string;
  sampleSize: number;
  favorableRate: number;
  avgMove: number;
  updatedAt: string;
}

function writeJsonBackup(filename: string, value: unknown) {
  try {
    const dir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(value, null, 2));
  } catch {}
}

function classifyRule(
  scope: LocalLearningRule["scope"],
  key: string,
  stats: { total: number; favorable: number; avgMove: number; avgNetPnlUsd?: number; avgNetReturnPercent?: number; avgMfe?: number; avgMae?: number; takeProfitHits?: number; stopLossHits?: number }
): LocalLearningRule | null {
  // A rule needs enough closed observations to mean something. At n=4 a fair
  // coin produces "1 win or fewer" about 31% of the time, so the old n>=4 gate
  // quarantined roughly one in three assets on noise alone — and because the
  // resulting REDUCE shrank position size below the minimum useful margin, a
  // run of bad luck could stop the bot trading that asset indefinitely.
  if (stats.total < MINIMUM_RULE_SAMPLE) return null;
  const favorableRate = stats.favorable / stats.total;
  const takeProfitRate = (stats.takeProfitHits || 0) / stats.total;
  const stopLossRate = (stats.stopLossHits || 0) / stats.total;
  const netReturn = Number.isFinite(Number(stats.avgNetReturnPercent))
    ? Number(stats.avgNetReturnPercent)
    : Number(stats.avgMove || 0);
  const netPnl = Number.isFinite(Number(stats.avgNetPnlUsd))
    ? Number(stats.avgNetPnlUsd)
    : netReturn;

  if ((favorableRate >= 0.65 && netReturn > 0.005) || (takeProfitRate >= 0.45 && netPnl > 0)) {
    return {
      id: `${scope}:${key}`,
      scope,
      key,
      action: "BOOST",
      confidenceAdjustment: 5,
      message: `${key} has recently produced positive net expectancy after estimated fees. The bot may slightly trust this pattern more.`,
      sampleSize: stats.total,
      favorableRate,
      avgMove: netReturn,
      updatedAt: new Date().toISOString(),
    };
  }

  if (favorableRate <= 0.35 || netReturn < -0.005 || stopLossRate >= 0.45) {
    return {
      id: `${scope}:${key}`,
      scope,
      key,
      action: "REDUCE",
      confidenceAdjustment: -8,
      message: `${key} has recently failed net-expectancy checks. The bot should use smaller size or require stronger proof here.`,
      sampleSize: stats.total,
      favorableRate,
      avgMove: netReturn,
      updatedAt: new Date().toISOString(),
    };
  }

  return null;
}

function ruleFromPerformanceBucket(
  scope: LocalLearningRule["scope"],
  bucket: SetupPerformanceBucket
): LocalLearningRule | null {
  if (bucket.tradeCount < 12 && bucket.opportunityCount < MINIMUM_RULE_SAMPLE) return null;
  if (bucket.confidenceAdjustment === 0) return null;

  const action: LocalLearningRule["action"] = bucket.quarantined
    ? "WATCH_ONLY"
    : bucket.confidenceAdjustment > 0
      ? "BOOST"
      : "REDUCE";
  if (action === "BOOST" && !bucket.promotionEligible) return null;
  const usesHoldout = bucket.quarantined && bucket.outOfSampleTradeCount > 0;
  const usesRecoveryEvidence = bucket.requalificationEligible && bucket.opportunityCount > 0;
  const sampleSize = usesRecoveryEvidence
    ? bucket.opportunityCount
    : usesHoldout
    ? bucket.outOfSampleTradeCount
    : bucket.tradeCount > 0
      ? bucket.tradeCount
      : bucket.opportunityCount;
  const favorableRate = usesRecoveryEvidence
    ? bucket.opportunityFavorableRate
    : usesHoldout
    ? bucket.outOfSampleWinRate
    : bucket.tradeCount > 0
      ? bucket.winRate
      : bucket.opportunityFavorableRate;
  const avgMove = usesRecoveryEvidence
    ? bucket.avgOpportunityNetPnlUsd
    : usesHoldout
    ? bucket.outOfSampleAvgPnl
    : bucket.tradeCount > 0
      ? bucket.avgPnl
      : bucket.avgOpportunityMove;
  const evidenceLabel = usesRecoveryEvidence
    ? "independent watched opportunities after quarantine"
    : usesHoldout
    ? "later chronological closed trades"
    : bucket.evidence.includes("trade")
      ? "closed trades"
      : "watched opportunities";

  return {
    id: `${scope}:${bucket.key}`,
    scope,
    key: bucket.key,
    action,
    confidenceAdjustment: Math.max(-12, Math.min(8, bucket.confidenceAdjustment)),
    message: bucket.quarantined
      ? `${bucket.label} failed its later chronological sample with negative expectancy and profit factor below 0.85; new entries are quarantined for this pattern.`
      : bucket.requalificationEligible
        ? `${bucket.label} failed closed-trade validation but has at least 20 positive independent watched outcomes; only a reduced recovery probe may retest it.`
      : `${bucket.label} is ${action === "BOOST" ? "performing well in its later closed-trade sample" : "underperforming"} based on ${evidenceLabel}; the bot should ${action === "BOOST" ? "trust it slightly more" : "be more selective here"}.`,
    sampleSize,
    favorableRate,
    avgMove,
    updatedAt: new Date().toISOString(),
  };
}

function ruleFromTradeReviewSignal(signal: TradeReviewAssetSignal): LocalLearningRule | null {
  if (signal.action === "NEUTRAL" || signal.confidenceAdjustment === 0) return null;
  if (signal.reviews < 10) return null;

  return {
    id: `review:asset:${signal.asset}`,
    scope: "asset",
    key: signal.asset,
    action: signal.action,
    confidenceAdjustment: Math.max(-8, Math.min(4, signal.confidenceAdjustment)),
    message: signal.message,
    sampleSize: signal.reviews,
    favorableRate: signal.winRate,
    avgMove: signal.avgPnl,
    updatedAt: signal.updatedAt,
  };
}

function combineCorrelatedAdjustments(values: number[]): number {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return 0;

  const strongestPositive = Math.max(0, ...finiteValues);
  const strongestNegative = Math.min(0, ...finiteValues);
  return strongestPositive + strongestNegative;
}

export function calculateLearningAdjustment(
  rules: LocalLearningRule[],
  asset: string,
  setupTags: string[] = []
) {
  const normalizedSetups = new Set(normalizeSetupTags(setupTags));
  const matched = rules.filter((rule) => (
    (rule.scope === "asset" && rule.key === asset) ||
    (rule.scope === "setup" && normalizedSetups.has(rule.key)) ||
    rule.scope === "global"
  ));

  // Lifetime performance and recent reviews are derived from overlapping
  // closed trades. Multiple setup tags from one signal are correlated too.
  // Use the strongest opposing evidence in each scope rather than adding
  // every rule and turning one observation into several confidence votes.
  const assetAdjustment = combineCorrelatedAdjustments(
    matched.filter((rule) => rule.scope === "asset").map((rule) => rule.confidenceAdjustment)
  );
  const setupAdjustment = Math.max(-5, Math.min(4, combineCorrelatedAdjustments(
    matched.filter((rule) => rule.scope === "setup").map((rule) => rule.confidenceAdjustment)
  )));
  const globalAdjustment = Math.max(-3, Math.min(3, combineCorrelatedAdjustments(
    matched.filter((rule) => rule.scope === "global").map((rule) => rule.confidenceAdjustment)
  )));

  const watchOnly = matched.some((rule) => (
    rule.action === "WATCH_ONLY" ||
    (
      rule.scope === "asset" &&
      rule.action === "REDUCE" &&
      rule.confidenceAdjustment <= -8 &&
      rule.favorableRate < 0.25 &&
      rule.sampleSize >= 6 &&
      rule.avgMove < -0.05
    )
  ));

  return {
    adjustment: Math.max(-12, Math.min(8, assetAdjustment + setupAdjustment + globalAdjustment)),
    watchOnly,
    rules: matched
      .sort((a, b) => Math.abs(b.confidenceAdjustment) - Math.abs(a.confidenceAdjustment))
      .slice(0, 5),
  };
}

export class LocalLearningMemory {
  static async clearCurrentStrategyState() {
    const redis = getRedis();
    await redis.del(RULES_KEY);
    writeJsonBackup("local_learning_rules.json", []);
  }

  static async rebuildRules() {
    const summary = await OpportunityJournal.getSummary();
    const ruleMap = new Map<string, LocalLearningRule>();

    for (const [asset, stats] of Object.entries(summary.byAsset || {}) as any) {
      const rule = classifyRule("asset", asset, stats);
      if (rule) ruleMap.set(rule.id, rule);
    }

    const aiTrades = await PortfolioManager.getTrades("ai");
    const setupPerformance = SetupPerformance.build(aiTrades, summary, {
      strategyVersion: TRADING_STRATEGY_VERSION,
    });
    for (const bucket of setupPerformance.byAsset) {
      const rule = ruleFromPerformanceBucket("asset", bucket);
      if (rule) ruleMap.set(rule.id, rule);
    }
    for (const bucket of setupPerformance.bySetup) {
      const rule = ruleFromPerformanceBucket("setup", bucket);
      if (rule) ruleMap.set(rule.id, rule);
    }

    const tradeReviewSignals = await TradeReviewJournal.getAssetSignals().catch(() => []);
    for (const signal of tradeReviewSignals) {
      const rule = ruleFromTradeReviewSignal(signal);
      if (rule) ruleMap.set(rule.id, rule);
    }

    const rules = Array.from(ruleMap.values());
    const redis = getRedis();
    await redis.set(RULES_KEY, rules);
    writeJsonBackup("local_learning_rules.json", rules);
    return rules;
  }

  static async getRules(): Promise<LocalLearningRule[]> {
    const redis = getRedis();
    const cached = await redis.get<LocalLearningRule[]>(RULES_KEY);
    return Array.isArray(cached) ? cached : [];
  }

  static async getAdjustment(asset: string, setupTags: string[] = []) {
    const rules = await this.getRules();
    return calculateLearningAdjustment(rules, asset, setupTags);
  }
}
