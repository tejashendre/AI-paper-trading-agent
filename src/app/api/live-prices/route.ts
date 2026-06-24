import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { getRedis } from "@/lib/redis";
import { MarketService, SUPPORTED_ASSETS } from "@/lib/market";

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
    const [livePrice, liveMeta, cachedPrice] = await Promise.all([
      redis.get<number | string>(`market:live:${asset}`).catch(() => null),
      redis.get<any>(`market:liveMeta:${asset}`).catch(() => null),
      redis.get<number | string>(`cache:price:${asset}`).catch(() => null),
    ]);

    const liveNumber = Number(livePrice);
    const cachedNumber = Number(cachedPrice);
    const updatedAt = liveMeta?.updatedAt || null;
    const liveAge = ageSeconds(updatedAt);

    if (Number.isFinite(liveNumber) && liveNumber > 0) {
      prices[asset] = {
        price: liveNumber,
        source: "WEBSOCKET",
        provider: liveMeta?.source || "CRYPTO_WS",
        mode,
        fresh: liveAge === null ? true : liveAge <= 10,
        updatedAt,
        ageSeconds: liveAge,
        change24h: 0,
        changePercent24h: 0,
        high24h: 0,
        low24h: 0,
        volume24h: 0,
      };
      return;
    }

    if (Number.isFinite(cachedNumber) && cachedNumber > 0) {
      prices[asset] = {
        price: cachedNumber,
        source: "RECENT_CACHE",
        provider: mode === "REALTIME_FAST" ? "HTTP_FALLBACK_CACHE" : "SLOW_FEED_CACHE",
        mode,
        fresh: mode === "SLOW_SWING",
        updatedAt: null,
        ageSeconds: null,
        change24h: 0,
        changePercent24h: 0,
        high24h: 0,
        low24h: 0,
        volume24h: 0,
      };
      return;
    }

    try {
      const fallbackPrice = await MarketService.getCurrentPrice(asset);
      if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
        prices[asset] = {
          price: fallbackPrice,
          source: "RECENT_CACHE",
          provider: mode === "REALTIME_FAST" ? "HTTP_FALLBACK_FETCH" : "SLOW_FEED_FETCH",
          mode,
          fresh: mode === "SLOW_SWING",
          updatedAt: new Date().toISOString(),
          ageSeconds: 0,
          change24h: 0,
          changePercent24h: 0,
          high24h: 0,
          low24h: 0,
          volume24h: 0,
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
    };
  }));

  const snapshots = Object.values(prices);
  const websocket = snapshots.filter((snapshot) => snapshot.source === "WEBSOCKET" && snapshot.fresh).length;
  const cached = snapshots.filter((snapshot) => snapshot.source === "RECENT_CACHE").length;
  const missing = snapshots.filter((snapshot) => snapshot.source === "REALTIME_UNAVAILABLE").length;

  return NextResponse.json({
    success: true,
    refreshMode: "live-price-only",
    timestamp: new Date().toISOString(),
    summary: {
      total: snapshots.length,
      websocket,
      cached,
      missing,
      realtimeAssets: assets.filter((asset) => cryptoMode(asset) === "REALTIME_FAST"),
    },
    prices,
  });
}
