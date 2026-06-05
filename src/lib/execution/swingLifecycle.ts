import crypto from "crypto";
import { MarketService } from "@/lib/market";
import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { getRedis } from "@/lib/redis";
import { RiskManager } from "@/lib/riskManager";
import { OpenPosition, Portfolio, Trade } from "@/lib/types";
import { calculatePnlUsd, estimateFeeUsd } from "@/lib/trading/assetSpecs";

export interface SwingExitSweepResult {
  source: string;
  checked: number;
  closed: number;
  trailed: number;
  skipped: number;
  errors: number;
  timestamp: string;
}

function ensurePortfolioStats(portfolio: Portfolio) {
  portfolio.returns = portfolio.returns || [];
  portfolio.totalPnl = portfolio.totalPnl || 0;
  portfolio.totalTrades = portfolio.totalTrades || 0;
  portfolio.winningTrades = portfolio.winningTrades || 0;
  portfolio.losingTrades = portfolio.losingTrades || 0;
  portfolio.grossProfit = portfolio.grossProfit || 0;
  portfolio.grossLoss = portfolio.grossLoss || 0;
  portfolio.consecutiveWins = portfolio.consecutiveWins || 0;
  portfolio.consecutiveLosses = portfolio.consecutiveLosses || 0;
  portfolio.maxConsecutiveWins = portfolio.maxConsecutiveWins || 0;
  portfolio.maxConsecutiveLosses = portfolio.maxConsecutiveLosses || 0;
  portfolio.totalFeesPaid = portfolio.totalFeesPaid || 0;
  portfolio.openPositions = portfolio.openPositions || {};
  portfolio.balances = portfolio.balances || {};
}

async function getLivePrice(asset: string): Promise<number> {
  const redis = getRedis();
  const livePrice = await redis.get<number | string>(`market:live:${asset}`);
  const parsedLivePrice = typeof livePrice === "string" ? parseFloat(livePrice) : Number(livePrice);
  if (Number.isFinite(parsedLivePrice) && parsedLivePrice > 0) return parsedLivePrice;
  return MarketService.getCurrentPrice(asset);
}

function buildCloseTrade(
  asset: string,
  pos: OpenPosition,
  exitPrice: number,
  reason: "STOP_LOSS" | "TAKE_PROFIT",
  netPnl: number,
  pnlPercent: number,
  entryFee: number
): Trade {
  const isShort = pos.direction === "SHORT";

  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    asset,
    action: isShort ? "COVER" : "SELL",
    direction: isShort ? "SHORT" : "LONG",
    amount: pos.amount,
    btcAmount: pos.amount,
    price: exitPrice,
    usdValue: pos.usdInvested + entryFee + netPnl,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    signalScore: pos.signalScore,
    reasoning: `Swing exit triggered: ${reason} | Net PnL: $${netPnl.toFixed(2)}`,
    pnl: netPnl,
    pnlPercent,
    entryPrice: pos.entryPrice,
    entryTime: pos.entryTime,
    exitPrice,
    exitTime: new Date().toISOString(),
    exitReason: reason,
  };
}

export async function sweepSwingExits(
  portfolio: Portfolio,
  options: { portfolioType?: "ai" | "user"; source?: string } = {}
): Promise<SwingExitSweepResult> {
  const portfolioType = options.portfolioType || "ai";
  const source = options.source || "SWING_EXIT_SWEEP";
  const redis = getRedis();

  ensurePortfolioStats(portfolio);

  const result: SwingExitSweepResult = {
    source,
    checked: 0,
    closed: 0,
    trailed: 0,
    skipped: 0,
    errors: 0,
    timestamp: new Date().toISOString(),
  };

  const activeKeys = Object.keys(portfolio.openPositions || {});

  for (const asset of activeKeys) {
    const pos = portfolio.openPositions[asset];
    if (!pos) {
      result.skipped++;
      continue;
    }

    result.checked++;

    try {
      const currentLivePrice = await getLivePrice(asset);
      if (!Number.isFinite(currentLivePrice) || currentLivePrice <= 0) {
        result.skipped++;
        continue;
      }

      const sltp = RiskManager.checkStopLossOrTakeProfit(pos, currentLivePrice);

      if (sltp.triggered && sltp.reason) {
        const isShort = pos.direction === "SHORT";
        const grossPnl = calculatePnlUsd(asset, pos.entryPrice, sltp.exitPrice, pos.amount, pos.direction);
        const entryFee = pos.entryFeePaid ?? estimateFeeUsd(asset, pos.amount, pos.entryPrice);
        const exitFee = estimateFeeUsd(asset, pos.amount, sltp.exitPrice);
        const netPnl = grossPnl - entryFee - exitFee;
        const pnlPercent = pos.usdInvested > 0 ? (netPnl / pos.usdInvested) * 100 : 0;

        portfolio.usd += pos.usdInvested + entryFee + netPnl;
        portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + exitFee;

        if (portfolio.balances && !isShort) {
          portfolio.balances[asset] = Math.max(0, (portfolio.balances[asset] || 0) - pos.amount);
        }

        portfolio.totalPnl += netPnl;
        portfolio.totalTrades++;
        portfolio.returns.push(pnlPercent);
        if (portfolio.returns.length > 2000) portfolio.returns.shift();

        if (netPnl >= 0) {
          portfolio.winningTrades++;
          portfolio.grossProfit += netPnl;
          portfolio.consecutiveWins++;
          portfolio.consecutiveLosses = 0;
          portfolio.maxConsecutiveWins = Math.max(portfolio.maxConsecutiveWins, portfolio.consecutiveWins);
        } else {
          portfolio.losingTrades++;
          portfolio.grossLoss += Math.abs(netPnl);
          portfolio.consecutiveLosses++;
          portfolio.consecutiveWins = 0;
          portfolio.maxConsecutiveLosses = Math.max(portfolio.maxConsecutiveLosses, portfolio.consecutiveLosses);
        }

        delete portfolio.openPositions[asset];
        await redis.set(`swing:cooldown:${asset}`, "1", { ex: 3600 });

        const closeTrade = buildCloseTrade(
          asset,
          pos,
          sltp.exitPrice,
          sltp.reason,
          netPnl,
          pnlPercent,
          entryFee
        );

        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
        await PortfolioManager.logTrade(closeTrade, portfolioType);
        await Logger.info(
          `[${source}] ${asset} ${isShort ? "SHORT COVER" : "LONG SELL"} via ${sltp.reason}. Net PnL: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`
        );

        result.closed++;
      } else if (sltp.trailed) {
        if (sltp.newStopLoss) pos.stopLoss = sltp.newStopLoss;
        if (sltp.newTakeProfit) pos.takeProfit = sltp.newTakeProfit;
        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
        await Logger.info(`[${source}] Trailed ${asset} levels. SL: $${pos.stopLoss.toFixed(4)}`);
        result.trailed++;
      }
    } catch (error) {
      result.errors++;
      await Logger.error(`[${source}] Sweep error on ${asset}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await redis.set(`swing:lastExitSweep:${portfolioType}`, result, { ex: 120 });
  return result;
}
