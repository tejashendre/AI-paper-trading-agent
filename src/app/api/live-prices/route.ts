import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { getRedis } from "@/lib/redis";
import {
  CRYPTO_EXECUTION_SOURCE,
  marketLiveMetaKey,
  marketLivePriceKey,
  MarketService,
  SUPPORTED_ASSETS,
} from "@/lib/market";

export const dynamic = "force-dynamic";

type LivePriceSnapshot = {
  price: number;
  source: "WEBSOCKET" | "RECENT_CACHE" | "REALTIME_UNAVAILABLE";
  provider: string;
  mode: "REALTIME_FAST" | "SLOW_SWING";
  fresh: boolean;
  updatedAt: string | null;
  ageSeconds: number | null;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  independentSources?: Array<{
    provider: string;
    price: number;
    fresh: boolean;
    updatedAt: string | null;
    ageSeconds: number | null;
  }>;
};

function cryptoMode(asset: string): LivePriceSnapshot["mode"] {
  return SUPPORTED_ASSETS[asset]?.category === "crypto" ? "REALTIME_FAST" : "SLOW_SWING";
}

function ageSeconds(updatedAt?: string | null) {
  if (!updatedAt) return null;
  const timestamp = new Date(updatedAt).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round((Date.now() - timestamp) / 1000));
}

export async function GET(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized) return NextResponse.json({ error: auth.error }, { status: 401 });

  const redis = getRedis();
  const prices: Record<string, LivePriceSnapshot> = {};
  const assets = Object.keys(SUPPORTED_ASSETS);

  await Promise.all(assets.map(async (asset) => {
    const mode = cryptoMode(asset);
    const [krakenPrice, krakenMeta, bybitPrice, bybitMeta, binancePrice, binanceMeta] = await Promise.all([
      redis.get<number | string>(marketLivePriceKey("KRAKEN_SPOT_WS", asset)).catch(() => null),
      redis.get<any>(marketLiveMetaKey("KRAKEN_SPOT_WS", asset)).catch(() => null),
      redis.get<number | string>(marketLivePriceKey(CRYPTO_EXECUTION_SOURCE, asset)).catch(() => null),
      redis.get<any>(marketLiveMetaKey(CRYPTO_EXECUTION_SOURCE, asset)).catch(() => null),
      redis.get<number | string>(marketLivePriceKey("BINANCE_SPOT_WS", asset)).catch(() => null),
      redis.get<any>(marketLiveMetaKey("BINANCE_SPOT_WS", asset)).catch(() => null),
    ]);

    const liveNumber = Number(bybitPrice);
    const updatedAt = bybitMeta?.providerEventTime || bybitMeta?.updatedAt || null;
    const liveAge = ageSeconds(updatedAt);
    const independentSources = mode === "REALTIME_FAST"
      ? [
          { provider: "KRAKEN_SPOT_WS", price: Number(krakenPrice), meta: krakenMeta },
          { provider: "BYBIT_LINEAR_WS", price: Number(bybitPrice), meta: bybitMeta },
          { provider: "BINANCE_SPOT_WS", price: Number(binancePrice), meta: binanceMeta },
        ].filter((source) => Number.isFinite(source.price) && source.price > 0).map((source) => {
          const sourceUpdatedAt = source.meta?.updatedAt || null;
          const sourceAge = ageSeconds(sourceUpdatedAt);
          return {
            provider: source.provider,
            price: source.price,
            fresh: sourceAge !== null && sourceAge <= 45,
            updatedAt: sourceUpdatedAt,
            ageSeconds: sourceAge,
          };
        })
      : undefined;

    if (mode === "REALTIME_FAST" && Number.isFinite(liveNumber) && liveNumber > 0 && liveAge !== null && liveAge <= 45) {
      prices[asset] = {
        price: liveNumber,
        source: "WEBSOCKET",
        provider: CRYPTO_EXECUTION_SOURCE,
        mode,
        fresh: liveAge <= 10,
        updatedAt,
        ageSeconds: liveAge,
        change24h: 0,
        changePercent24h: 0,
        high24h: 0,
        low24h: 0,
        volume24h: 0,
        independentSources,
      };
      return;
    }

    try {
      const fallback = await MarketService.getCurrentPriceSnapshot(asset);
      if (Number.isFinite(fallback.price) && fallback.price > 0) {
        const fallbackAge = ageSeconds(fallback.updatedAt);
        prices[asset] = {
          price: fallback.price,
          source: fallback.source === "WEBSOCKET" ? "WEBSOCKET" : "RECENT_CACHE",
          provider: fallback.provider,
          mode,
          fresh: fallbackAge !== null && fallbackAge <= (mode === "REALTIME_FAST" ? 45 : 8 * 60 * 60),
          updatedAt: fallback.updatedAt,
          ageSeconds: fallbackAge,
          change24h: 0,
          changePercent24h: 0,
          high24h: 0,
          low24h: 0,
          volume24h: 0,
          independentSources,
        };
        return;
      }
    } catch {}

    prices[asset] = {
      price: 0,
      source: "REALTIME_UNAVAILABLE",
      provider: "NO_RECENT_PRICE",
      mode,
      fresh: false,
      updatedAt: null,
      ageSeconds: null,
      change24h: 0,
      changePercent24h: 0,
      high24h: 0,
      low24h: 0,
      volume24h: 0,
      independentSources,
    };
  }));

  const snapshots = Object.values(prices);
  const websocket = snapshots.filter((snapshot) => snapshot.source === "WEBSOCKET" && snapshot.fresh).length;
  const cached = snapshots.filter((snapshot) => snapshot.source === "RECENT_CACHE").length;
  const missing = snapshots.filter((snapshot) => snapshot.source === "REALTIME_UNAVAILABLE").length;
  const assetsWithDualWebsocket = snapshots.filter((snapshot) => (
    (snapshot.independentSources?.filter((source) => source.fresh).length || 0) >= 2
  )).length;
  const independentWebsocketFeeds = snapshots.reduce(
    (sum, snapshot) => sum + (snapshot.independentSources?.filter((source) => source.fresh).length || 0),
    0
  );

  return NextResponse.json({
    success: true,
    refreshMode: "live-price-only",
    timestamp: new Date().toISOString(),
    summary: {
      total: snapshots.length,
      websocket,
      cached,
      missing,
      independentWebsocketFeeds,
      assetsWithDualWebsocket,
      realtimeAssets: assets.filter((asset) => cryptoMode(asset) === "REALTIME_FAST"),
    },
    prices,
  });
}
