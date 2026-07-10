import { Trade } from "@/lib/types";

type PerformanceSide = "trade" | "opportunity";

export interface SetupPerformanceBucket {
  key: string;
  label: string;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  avgPnl: number;
  opportunityCount: number;
  favorableOpportunities: number;
  opportunityFavorableRate: number;
  avgOpportunityMove: number;
  avgOpportunityNetPnlUsd: number;
  avgOpportunityNetReturnPercent: number;
  opportunityProfitFactor: number | null;
  confidenceAdjustment: number;
  evidence: PerformanceSide[];
}

export interface SetupPerformanceSummary {
  generatedAt: string;
  closedTradeCount: number;
  taggedTradeCount: number;
  setupCount: number;
  assetCount: number;
  bySetup: SetupPerformanceBucket[];
  byAsset: SetupPerformanceBucket[];
  bestSetup: SetupPerformanceBucket | null;
  worstSetup: SetupPerformanceBucket | null;
  plainFindings: string[];
}

interface MutableBucket extends Omit<SetupPerformanceBucket, "winRate" | "profitFactor" | "avgPnl" | "opportunityFavorableRate" | "avgOpportunityNetPnlUsd" | "avgOpportunityNetReturnPercent" | "opportunityProfitFactor" | "evidence"> {
  grossOpportunityProfitUsd: number;
  grossOpportunityLossUsd: number;
  opportunityNetPnlTotalUsd: number;
  opportunityNetReturnTotalPercent: number;
  evidence: Set<PerformanceSide>;
}

function emptyBucket(key: string): MutableBucket {
  return {
    key,
    label: humanLabel(key),
    tradeCount: 0,
    wins: 0,
    losses: 0,
    realizedPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    opportunityCount: 0,
    favorableOpportunities: 0,
    avgOpportunityMove: 0,
    grossOpportunityProfitUsd: 0,
    grossOpportunityLossUsd: 0,
    opportunityNetPnlTotalUsd: 0,
    opportunityNetReturnTotalPercent: 0,
    confidenceAdjustment: 0,
    evidence: new Set(),
  };
}

function humanLabel(key: string) {
  return key
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function normalizeSetupTags(tags?: string[], includeUntagged = false) {
  const normalized = new Set<string>();

  for (const tag of tags || []) {
    const upper = String(tag).toUpperCase();
    if (upper.includes("VWAP_RECLAIM") || upper.includes("OVERSOLD")) normalized.add("VWAP_RECLAIM");
    if (upper.includes("VWAP_REJECTION") || upper.includes("OVERBOUGHT")) normalized.add("VWAP_REJECTION");
    if (upper.includes("VOLUME_BURST")) normalized.add("VOLUME_BURST");
    if (upper.includes("VOLATILITY_EXPANSION")) normalized.add("VOLATILITY_EXPANSION");
    if (upper.includes("LIVE_BREAK") || upper.includes("MOMENTUM_CONTINUATION")) normalized.add("MOMENTUM_CONTINUATION");
    if (upper.includes("SQUEEZE")) normalized.add("SQUEEZE_BREAKOUT");
    if (upper.includes("STRUCTURAL") || upper.includes("HTF_TREND_BREAKOUT")) normalized.add("HTF_TREND_BREAKOUT");
    if (upper.includes("Z-SCORE") || upper.includes("MEAN_REVERSION_EXTREME")) normalized.add("MEAN_REVERSION_EXTREME");
    if (upper.includes("DATA")) normalized.add("DATA_QUALITY");
  }

  return normalized.size > 0 ? Array.from(normalized) : includeUntagged ? ["UNTAGGED"] : [];
}

function addTrade(bucket: MutableBucket, trade: Trade) {
  const pnl = Number(trade.pnl || 0);
  bucket.tradeCount++;
  bucket.realizedPnl += pnl;
  bucket.evidence.add("trade");

  if (pnl >= 0) {
    bucket.wins++;
    bucket.grossProfit += pnl;
  } else {
    bucket.losses++;
    bucket.grossLoss += Math.abs(pnl);
  }
}

function addOpportunity(bucket: MutableBucket, stats: { total?: number; favorable?: number; avgMove?: number; avgNetPnlUsd?: number; avgNetReturnPercent?: number; grossProfitUsd?: number; grossLossUsd?: number }) {
  const total = Number(stats.total || 0);
  const favorable = Number(stats.favorable || 0);
  const avgMove = Number(stats.avgMove || 0);
  const avgNetPnlUsd = Number.isFinite(Number(stats.avgNetPnlUsd)) ? Number(stats.avgNetPnlUsd) : avgMove;
  const avgNetReturnPercent = Number.isFinite(Number(stats.avgNetReturnPercent)) ? Number(stats.avgNetReturnPercent) : avgMove;

  bucket.opportunityCount += total;
  bucket.favorableOpportunities += favorable;
  bucket.avgOpportunityMove += avgMove * total;
  bucket.opportunityNetPnlTotalUsd += avgNetPnlUsd * total;
  bucket.opportunityNetReturnTotalPercent += avgNetReturnPercent * total;
  bucket.grossOpportunityProfitUsd += Number(stats.grossProfitUsd || 0);
  bucket.grossOpportunityLossUsd += Number(stats.grossLossUsd || 0);
  bucket.evidence.add("opportunity");
}

function finalize(bucket: MutableBucket): SetupPerformanceBucket {
  const winRate = bucket.tradeCount > 0 ? bucket.wins / bucket.tradeCount : 0;
  const avgPnl = bucket.tradeCount > 0 ? bucket.realizedPnl / bucket.tradeCount : 0;
  const profitFactor = bucket.grossLoss > 0
    ? bucket.grossProfit / bucket.grossLoss
    : bucket.grossProfit > 0
      ? null
      : 0;
  const opportunityFavorableRate = bucket.opportunityCount > 0 ? bucket.favorableOpportunities / bucket.opportunityCount : 0;
  const avgOpportunityMove = bucket.opportunityCount > 0 ? bucket.avgOpportunityMove / bucket.opportunityCount : 0;
  const avgOpportunityNetPnlUsd = bucket.opportunityCount > 0 ? bucket.opportunityNetPnlTotalUsd / bucket.opportunityCount : 0;
  const avgOpportunityNetReturnPercent = bucket.opportunityCount > 0 ? bucket.opportunityNetReturnTotalPercent / bucket.opportunityCount : 0;
  const opportunityProfitFactor = bucket.grossOpportunityLossUsd > 0
    ? bucket.grossOpportunityProfitUsd / bucket.grossOpportunityLossUsd
    : bucket.grossOpportunityProfitUsd > 0
      ? null
      : 0;

  let confidenceAdjustment = 0;
  if (bucket.tradeCount >= 3 && winRate >= 0.6 && avgPnl > 0) confidenceAdjustment += 5;
  if (bucket.tradeCount >= 3 && (winRate <= 0.35 || avgPnl < 0)) confidenceAdjustment -= 8;
  if (bucket.opportunityCount >= 6 && opportunityFavorableRate >= 0.62 && avgOpportunityNetPnlUsd > 0) confidenceAdjustment += 3;
  if (bucket.opportunityCount >= 6 && (opportunityFavorableRate <= 0.35 || avgOpportunityNetPnlUsd < 0)) confidenceAdjustment -= 4;

  return {
    ...bucket,
    winRate,
    profitFactor,
    avgPnl,
    opportunityFavorableRate,
    avgOpportunityMove,
    avgOpportunityNetPnlUsd,
    avgOpportunityNetReturnPercent,
    opportunityProfitFactor,
    confidenceAdjustment,
    evidence: Array.from(bucket.evidence),
  };
}

function upsert(map: Map<string, MutableBucket>, key: string) {
  const existing = map.get(key);
  if (existing) return existing;
  const created = emptyBucket(key);
  map.set(key, created);
  return created;
}

function sortBuckets(buckets: SetupPerformanceBucket[]) {
  return buckets.sort((a, b) => {
    const scoreA = a.realizedPnl + a.avgOpportunityNetPnlUsd * Math.min(a.opportunityCount, 20);
    const scoreB = b.realizedPnl + b.avgOpportunityNetPnlUsd * Math.min(b.opportunityCount, 20);
    return scoreB - scoreA;
  });
}

function buildFindings(summary: Omit<SetupPerformanceSummary, "plainFindings">) {
  const findings: string[] = [];
  if (summary.closedTradeCount === 0) {
    findings.push("No closed tagged AI trades yet, so the system is learning mostly from watched opportunities.");
  }
  if (summary.bestSetup) {
    findings.push(`${summary.bestSetup.label} is currently the strongest observed setup.`);
  }
  if (summary.worstSetup && summary.worstSetup.key !== summary.bestSetup?.key) {
    findings.push(`${summary.worstSetup.label} needs caution until more evidence improves.`);
  }
  if (summary.bySetup.some((bucket) => bucket.opportunityCount > 0 && bucket.tradeCount === 0)) {
    findings.push("Some patterns have opportunity evidence but no closed trades yet; treat them as early signals, not proven edge.");
  }
  return findings.slice(0, 4);
}

export class SetupPerformance {
  static build(aiTrades: Trade[], opportunitySummary: any): SetupPerformanceSummary {
    const bySetup = new Map<string, MutableBucket>();
    const byAsset = new Map<string, MutableBucket>();
    const closedTrades = aiTrades.filter((trade) => typeof trade.pnl === "number" && !trade.isPartialExit);
    let taggedTradeCount = 0;

    for (const trade of closedTrades) {
      const setupTags = normalizeSetupTags(trade.setupTags, true);
      if (setupTags.some((tag) => tag !== "UNTAGGED")) taggedTradeCount++;

      for (const tag of setupTags) {
        addTrade(upsert(bySetup, tag), trade);
      }
      addTrade(upsert(byAsset, trade.asset || "UNKNOWN"), trade);
    }

    for (const [asset, stats] of Object.entries(opportunitySummary?.byAsset || {}) as Array<[string, any]>) {
      addOpportunity(upsert(byAsset, asset), stats);
    }

    for (const [setup, stats] of Object.entries(opportunitySummary?.bySetup || {}) as Array<[string, any]>) {
      // Unknown diagnostics (for example STRUCTURE_ALIGNED or sensor-online
      // tags) are not setups. Pooling every unknown key into UNTAGGED counted
      // one market observation many times and polluted learning confidence.
      for (const tag of normalizeSetupTags([setup])) {
        addOpportunity(upsert(bySetup, tag), stats);
      }
    }

    const setupBuckets = sortBuckets(Array.from(bySetup.values()).map(finalize));
    const assetBuckets = sortBuckets(Array.from(byAsset.values()).map(finalize));
    const bucketsWithEvidence = setupBuckets.filter((bucket) => bucket.tradeCount > 0 || bucket.opportunityCount > 0);
    const bestSetup = bucketsWithEvidence[0] || null;
    const worstSetup = bucketsWithEvidence.length > 1
      ? [...bucketsWithEvidence].sort((a, b) => (a.realizedPnl + a.avgOpportunityNetPnlUsd) - (b.realizedPnl + b.avgOpportunityNetPnlUsd))[0]
      : null;

    const summaryWithoutFindings = {
      generatedAt: new Date().toISOString(),
      closedTradeCount: closedTrades.length,
      taggedTradeCount,
      setupCount: setupBuckets.length,
      assetCount: assetBuckets.length,
      bySetup: setupBuckets,
      byAsset: assetBuckets,
      bestSetup,
      worstSetup,
    };

    return {
      ...summaryWithoutFindings,
      plainFindings: buildFindings(summaryWithoutFindings),
    };
  }
}
