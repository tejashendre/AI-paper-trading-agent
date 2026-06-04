import { getRedis } from "@/lib/redis";
import { MarketService } from "@/lib/market";
import { AutonomousDecision, DirectionExpectation } from "@/lib/types";

const PREDICTIONS_KEY = "ai:predictions";
const PREDICTION_SCORES_KEY = "ai:prediction_scores";
const SUMMARY_KEY = "ai:prediction_summary";
const MAX_PREDICTIONS = 500;
const MAX_SCORES = 1000;
const PRUNE_UNRESOLVED_AFTER_MS = 72 * 60 * 60 * 1000;

export interface PredictionRecord {
  decisionId: string;
  asset: string;
  timestamp: string;
  entryPrice: number;
  action: string;
  confidence: number;
  predicted15m: DirectionExpectation;
  predicted1h: DirectionExpectation;
  predicted4h: DirectionExpectation;
  actual15m?: DirectionExpectation;
  actual1h?: DirectionExpectation;
  actual4h?: DirectionExpectation;
  price15m?: number;
  price1h?: number;
  price4h?: number;
  score15m?: number;
  score1h?: number;
  score4h?: number;
  directionScore?: number;
  calibrationScore?: number;
  resolved: boolean;
  pruned?: boolean;
  prunedReason?: string;
}

export interface PredictionScoreRecord {
  id: string;
  decisionId: string;
  asset: string;
  horizon: "15m" | "1h" | "4h";
  predicted: DirectionExpectation;
  actual: DirectionExpectation;
  score: number;
  confidence: number;
  calibrationScore: number;
  resolvedAt: string;
  action: string;
}

export interface PredictionPerformanceSummary {
  totalResolved: number;
  totalOpen: number;
  accuracy: number;
  calibrationScore: number;
  accuracy15m: number;
  accuracy1h: number;
  accuracy4h: number;
  recentCorrect: number;
  recentWrong: number;
}

function emptySummary(open = 0): PredictionPerformanceSummary {
  return {
    totalResolved: 0,
    totalOpen: open,
    accuracy: 0,
    calibrationScore: 0,
    accuracy15m: 0,
    accuracy1h: 0,
    accuracy4h: 0,
    recentCorrect: 0,
    recentWrong: 0,
  };
}

async function getAllPredictions(): Promise<PredictionRecord[]> {
  try {
    const data = await getRedis().get<PredictionRecord[]>(PREDICTIONS_KEY);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function setAllPredictions(predictions: PredictionRecord[]): Promise<void> {
  await getRedis().set(PREDICTIONS_KEY, predictions.slice(0, MAX_PREDICTIONS));
}

async function appendPredictionScores(scores: PredictionScoreRecord[]): Promise<void> {
  if (scores.length === 0) return;
  const redis = getRedis();
  let existing: PredictionScoreRecord[] = [];
  try {
    const data = await redis.get<PredictionScoreRecord[]>(PREDICTION_SCORES_KEY);
    existing = Array.isArray(data) ? data : [];
  } catch {}
  const byId = new Map<string, PredictionScoreRecord>();
  for (const score of [...scores, ...existing]) byId.set(score.id, score);
  await redis.set(PREDICTION_SCORES_KEY, Array.from(byId.values()).slice(0, MAX_SCORES));
}

export async function savePredictionFromDecision(
  decision: AutonomousDecision,
  entryPrice: number
): Promise<PredictionRecord> {
  const record: PredictionRecord = {
    decisionId: decision.id,
    asset: decision.asset,
    timestamp: decision.timestamp,
    entryPrice,
    action: decision.action,
    confidence: decision.confidence,
    predicted15m: decision.expected15mDirection,
    predicted1h: decision.expected1hDirection,
    predicted4h: decision.expected4hDirection,
    resolved: false,
  };

  const predictions = await getAllPredictions();
  const next = [record, ...predictions.filter((item) => item.decisionId !== record.decisionId)].slice(0, MAX_PREDICTIONS);
  await setAllPredictions(next);
  return record;
}

function actualDirection(entryPrice: number, currentPrice: number): DirectionExpectation {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || entryPrice <= 0) return "SIDEWAYS";
  const movePercent = ((currentPrice - entryPrice) / entryPrice) * 100;
  if (movePercent > 0.15) return "UP";
  if (movePercent < -0.15) return "DOWN";
  return "SIDEWAYS";
}

function scoreDirection(predicted: DirectionExpectation, actual: DirectionExpectation, action?: string): number {
  if (action === "HOLD") {
    if (predicted === "SIDEWAYS" && actual === "SIDEWAYS") return 1;
    if (actual === "SIDEWAYS") return 0.75;
    if (predicted === actual) return 0.65;
    return 0.25;
  }
  if (predicted === actual) return 1;
  if (predicted === "SIDEWAYS" || actual === "SIDEWAYS") return 0.5;
  return 0;
}

function scoreCalibration(confidence: number, directionScore: number): number {
  const centeredConfidence = Math.max(0, Math.min(1, confidence));
  if (directionScore >= 1) return centeredConfidence;
  if (directionScore >= 0.5) return 0.25 - centeredConfidence * 0.25;
  return -(centeredConfidence * (centeredConfidence >= 0.7 ? 1.35 : 1));
}

async function getPriceAtOrAfter(asset: string, timeframe: "15m" | "1h" | "4h", targetMs: number): Promise<number> {
  const candles = await MarketService.getCandles(timeframe, 300, asset);
  const targetSeconds = Math.floor(targetMs / 1000);
  const sorted = [...candles].sort((a, b) => Math.abs(a.time - targetSeconds) - Math.abs(b.time - targetSeconds));
  const price = sorted[0]?.close;
  if (Number.isFinite(price) && price > 0) return price;
  return MarketService.getCurrentPrice(asset);
}

function createScoreRecord(args: {
  prediction: PredictionRecord;
  horizon: "15m" | "1h" | "4h";
  predicted: DirectionExpectation;
  actual: DirectionExpectation;
  score: number;
}): PredictionScoreRecord {
  return {
    id: `${args.prediction.decisionId}:${args.horizon}`,
    decisionId: args.prediction.decisionId,
    asset: args.prediction.asset,
    horizon: args.horizon,
    predicted: args.predicted,
    actual: args.actual,
    score: args.score,
    confidence: args.prediction.confidence,
    calibrationScore: scoreCalibration(args.prediction.confidence, args.score),
    resolvedAt: new Date().toISOString(),
    action: args.prediction.action,
  };
}

export async function resolvePendingPredictions(now = Date.now()): Promise<PredictionPerformanceSummary> {
  const predictions = await getAllPredictions();
  const next = [...predictions];
  const newScores: PredictionScoreRecord[] = [];

  for (const prediction of next) {
    if (prediction.resolved) continue;
    const ageMs = now - new Date(prediction.timestamp).getTime();
    if (ageMs < 15 * 60 * 1000) continue;

    try {
      const decisionMs = new Date(prediction.timestamp).getTime();
      if (ageMs >= 15 * 60 * 1000 && !prediction.actual15m) {
        prediction.price15m = await getPriceAtOrAfter(prediction.asset, "15m", decisionMs + 15 * 60 * 1000);
        prediction.actual15m = actualDirection(prediction.entryPrice, prediction.price15m);
        prediction.score15m = scoreDirection(prediction.predicted15m, prediction.actual15m, prediction.action);
        newScores.push(createScoreRecord({ prediction, horizon: "15m", predicted: prediction.predicted15m, actual: prediction.actual15m, score: prediction.score15m }));
      }
      if (ageMs >= 60 * 60 * 1000 && !prediction.actual1h) {
        prediction.price1h = await getPriceAtOrAfter(prediction.asset, "1h", decisionMs + 60 * 60 * 1000);
        prediction.actual1h = actualDirection(prediction.entryPrice, prediction.price1h);
        prediction.score1h = scoreDirection(prediction.predicted1h, prediction.actual1h, prediction.action);
        newScores.push(createScoreRecord({ prediction, horizon: "1h", predicted: prediction.predicted1h, actual: prediction.actual1h, score: prediction.score1h }));
      }
      if (ageMs >= 4 * 60 * 60 * 1000 && !prediction.actual4h) {
        prediction.price4h = await getPriceAtOrAfter(prediction.asset, "4h", decisionMs + 4 * 60 * 60 * 1000);
        prediction.actual4h = actualDirection(prediction.entryPrice, prediction.price4h);
        prediction.score4h = scoreDirection(prediction.predicted4h, prediction.actual4h, prediction.action);
        newScores.push(createScoreRecord({ prediction, horizon: "4h", predicted: prediction.predicted4h, actual: prediction.actual4h, score: prediction.score4h }));
      }

      if (prediction.actual15m && prediction.actual1h && prediction.actual4h) {
        const score15m = prediction.score15m ?? scoreDirection(prediction.predicted15m, prediction.actual15m, prediction.action);
        const score1h = prediction.score1h ?? scoreDirection(prediction.predicted1h, prediction.actual1h, prediction.action);
        const score4h = prediction.score4h ?? scoreDirection(prediction.predicted4h, prediction.actual4h, prediction.action);
        prediction.directionScore = (score15m + score1h + score4h) / 3;
        prediction.calibrationScore = scoreCalibration(prediction.confidence, prediction.directionScore);
        prediction.resolved = true;
      }
    } catch {
      if (ageMs > PRUNE_UNRESOLVED_AFTER_MS) {
        prediction.resolved = true;
        prediction.pruned = true;
        prediction.prunedReason = "Prediction was pruned after 72h without resolvable market data";
      }
      continue;
    }
  }

  await appendPredictionScores(newScores);
  await setAllPredictions(next);
  const summary = summarizePredictions(next);
  await getRedis().set(SUMMARY_KEY, summary);
  return summary;
}

export function summarizePredictions(predictions: PredictionRecord[]): PredictionPerformanceSummary {
  const resolved = predictions.filter((prediction) => prediction.resolved && !prediction.pruned);
  if (resolved.length === 0) return emptySummary(predictions.length);

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const scored15m = resolved.filter((prediction) => prediction.actual15m);
  const scored1h = resolved.filter((prediction) => prediction.actual1h);
  const scored4h = resolved.filter((prediction) => prediction.actual4h);
  const recent = resolved.slice(0, 20);

  const summary = {
    totalResolved: resolved.length,
    totalOpen: predictions.filter((prediction) => !prediction.resolved).length,
    accuracy: sum(resolved.map((prediction) => prediction.directionScore || 0)) / resolved.length,
    calibrationScore: sum(resolved.map((prediction) => prediction.calibrationScore || 0)) / resolved.length,
    accuracy15m: scored15m.length ? sum(scored15m.map((prediction) => prediction.score15m ?? scoreDirection(prediction.predicted15m, prediction.actual15m!, prediction.action))) / scored15m.length : 0,
    accuracy1h: scored1h.length ? sum(scored1h.map((prediction) => prediction.score1h ?? scoreDirection(prediction.predicted1h, prediction.actual1h!, prediction.action))) / scored1h.length : 0,
    accuracy4h: scored4h.length ? sum(scored4h.map((prediction) => prediction.score4h ?? scoreDirection(prediction.predicted4h, prediction.actual4h!, prediction.action))) / scored4h.length : 0,
    recentCorrect: recent.filter((prediction) => (prediction.directionScore || 0) >= 0.66).length,
    recentWrong: recent.filter((prediction) => (prediction.directionScore || 0) < 0.5).length,
  };

  return summary;
}

export async function getPredictionPerformanceSummary(): Promise<PredictionPerformanceSummary> {
  try {
    const cached = await getRedis().get<PredictionPerformanceSummary>(SUMMARY_KEY);
    if (cached) return cached;
  } catch {}
  const predictions = await getAllPredictions();
  return summarizePredictions(predictions);
}

export async function getRecentPredictions(limit = 25): Promise<PredictionRecord[]> {
  return (await getAllPredictions()).slice(0, limit);
}

export async function getRecentPredictionScores(limit = 50): Promise<PredictionScoreRecord[]> {
  try {
    const data = await getRedis().get<PredictionScoreRecord[]>(PREDICTION_SCORES_KEY);
    return Array.isArray(data) ? data.slice(0, limit) : [];
  } catch {
    return [];
  }
}
