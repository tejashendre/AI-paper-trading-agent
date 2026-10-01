import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { MarketService, SUPPORTED_ASSETS } from "@/lib/market";

export const dynamic = "force-dynamic";

type LivePriceSnapshot = {
  price: number;
  /** WEBSOCKET and REST are two transports from Bybit, the only venue. */
  source: "WEBSOCKET" | "REST" | "REALTIME_UNAVAILABLE";
  provider: string;
  instrument: string | null;
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

  const prices: Record<string, LivePriceSnapshot> = {};
  const assets = Object.keys(SUPPORTED_ASSETS);
  const empty = { change24h: 0, changePercent24h: 0, high24h: 0, low24h: 0, volume24h: 0 };

  await Promise.all(assets.map(async (asset) => {
    const mode = cryptoMode(asset);
    try {
      const quote = await MarketService.getCurrentPriceSnapshot(asset);
      const age = ageSeconds(quote.updatedAt);
      prices[asset] = {
        price: quote.price,
        source: quote.transport === "WS" ? "WEBSOCKET" : "REST",
        provider: quote.provider,
        instrument: quote.instrument,
        mode,
        fresh: age !== null && age <= (quote.transport === "WS" ? 10 : 45),
        updatedAt: quote.updatedAt,
        ageSeconds: age,
        ...empty,
      };
    } catch {
      prices[asset] = {
        price: 0,
        source: "REALTIME_UNAVAILABLE",
        provider: "NO_RECENT_PRICE",
        instrument: SUPPORTED_ASSETS[asset].bybitLinearSymbol,
        mode,
        fresh: false,
        updatedAt: null,
        ageSeconds: null,
        ...empty,
      };
    }
  }));

  const snapshots = Object.values(prices);
  const rest = snapshots.filter((snapshot) => snapshot.source === "REST").length;
  return NextResponse.json({
    success: true,
    refreshMode: "live-price-only",
    timestamp: new Date().toISOString(),
    summary: {
      total: snapshots.length,
      websocket: snapshots.filter((snapshot) => snapshot.source === "WEBSOCKET" && snapshot.fresh).length,
      rest,
      // Kept for the existing dashboard counter: quotes served over REST.
      cached: rest,
      missing: snapshots.filter((snapshot) => snapshot.source === "REALTIME_UNAVAILABLE").length,
      independentVenues: 1,
      realtimeAssets: assets.filter((asset) => cryptoMode(asset) === "REALTIME_FAST"),
    },
    prices,
  });
}
