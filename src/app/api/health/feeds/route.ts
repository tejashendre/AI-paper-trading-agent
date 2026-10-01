import { NextResponse } from "next/server";
import { FeedHealthSummary } from "@/lib/data/feedHealthSummary";
import { primaryMarketDataProvider, SUPPORTED_ASSETS } from "@/lib/market";

export const dynamic = "force-dynamic";

/**
 * Are the upstream market data feeds working, for every asset class?
 *
 * This question was previously only answerable by signing in: the feed health
 * matrix was computed on every dashboard load but returned inside
 * `/api/user/status`, which is auth-gated. The owner could therefore see the
 * portfolio without being able to check whether the data behind it was
 * arriving, which is the wrong way round — a stale feed silently stops an
 * asset trading, and nothing about the portfolio view reveals that.
 *
 * The payload carries feed status only: which upstream serves each asset, how
 * old its data is, and whether it passes the entry data gate. No positions,
 * balances, trades or account identifiers, so it is safe to serve publicly
 * alongside the other spectator endpoints.
 */
export async function GET() {
  try {
    const matrix = await FeedHealthSummary.build();

    // Data readiness only. A ready feed does not mean the asset will trade:
    // strategy, cost and risk checks are separate and can still veto.
    const byCategory: Record<string, { total: number; dataReady: number; assets: string[] }> = {};
    for (const row of matrix.assets) {
      const bucket = (byCategory[row.category] ??= { total: 0, dataReady: 0, assets: [] });
      bucket.total += 1;
      if (row.dataEligibility.allowed) bucket.dataReady += 1;
      else bucket.assets.push(row.asset);
    }

    // The upstream each asset depends on, derived from the router rather than
    // restated here. Every asset is one Bybit perpetual; the stream and REST
    // are two transports of that one venue, not independent sources.
    const feeds = Object.entries(SUPPORTED_ASSETS).map(([asset, config]) => ({
      asset,
      category: config.category,
      provider: primaryMarketDataProvider(asset),
      upstream: "Bybit linear perpetuals",
      instrument: config.bybitLinearSymbol,
      streamsLive: true,
      independentVenues: 1,
    }));

    const blocked = matrix.assets.filter((a) => !a.dataEligibility.allowed);
    const firstCode = (row: (typeof matrix.assets)[number]) => row.dataEligibility.reasons[0]?.split(":")[0] ?? row.dataEligibility.state;
    const plain = (blocked.length === 0
      ? `All ${matrix.assets.length} assets have entry-ready data.`
      : `${matrix.assets.length - blocked.length} of ${matrix.assets.length} assets have entry-ready data. ` +
        `Held back: ${blocked.map((a) => `${a.asset} (${firstCode(a)})`).join(", ")}.`) +
      " This covers data only; strategy, cost and risk checks still decide whether a trade happens.";

    return NextResponse.json({
      plainEnglish: plain,
      dataReadyNow: matrix.assets.length - blocked.length,
      totalAssets: matrix.assets.length,
      byCategory,
      feeds,
      matrix,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read feed health" },
      { status: 500 }
    );
  }
}
