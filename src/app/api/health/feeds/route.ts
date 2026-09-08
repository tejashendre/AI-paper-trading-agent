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
 * old its data is, and whether that is fresh enough to trade on. No positions,
 * balances, trades or account identifiers, so it is safe to serve publicly
 * alongside the other spectator endpoints.
 */
export async function GET() {
  try {
    const matrix = await FeedHealthSummary.build();

    const byCategory: Record<string, { total: number; tradeable: number; assets: string[] }> = {};
    for (const row of matrix.assets) {
      const bucket = (byCategory[row.category] ??= { total: 0, tradeable: 0, assets: [] });
      bucket.total += 1;
      if (row.safeForSwingExecution) bucket.tradeable += 1;
      else bucket.assets.push(row.asset);
    }

    // The upstream each asset class depends on, so a reader can tell at a
    // glance whether a problem is one asset or one provider having an outage.
    // Derived from the router rather than restated here, so this can never
    // drift from where the data actually comes from. It said "Yahoo" for the
    // FX pairs for one deploy after they moved to Kraken, which is exactly the
    // kind of quiet inaccuracy this endpoint exists to prevent.
    const UPSTREAM_LABEL: Record<string, string> = {
      BYBIT_LINEAR: "Bybit linear perpetuals",
      KRAKEN: "Kraken spot",
      YAHOO: "Yahoo Finance",
    };
    const feeds = Object.entries(SUPPORTED_ASSETS).map(([asset, config]) => {
      const provider = primaryMarketDataProvider(asset);
      const instrument = provider === "BYBIT_LINEAR"
        ? config.bybitLinearSymbol
        : provider === "KRAKEN"
          ? config.krakenPair
          : config.yahooTicker;
      return {
        asset,
        category: config.category,
        provider,
        upstream: UPSTREAM_LABEL[provider] ?? provider,
        instrument,
        streamsLive: Boolean(config.bybitLinearSymbol || config.krakenWsSymbol),
      };
    });

    const blocked = matrix.assets.filter((a) => !a.safeForSwingExecution);
    const plain = blocked.length === 0
      ? `All ${matrix.assets.length} assets have fresh data and can trade.`
      : `${matrix.assets.length - blocked.length} of ${matrix.assets.length} assets can trade. ` +
        `${blocked.map((a) => a.asset).join(", ")} ${blocked.length === 1 ? "is" : "are"} held back because ` +
        `${blocked.length === 1 ? "its" : "their"} data feed is stale. The bot refuses to trade on stale ` +
        `prices rather than guessing, so this stops trades rather than causing bad ones.`;

    return NextResponse.json({
      plainEnglish: plain,
      tradeableNow: matrix.assets.length - blocked.length,
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
