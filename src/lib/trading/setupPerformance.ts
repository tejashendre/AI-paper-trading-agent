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
  outOfSampleTradeCount: number;
  outOfSampleWinRate: number;
  outOfSampleProfitFactor: number | null;
  outOfSampleAvgPnl: number;
  promotionEligible: boolean;
  quarantined: boolean;
  requalificationEligible: boolean;
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

export interface SetupPerformanceBuildOptions {
  strategyVersion?: string;
}

interface MutableBucket extends Omit<SetupPerformanceBucket, "winRate" | "profitFactor" | "avgPnl" | "outOfSampleTradeCount" | "outOfSampleWinRate" | "outOfSampleProfitFactor" | "outOfSampleAvgPnl" | "promotionEligible" | "quarantined" | "requalificationEligible" | "opportunityFavorableRate" | "avgOpportunityNetPnlUsd" | "avgOpportunityNetReturnPercent" | "opportunityProfitFactor" | "evidence"> {
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
  if (bucket.tradeCount >= 3 && (winRate <= 0.35 || avgPnl < 0)) confidenceAdjustment -= 8;
  if (bucket.opportunityCount >= 6 && (opportunityFavorableRate <= 0.35 || avgOpportunityNetPnlUsd < 0)) confidenceAdjustment -= 4;

  return {
    ...bucket,
    winRate,
    profitFactor,
    avgPnl,
    outOfSampleTradeCount: 0,
    outOfSampleWinRate: 0,
    outOfSampleProfitFactor: null,
    outOfSampleAvgPnl: 0,
    promotionEligible: false,
    quarantined: false,
    requalificationEligible: false,
    opportunityFavorableRate,
    avgOpportunityMove,
    avgOpportunityNetPnlUsd,
    avgOpportunityNetReturnPercent,
    opportunityProfitFactor,
    confidenceAdjustment,
    evidence: Array.from(bucket.evidence),
  };
}

function enrichWithOutOfSampleEvidence(bucket: SetupPerformanceBucket, holdoutTrades: Trade[] = []): SetupPerformanceBucket {
  const wins = holdoutTrades.filter((trade) => Number(trade.pnl || 0) >= 0);
  const losses = holdoutTrades.filter((trade) => Number(trade.pnl || 0) < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.abs(Number(trade.pnl || 0)), 0);
  const outOfSampleTradeCount = holdoutTrades.length;
  const outOfSampleWinRate = outOfSampleTradeCount > 0 ? wins.length / outOfSampleTradeCount : 0;
  const outOfSampleAvgPnl = outOfSampleTradeCount > 0
    ? holdoutTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0) / outOfSampleTradeCount
    : 0;
  const outOfSampleProfitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0
      ? null
      : 0;

  // A setup is promoted only after it has survived a later chronological
  // sample of real closed trades. Watched opportunities can reduce trust, but
  // cannot create an unearned size boost.
  const promotionEligible = (
    outOfSampleTradeCount >= 8 &&
    outOfSampleWinRate >= 0.55 &&
    outOfSampleAvgPnl > 0 &&
    (outOfSampleProfitFactor === null || outOfSampleProfitFactor >= 1.15)
  );
  const failedHoldout = (
    outOfSampleTradeCount >= 12 &&
    outOfSampleAvgPnl < 0 &&
    outOfSampleProfitFactor !== null &&
    outOfSampleProfitFactor < 0.85
  );
  const requalificationEligible = (
    bucket.opportunityCount >= 20 &&
    bucket.opportunityFavorableRate >= 0.6 &&
    bucket.avgOpportunityNetPnlUsd > 0 &&
    (bucket.opportunityProfitFactor === null || bucket.opportunityProfitFactor >= 1.15)
  );
  const quarantined = failedHoldout && !requalificationEligible;
  const outOfSampleWarning = (
    outOfSampleTradeCount >= 8 &&
    outOfSampleAvgPnl < 0 &&
    outOfSampleProfitFactor !== null &&
    outOfSampleProfitFactor < 1
  );
  const holdoutAdjustment = quarantined ? -12 : outOfSampleWarning ? -4 : promotionEligible ? 4 : 0;

  return {
    ...bucket,
    outOfSampleTradeCount,
    outOfSampleWinRate,
    outOfSampleProfitFactor,
    outOfSampleAvgPnl,
    promotionEligible,
    quarantined,
    requalificationEligible,
    confidenceAdjustment: quarantined
      ? -12
      : failedHoldout
        ? Math.min(-8, bucket.confidenceAdjustment + holdoutAdjustment)
        : Math.max(-12, Math.min(8, bucket.confidenceAdjustment + holdoutAdjustment)),
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
    findings.push(summary.bestSetup.promotionEligible
      ? `${summary.bestSetup.label} is currently the strongest independently validated setup.`
      : `${summary.bestSetup.label} is currently the strongest observed setup, but it has not earned a size boost yet.`);
  }
  if (summary.worstSetup && summary.worstSetup.key !== summary.bestSetup?.key) {
    findings.push(`${summary.worstSetup.label} needs caution until more evidence improves.`);
  }
  const quarantinedCount = summary.bySetup.filter((bucket) => bucket.quarantined).length;
  if (quarantinedCount > 0) {
    findings.push(`${quarantinedCount} setup${quarantinedCount === 1 ? " is" : "s are"} quarantined after failing later chronological expectancy checks.`);
  }
  if (summary.bySetup.some((bucket) => bucket.opportunityCount > 0 && bucket.tradeCount === 0)) {
    findings.push("Some patterns have opportunity evidence but no closed trades yet; treat them as early signals, not proven edge.");
  }
  return findings.slice(0, 4);
}

export class SetupPerformance {
  static build(
    aiTrades: Trade[],
    opportunitySummary: any,
    options: SetupPerformanceBuildOptions = {}
  ): SetupPerformanceSummary {
    const bySetup = new Map<string, MutableBucket>();
    const byAsset = new Map<string, MutableBucket>();
    const strategyTrades = options.strategyVersion
      ? aiTrades.filter((trade) => trade.strategyVersion === options.strategyVersion)
      : aiTrades;
    const closedTrades = strategyTrades.filter((trade) => typeof trade.pnl === "number" && !trade.isPartialExit);
    const chronologicalClosedTrades = [...closedTrades].sort((a, b) => (
      new Date(a.exitTime || a.timestamp).getTime() - new Date(b.exitTime || b.timestamp).getTime()
    ));
    const holdoutStart = Math.max(0, Math.floor(chronologicalClosedTrades.length * 0.7));
    const holdoutIds = new Set(chronologicalClosedTrades.slice(holdoutStart).map((trade) => trade.id));
    const holdoutBySetup = new Map<string, Trade[]>();
    const holdoutByAsset = new Map<string, Trade[]>();
    let taggedTradeCount = 0;

    for (const trade of closedTrades) {
      const setupTags = normalizeSetupTags(trade.setupTags, true);
      if (setupTags.some((tag) => tag !== "UNTAGGED")) taggedTradeCount++;

      for (const tag of setupTags) {
        addTrade(upsert(bySetup, tag), trade);
        if (holdoutIds.has(trade.id)) {
          const values = holdoutBySetup.get(tag) || [];
          values.push(trade);
          holdoutBySetup.set(tag, values);
        }
      }
      // Every closed position changes capital. Probe size may reduce PnL, but
      // excluding probe outcomes from asset expectancy allowed repeated probe
      // losses to bypass the asset-level safety model entirely.
      addTrade(upsert(byAsset, trade.asset || "UNKNOWN"), trade);
      if (holdoutIds.has(trade.id)) {
        const assetKey = trade.asset || "UNKNOWN";
        const values = holdoutByAsset.get(assetKey) || [];
        values.push(trade);
        holdoutByAsset.set(assetKey, values);
      }
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

    const setupBuckets = sortBuckets(Array.from(bySetup.values()).map((bucket) => (
      enrichWithOutOfSampleEvidence(finalize(bucket), holdoutBySetup.get(bucket.key))
    )));
    const assetBuckets = sortBuckets(Array.from(byAsset.values()).map((bucket) => (
      enrichWithOutOfSampleEvidence(finalize(bucket), holdoutByAsset.get(bucket.key))
    )));
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
