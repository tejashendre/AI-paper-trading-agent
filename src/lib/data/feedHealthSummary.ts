import { buildMarketFrame } from "@/lib/data/freeDataMesh";
import { closedCandles, entryInstrumentFor, liveQuoteKey, MarketService, SUPPORTED_ASSETS } from "@/lib/market";
import { evaluateEntryEligibility, EntryEligibility } from "@/lib/trading/entryEligibility";
import type { BybitTickerState } from "@/lib/data/bybitPublic";
import { getRedis } from "@/lib/redis";
import type { FeedHealthReport } from "@/lib/types";

export type AssetDataMode = "REALTIME_FAST" | "SLOW_SWING" | "DISABLED";

export interface AssetFeedHealthSummary {
  asset: string;
  category: "crypto" | "forex" | "commodity";
  mode: AssetDataMode;
  status: "GOOD" | "DEGRADED" | "BAD";
  score: number;
  source: string;
  stale: boolean;
  cacheAgeSeconds: number;
  sourceAgreementPercent: number;
  warnings: string[];
  safeForFastExecution: boolean;
  safeForSwingExecution: boolean;
  /** Fresh Bybit stream transports for this asset: 0 or 1. */
  freshWebsocketSources: number;
  /** Every asset is priced by one venue; stream and REST are its two transports. */
  independentVenues: 1;
  /**
   * The same data-eligibility decision the daemon applies to a new entry.
   * Data only: strategy, cost and risk checks still decide whether a trade happens.
   */
  dataEligibility: Pick<EntryEligibility, "allowed" | "state" | "reasons"> & { quoteEventTimeMs?: number | null };
  updatedAt: string;
}

const WEBSOCKET_FRESHNESS_MS = 45_000;

/** 1 when the Bybit stream delivered this asset's last price recently, else 0. */
async function freshWebsocketSourceCount(redis: ReturnType<typeof getRedis>, asset: string) {
  const state = await redis.get<BybitTickerState>(liveQuoteKey(asset)).catch(() => null);
  const lastPriceAt = Number(state?.lastPriceEventMs);
  return Number.isFinite(lastPriceAt) && Date.now() - lastPriceAt <= WEBSOCKET_FRESHNESS_MS ? 1 : 0;
}

export interface FeedHealthMatrix {
  generatedAt: string;
  timeframe: "15m";
  assets: AssetFeedHealthSummary[];
  summary: {
    good: number;
    degraded: number;
    bad: number;
    fastEligible: number;
    swingEligible: number;
  };
  plainFindings: string[];
}

/**
 * Which treatment an asset qualifies for. The fast tier remains a crypto
 * strategy choice; data policy is the same single venue for every asset.
 */
function assetMode(asset: string, category: AssetFeedHealthSummary["category"], health?: FeedHealthReport | null): AssetDataMode {
  if (health?.status === "BAD") return "DISABLED";
  if (category === "crypto" && ["BTC", "ETH", "SOL"].includes(asset)) return "REALTIME_FAST";
  return "SLOW_SWING";
}

function fallbackReport(asset: string, category: AssetFeedHealthSummary["category"], error: unknown): AssetFeedHealthSummary {
  const message = error instanceof Error ? error.message : String(error);
  return {
    asset,
    category,
    mode: "DISABLED",
    status: "BAD",
    score: 0,
    source: "UNAVAILABLE",
    stale: true,
    cacheAgeSeconds: 0,
    sourceAgreementPercent: 0,
    warnings: [`Feed health unavailable: ${message}`],
    safeForFastExecution: false,
    safeForSwingExecution: false,
    freshWebsocketSources: 0,
    independentVenues: 1,
    dataEligibility: { allowed: false, state: "BLOCKED_DATA", reasons: [`FEED_UNAVAILABLE: ${message}`] },
    updatedAt: new Date().toISOString(),
  };
}

/** The entry data decision, built from the same inputs the daemon uses. */
async function dataEligibilityFor(asset: string): Promise<AssetFeedHealthSummary["dataEligibility"]> {
  const [quote, metadata, m15, h1, h4, w1] = await Promise.all([
    MarketService.getCurrentPriceSnapshot(asset).catch(() => null),
    MarketService.getInstrumentMetadata(asset).catch(() => null),
    MarketService.getCandles("15m", 101, asset).catch(() => []),
    MarketService.getCandles("1h", 101, asset).catch(() => []),
    MarketService.getCandles("4h", 100, asset).catch(() => []),
    MarketService.getWeeklyCandles(20, asset).catch(() => []),
  ]);
  const nowMs = Date.now();
  const referenceMs = quote?.eventTimeMs ?? nowMs;
  const { allowed, state, reasons } = evaluateEntryEligibility({
    instrument: entryInstrumentFor(asset),
    metadata,
    quote,
    closedBarCounts: {
      m15: closedCandles(m15, "15m", referenceMs).length,
      h1: closedCandles(h1, "1h", referenceMs).length,
      h4: closedCandles(h4, "4h", referenceMs).length,
      w1: closedCandles(w1, "1w", referenceMs).length,
    },
    nowMs,
    fastExecution: false,
    depthAvailable: true,
  });
  return { allowed, state, reasons, quoteEventTimeMs: quote?.eventTimeMs ?? null };
}

function summarizeReport(
  asset: string,
  category: AssetFeedHealthSummary["category"],
  health: FeedHealthReport,
  freshWebsocketSources: number,
  dataEligibility: AssetFeedHealthSummary["dataEligibility"]
): AssetFeedHealthSummary {
  const mode = assetMode(asset, category, health);
  // Single-venue policy: a swing entry may use a fresh REST quote, so a quiet
  // or dropped stream degrades only the fast tier, which needs the stream.
  const streamMissing = mode === "REALTIME_FAST" && freshWebsocketSources === 0;
  const displayStatus = (health.stale || streamMissing) && health.status === "GOOD" ? "DEGRADED" : health.status;
  const warnings = health.warnings.slice(0, 4);
  if (streamMissing) warnings.unshift("Bybit stream quote is not fresh; swing entries use REST quotes and fast entries wait");
  const score = streamMissing ? Math.min(health.score, 75) : health.score;
  const safeForSwingExecution = health.status !== "BAD" && !health.stale && score >= 50;
  const safeForFastExecution = mode === "REALTIME_FAST" && freshWebsocketSources >= 1 && displayStatus === "GOOD" && score >= 80 && !health.stale;

  return {
    asset,
    category,
    mode,
    status: displayStatus,
    score,
    source: health.primarySource,
    stale: health.stale,
    cacheAgeSeconds: health.cacheAgeSeconds,
    sourceAgreementPercent: Math.round(health.sourceAgreementScore * 1000) / 10,
    warnings: warnings.slice(0, 4),
    safeForFastExecution,
    safeForSwingExecution,
    freshWebsocketSources,
    independentVenues: 1,
    dataEligibility,
    updatedAt: health.lastUpdated,
  };
}

function buildFindings(assets: AssetFeedHealthSummary[]) {
  const findings: string[] = [];
  const bad = assets.filter((asset) => asset.status === "BAD");
  const degraded = assets.filter((asset) => asset.status === "DEGRADED");
  const fast = assets.filter((asset) => asset.safeForFastExecution);

  if (fast.length > 0) {
    findings.push(`${fast.map((asset) => asset.asset).join(", ")} can use the fastest free-data treatment right now.`);
  }
  if (degraded.length > 0) {
    findings.push(`${degraded.map((asset) => asset.asset).join(", ")} should be treated carefully until data quality improves.`);
  }
  if (bad.length > 0) {
    findings.push(`${bad.map((asset) => asset.asset).join(", ")} should not receive new autonomous entries while data health is bad.`);
  }
  if (findings.length === 0) {
    findings.push("All tracked feeds are currently acceptable for their intended trading mode.");
  }

  return findings.slice(0, 4);
}

export class FeedHealthSummary {
  static async build(): Promise<FeedHealthMatrix> {
    const redis = getRedis();
    // Versioned: the row shape changed when data eligibility was added.
    const cacheKey = "feedHealth:matrix:v2:15m";
    try {
      const cached = await redis.get<FeedHealthMatrix>(cacheKey);
      if (cached?.assets?.length) return cached;
    } catch {}

    const entries = Object.entries(SUPPORTED_ASSETS);
    const assets = await Promise.all(entries.map(async ([asset, config]) => {
      try {
        const frame = await buildMarketFrame(asset, "15m", 120, false);
        if (!frame) return fallbackReport(asset, config.category, "No market frame returned");
        // Every configured asset streams from Bybit.
        const [websocketSources, eligibility] = await Promise.all([
          freshWebsocketSourceCount(redis, asset),
          dataEligibilityFor(asset),
        ]);
        return summarizeReport(asset, config.category, frame.feedHealth, websocketSources, eligibility);
      } catch (error) {
        return fallbackReport(asset, config.category, error);
      }
    }));

    const summary = {
      good: assets.filter((asset) => asset.status === "GOOD").length,
      degraded: assets.filter((asset) => asset.status === "DEGRADED").length,
      bad: assets.filter((asset) => asset.status === "BAD").length,
      fastEligible: assets.filter((asset) => asset.safeForFastExecution).length,
      swingEligible: assets.filter((asset) => asset.safeForSwingExecution).length,
    };

    const matrix: FeedHealthMatrix = {
      generatedAt: new Date().toISOString(),
      timeframe: "15m",
      assets,
      summary,
      plainFindings: buildFindings(assets),
    };

    try {
      await redis.set(cacheKey, matrix, { ex: 60 });
    } catch {}

    return matrix;
  }
}
