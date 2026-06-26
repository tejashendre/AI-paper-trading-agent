import fs from "fs";
import path from "path";
import { getRedis } from "@/lib/redis";
import { OpenPosition, Trade } from "@/lib/types";

const REVIEW_KEY = "tradeReview:aiSwing";
const DIGEST_KEY = "tradeReview:aiSwing:digest";
const MAX_REVIEWS = 300;

export type TradeReviewOutcome =
  | "STRONG_WIN"
  | "PROFIT_PROTECTED"
  | "SMALL_WIN"
  | "CONTROLLED_LOSS"
  | "RISK_BREACH"
  | "THESIS_FAILED"
  | "UNKNOWN";

export interface TradeReviewRecord {
  id: string;
  tradeId: string;
  asset: string;
  direction: "LONG" | "SHORT";
  entryTime?: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: NonNullable<Trade["exitReason"]>;
  pnl: number;
  pnlPercent: number;
  peakOpenPnl: number;
  retainedPeakPercent: number | null;
  plannedRiskUsd: number | null;
  riskMultiple: number | null;
  finalConviction: number | null;
  triggerScore: number | null;
  dataQuality: number | null;
  setupTags: string[];
  thesisStatus: OpenPosition["thesisStatus"] | null;
  thesisReason: string | null;
  outcome: TradeReviewOutcome;
  lesson: string;
  nextAction: "TRUST_MORE" | "KEEP_NORMAL" | "TIGHTEN_EXITS" | "REDUCE_SIZE" | "WATCH_ONLY";
  reviewedAt: string;
}

export interface TradeReviewDigest {
  totalReviewed: number;
  recentCount: number;
  winRate: number;
  avgPnl: number;
  avgRetainedPeakPercent: number | null;
  byOutcome: Record<TradeReviewOutcome, number>;
  watchOnlyAssets: string[];
  trustMoreAssets: string[];
  latestLessons: Array<{
    asset: string;
    outcome: TradeReviewOutcome;
    pnl: number;
    lesson: string;
    reviewedAt: string;
  }>;
  lastUpdated: string | null;
}

export interface TradeReviewAssetSignal {
  asset: string;
  reviews: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnl: number;
  avgRetainedPeakPercent: number | null;
  protectedWins: number;
  controlledLosses: number;
  riskBreaches: number;
  thesisFailures: number;
  confidenceAdjustment: number;
  action: "BOOST" | "REDUCE" | "NEUTRAL";
  message: string;
  updatedAt: string;
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

function parseReview(raw: unknown): TradeReviewRecord | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as TradeReviewRecord;
    } catch {
      return null;
    }
  }
  return raw as TradeReviewRecord;
}

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function retainedPeakPercent(pnl: number, peakOpenPnl: number): number | null {
  if (!Number.isFinite(peakOpenPnl) || peakOpenPnl <= 0 || !Number.isFinite(pnl) || pnl <= 0) return null;
  return Math.max(0, Math.min(1, pnl / peakOpenPnl));
}

function riskMultiple(pnl: number, plannedRiskUsd: number | null): number | null {
  if (!plannedRiskUsd || plannedRiskUsd <= 0 || !Number.isFinite(pnl)) return null;
  return pnl / plannedRiskUsd;
}

export function classifyTradeReview(input: {
  pnl: number;
  peakOpenPnl: number;
  plannedRiskUsd: number | null;
  exitReason: NonNullable<Trade["exitReason"]>;
  thesisStatus?: OpenPosition["thesisStatus"] | null;
}): { outcome: TradeReviewOutcome; nextAction: TradeReviewRecord["nextAction"]; lesson: string } {
  const retained = retainedPeakPercent(input.pnl, input.peakOpenPnl);
  const rMultiple = riskMultiple(input.pnl, input.plannedRiskUsd);

  if (
    input.exitReason === "SIGNAL_REVERSAL" ||
    input.exitReason === "SIGNAL_INVALIDATION" ||
    input.thesisStatus === "OPPOSITE_EDGE_CONFIRMED"
  ) {
    return {
      outcome: "THESIS_FAILED",
      nextAction: input.pnl < 0 ? "REDUCE_SIZE" : "TIGHTEN_EXITS",
      lesson: "The live thesis changed before the original trade fully completed. Future trades in this setup should react faster to weakening or opposite evidence.",
    };
  }

  if (input.pnl < 0 && rMultiple !== null && rMultiple <= -1.1) {
    return {
      outcome: "RISK_BREACH",
      nextAction: "WATCH_ONLY",
      lesson: "The trade lost more than the planned risk budget. This asset/setup needs smaller size or stronger confirmation before the next entry.",
    };
  }

  if (input.pnl < 0) {
    return {
      outcome: "CONTROLLED_LOSS",
      nextAction: "REDUCE_SIZE",
      lesson: "The loss stayed inside the expected paper risk zone, but the setup still failed. Reduce confidence until similar entries recover.",
    };
  }

  if (input.exitReason === "TAKE_PROFIT" && (rMultiple === null || rMultiple >= 1.2)) {
    return {
      outcome: "STRONG_WIN",
      nextAction: "TRUST_MORE",
      lesson: "The setup reached target-quality profit. Similar future setups can keep normal sizing when data quality is still healthy.",
    };
  }

  if (input.exitReason === "TRAILING_STOP_PROFIT" || (retained !== null && retained >= 0.55)) {
    return {
      outcome: "PROFIT_PROTECTED",
      nextAction: "KEEP_NORMAL",
      lesson: "The bot protected a meaningful share of the open profit. Keep this exit behavior active for similar winners.",
    };
  }

  return {
    outcome: input.pnl > 0 ? "SMALL_WIN" : "UNKNOWN",
    nextAction: input.pnl > 0 ? "TIGHTEN_EXITS" : "KEEP_NORMAL",
    lesson: input.pnl > 0
      ? "The trade closed green but did not retain much open profit. Future winners should tighten exits sooner after momentum fades."
      : "The close did not provide enough evidence to adjust this setup yet.",
  };
}

function buildReview(trade: Trade, position: OpenPosition): TradeReviewRecord | null {
  if (typeof trade.pnl !== "number" || !trade.exitReason || !trade.exitPrice) return null;
  const pnl = Number(trade.pnl);
  const pnlPercent = Number(trade.pnlPercent || 0);
  const peakOpenPnl = Math.max(0, Number(position.maxUnrealizedPnlUsd || 0), pnl);
  const plannedRiskUsd = finiteOrNull(position.maxLossUsd);
  const retained = retainedPeakPercent(pnl, peakOpenPnl);
  const multiple = riskMultiple(pnl, plannedRiskUsd);
  const classification = classifyTradeReview({
    pnl,
    peakOpenPnl,
    plannedRiskUsd,
    exitReason: trade.exitReason,
    thesisStatus: position.thesisStatus,
  });

  return {
    id: `${trade.id}:review`,
    tradeId: trade.id,
    asset: trade.asset,
    direction: trade.direction || position.direction,
    entryTime: trade.entryTime || position.entryTime,
    exitTime: trade.exitTime || new Date().toISOString(),
    entryPrice: Number(trade.entryPrice || position.entryPrice),
    exitPrice: Number(trade.exitPrice),
    exitReason: trade.exitReason,
    pnl,
    pnlPercent,
    peakOpenPnl,
    retainedPeakPercent: retained,
    plannedRiskUsd,
    riskMultiple: multiple,
    finalConviction: finiteOrNull(trade.finalConviction ?? position.finalConviction),
    triggerScore: finiteOrNull(trade.triggerScore ?? position.triggerScore),
    dataQuality: finiteOrNull(trade.dataQuality ?? position.dataQuality),
    setupTags: Array.isArray(trade.setupTags) ? trade.setupTags.slice(0, 8) : [],
    thesisStatus: position.thesisStatus || null,
    thesisReason: position.thesisReason || null,
    ...classification,
    reviewedAt: new Date().toISOString(),
  };
}

function emptyDigest(): TradeReviewDigest {
  return {
    totalReviewed: 0,
    recentCount: 0,
    winRate: 0,
    avgPnl: 0,
    avgRetainedPeakPercent: null,
    byOutcome: {
      STRONG_WIN: 0,
      PROFIT_PROTECTED: 0,
      SMALL_WIN: 0,
      CONTROLLED_LOSS: 0,
      RISK_BREACH: 0,
      THESIS_FAILED: 0,
      UNKNOWN: 0,
    },
    watchOnlyAssets: [],
    trustMoreAssets: [],
    latestLessons: [],
    lastUpdated: null,
  };
}

function buildDigest(reviews: TradeReviewRecord[]): TradeReviewDigest {
  if (reviews.length === 0) return emptyDigest();

  const digest = emptyDigest();
  digest.totalReviewed = reviews.length;
  digest.recentCount = Math.min(30, reviews.length);
  let pnlSum = 0;
  let wins = 0;
  let retainedSum = 0;
  let retainedCount = 0;
  const watchOnly = new Map<string, number>();
  const trustMore = new Map<string, number>();

  for (const review of reviews) {
    digest.byOutcome[review.outcome] = (digest.byOutcome[review.outcome] || 0) + 1;
    pnlSum += review.pnl;
    if (review.pnl > 0) wins++;
    if (typeof review.retainedPeakPercent === "number") {
      retainedSum += review.retainedPeakPercent;
      retainedCount++;
    }
    if (review.nextAction === "WATCH_ONLY" || review.nextAction === "REDUCE_SIZE") {
      watchOnly.set(review.asset, (watchOnly.get(review.asset) || 0) + 1);
    }
    if (review.nextAction === "TRUST_MORE") {
      trustMore.set(review.asset, (trustMore.get(review.asset) || 0) + 1);
    }
  }

  digest.winRate = wins / reviews.length;
  digest.avgPnl = pnlSum / reviews.length;
  digest.avgRetainedPeakPercent = retainedCount > 0 ? retainedSum / retainedCount : null;
  digest.watchOnlyAssets = Array.from(watchOnly.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([asset]) => asset);
  digest.trustMoreAssets = Array.from(trustMore.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([asset]) => asset);
  digest.latestLessons = reviews.slice(0, 5).map((review) => ({
    asset: review.asset,
    outcome: review.outcome,
    pnl: review.pnl,
    lesson: review.lesson,
    reviewedAt: review.reviewedAt,
  }));
  digest.lastUpdated = reviews[0]?.reviewedAt || null;

  return digest;
}

function buildAssetSignals(reviews: TradeReviewRecord[]): TradeReviewAssetSignal[] {
  const grouped = new Map<string, TradeReviewRecord[]>();
  for (const review of reviews) {
    const existing = grouped.get(review.asset) || [];
    existing.push(review);
    grouped.set(review.asset, existing);
  }

  return Array.from(grouped.entries()).map(([asset, rows]) => {
    const recent = rows.slice(0, 12);
    const wins = recent.filter((review) => review.pnl > 0).length;
    const losses = recent.filter((review) => review.pnl < 0).length;
    const pnlSum = recent.reduce((sum, review) => sum + review.pnl, 0);
    const retainedRows = recent.filter((review) => typeof review.retainedPeakPercent === "number");
    const retainedSum = retainedRows.reduce((sum, review) => sum + Number(review.retainedPeakPercent || 0), 0);
    const protectedWins = recent.filter((review) => review.outcome === "PROFIT_PROTECTED" || review.outcome === "STRONG_WIN").length;
    const controlledLosses = recent.filter((review) => review.outcome === "CONTROLLED_LOSS").length;
    const riskBreaches = recent.filter((review) => review.outcome === "RISK_BREACH").length;
    const thesisFailures = recent.filter((review) => review.outcome === "THESIS_FAILED").length;
    const winRate = recent.length > 0 ? wins / recent.length : 0;
    const avgPnl = recent.length > 0 ? pnlSum / recent.length : 0;
    const avgRetainedPeakPercent = retainedRows.length > 0 ? retainedSum / retainedRows.length : null;

    let confidenceAdjustment = 0;
    let action: TradeReviewAssetSignal["action"] = "NEUTRAL";
    let message = `${asset} has too little reviewed exit evidence to change confidence.`;

    if (recent.length >= 4 && winRate >= 0.65 && avgPnl > 0 && protectedWins >= 2) {
      confidenceAdjustment = 3;
      action = "BOOST";
      message = `${asset} has recently protected profitable exits well. The bot can trust clean setups slightly more.`;
    }

    if (
      recent.length >= 3 &&
      (
        avgPnl < 0 ||
        riskBreaches > 0 ||
        thesisFailures >= 2 ||
        controlledLosses >= Math.max(2, Math.ceil(recent.length * 0.45))
      )
    ) {
      confidenceAdjustment = riskBreaches > 0 || avgPnl < -15 ? -8 : -5;
      action = "REDUCE";
      message = `${asset} has weak recent exit reviews. The bot should require stronger proof or smaller size.`;
    }

    return {
      asset,
      reviews: recent.length,
      wins,
      losses,
      winRate,
      avgPnl,
      avgRetainedPeakPercent,
      protectedWins,
      controlledLosses,
      riskBreaches,
      thesisFailures,
      confidenceAdjustment,
      action,
      message,
      updatedAt: recent[0]?.reviewedAt || new Date().toISOString(),
    };
  }).sort((a, b) => Math.abs(b.confidenceAdjustment) - Math.abs(a.confidenceAdjustment));
}

export class TradeReviewJournal {
  static async recordSwingClose(trade: Trade, position: OpenPosition): Promise<TradeReviewRecord | null> {
    const review = buildReview(trade, position);
    if (!review) return null;

    const redis = getRedis();
    await redis.lpush(REVIEW_KEY, JSON.stringify(review));
    await redis.ltrim(REVIEW_KEY, 0, MAX_REVIEWS - 1);
    const recent = await this.getRecent(MAX_REVIEWS);
    const digest = buildDigest(recent);
    await redis.set(DIGEST_KEY, digest);
    writeJsonBackup("trade_review_journal.json", recent.slice(0, 100));
    writeJsonBackup("trade_review_digest.json", digest);
    return review;
  }

  static async getRecent(limit = 20): Promise<TradeReviewRecord[]> {
    const redis = getRedis();
    const rows = await redis.lrange(REVIEW_KEY, 0, Math.max(0, limit - 1));
    return rows.map(parseReview).filter(Boolean) as TradeReviewRecord[];
  }

  static async getDigest(): Promise<TradeReviewDigest> {
    const redis = getRedis();
    const cached = await redis.get<TradeReviewDigest>(DIGEST_KEY);
    if (cached && typeof cached.totalReviewed === "number") return cached;
    const recent = await this.getRecent(MAX_REVIEWS);
    const digest = buildDigest(recent);
    if (recent.length > 0) await redis.set(DIGEST_KEY, digest);
    return digest;
  }

  static async getAssetSignals(limit = MAX_REVIEWS): Promise<TradeReviewAssetSignal[]> {
    const recent = await this.getRecent(limit);
    return buildAssetSignals(recent).filter((signal) => signal.action !== "NEUTRAL");
  }
}
