import fs from "fs";
import path from "path";
import { getRedis } from "@/lib/redis";
import { MarketService } from "@/lib/market";
import { Candle, Timeframe } from "@/lib/types";
import { amountFromNotionalUsd, calculatePnlUsd, estimateFeeUsd } from "@/lib/trading/assetSpecs";

// V2 starts a clean derived-learning window after fixing duplicate sampling
// and contract-aware net outcome calculations. V1 data remains preserved in
// Redis for audit purposes but no longer controls current trade decisions.
const HISTORY_KEY = "opportunity:v2:history";
const PENDING_KEY = "opportunity:v2:pending";
const EVALUATIONS_KEY = "opportunity:v2:evaluations";
const SUMMARY_KEY = "opportunity:v2:summary";
const DEDUPE_KEY_PREFIX = "opportunity:v2:last:";
const MAX_HISTORY = 500;
const MAX_EVALUATIONS = 1000;
const DEDUPE_SECONDS = 15 * 60;

type OpportunityDirection = "LONG" | "SHORT" | "NEUTRAL";
type OpportunityDecision = "ENTRY" | "WATCH" | "BLOCKED" | "SKIPPED" | "ERROR";
type EvaluationHorizon = "15m" | "1h" | "4h" | "24h";
type HypotheticalOutcome = "TAKE_PROFIT" | "STOP_LOSS" | "FAVORABLE" | "ADVERSE" | "FLAT" | "UNKNOWN";

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
  stopLoss?: number;
  takeProfit?: number;
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
  stopLoss?: number;
  takeProfit?: number;
  currentPrice: number;
  movePercent: number;
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
  hitTakeProfit: boolean;
  hitStopLoss: boolean;
  firstHit: "TAKE_PROFIT" | "STOP_LOSS" | "NONE";
  hypotheticalOutcome: HypotheticalOutcome;
  favorable: boolean;
  hypotheticalExitPrice?: number;
  grossPnlUsd?: number;
  feeDragUsd?: number;
  netPnlUsd?: number;
  netReturnPercent?: number;
  decision: OpportunityDecision;
  decisionState?: string;
  setupTags: string[];
  finalConviction: number;
  evaluatedAt: string;
}

const HORIZON_MS: Record<EvaluationHorizon, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

function timeframeForHorizon(horizon: EvaluationHorizon): Timeframe {
  if (horizon === "15m") return "1m";
  if (horizon === "1h") return "5m";
  if (horizon === "4h") return "15m";
  return "1h";
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

function observationFingerprint(record: OpportunityRecord): string {
  return [
    record.direction,
    record.decision,
    record.decisionState || "",
    [...record.setupTags].sort().join("|"),
  ].join(":");
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
  if ((result.finalConviction || 0) >= 25) return true;
  if (["WATCH_LONG", "WATCH_SHORT", "TRIGGER_PENDING", "HIGH_ACCURACY_EXCEPTION"].includes(result.decisionState)) return true;
  return false;
}

function signedMovePercent(direction: OpportunityDirection, entryPrice: number, exitPrice: number) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(exitPrice) || exitPrice <= 0) return 0;
  if (direction === "SHORT") return ((entryPrice - exitPrice) / entryPrice) * 100;
  if (direction === "LONG") return ((exitPrice - entryPrice) / entryPrice) * 100;
  return 0;
}

function evaluateCandles(record: OpportunityRecord, candles: Candle[], currentPrice: number) {
  const entryPrice = record.entryPrice;
  let maxFavorableExcursion = Math.max(0, signedMovePercent(record.direction, entryPrice, currentPrice));
  let maxAdverseExcursion = Math.min(0, signedMovePercent(record.direction, entryPrice, currentPrice));
  let hitTakeProfit = false;
  let hitStopLoss = false;
  let firstHit: OpportunityEvaluation["firstHit"] = "NONE";

  for (const candle of candles) {
    if (record.direction === "LONG") {
      maxFavorableExcursion = Math.max(maxFavorableExcursion, signedMovePercent("LONG", entryPrice, candle.high));
      maxAdverseExcursion = Math.min(maxAdverseExcursion, signedMovePercent("LONG", entryPrice, candle.low));

      const touchedStop = Number(record.stopLoss || 0) > 0 && candle.low <= Number(record.stopLoss);
      const touchedTarget = Number(record.takeProfit || 0) > 0 && candle.high >= Number(record.takeProfit);
      hitStopLoss = hitStopLoss || touchedStop;
      hitTakeProfit = hitTakeProfit || touchedTarget;
      if (firstHit === "NONE" && touchedStop && touchedTarget) firstHit = "STOP_LOSS";
      else if (firstHit === "NONE" && touchedStop) firstHit = "STOP_LOSS";
      else if (firstHit === "NONE" && touchedTarget) firstHit = "TAKE_PROFIT";
    } else if (record.direction === "SHORT") {
      maxFavorableExcursion = Math.max(maxFavorableExcursion, signedMovePercent("SHORT", entryPrice, candle.low));
      maxAdverseExcursion = Math.min(maxAdverseExcursion, signedMovePercent("SHORT", entryPrice, candle.high));

      const touchedStop = Number(record.stopLoss || 0) > 0 && candle.high >= Number(record.stopLoss);
      const touchedTarget = Number(record.takeProfit || 0) > 0 && candle.low <= Number(record.takeProfit);
      hitStopLoss = hitStopLoss || touchedStop;
      hitTakeProfit = hitTakeProfit || touchedTarget;
      if (firstHit === "NONE" && touchedStop && touchedTarget) firstHit = "STOP_LOSS";
      else if (firstHit === "NONE" && touchedStop) firstHit = "STOP_LOSS";
      else if (firstHit === "NONE" && touchedTarget) firstHit = "TAKE_PROFIT";
    }
  }

  const movePercent = signedMovePercent(record.direction, entryPrice, currentPrice);
  let hypotheticalOutcome: HypotheticalOutcome = "UNKNOWN";
  if (firstHit === "TAKE_PROFIT") hypotheticalOutcome = "TAKE_PROFIT";
  else if (firstHit === "STOP_LOSS") hypotheticalOutcome = "STOP_LOSS";
  else if (movePercent > 0.03 || maxFavorableExcursion > 0.08) hypotheticalOutcome = "FAVORABLE";
  else if (movePercent < -0.03 || maxAdverseExcursion < -0.08) hypotheticalOutcome = "ADVERSE";
  else if (record.direction !== "NEUTRAL") hypotheticalOutcome = "FLAT";

  return {
    movePercent,
    maxFavorableExcursion,
    maxAdverseExcursion,
    hitTakeProfit,
    hitStopLoss,
    firstHit,
    hypotheticalOutcome,
    favorable: hypotheticalOutcome === "TAKE_PROFIT" || (hypotheticalOutcome !== "STOP_LOSS" && maxFavorableExcursion > Math.abs(maxAdverseExcursion)),
  };
}

function simulatedNetOutcome(
  record: Pick<OpportunityRecord, "asset" | "direction" | "entryPrice" | "stopLoss" | "takeProfit">,
  path: Pick<OpportunityEvaluation, "firstHit" | "currentPrice"> | { firstHit: OpportunityEvaluation["firstHit"]; currentPrice?: number },
  fallbackCurrentPrice: number
) {
  const notionalUsd = 1_000;
  const entryPrice = Number(record.entryPrice || 0);
  const currentPrice = Number(path.currentPrice || fallbackCurrentPrice || 0);

  if (record.direction === "NEUTRAL" || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      hypotheticalExitPrice: currentPrice || entryPrice,
      grossPnlUsd: 0,
      feeDragUsd: 0,
      netPnlUsd: 0,
      netReturnPercent: 0,
    };
  }

  const stopLoss = Number(record.stopLoss || 0);
  const takeProfit = Number(record.takeProfit || 0);
  let hypotheticalExitPrice = currentPrice;

  if (path.firstHit === "TAKE_PROFIT" && takeProfit > 0) {
    hypotheticalExitPrice = takeProfit;
  } else if (path.firstHit === "STOP_LOSS" && stopLoss > 0) {
    hypotheticalExitPrice = stopLoss;
  }

  try {
    const amount = amountFromNotionalUsd(record.asset, notionalUsd, entryPrice);
    const grossPnlUsd = calculatePnlUsd(record.asset, entryPrice, hypotheticalExitPrice, amount, record.direction);
    const entryFeeUsd = estimateFeeUsd(record.asset, amount, entryPrice);
    const exitFeeUsd = estimateFeeUsd(record.asset, amount, hypotheticalExitPrice);
    const feeDragUsd = entryFeeUsd + exitFeeUsd;
    const netPnlUsd = grossPnlUsd - feeDragUsd;
    return {
      hypotheticalExitPrice,
      grossPnlUsd,
      feeDragUsd,
      netPnlUsd,
      netReturnPercent: (netPnlUsd / notionalUsd) * 100,
    };
  } catch {
    return {
      hypotheticalExitPrice,
      grossPnlUsd: 0,
      feeDragUsd: 0,
      netPnlUsd: 0,
      netReturnPercent: 0,
    };
  }
}

async function evaluatePath(record: OpportunityRecord, horizon: EvaluationHorizon, currentPrice: number) {
  if (record.direction === "NEUTRAL") {
    return evaluateCandles(record, [], currentPrice);
  }

  try {
    const startMs = new Date(record.timestamp).getTime();
    const endMs = startMs + HORIZON_MS[horizon];
    const timeframe = timeframeForHorizon(horizon);
    const candles = await MarketService.getCandles(timeframe, 120, record.asset);
    const pathCandles = candles.filter((candle) => {
      const candleMs = candle.time * 1000;
      return candleMs >= startMs && candleMs <= endMs + 5 * 60_000;
    });
    return evaluateCandles(record, pathCandles, currentPrice);
  } catch {
    return evaluateCandles(record, [], currentPrice);
  }
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
      stopLoss: Number(result.stopLoss || 0) > 0 ? Number(result.stopLoss) : undefined,
      takeProfit: Number(result.takeProfit || 0) > 0 ? Number(result.takeProfit) : undefined,
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
      const dedupeKey = `${DEDUPE_KEY_PREFIX}${record.asset}`;
      const previous = await redis.get<{ fingerprint: string; entryPrice: number }>(dedupeKey).catch(() => null);
      const fingerprint = observationFingerprint(record);
      const priceMovePercent = previous?.entryPrice
        ? Math.abs(record.entryPrice - previous.entryPrice) / previous.entryPrice * 100
        : Infinity;
      if (previous?.fingerprint === fingerprint && priceMovePercent < 0.15) continue;

      await redis.set(dedupeKey, { fingerprint, entryPrice: record.entryPrice }, { ex: DEDUPE_SECONDS });
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
        const path = await evaluatePath(record, horizon, currentPrice);
        const netOutcome = simulatedNetOutcome(record, { ...path, currentPrice }, currentPrice);
        evaluations.push({
          id: `${record.id}-${horizon}`,
          opportunityId: record.id,
          asset: record.asset,
          horizon,
          direction: record.direction,
          entryPrice: record.entryPrice,
          stopLoss: record.stopLoss,
          takeProfit: record.takeProfit,
          currentPrice,
          movePercent: path.movePercent,
          maxFavorableExcursion: path.maxFavorableExcursion,
          maxAdverseExcursion: path.maxAdverseExcursion,
          hitTakeProfit: path.hitTakeProfit,
          hitStopLoss: path.hitStopLoss,
          firstHit: path.firstHit,
          hypotheticalOutcome: path.hypotheticalOutcome,
          favorable: netOutcome.netPnlUsd > 0,
          hypotheticalExitPrice: netOutcome.hypotheticalExitPrice,
          grossPnlUsd: netOutcome.grossPnlUsd,
          feeDragUsd: netOutcome.feeDragUsd,
          netPnlUsd: netOutcome.netPnlUsd,
          netReturnPercent: netOutcome.netReturnPercent,
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
    const byAsset: Record<string, { total: number; favorable: number; avgMove: number; avgNetPnlUsd: number; avgNetReturnPercent: number; grossProfitUsd: number; grossLossUsd: number; profitFactor: number | null }> = {};
    const bySetup: Record<string, { total: number; favorable: number; avgMove: number; avgMfe: number; avgMae: number; avgNetPnlUsd: number; avgNetReturnPercent: number; grossProfitUsd: number; grossLossUsd: number; profitFactor: number | null; takeProfitHits: number; stopLossHits: number }> = {};
    let bestMissed: OpportunityEvaluation | null = null;

    for (const evaluation of evaluations) {
      const net = Number.isFinite(Number(evaluation.netPnlUsd))
        ? {
          netPnlUsd: Number(evaluation.netPnlUsd),
          netReturnPercent: Number(evaluation.netReturnPercent || 0),
        }
        : simulatedNetOutcome(evaluation, evaluation, Number(evaluation.currentPrice || 0));

      const asset = byAsset[evaluation.asset] || { total: 0, favorable: 0, avgMove: 0, avgNetPnlUsd: 0, avgNetReturnPercent: 0, grossProfitUsd: 0, grossLossUsd: 0, profitFactor: null };
      asset.total++;
      asset.favorable += net.netPnlUsd > 0 ? 1 : 0;
      asset.avgMove += evaluation.movePercent;
      asset.avgNetPnlUsd += net.netPnlUsd;
      asset.avgNetReturnPercent += net.netReturnPercent;
      if (net.netPnlUsd > 0) asset.grossProfitUsd += net.netPnlUsd;
      else asset.grossLossUsd += Math.abs(net.netPnlUsd);
      byAsset[evaluation.asset] = asset;

      for (const tag of evaluation.setupTags.length ? evaluation.setupTags : ["UNTAGGED"]) {
        const setup = bySetup[tag] || { total: 0, favorable: 0, avgMove: 0, avgMfe: 0, avgMae: 0, avgNetPnlUsd: 0, avgNetReturnPercent: 0, grossProfitUsd: 0, grossLossUsd: 0, profitFactor: null, takeProfitHits: 0, stopLossHits: 0 };
        setup.total++;
        setup.favorable += net.netPnlUsd > 0 ? 1 : 0;
        setup.avgMove += evaluation.movePercent;
        setup.avgMfe += evaluation.maxFavorableExcursion || 0;
        setup.avgMae += evaluation.maxAdverseExcursion || 0;
        setup.avgNetPnlUsd += net.netPnlUsd;
        setup.avgNetReturnPercent += net.netReturnPercent;
        if (net.netPnlUsd > 0) setup.grossProfitUsd += net.netPnlUsd;
        else setup.grossLossUsd += Math.abs(net.netPnlUsd);
        setup.takeProfitHits += evaluation.hitTakeProfit ? 1 : 0;
        setup.stopLossHits += evaluation.hitStopLoss ? 1 : 0;
        bySetup[tag] = setup;
      }

      const bestMissedNet = bestMissed ? Number(bestMissed.netPnlUsd || 0) : -Infinity;
      if (evaluation.decision !== "ENTRY" && net.netPnlUsd > bestMissedNet) {
        evaluation.netPnlUsd = net.netPnlUsd;
        evaluation.netReturnPercent = net.netReturnPercent;
        bestMissed = evaluation;
      }
    }

    for (const value of Object.values(byAsset)) {
      value.avgMove = value.total > 0 ? value.avgMove / value.total : 0;
      value.avgNetPnlUsd = value.total > 0 ? value.avgNetPnlUsd / value.total : 0;
      value.avgNetReturnPercent = value.total > 0 ? value.avgNetReturnPercent / value.total : 0;
      value.profitFactor = value.grossLossUsd > 0 ? value.grossProfitUsd / value.grossLossUsd : value.grossProfitUsd > 0 ? null : 0;
    }
    for (const value of Object.values(bySetup)) {
      value.avgMove = value.total > 0 ? value.avgMove / value.total : 0;
      value.avgMfe = value.total > 0 ? value.avgMfe / value.total : 0;
      value.avgMae = value.total > 0 ? value.avgMae / value.total : 0;
      value.avgNetPnlUsd = value.total > 0 ? value.avgNetPnlUsd / value.total : 0;
      value.avgNetReturnPercent = value.total > 0 ? value.avgNetReturnPercent / value.total : 0;
      value.profitFactor = value.grossLossUsd > 0 ? value.grossProfitUsd / value.grossLossUsd : value.grossProfitUsd > 0 ? null : 0;
    }

    const totalEvaluated = evaluations.length;
    const favorable = Object.values(byAsset).reduce((sum, stats) => sum + stats.favorable, 0);
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
