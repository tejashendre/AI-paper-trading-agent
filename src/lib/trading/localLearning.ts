import fs from "fs";
import path from "path";
import { getRedis } from "@/lib/redis";
import { PortfolioManager } from "@/lib/portfolio";
import { OpportunityJournal } from "./opportunityJournal";
import { SetupPerformance, SetupPerformanceBucket } from "./setupPerformance";
import { TradeReviewJournal, TradeReviewAssetSignal } from "./tradeReviewJournal";

const RULES_KEY = "learning:localRules";

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
  stats: { total: number; favorable: number; avgMove: number; avgMfe?: number; avgMae?: number; takeProfitHits?: number; stopLossHits?: number }
): LocalLearningRule | null {
  if (stats.total < 4) return null;
  const favorableRate = stats.favorable / stats.total;
  const takeProfitRate = (stats.takeProfitHits || 0) / stats.total;
  const stopLossRate = (stats.stopLossHits || 0) / stats.total;

  if ((favorableRate >= 0.65 && stats.avgMove > 0.005) || takeProfitRate >= 0.45) {
    return {
      id: `${scope}:${key}`,
      scope,
      key,
      action: "BOOST",
      confidenceAdjustment: 5,
      message: `${key} has recently produced favorable follow-through. The bot may slightly trust this pattern more.`,
      sampleSize: stats.total,
      favorableRate,
      avgMove: stats.avgMove,
      updatedAt: new Date().toISOString(),
    };
  }

  if (favorableRate <= 0.35 || stats.avgMove < -0.005 || stopLossRate >= 0.45) {
    return {
      id: `${scope}:${key}`,
      scope,
      key,
      action: "REDUCE",
      confidenceAdjustment: -8,
      message: `${key} has recently failed too often. The bot should be more selective here.`,
      sampleSize: stats.total,
      favorableRate,
      avgMove: stats.avgMove,
      updatedAt: new Date().toISOString(),
    };
  }

  return null;
}

function ruleFromPerformanceBucket(
  scope: LocalLearningRule["scope"],
  bucket: SetupPerformanceBucket
): LocalLearningRule | null {
  if (bucket.tradeCount < 3 && bucket.opportunityCount < 6) return null;
  if (bucket.confidenceAdjustment === 0) return null;

  const action: LocalLearningRule["action"] = bucket.confidenceAdjustment > 0 ? "BOOST" : "REDUCE";
  const sampleSize = Math.max(bucket.tradeCount, bucket.opportunityCount);
  const favorableRate = bucket.tradeCount > 0 ? bucket.winRate : bucket.opportunityFavorableRate;
  const avgMove = bucket.tradeCount > 0 ? bucket.avgPnl : bucket.avgOpportunityMove;
  const evidenceLabel = bucket.evidence.includes("trade") ? "closed trades" : "watched opportunities";

  return {
    id: `${scope}:${bucket.key}`,
    scope,
    key: bucket.key,
    action,
    confidenceAdjustment: Math.max(-12, Math.min(8, bucket.confidenceAdjustment)),
    message: `${bucket.label} is ${action === "BOOST" ? "performing well" : "underperforming"} based on ${evidenceLabel}; the bot should ${action === "BOOST" ? "trust it slightly more" : "be more selective here"}.`,
    sampleSize,
    favorableRate,
    avgMove,
    updatedAt: new Date().toISOString(),
  };
}

function ruleFromTradeReviewSignal(signal: TradeReviewAssetSignal): LocalLearningRule | null {
  if (signal.action === "NEUTRAL" || signal.confidenceAdjustment === 0) return null;
  if (signal.reviews < 3) return null;

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

export class LocalLearningMemory {
  static async rebuildRules() {
    const summary = await OpportunityJournal.getSummary();
    const ruleMap = new Map<string, LocalLearningRule>();

    for (const [asset, stats] of Object.entries(summary.byAsset || {}) as any) {
      const rule = classifyRule("asset", asset, stats);
      if (rule) ruleMap.set(rule.id, rule);
    }

    for (const [setup, stats] of Object.entries(summary.bySetup || {}) as any) {
      const rule = classifyRule("setup", setup, stats);
      if (rule) ruleMap.set(rule.id, rule);
    }

    const aiTrades = await PortfolioManager.getTrades("ai");
    const setupPerformance = SetupPerformance.build(aiTrades, summary);
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
    const matched = rules.filter((rule) => (
      (rule.scope === "asset" && rule.key === asset) ||
      (rule.scope === "setup" && setupTags.includes(rule.key)) ||
      rule.scope === "global"
    ));

    const adjustment = matched.reduce((sum, rule) => sum + rule.confidenceAdjustment, 0);
    const watchOnly = matched.some((rule) => rule.action === "REDUCE" && rule.favorableRate < 0.25 && rule.sampleSize >= 6 && rule.avgMove < -0.05);

    return {
      adjustment: Math.max(-15, Math.min(10, adjustment)),
      watchOnly,
      rules: matched.slice(0, 5),
    };
  }
}
