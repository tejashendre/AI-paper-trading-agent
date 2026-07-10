import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { SignalEngine } from "@/lib/signals";
import { RiskManager } from "@/lib/riskManager";
import { MarketService, SUPPORTED_ASSETS } from "@/lib/market";
import { PortfolioManager } from "@/lib/portfolio";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized) return NextResponse.json({ error: auth.error }, { status: 401 });

  const url = new URL(request.url);
  const asset = url.searchParams.get("asset") || "BTC";
  if (!SUPPORTED_ASSETS[asset]) {
    return NextResponse.json({ error: "Unsupported asset" }, { status: 400 });
  }

  try {
    const env = getEnv();
    const signal = await SignalEngine.analyze(asset);
    
    let risk = null;
    if (signal.action === "BUY" || signal.action === "SHORT") {
      const currentPrice = await MarketService.getCurrentPrice(asset);
      const portfolio = await PortfolioManager.getPortfolio();
      
      let currentValue = portfolio.usd;
      for (const key of Object.keys(portfolio.openPositions || {})) {
        const openPos = portfolio.openPositions[key];
        if (openPos) {
          try {
            const livePrice = await MarketService.getCurrentPrice(key);
            currentValue += openPos.amount * livePrice;
          } catch {
            currentValue += openPos.usdInvested;
          }
        }
      }

      const onehourTF = signal.timeframes.find((t: any) => t.timeframe === "1h");
      const atr = onehourTF?.snapshot.atr || 0;
      
      if (atr > 0) {
        const direction = signal.action === "SHORT" ? "SHORT" : "LONG";
        risk = RiskManager.calculatePosition(currentValue, env.RISK_PER_TRADE, currentPrice, atr, portfolio, asset, direction, onehourTF?.statistics);
      }
    }

    return NextResponse.json({ composite: signal, risk });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
