import fs from "fs";
import path from "path";
import { getRedis } from "@/lib/redis";
import { OpportunityJournal } from "./opportunityJournal";

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
  let action: LocalLearningRule["action"] = "WATCH_ONLY";
  let confidenceAdjustment = 0;
  let message = `${key} does not have enough edge yet.`;

  if ((favorableRate >= 0.65 && stats.avgMove > 0.05) || takeProfitRate >= 0.45) {
    action = "BOOST";
    confidenceAdjustment = 5;
    message = `${key} has recently produced favorable follow-through. The bot may slightly trust this pattern more.`;
  } else if (favorableRate <= 0.35 || stats.avgMove < -0.05 || stopLossRate >= 0.45) {
    action = "REDUCE";
    confidenceAdjustment = -8;
    message = `${key} has recently failed too often. The bot should be more selective here.`;
  }

  return {
    id: `${scope}:${key}`,
    scope,
    key,
    action,
    confidenceAdjustment,
    message,
    sampleSize: stats.total,
    favorableRate,
    avgMove: stats.avgMove,
    updatedAt: new Date().toISOString(),
  };
}

export class LocalLearningMemory {
  static async rebuildRules() {
    const summary = await OpportunityJournal.getSummary();
    const rules: LocalLearningRule[] = [];

    for (const [asset, stats] of Object.entries(summary.byAsset || {}) as any) {
      const rule = classifyRule("asset", asset, stats);
      if (rule) rules.push(rule);
    }

    for (const [setup, stats] of Object.entries(summary.bySetup || {}) as any) {
      const rule = classifyRule("setup", setup, stats);
      if (rule) rules.push(rule);
    }

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
    const watchOnly = matched.some((rule) => rule.action === "WATCH_ONLY" || (rule.action === "REDUCE" && rule.favorableRate < 0.25 && rule.sampleSize >= 6));

    return {
      adjustment: Math.max(-15, Math.min(10, adjustment)),
      watchOnly,
      rules: matched.slice(0, 5),
    };
  }
}
