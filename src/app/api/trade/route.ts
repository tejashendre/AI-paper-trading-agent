import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { Logger } from "@/lib/logger";
import { SwingEngine } from "@/lib/swingEngine";
import { MarketService, SUPPORTED_ASSETS } from "@/lib/market";
import { PortfolioManager as OriginalPortfolioManager } from "@/lib/portfolio";
import { Trade, OpenPosition } from "@/lib/types";
import { TradeAdmissionController } from "@/lib/trading/tradeAdmission";
import { getMarketSessionState } from "@/lib/trading/marketSession";

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

        const session = getMarketSessionState(asset);
        if (!session.isOpen) {
          scanResults.push({ asset, action: "SKIPPED", reason: session.reason });
          continue;
        }

        const swingSignal = await SwingEngine.analyze(asset);

        if (swingSignal.action === 'SWING_BUY' || swingSignal.action === 'SWING_SHORT') {
          const isShort = swingSignal.action === 'SWING_SHORT';

          const admission = TradeAdmissionController.evaluate({
            portfolio,
            asset,
            direction: isShort ? "SHORT" : "LONG",
            entryPrice: currentPrice,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            signalScore: swingSignal.score,
            finalConviction: swingSignal.finalConviction,
            reasoning: swingSignal.reasoning,
            strategyType: "swing",
          });

          if (!admission.approved) {
            scanResults.push({ asset, action: "BLOCKED", reason: admission.reason, score: swingSignal.score });
            continue;
          }

          portfolio.usd -= (admission.requiredMarginUsd + admission.entryFeeUsd);
          portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + admission.entryFeeUsd;

          const newPos: OpenPosition = {
            asset: asset,
            entryPrice: currentPrice,
            amount: admission.amount,
            btcAmount: admission.amount,
            usdInvested: admission.requiredMarginUsd,
            entryFeePaid: admission.entryFeeUsd,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            entryTime: new Date().toISOString(),
            signalScore: swingSignal.score,
            finalConviction: swingSignal.finalConviction,
            decisionState: swingSignal.decisionState,
            setupTags: swingSignal.setupTags,
            dataQuality: swingSignal.dataQuality,
            triggerScore: swingSignal.triggerScore,
            paperSize: swingSignal.paperSize,
            reasoning: `${swingSignal.simpleStatus}. ${swingSignal.simpleReason} | ${swingSignal.reasoning} | ${admission.reason}`,
            direction: isShort ? 'SHORT' : 'LONG',
            isScalp: false,
            notionalUsd: admission.notionalUsd,
            leverageUsed: admission.leverage,
            riskAmountUsd: admission.riskAmountUsd,
            maxLossUsd: admission.maxLossUsd,
            admissionScore: admission.admissionScore,
            strategyType: "swing"
          };

          portfolio.openPositions[asset] = newPos;
          await PortfolioManager.updatePortfolio(portfolio);

          const trade: Trade = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            asset: asset,
            action: isShort ? "SHORT" : "BUY",
            direction: isShort ? 'SHORT' : 'LONG',
            amount: admission.amount,
            btcAmount: admission.amount,
            price: currentPrice,
            usdValue: admission.requiredMarginUsd,
            stopLoss: swingSignal.stopLoss,
            takeProfit: swingSignal.takeProfit,
            signalScore: swingSignal.score,
            finalConviction: swingSignal.finalConviction,
            decisionState: swingSignal.decisionState,
            setupTags: swingSignal.setupTags,
            dataQuality: swingSignal.dataQuality,
            triggerScore: swingSignal.triggerScore,
            paperSize: swingSignal.paperSize,
            reasoning: newPos.reasoning
          };

          await PortfolioManager.logTrade(trade);
          scanResults.push({ asset, action: swingSignal.action, score: swingSignal.score, finalConviction: swingSignal.finalConviction, decisionState: swingSignal.decisionState, simpleStatus: swingSignal.simpleStatus, simpleReason: swingSignal.simpleReason, triggerScore: swingSignal.triggerScore, marketStructureScore: swingSignal.marketStructureScore, liquidityState: swingSignal.liquidityState, dataQuality: swingSignal.dataQuality, price: currentPrice, margin: admission.requiredMarginUsd, leverage: admission.leverage, paperSize: swingSignal.paperSize });
        } else {
          scanResults.push({ asset, action: "HOLD", reason: swingSignal.reasoning, decisionState: swingSignal.decisionState, simpleStatus: swingSignal.simpleStatus, simpleReason: swingSignal.simpleReason, nextStep: swingSignal.nextStep, score: swingSignal.score, triggerScore: swingSignal.triggerScore, marketStructureScore: swingSignal.marketStructureScore, liquidityState: swingSignal.liquidityState, dataQuality: swingSignal.dataQuality, finalConviction: swingSignal.finalConviction, paperSize: swingSignal.paperSize });
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
