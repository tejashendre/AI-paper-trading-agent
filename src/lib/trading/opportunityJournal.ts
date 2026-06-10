import fs from "fs";
import path from "path";
import { getRedis } from "@/lib/redis";
import { MarketService } from "@/lib/market";

const HISTORY_KEY = "opportunity:history";
const PENDING_KEY = "opportunity:pending";
const EVALUATIONS_KEY = "opportunity:evaluations";
const SUMMARY_KEY = "opportunity:summary";
const MAX_HISTORY = 500;
const MAX_EVALUATIONS = 1000;

type OpportunityDirection = "LONG" | "SHORT" | "NEUTRAL";
type OpportunityDecision = "ENTRY" | "WATCH" | "BLOCKED" | "SKIPPED" | "ERROR";
type EvaluationHorizon = "15m" | "1h" | "4h" | "24h";

export interface OpportunityRecord {
  id: string;
  asset: string;
  timestamp: string;
  direction: OpportunityDirection;
  decision: OpportunityDecision;
  decisionState?: string;
  simpleStatus?: string;
  simpleReason?: string;
  entryPrice: number;
  score: number;
  triggerScore: number;
  dataQuality: number;
  finalConviction: number;
  paperSize?: string;
  setupTags: string[];
  evaluatedHorizons: EvaluationHorizon[];
}

export interface OpportunityEvaluation {
  id: string;
  opportunityId: string;
  asset: string;
  horizon: EvaluationHorizon;
  direction: OpportunityDirection;
  entryPrice: number;
  currentPrice: number;
  movePercent: number;
  favorable: boolean;
  decision: OpportunityDecision;
  decisionState?: string;
  setupTags: string[];
  finalConviction: number;
  evaluatedAt: string;
}

function dataPath(filename: string) {
  return path.join(process.cwd(), "data", filename);
}

function writeJsonBackup(filename: string, value: unknown) {
  try {
    const dir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dataPath(filename), JSON.stringify(value, null, 2));
  } catch {}
}

function parseRecord(raw: unknown): OpportunityRecord | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as OpportunityRecord;
    } catch {
      return null;
    }
  }
  return raw as OpportunityRecord;
}

function parseEvaluation(raw: unknown): OpportunityEvaluation | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as OpportunityEvaluation;
    } catch {
      return null;
    }
  }
  return raw as OpportunityEvaluation;
}

function dueHorizons(record: OpportunityRecord, now = Date.now()): EvaluationHorizon[] {
  const age = now - new Date(record.timestamp).getTime();
  const already = new Set(record.evaluatedHorizons || []);
  const due: Array<[EvaluationHorizon, number]> = [
    ["15m", 15 * 60_000],
    ["1h", 60 * 60_000],
    ["4h", 4 * 60 * 60_000],
    ["24h", 24 * 60 * 60_000],
  ];
  return due.filter(([horizon, ms]) => age >= ms && !already.has(horizon)).map(([horizon]) => horizon);
}

function inferDecision(action?: string, decisionState?: string): OpportunityDecision {
  if (action === "ENTRY") return "ENTRY";
  if (action === "BLOCKED" || decisionState?.startsWith("BLOCKED")) return "BLOCKED";
  if (action === "SKIPPED") return "SKIPPED";
  if (action === "ERROR") return "ERROR";
  return "WATCH";
}

function inferDirection(result: any): OpportunityDirection {
  if (result.directionBias === "LONG") return "LONG";
  if (result.directionBias === "SHORT") return "SHORT";
  if (result.decisionState === "WATCH_LONG") return "LONG";
  if (result.decisionState === "WATCH_SHORT") return "SHORT";
  if (result.reason?.toLowerCase?.().includes("bullish")) return "LONG";
  if (result.reason?.toLowerCase?.().includes("bearish")) return "SHORT";
  return "NEUTRAL";
}

function shouldRecord(result: any) {
  if (!result || !result.asset) return false;
  if (result.action === "ERROR") return true;
  if (result.action === "ENTRY" || result.action === "BLOCKED") return true;
  if ((result.finalConviction || 0) >= 40) return true;
  if (["WATCH_LONG", "WATCH_SHORT", "TRIGGER_PENDING", "HIGH_ACCURACY_EXCEPTION"].includes(result.decisionState)) return true;
  return false;
}

export class OpportunityJournal {
  static buildFromScanResult(result: any): OpportunityRecord | null {
    if (!shouldRecord(result)) return null;
    const entryPrice = Number(result.price || result.livePrice || result.signalPrice || 0);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

    return {
      id: `${result.asset}-${result.timestamp || new Date().toISOString()}-${result.decisionState || result.action}`,
      asset: result.asset,
      timestamp: result.timestamp || new Date().toISOString(),
      direction: inferDirection(result),
      decision: inferDecision(result.action, result.decisionState),
      decisionState: result.decisionState,
      simpleStatus: result.simpleStatus,
      simpleReason: result.simpleReason || result.reason,
      entryPrice,
      score: Number(result.score || 0),
      triggerScore: Number(result.triggerScore || 0),
      dataQuality: Number(result.dataQuality || 0),
      finalConviction: Number(result.finalConviction || 0),
      paperSize: result.paperSize,
      setupTags: Array.isArray(result.setupTags) ? result.setupTags.slice(0, 8) : [],
      evaluatedHorizons: [],
    };
  }

  static async recordMany(results: any[]) {
    const records = results.map((result) => this.buildFromScanResult(result)).filter(Boolean) as OpportunityRecord[];
    if (records.length === 0) return;

    const redis = getRedis();
    for (const record of records) {
      await redis.lpush(HISTORY_KEY, JSON.stringify(record));
      if (record.direction !== "NEUTRAL") await redis.lpush(PENDING_KEY, JSON.stringify(record));
    }
    await redis.ltrim(HISTORY_KEY, 0, MAX_HISTORY - 1);
    await redis.ltrim(PENDING_KEY, 0, MAX_HISTORY - 1);
  }

  static async evaluateDue() {
    const redis = getRedis();
    const pendingRaw = await redis.lrange(PENDING_KEY, 0, MAX_HISTORY - 1);
    const pending = pendingRaw.map(parseRecord).filter(Boolean) as OpportunityRecord[];
    const keep: OpportunityRecord[] = [];
    const evaluations: OpportunityEvaluation[] = [];

    for (const record of pending) {
      const due = dueHorizons(record);
      if (due.length === 0) {
        keep.push(record);
        continue;
      }

      let currentPrice = 0;
      try {
        currentPrice = await MarketService.getCurrentPrice(record.asset);
      } catch {
        keep.push(record);
        continue;
      }

      for (const horizon of due) {
        const signedMove = record.direction === "SHORT"
          ? (record.entryPrice - currentPrice) / record.entryPrice
          : (currentPrice - record.entryPrice) / record.entryPrice;
        evaluations.push({
          id: `${record.id}-${horizon}`,
          opportunityId: record.id,
          asset: record.asset,
          horizon,
          direction: record.direction,
          entryPrice: record.entryPrice,
          currentPrice,
          movePercent: signedMove * 100,
          favorable: signedMove > 0,
          decision: record.decision,
          decisionState: record.decisionState,
          setupTags: record.setupTags,
          finalConviction: record.finalConviction,
          evaluatedAt: new Date().toISOString(),
        });
        record.evaluatedHorizons.push(horizon);
      }

      if (record.evaluatedHorizons.length < 4) keep.push(record);
    }

    if (evaluations.length > 0) {
      for (const evaluation of evaluations) {
        await redis.lpush(EVALUATIONS_KEY, JSON.stringify(evaluation));
      }
      await redis.ltrim(EVALUATIONS_KEY, 0, MAX_EVALUATIONS - 1);
      await this.rebuildSummary();
    }

    await redis.del(PENDING_KEY);
    for (let i = keep.length - 1; i >= 0; i--) {
      await redis.lpush(PENDING_KEY, JSON.stringify(keep[i]));
    }
    await redis.ltrim(PENDING_KEY, 0, MAX_HISTORY - 1);

    return { evaluated: evaluations.length, pending: keep.length };
  }

  static async getRecent(limit = 20) {
    const redis = getRedis();
    const rows = await redis.lrange(HISTORY_KEY, 0, limit - 1);
    return rows.map(parseRecord).filter(Boolean) as OpportunityRecord[];
  }

  static async getSummary() {
    const redis = getRedis();
    const summary = await redis.get<any>(SUMMARY_KEY);
    return summary || {
      totalEvaluated: 0,
      favorableRate: 0,
      bestMissed: null,
      byAsset: {},
      bySetup: {},
      lastUpdated: null,
    };
  }

  static async rebuildSummary() {
    const redis = getRedis();
    const rows = await redis.lrange(EVALUATIONS_KEY, 0, MAX_EVALUATIONS - 1);
    const evaluations = rows.map(parseEvaluation).filter(Boolean) as OpportunityEvaluation[];
    const byAsset: Record<string, { total: number; favorable: number; avgMove: number }> = {};
    const bySetup: Record<string, { total: number; favorable: number; avgMove: number }> = {};
    let bestMissed: OpportunityEvaluation | null = null;

    for (const evaluation of evaluations) {
      const asset = byAsset[evaluation.asset] || { total: 0, favorable: 0, avgMove: 0 };
      asset.total++;
      asset.favorable += evaluation.favorable ? 1 : 0;
      asset.avgMove += evaluation.movePercent;
      byAsset[evaluation.asset] = asset;

      for (const tag of evaluation.setupTags.length ? evaluation.setupTags : ["UNTAGGED"]) {
        const setup = bySetup[tag] || { total: 0, favorable: 0, avgMove: 0 };
        setup.total++;
        setup.favorable += evaluation.favorable ? 1 : 0;
        setup.avgMove += evaluation.movePercent;
        bySetup[tag] = setup;
      }

      if (evaluation.decision !== "ENTRY" && (!bestMissed || evaluation.movePercent > bestMissed.movePercent)) {
        bestMissed = evaluation;
      }
    }

    for (const value of Object.values(byAsset)) value.avgMove = value.total > 0 ? value.avgMove / value.total : 0;
    for (const value of Object.values(bySetup)) value.avgMove = value.total > 0 ? value.avgMove / value.total : 0;

    const totalEvaluated = evaluations.length;
    const favorable = evaluations.filter((evaluation) => evaluation.favorable).length;
    const summary = {
      totalEvaluated,
      favorableRate: totalEvaluated > 0 ? favorable / totalEvaluated : 0,
      bestMissed,
      byAsset,
      bySetup,
      lastUpdated: new Date().toISOString(),
    };

    await redis.set(SUMMARY_KEY, summary);
    writeJsonBackup("opportunity_summary.json", summary);
    writeJsonBackup("opportunity_evaluations.json", evaluations.slice(0, 300));
    return summary;
  }
}
