import crypto from "crypto";
import { MarketService } from "@/lib/market";
import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { getRedis } from "@/lib/redis";
import { RiskManager } from "@/lib/riskManager";
import { OpenPosition, Portfolio, Trade } from "@/lib/types";
import { amountFromNotionalUsd, calculatePnlUsd, estimateFeeUsd, estimateNotionalUsd } from "@/lib/trading/assetSpecs";
import { SwingEngine, SwingSignal } from "@/lib/swingEngine";

export interface SwingExitSweepResult {
  source: string;
  checked: number;
  closed: number;
  trailed: number;
  scaledIn?: number;
  partialExits?: number;
  signalReversals: number;
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
  reason: NonNullable<Trade["exitReason"]>,
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
    finalConviction: pos.finalConviction,
    decisionState: pos.decisionState,
    setupTags: pos.setupTags,
    dataQuality: pos.dataQuality,
    triggerScore: pos.triggerScore,
    marketStructureScore: pos.marketStructureScore,
    microstructureScore: pos.microstructureScore,
    microstructureSummary: pos.microstructureSummary,
    fundingRate: pos.fundingRate,
    openInterest: pos.openInterest,
    orderbookImbalanceRatio: pos.orderbookImbalanceRatio,
    liquidityState: pos.liquidityState,
    paperSize: pos.paperSize,
    reasoning: `Swing exit triggered: ${reason.replaceAll("_", " ")} | Net PnL: $${netPnl.toFixed(2)}`,
    pnl: netPnl,
    pnlPercent,
    entryPrice: pos.entryPrice,
    entryTime: pos.entryTime,
    exitPrice,
    exitTime: new Date().toISOString(),
    exitReason: reason,
  };
}

function classifyExitReason(pos: OpenPosition, reason: "STOP_LOSS" | "TAKE_PROFIT" | "SIGNAL_REVERSAL", netPnl: number): NonNullable<Trade["exitReason"]> {
  if (reason === "SIGNAL_REVERSAL") return "SIGNAL_REVERSAL";
  if (reason === "TAKE_PROFIT") return "TAKE_PROFIT";
  if (netPnl >= 0 && pos.isTrailing) return "TRAILING_STOP_PROFIT";
  if (netPnl >= 0) return "BREAKEVEN_STOP";
  return "STOP_LOSS";
}

function cooldownSecondsForExit(reason: NonNullable<Trade["exitReason"]>, netPnl: number): number {
  if (reason === "TAKE_PROFIT" || reason === "TRAILING_STOP_PROFIT" || reason === "SIGNAL_REVERSAL") return 0;
  if (netPnl >= 0) return 0;
  return 600;
}

function isCryptoFastAsset(asset: string) {
  return asset === "BTC" || asset === "ETH" || asset === "SOL";
}

function activeMarginUsd(portfolio: Portfolio): number {
  const swingMargin = Object.values(portfolio.openPositions || {}).reduce(
    (sum, position) => sum + (position?.usdInvested || 0),
    0
  );
  const scalpMargin = Object.values(portfolio.scalpPositions || {}).reduce(
    (sum, position) => sum + (position?.usdInvested || 0),
    0
  );
  return swingMargin + scalpMargin;
}

function unrealizedNetPnl(asset: string, pos: OpenPosition, currentPrice: number): number {
  const grossPnl = calculatePnlUsd(asset, pos.entryPrice, currentPrice, pos.amount, pos.direction);
  const entryFee = pos.entryFeePaid ?? estimateFeeUsd(asset, pos.amount, pos.entryPrice);
  const exitFee = estimateFeeUsd(asset, pos.amount, currentPrice);
  return grossPnl - entryFee - exitFee;
}

function profitMultiple(asset: string, pos: OpenPosition, currentPrice: number): number {
  const maxLoss = pos.maxLossUsd && pos.maxLossUsd > 0
    ? pos.maxLossUsd
    : Math.abs(calculatePnlUsd(asset, pos.entryPrice, pos.stopLoss, pos.amount, pos.direction));
  if (!Number.isFinite(maxLoss) || maxLoss <= 0) return 0;
  return unrealizedNetPnl(asset, pos, currentPrice) / maxLoss;
}

function updateProfitWatermark(asset: string, pos: OpenPosition, currentPrice: number): { netPnl: number; peakPnl: number; updated: boolean } {
  const netPnl = unrealizedNetPnl(asset, pos, currentPrice);
  const previousPeak = Number(pos.maxUnrealizedPnlUsd || 0);
  if (Number.isFinite(netPnl) && netPnl > previousPeak) {
    pos.maxUnrealizedPnlUsd = netPnl;
    pos.maxUnrealizedPnlTime = new Date().toISOString();
    return { netPnl, peakPnl: netPnl, updated: true };
  }

  return { netPnl, peakPnl: previousPeak, updated: false };
}

function profitGivebackLimit(peakPnl: number): number {
  if (peakPnl >= 150) return Math.max(8, peakPnl * 0.06);
  if (peakPnl >= 80) return 5;
  if (peakPnl >= 40) return 4;
  if (peakPnl >= 20) return 3;
  return Infinity;
}

function shouldCloseOnProfitGiveback(asset: string, pos: OpenPosition, currentPrice: number) {
  const watermark = updateProfitWatermark(asset, pos, currentPrice);
  const givebackLimit = profitGivebackLimit(watermark.peakPnl);
  const giveback = watermark.peakPnl - watermark.netPnl;
  const triggered = (
    Number.isFinite(givebackLimit) &&
    watermark.peakPnl >= 20 &&
    watermark.netPnl > 0 &&
    giveback >= givebackLimit
  );

  return {
    ...watermark,
    giveback,
    givebackLimit,
    triggered,
  };
}

function isOppositeSignalStrong(pos: OpenPosition, signal: SwingSignal) {
  const oppositeLong = pos.direction === "SHORT" && signal.action === "SWING_BUY";
  const oppositeShort = pos.direction === "LONG" && signal.action === "SWING_SHORT";
  if (!oppositeLong && !oppositeShort) return false;

  return (
    signal.assetMode === "REALTIME_FAST" &&
    signal.dataQuality >= 80 &&
    signal.triggerScore >= 14 &&
    signal.finalConviction >= 70 &&
    signal.htfScore >= 8 &&
    signal.slippagePercent <= 0.25
  );
}

async function closePosition(
  portfolio: Portfolio,
  portfolioType: "ai" | "user",
  source: string,
  asset: string,
  pos: OpenPosition,
  exitPrice: number,
  reason: "STOP_LOSS" | "TAKE_PROFIT" | "SIGNAL_REVERSAL",
  result: SwingExitSweepResult,
  setCooldown = true
) {
  const redis = getRedis();
  const isShort = pos.direction === "SHORT";
  const grossPnl = calculatePnlUsd(asset, pos.entryPrice, exitPrice, pos.amount, pos.direction);
  const entryFee = pos.entryFeePaid ?? estimateFeeUsd(asset, pos.amount, pos.entryPrice);
  const exitFee = estimateFeeUsd(asset, pos.amount, exitPrice);
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
  const exitReason = classifyExitReason(pos, reason, netPnl);
  const cooldownSeconds = setCooldown ? cooldownSecondsForExit(exitReason, netPnl) : 0;
  if (cooldownSeconds > 0) {
    await redis.set(`swing:cooldown:${asset}`, "1", { ex: cooldownSeconds });
  }

  const closeTrade = buildCloseTrade(
    asset,
    pos,
    exitPrice,
    exitReason,
    netPnl,
    pnlPercent,
    entryFee
  );

  await PortfolioManager.updatePortfolio(portfolio, portfolioType);
  await PortfolioManager.logTrade(closeTrade, portfolioType);
  await Logger.info(
    `[${source}] ${asset} ${isShort ? "SHORT COVER" : "LONG SELL"} via ${exitReason}. Net PnL: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`
  );

  result.closed++;
  if (reason === "SIGNAL_REVERSAL") result.signalReversals++;
}

async function scaleIntoWinner(
  portfolio: Portfolio,
  portfolioType: "ai" | "user",
  source: string,
  asset: string,
  pos: OpenPosition,
  currentPrice: number,
  result: SwingExitSweepResult
): Promise<boolean> {
  if (portfolioType !== "ai") return false;
  if (pos.strategyType && pos.strategyType !== "swing") return false;
  if ((pos.scaleInCount || 0) >= 1) return false;
  if (pos.entryMode !== "CONTROLLED_PROBE") return false;
  if (profitMultiple(asset, pos, currentPrice) < 0.9) return false;
  if ((pos.finalConviction || 0) < 60 || (pos.dataQuality || 0) < 68) return false;

  const equity = Math.max(portfolio.usd + activeMarginUsd(portfolio), portfolio.usd, 0);
  const maxTotalMargin = equity * 0.55;
  const remainingRoom = Math.max(0, maxTotalMargin - activeMarginUsd(portfolio));
  const addMarginUsd = Math.min(portfolio.usd * 0.06, pos.usdInvested * 0.5, 600, remainingRoom);
  const leverage = Math.max(1, pos.leverageUsed || 1);
  if (!Number.isFinite(addMarginUsd) || addMarginUsd < 50) return false;

  const addNotionalUsd = addMarginUsd * leverage;
  const addAmount = amountFromNotionalUsd(asset, addNotionalUsd, currentPrice);
  const entryFee = estimateFeeUsd(asset, addAmount, currentPrice);
  if (addMarginUsd + entryFee > portfolio.usd || addAmount <= 0) return false;

  const existingNotional = estimateNotionalUsd(asset, pos.amount, pos.entryPrice);
  const totalNotional = existingNotional + addNotionalUsd;
  pos.entryPrice = totalNotional > 0
    ? ((pos.entryPrice * existingNotional) + (currentPrice * addNotionalUsd)) / totalNotional
    : pos.entryPrice;
  pos.amount += addAmount;
  pos.btcAmount = pos.amount;
  pos.usdInvested += addMarginUsd;
  pos.notionalUsd = (pos.notionalUsd || existingNotional) + addNotionalUsd;
  pos.entryFeePaid = (pos.entryFeePaid || 0) + entryFee;
  pos.maxLossUsd = Math.abs(calculatePnlUsd(asset, pos.entryPrice, pos.stopLoss, pos.amount, pos.direction));
  pos.scaleInCount = (pos.scaleInCount || 0) + 1;
  pos.lastScaleInTime = new Date().toISOString();
  pos.paperSize = pos.paperSize === "Probe" ? "Normal" : pos.paperSize;
  pos.reasoning = `${pos.reasoning} | Scaled into profitable probe after live follow-through.`;

  portfolio.usd -= addMarginUsd + entryFee;
  portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + entryFee;
  if (pos.direction === "LONG") {
    portfolio.balances[asset] = (portfolio.balances[asset] || 0) + addAmount;
  }

  const scaleTrade: Trade = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    asset,
    action: pos.direction === "SHORT" ? "SHORT" : "BUY",
    direction: pos.direction,
    amount: addAmount,
    btcAmount: addAmount,
    price: currentPrice,
    usdValue: addMarginUsd,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    signalScore: pos.signalScore,
    finalConviction: pos.finalConviction,
    decisionState: pos.decisionState,
    setupTags: pos.setupTags,
    dataQuality: pos.dataQuality,
    triggerScore: pos.triggerScore,
    marketStructureScore: pos.marketStructureScore,
    microstructureScore: pos.microstructureScore,
    microstructureSummary: pos.microstructureSummary,
    fundingRate: pos.fundingRate,
    openInterest: pos.openInterest,
    orderbookImbalanceRatio: pos.orderbookImbalanceRatio,
    liquidityState: pos.liquidityState,
    paperSize: pos.paperSize,
    entryMode: pos.entryMode,
    reasoning: `Scaled into profitable swing winner. Added $${addMarginUsd.toFixed(2)} margin after probe follow-through.`,
  };

  await PortfolioManager.updatePortfolio(portfolio, portfolioType);
  await PortfolioManager.logTrade(scaleTrade, portfolioType);
  await Logger.info(`[${source}] Scaled into ${asset} ${pos.direction}. Added margin $${addMarginUsd.toFixed(2)} after profitable follow-through.`);
  result.scaledIn = (result.scaledIn || 0) + 1;
  return true;
}

async function takePartialProfit(
  portfolio: Portfolio,
  portfolioType: "ai" | "user",
  source: string,
  asset: string,
  pos: OpenPosition,
  currentPrice: number,
  result: SwingExitSweepResult
): Promise<boolean> {
  if (portfolioType !== "ai") return false;
  if (pos.strategyType && pos.strategyType !== "swing") return false;
  if ((pos.partialExitCount || 0) >= 1) return false;
  if (profitMultiple(asset, pos, currentPrice) < 1.2) return false;
  if (pos.amount <= 0 || pos.usdInvested <= 0) return false;

  const exitFraction = 0.35;
  const exitAmount = pos.amount * exitFraction;
  const releasedMargin = pos.usdInvested * exitFraction;
  const entryFeeShare = (pos.entryFeePaid || 0) * exitFraction;
  const grossPnl = calculatePnlUsd(asset, pos.entryPrice, currentPrice, exitAmount, pos.direction);
  const exitFee = estimateFeeUsd(asset, exitAmount, currentPrice);
  const netPnl = grossPnl - entryFeeShare - exitFee;
  const pnlPercent = releasedMargin > 0 ? (netPnl / releasedMargin) * 100 : 0;

  pos.amount -= exitAmount;
  pos.btcAmount = pos.amount;
  pos.usdInvested -= releasedMargin;
  pos.entryFeePaid = Math.max(0, (pos.entryFeePaid || 0) - entryFeeShare);
  pos.notionalUsd = Math.max(0, (pos.notionalUsd || estimateNotionalUsd(asset, pos.amount, pos.entryPrice)) * (1 - exitFraction));
  pos.maxLossUsd = Math.abs(calculatePnlUsd(asset, pos.entryPrice, pos.stopLoss, pos.amount, pos.direction));
  pos.partialExitCount = (pos.partialExitCount || 0) + 1;
  pos.lastPartialExitTime = new Date().toISOString();
  pos.isTrailing = true;

  portfolio.usd += releasedMargin + entryFeeShare + netPnl;
  portfolio.totalPnl += netPnl;
  portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + exitFee;
  if (portfolio.returns) portfolio.returns.push(pnlPercent);
  if (portfolio.returns && portfolio.returns.length > 2000) portfolio.returns.shift();
  if (netPnl >= 0) portfolio.grossProfit = (portfolio.grossProfit || 0) + netPnl;
  else portfolio.grossLoss = (portfolio.grossLoss || 0) + Math.abs(netPnl);
  if (pos.direction === "LONG") {
    portfolio.balances[asset] = Math.max(0, (portfolio.balances[asset] || 0) - exitAmount);
  }

  const partialTrade = buildCloseTrade(
    asset,
    { ...pos, amount: exitAmount, btcAmount: exitAmount, usdInvested: releasedMargin, entryFeePaid: entryFeeShare },
    currentPrice,
    "TAKE_PROFIT",
    netPnl,
    pnlPercent,
    entryFeeShare
  );
  partialTrade.reasoning = `Partial profit taken on swing winner. Closed ${(exitFraction * 100).toFixed(0)}% and left runner active. Net PnL: $${netPnl.toFixed(2)}`;

  await PortfolioManager.updatePortfolio(portfolio, portfolioType);
  await PortfolioManager.logTrade(partialTrade, portfolioType);
  await Logger.info(`[${source}] Partial profit ${asset} ${pos.direction}. Closed ${(exitFraction * 100).toFixed(0)}%, net PnL ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}.`);
  result.partialExits = (result.partialExits || 0) + 1;
  return true;
}

async function manageProfitableWinner(
  portfolio: Portfolio,
  portfolioType: "ai" | "user",
  source: string,
  asset: string,
  pos: OpenPosition,
  currentPrice: number,
  result: SwingExitSweepResult
) {
  const scaled = await scaleIntoWinner(portfolio, portfolioType, source, asset, pos, currentPrice, result);
  if (!scaled) {
    await takePartialProfit(portfolio, portfolioType, source, asset, pos, currentPrice, result);
  }
}

async function getStrongOppositeSignal(asset: string, pos: OpenPosition): Promise<SwingSignal | null> {
  if (!isCryptoFastAsset(asset)) return null;

  const signal = await SwingEngine.analyze(asset);
  return isOppositeSignalStrong(pos, signal) ? signal : null;
}

export async function sweepSwingExits(
  portfolio: Portfolio,
  options: { portfolioType?: "ai" | "user"; source?: string; checkSignalReversal?: boolean } = {}
): Promise<SwingExitSweepResult> {
  const portfolioType = options.portfolioType || "ai";
  const source = options.source || "SWING_EXIT_SWEEP";
  const checkSignalReversal = options.checkSignalReversal === true;
  const redis = getRedis();

  ensurePortfolioStats(portfolio);

  const result: SwingExitSweepResult = {
    source,
    checked: 0,
    closed: 0,
    trailed: 0,
    scaledIn: 0,
    partialExits: 0,
    signalReversals: 0,
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

      const profitGuard = shouldCloseOnProfitGiveback(asset, pos, currentLivePrice);
      if (profitGuard.updated) {
        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
      }
      if (portfolioType === "ai" && profitGuard.triggered) {
        await Logger.info(
          `[${source}] ${asset} profit giveback guard closing. Peak open PnL $${profitGuard.peakPnl.toFixed(2)}, current $${profitGuard.netPnl.toFixed(2)}, giveback $${profitGuard.giveback.toFixed(2)}.`
        );
        await closePosition(portfolio, portfolioType, source, asset, pos, currentLivePrice, "TAKE_PROFIT", result, false);
        continue;
      }

      const sltp = RiskManager.checkStopLossOrTakeProfit(pos, currentLivePrice);

      if (sltp.triggered && sltp.reason) {
        await closePosition(portfolio, portfolioType, source, asset, pos, sltp.exitPrice, sltp.reason, result);
      } else if (checkSignalReversal) {
        const oppositeSignal = await getStrongOppositeSignal(asset, pos);
        if (oppositeSignal) {
          await Logger.info(
            `[${source}] ${asset} signal reversal detected. Current ${pos.direction} thesis invalidated by ${oppositeSignal.directionBias} setup at ${oppositeSignal.finalConviction} conviction.`
          );
          await closePosition(portfolio, portfolioType, source, asset, pos, currentLivePrice, "SIGNAL_REVERSAL", result, false);
        } else if (sltp.trailed) {
          if (sltp.newStopLoss) pos.stopLoss = sltp.newStopLoss;
          if (sltp.newTakeProfit) pos.takeProfit = sltp.newTakeProfit;
          await PortfolioManager.updatePortfolio(portfolio, portfolioType);
          await Logger.info(`[${source}] Trailed ${asset} levels. SL: $${pos.stopLoss.toFixed(4)}`);
          result.trailed++;
          await manageProfitableWinner(portfolio, portfolioType, source, asset, pos, currentLivePrice, result);
        }
      } else if (sltp.trailed) {
        if (sltp.newStopLoss) pos.stopLoss = sltp.newStopLoss;
        if (sltp.newTakeProfit) pos.takeProfit = sltp.newTakeProfit;
        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
        await Logger.info(`[${source}] Trailed ${asset} levels. SL: $${pos.stopLoss.toFixed(4)}`);
        result.trailed++;
        await manageProfitableWinner(portfolio, portfolioType, source, asset, pos, currentLivePrice, result);
      } else {
        await manageProfitableWinner(portfolio, portfolioType, source, asset, pos, currentLivePrice, result);
      }
    } catch (error) {
      result.errors++;
      await Logger.error(`[${source}] Sweep error on ${asset}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await redis.set(`swing:lastExitSweep:${portfolioType}`, result, { ex: 120 });
  return result;
}
