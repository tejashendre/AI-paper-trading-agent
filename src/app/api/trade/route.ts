import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { Logger } from "@/lib/logger";
import { SwingEngine } from "@/lib/swingEngine";
import { MarketService, SUPPORTED_ASSETS } from "@/lib/market";
import { PortfolioManager as OriginalPortfolioManager } from "@/lib/portfolio";
import { TelegramService } from "@/lib/telegram";
import { getEnv } from "@/lib/env";
import { Trade, OpenPosition, Portfolio } from "@/lib/types";
import { getRedis } from "@/lib/redis";

// Proxy PortfolioManager calls to the 'ai' portfolio context for parallel execution
const PortfolioManager = {
  getPortfolio: () => OriginalPortfolioManager.getPortfolio("ai"),
  updatePortfolio: (p: any) => OriginalPortfolioManager.updatePortfolio(p, "ai"),
  logTrade: (t: any) => OriginalPortfolioManager.logTrade(t, "ai"),
  saveSignal: (s: any) => OriginalPortfolioManager.saveSignal(s, "ai"),
};

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleSwingTrade(request);
}

async function handleSwingTrade(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized) return NextResponse.json({ error: auth.error }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const targetAsset = searchParams.get("asset") || "all";

  if (targetAsset !== "all" && !SUPPORTED_ASSETS[targetAsset]) {
    return NextResponse.json({ error: `Asset ${targetAsset} is not supported` }, { status: 400 });
  }

  try {
    const portfolio = await PortfolioManager.getPortfolio();

    if (!portfolio.openPositions) {
      portfolio.openPositions = {};
    }

    const scanResults = [];
    const assetsToScan = targetAsset === "all" ? Object.keys(SUPPORTED_ASSETS) : [targetAsset];

    for (const asset of assetsToScan) {
      try {
        const currentPrice = await MarketService.getCurrentPrice(asset);
        
        // Skip if a position is already active for this asset
        if (portfolio.openPositions[asset]) {
          continue;
        }

        const swingSignal = await SwingEngine.analyze(asset);

        if (swingSignal.action === 'SWING_BUY' || swingSignal.action === 'SWING_SHORT') {
          const isShort = swingSignal.action === 'SWING_SHORT';

          // Institutional Position Sizing: Risk exactly 1.5% of Equity
          const RISK_PER_TRADE_PERCENT = 0.015;
          const MAX_LEVERAGE = 5.0;
          const TRANSACTION_FEE_RATE = 0.0005;

          const riskAmountUsd = portfolio.usd * RISK_PER_TRADE_PERCENT;
          const priceDistance = Math.abs(currentPrice - swingSignal.stopLoss);
          
          if (priceDistance <= 0) continue;

          const amount = riskAmountUsd / priceDistance;
          const notionalPositionSizeUsd = amount * currentPrice;
          const requiredMarginUsd = notionalPositionSizeUsd / MAX_LEVERAGE;
          
          if (requiredMarginUsd > portfolio.usd) {
             continue;
          }

          const entryFee = notionalPositionSizeUsd * TRANSACTION_FEE_RATE;

          if (requiredMarginUsd + entryFee > portfolio.usd) continue;

          portfolio.usd -= (requiredMarginUsd + entryFee);
          portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + entryFee;

          const newPos: OpenPosition = {
            asset: asset,
            entryPrice: currentPrice,
            amount: amount,
            btcAmount: amount,
            usdInvested: requiredMarginUsd,
            entryFeePaid: entryFee,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            entryTime: new Date().toISOString(),
            signalScore: swingSignal.score,
            reasoning: swingSignal.reasoning,
            direction: isShort ? 'SHORT' : 'LONG',
            isScalp: false
          };

          portfolio.openPositions[asset] = newPos;
          await PortfolioManager.updatePortfolio(portfolio);

          const trade: Trade = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            asset: asset,
            action: isShort ? "SHORT" : "BUY",
            direction: isShort ? 'SHORT' : 'LONG',
            amount: amount,
            btcAmount: amount,
            price: currentPrice,
            usdValue: requiredMarginUsd,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            signalScore: swingSignal.score,
            reasoning: swingSignal.reasoning
          };

          await PortfolioManager.logTrade(trade);
          scanResults.push({ asset, action: swingSignal.action, score: swingSignal.score, price: currentPrice });
        } else {
          scanResults.push({ asset, action: "HOLD", reason: swingSignal.reasoning });
        }
      } catch (assetErr) {
        console.error(`Error scanning swing setup for ${asset}:`, assetErr);
      }
    }

    return NextResponse.json({ success: true, scanResults });
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    await Logger.error(`Swing execution run failed: ${errorMsg}`);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
