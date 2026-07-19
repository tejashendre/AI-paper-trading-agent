import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { MarketService, SUPPORTED_ASSETS } from "@/lib/market";
import { computeAllIndicators } from "@/lib/indicators";
import { PortfolioManager } from "@/lib/portfolio";
import { Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized) return NextResponse.json({ error: auth.error }, { status: 401 });

  const url = new URL(request.url);
  const intervalValue = url.searchParams.get("interval") || "1h";
  const parsedLimit = Number.parseInt(url.searchParams.get("limit") || "720", 10);
  const asset = url.searchParams.get("asset") || "BTC";
  const portfolioValue = url.searchParams.get("portfolio") || "user";
  const allowedTimeframes = new Set<Timeframe>(["1m", "5m", "15m", "30m", "1h", "4h"]);

  if (!SUPPORTED_ASSETS[asset]) return NextResponse.json({ error: "Unsupported asset" }, { status: 400 });
  if (!allowedTimeframes.has(intervalValue as Timeframe)) return NextResponse.json({ error: "Unsupported interval" }, { status: 400 });
  if (!Number.isFinite(parsedLimit) || parsedLimit < 50 || parsedLimit > 1_000) {
    return NextResponse.json({ error: "Limit must be between 50 and 1000" }, { status: 400 });
  }
  if (portfolioValue !== "user" && portfolioValue !== "ai") {
    return NextResponse.json({ error: "Unsupported portfolio" }, { status: 400 });
  }

  const interval = intervalValue as Timeframe;
  const limit = parsedLimit;
  const portfolioType = portfolioValue;

  try {
    const candles = await MarketService.getCandles(interval, limit, asset, { allowStale: true });
    const seriesStatus = MarketService.getCandleSeriesStatus(asset, interval, candles);
    const indicators = computeAllIndicators(candles);
    
    const trades = await PortfolioManager.getTrades(portfolioType).catch((error) => {
      console.warn(`[Chart] Trade overlays unavailable for ${portfolioType}:`, error);
      return [];
    });
    const chartTrades = trades
      .filter(t => t.asset === asset)
      .map(t => ({
        time: new Date(t.timestamp).getTime() / 1000,
        action: t.action,
        price: t.price
      }));

    return NextResponse.json({
      asset,
      interval,
      candles,
      indicators,
      trades: chartTrades,
      stale: !seriesStatus.fresh,
      asOf: seriesStatus.asOf,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
