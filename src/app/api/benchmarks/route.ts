import { NextResponse } from "next/server";
import { getRedis } from "@/lib/redis";
import { PortfolioManager } from "@/lib/portfolio";
import { markedEquity } from "@/lib/trading/markedEquity";
import { getAssetSpec } from "@/lib/trading/assetSpecs";
import { SUPPORTED_ASSETS } from "@/lib/market";
import { fetchTickers } from "@/lib/data/perpUniverse";
import { bookEquityUsd, loadBookPortfolio } from "@/lib/execution/bookRebalancer";
import {
  BASELINES_VERSION, DAY_MS, loadDailySeries, simulateBaselines, TREND_REGISTERED_AT_MS, trendForwardEvidence,
} from "@/lib/research/baselines";

export const dynamic = "force-dynamic";

/** The swing engine's tracking start (lifetimeStats.trackedSince 2026-08-26). */
const BENCHMARK_START_MS = Date.parse("2026-08-26T00:00:00Z");
const CACHE_KEY = `benchmarks:${BASELINES_VERSION}`;
const CACHE_SECONDS = 3_600;
/** 120-day lookback plus the 30-day volatility window, with margin. */
const HISTORY_DAYS = 160;

/** Does the bot beat doing something simple? Same start, same $10,000, net of the same costs. */
export async function GET() {
  try {
    const redis = getRedis();
    const cached = await redis.get<Record<string, unknown>>(CACHE_KEY).catch(() => null);
    const nowMs = Date.now();
    const baselines = cached ?? await (async () => {
      const series = await Promise.all(Object.entries(SUPPORTED_ASSETS).map(([asset, config]) =>
        loadDailySeries({ asset, symbol: config.bybitLinearSymbol, takerFeeRate: getAssetSpec(asset).takerFeeRate,
          fromMs: BENCHMARK_START_MS - HISTORY_DAYS * DAY_MS, nowMs })));
      const [hold, trend] = simulateBaselines({ series, startMs: BENCHMARK_START_MS, endMs: nowMs, capitalUsd: 10_000 });
      const evidence = trendForwardEvidence(trend);
      const summary = (b: typeof hold) => ({
        returnPercent: b.returnPercent, maxDrawdownPercent: b.maxDrawdownPercent, feesUsd: b.feesUsd, fundingUsd: b.fundingUsd,
        days: b.curve.length - 1, curve: b.curve,
      });
      const result = {
        version: BASELINES_VERSION,
        computedAt: new Date(nowMs).toISOString(),
        startAt: new Date(BENCHMARK_START_MS).toISOString(),
        equalWeightHold: summary(hold),
        trendDaily: { ...summary(trend), mode: "SHADOW", registeredAt: new Date(TREND_REGISTERED_AT_MS).toISOString(), forwardEvidence: evidence },
      };
      await redis.set(CACHE_KEY, result, { ex: CACHE_SECONDS }).catch(() => undefined);
      return result;
    })();

    const [swing, book, prices] = await Promise.all([
      PortfolioManager.getPortfolio("ai"),
      loadBookPortfolio(),
      fetchTickers().catch(() => new Map()),
    ]);
    const swingEquity = markedEquity(swing);
    const bookEquity = bookEquityUsd(book, prices);
    return NextResponse.json({
      ...baselines,
      bot: {
        swingReturnPercent: swing.initialCapital > 0 ? (swingEquity / swing.initialCapital - 1) * 100 : null,
        crossSectionalReturnPercent: book.initialCapitalUsd > 0 ? (bookEquity / book.initialCapitalUsd - 1) * 100 : null,
      },
      note: "Baselines are hypothetical, recomputed from Bybit daily closes and funding, net of taker fees. They hold no capital.",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Benchmarks unavailable" }, { status: 500 });
  }
}
