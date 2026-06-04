import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { MarketService } from "@/lib/market";
import { computeAllIndicators } from "@/lib/indicators";
import { PortfolioManager } from "@/lib/portfolio";
import { Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized) return NextResponse.json({ error: auth.error }, { status: 401 });

  const url = new URL(request.url);
  const interval = (url.searchParams.get("interval") || "1h") as Timeframe;
  const limit = parseInt(url.searchParams.get("limit") || "720", 10);
  const asset = url.searchParams.get("asset") || "BTC";
  const portfolioType = (url.searchParams.get("portfolio") || "user") as "user" | "ai";

  try {
    const candles = await MarketService.getCandles(interval, limit, asset);
    const indicators = computeAllIndicators(candles);
    
    const trades = await PortfolioManager.getTrades(portfolioType);
    const chartTrades = trades
      .filter(t => t.asset === asset)
      .map(t => ({
        time: new Date(t.timestamp).getTime() / 1000,
        action: t.action,
        price: t.price
      }));

    return NextResponse.json({ candles, indicators, trades: chartTrades });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
