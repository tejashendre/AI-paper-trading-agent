import crypto from "crypto";
import { MarketService } from "@/lib/market";
import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { getRedis } from "@/lib/redis";
import { RiskManager } from "@/lib/riskManager";
import { OpenPosition, Portfolio, Trade } from "@/lib/types";
import { amountFromNotionalUsd, calculatePnlUsd, estimateFeeUsd, estimateNotionalUsd } from "@/lib/trading/assetSpecs";
import { SwingEngine, SwingSignal } from "@/lib/swingEngine";
import { LocalLearningMemory } from "@/lib/trading/localLearning";
import { TradeReviewJournal } from "@/lib/trading/tradeReviewJournal";

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

type SwingCloseReason = "STOP_LOSS" | "TAKE_PROFIT" | "SIGNAL_REVERSAL" | "SIGNAL_INVALIDATION";

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

function classifyExitReason(pos: OpenPosition, reason: SwingCloseReason, netPnl: number): NonNullable<Trade["exitReason"]> {
  if (reason === "SIGNAL_REVERSAL") return "SIGNAL_REVERSAL";
  if (reason === "SIGNAL_INVALIDATION") return "SIGNAL_INVALIDATION";
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

function repairInvalidProtectiveStop(pos: OpenPosition, currentPrice: number): boolean {
  const reference = Math.max(currentPrice, pos.entryPrice, 1e-9);
  const minBufferPercent = 0.001;

  if (pos.direction === "SHORT" && pos.stopLoss <= currentPrice) {
    const repairedStop = Math.max(currentPrice * (1 + minBufferPercent), pos.entryPrice * (1 + minBufferPercent));
    pos.stopLoss = repairedStop;
    pos.isTrailing = true;
    return true;
  }

  if (pos.direction === "LONG" && pos.stopLoss >= currentPrice) {
    const repairedStop = Math.min(currentPrice * (1 - minBufferPercent), pos.entryPrice * (1 - minBufferPercent));
    pos.stopLoss = Math.max(repairedStop, reference * 0.01);
    pos.isTrailing = true;
    return true;
  }

  return false;
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

function shouldCloseOnPlannedRiskBreach(asset: string, pos: OpenPosition, currentPrice: number) {
  const plannedMaxLoss = Number(pos.maxLossUsd || 0);
  if (!Number.isFinite(plannedMaxLoss) || plannedMaxLoss <= 0) {
    return { triggered: false, netPnl: unrealizedNetPnl(asset, pos, currentPrice), plannedMaxLoss };
  }

  const netPnl = unrealizedNetPnl(asset, pos, currentPrice);
  const breachLimit = Math.max(5, plannedMaxLoss * 1.25);
  return {
    triggered: netPnl <= -breachLimit,
    netPnl,
    plannedMaxLoss,
    breachLimit,
  };
}

function shouldCloseWeakThesisProfitDecay(asset: string, pos: OpenPosition, currentPrice: number) {
  if (pos.thesisStatus !== "WEAKENING") {
    return { triggered: false, netPnl: unrealizedNetPnl(asset, pos, currentPrice), peakPnl: Number(pos.maxUnrealizedPnlUsd || 0), giveback: 0, givebackLimit: Infinity };
  }

  const netPnl = unrealizedNetPnl(asset, pos, currentPrice);
  const peakPnl = Number(pos.maxUnrealizedPnlUsd || 0);
  const giveback = peakPnl - netPnl;
  const givebackLimit = Math.max(2, peakPnl * 0.25);
  const triggered = (
    peakPnl >= 8 &&
    netPnl > 0 &&
    (
      giveback >= givebackLimit ||
      (peakPnl >= 12 && netPnl <= peakPnl * 0.55)
    )
  );

  return {
    triggered,
    netPnl,
    peakPnl,
    giveback,
    givebackLimit,
  };
}

function shouldCloseWeakThesisLossCompression(asset: string, pos: OpenPosition, currentPrice: number) {
  const netPnl = unrealizedNetPnl(asset, pos, currentPrice);
  const plannedMaxLoss = Number(pos.maxLossUsd || 0);
  const thesisWeak = (
    pos.thesisStatus === "WEAKENING" ||
    pos.thesisStatus === "INVALID" ||
    pos.thesisStatus === "OPPOSITE_EDGE_CONFIRMED"
  );

  if (!thesisWeak || !Number.isFinite(plannedMaxLoss) || plannedMaxLoss <= 0) {
    return { triggered: false, netPnl, plannedMaxLoss, lossLimit: Infinity };
  }

  const weakDataPenalty = Number(pos.dataQuality || 100) < 70 ? 0.45 : 0.55;
  const lossLimit = Math.max(8, plannedMaxLoss * weakDataPenalty);

  return {
    triggered: netPnl < 0 && Math.abs(netPnl) >= lossLimit,
    netPnl,
    plannedMaxLoss,
    lossLimit,
  };
}

function isOppositeSignalStrong(pos: OpenPosition, signal: SwingSignal) {
  const oppositeLong = pos.direction === "SHORT" && signal.action === "SWING_BUY";
  const oppositeShort = pos.direction === "LONG" && signal.action === "SWING_SHORT";
  if (!oppositeLong && !oppositeShort) return false;

  const convictionGap = signal.finalConviction - Number(pos.finalConviction || 0);
  const isFastCrypto = isCryptoFastAsset(pos.asset);
  const requiredConviction = isFastCrypto
    ? Math.max(72, Number(pos.finalConviction || 0) + 6)
    : Math.max(82, Number(pos.finalConviction || 0) + 10);

  return (
    signal.dataQuality >= (isFastCrypto ? 80 : 74) &&
    signal.triggerScore >= (isFastCrypto ? 16 : 12) &&
    signal.finalConviction >= requiredConviction &&
    convictionGap >= (isFastCrypto ? 6 : 10) &&
    signal.htfScore >= (isFastCrypto ? 8 : 10) &&
    signal.slippagePercent <= (isFastCrypto ? 0.25 : 0.35)
  );
}

function isOppositeSignalPresent(pos: OpenPosition, signal: SwingSignal) {
  return (
    (pos.direction === "SHORT" && signal.action === "SWING_BUY") ||
    (pos.direction === "LONG" && signal.action === "SWING_SHORT")
  );
}

function tightenStopForWeakThesis(pos: OpenPosition, currentPrice: number): boolean {
  const bufferPercent = isCryptoFastAsset(pos.asset) ? 0.0035 : 0.0045;

  if (pos.direction === "LONG") {
    const tightenedStop = currentPrice * (1 - bufferPercent);
    if (tightenedStop > pos.stopLoss && tightenedStop < currentPrice) {
      pos.stopLoss = tightenedStop;
      pos.isTrailing = true;
      return true;
    }
    return false;
  }

  const tightenedStop = currentPrice * (1 + bufferPercent);
  if (tightenedStop < pos.stopLoss && tightenedStop > currentPrice) {
    pos.stopLoss = tightenedStop;
    pos.isTrailing = true;
    return true;
  }

  return false;
}

async function reviewLiveThesis(asset: string, pos: OpenPosition, currentPrice: number) {
  const signal = await SwingEngine.analyze(asset);
  const netPnl = unrealizedNetPnl(asset, pos, currentPrice);
  const learning = await LocalLearningMemory.getAdjustment(asset, pos.setupTags || []).catch(() => ({
    adjustment: 0,
    watchOnly: false,
    rules: [],
  }));

  const checkedAt = new Date().toISOString();
  pos.lastThesisCheckTime = checkedAt;

  if (isOppositeSignalStrong(pos, signal)) {
    pos.thesisStatus = "OPPOSITE_EDGE_CONFIRMED";
    pos.thesisReason = `Opposite ${signal.directionBias.toLowerCase()} setup is stronger than the open ${pos.direction.toLowerCase()} trade: conviction ${signal.finalConviction}, trigger ${signal.triggerScore}, data ${signal.dataQuality}.`;
    pos.scaleInBlockedReason = "Opposite edge confirmed; scale-in disabled.";
    return { signal, shouldClose: true, tightened: false, updated: true, netPnl };
  }

  const oppositeSignalPresent = isOppositeSignalPresent(pos, signal);
  const oppositeConviction = oppositeSignalPresent && signal.finalConviction >= Math.max(62, Number(pos.finalConviction || 0) - 4);
  const learningWarning = learning.watchOnly || learning.adjustment <= -10;
  const shouldTighten = (oppositeConviction || learningWarning) && netPnl <= 20;

  if (oppositeConviction || learningWarning) {
    pos.thesisStatus = "WEAKENING";
    pos.thesisReason = oppositeConviction
      ? `Live market evidence is pushing against the open ${pos.direction.toLowerCase()} trade, but the opposite edge is not strong enough to force a close yet.`
      : `Local learning has reduced trust in this asset/setup, so the bot is protecting the trade more tightly.`;
    pos.scaleInBlockedReason = "Live thesis is weakening; scale-in disabled until the trade proves itself again.";
    const tightened = shouldTighten ? tightenStopForWeakThesis(pos, currentPrice) : false;
    return { signal, shouldClose: false, tightened, updated: true, netPnl };
  }

  pos.thesisStatus = "VALID";
  pos.thesisReason = "Live thesis still matches the open trade closely enough to keep managing it normally.";
  pos.scaleInBlockedReason = undefined;
  return { signal, shouldClose: false, tightened: false, updated: true, netPnl };
}

async function closePosition(
  portfolio: Portfolio,
  portfolioType: "ai" | "user",
  source: string,
  asset: string,
  pos: OpenPosition,
  exitPrice: number,
  reason: SwingCloseReason,
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
  if (portfolioType === "ai" && pos.strategyType !== "manual" && !pos.isScalp) {
    await TradeReviewJournal.recordSwingClose(closeTrade, pos).catch((error) => {
      console.warn(`[${source}] Failed to record trade review for ${asset}:`, error);
    });
  }
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
  if (pos.scaleInBlockedReason) return false;
  if (pos.thesisStatus && pos.thesisStatus !== "VALID") return false;
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
        continue;
      }

      const riskBreach = shouldCloseOnPlannedRiskBreach(asset, pos, currentLivePrice);
      if (portfolioType === "ai" && riskBreach.triggered) {
        await Logger.warn(
          `[${source}] ${asset} planned risk breach closing. Net PnL $${riskBreach.netPnl.toFixed(2)} exceeded planned max loss $${riskBreach.plannedMaxLoss.toFixed(2)}.`
        );
        await closePosition(portfolio, portfolioType, source, asset, pos, currentLivePrice, "STOP_LOSS", result);
        continue;
      }

      if (repairInvalidProtectiveStop(pos, currentLivePrice)) {
        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
        await Logger.warn(
          `[${source}] Repaired invalid ${asset} ${pos.direction} protective stop after confirming no stop trigger. New SL: $${pos.stopLoss.toFixed(4)}`
        );
      }

      if (checkSignalReversal) {
        const thesisReview = await reviewLiveThesis(asset, pos, currentLivePrice);
        if (thesisReview.shouldClose) {
          await Logger.info(
            `[${source}] ${asset} signal reversal detected. Current ${pos.direction} thesis invalidated by ${thesisReview.signal.directionBias} setup at ${thesisReview.signal.finalConviction} conviction.`
          );
          await closePosition(portfolio, portfolioType, source, asset, pos, currentLivePrice, "SIGNAL_REVERSAL", result, false);
        } else {
          const weakLossGuard = shouldCloseWeakThesisLossCompression(asset, pos, currentLivePrice);
          if (portfolioType === "ai" && weakLossGuard.triggered) {
            await Logger.warn(
              `[${source}] ${asset} weak-thesis loss compression closing. Net PnL $${weakLossGuard.netPnl.toFixed(2)} reached $${weakLossGuard.lossLimit.toFixed(2)} soft-loss limit before full planned loss $${weakLossGuard.plannedMaxLoss.toFixed(2)}.`
            );
            await closePosition(portfolio, portfolioType, source, asset, pos, currentLivePrice, "SIGNAL_INVALIDATION", result);
            continue;
          }

          const weakProfitGuard = shouldCloseWeakThesisProfitDecay(asset, pos, currentLivePrice);
          if (portfolioType === "ai" && weakProfitGuard.triggered) {
            await Logger.info(
              `[${source}] ${asset} weak-thesis profit guard closing. Peak $${weakProfitGuard.peakPnl.toFixed(2)}, current $${weakProfitGuard.netPnl.toFixed(2)}, giveback $${weakProfitGuard.giveback.toFixed(2)}.`
            );
            await closePosition(portfolio, portfolioType, source, asset, pos, currentLivePrice, "TAKE_PROFIT", result, false);
          } else if (thesisReview.tightened) {
            await PortfolioManager.updatePortfolio(portfolio, portfolioType);
            await Logger.warn(
              `[${source}] ${asset} thesis weakening. Tightened protective stop to $${pos.stopLoss.toFixed(4)} instead of waiting for full stop loss.`
            );
            result.trailed++;
          } else if (sltp.trailed) {
            if (sltp.newStopLoss) pos.stopLoss = sltp.newStopLoss;
            if (sltp.newTakeProfit) pos.takeProfit = sltp.newTakeProfit;
            await PortfolioManager.updatePortfolio(portfolio, portfolioType);
            if (sltp.newStopLoss || sltp.newTakeProfit) {
              await Logger.info(`[${source}] Trailed ${asset} levels. SL: $${pos.stopLoss.toFixed(4)}`);
              result.trailed++;
            }
            await manageProfitableWinner(portfolio, portfolioType, source, asset, pos, currentLivePrice, result);
          } else if (thesisReview.updated) {
            await PortfolioManager.updatePortfolio(portfolio, portfolioType);
            await manageProfitableWinner(portfolio, portfolioType, source, asset, pos, currentLivePrice, result);
          }
        }
      } else if (sltp.trailed) {
        if (sltp.newStopLoss) pos.stopLoss = sltp.newStopLoss;
        if (sltp.newTakeProfit) pos.takeProfit = sltp.newTakeProfit;
        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
        if (sltp.newStopLoss || sltp.newTakeProfit) {
          await Logger.info(`[${source}] Trailed ${asset} levels. SL: $${pos.stopLoss.toFixed(4)}`);
          result.trailed++;
        }
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
