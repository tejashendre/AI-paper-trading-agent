import { buildMarketFrame } from "@/lib/data/freeDataMesh";
import { SUPPORTED_ASSETS } from "@/lib/market";
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
  updatedAt: string;
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
    updatedAt: new Date().toISOString(),
  };
}

function summarizeReport(asset: string, category: AssetFeedHealthSummary["category"], health: FeedHealthReport): AssetFeedHealthSummary {
  const mode = assetMode(asset, category, health);
  const safeForSwingExecution = health.status !== "BAD" && !health.stale && health.score >= 50;
  const safeForFastExecution = mode === "REALTIME_FAST" && health.status === "GOOD" && health.score >= 80 && !health.stale;

  return {
    asset,
    category,
    mode,
    status: health.status,
    score: health.score,
    source: health.primarySource,
    stale: health.stale,
    cacheAgeSeconds: health.cacheAgeSeconds,
    sourceAgreementPercent: Math.round(health.sourceAgreementScore * 1000) / 10,
    warnings: health.warnings.slice(0, 4),
    safeForFastExecution,
    safeForSwingExecution,
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
    const cacheKey = "feedHealth:matrix:15m";
    try {
      const cached = await redis.get<FeedHealthMatrix>(cacheKey);
      if (cached?.assets?.length) return cached;
    } catch {}

    const entries = Object.entries(SUPPORTED_ASSETS);
    const assets = await Promise.all(entries.map(async ([asset, config]) => {
      try {
        const frame = await buildMarketFrame(asset, "15m", 120, false);
        if (!frame) return fallbackReport(asset, config.category, "No market frame returned");
        return summarizeReport(asset, config.category, frame.feedHealth);
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
