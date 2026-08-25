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
import {
  estimateCarryCostUsd,
  estimatePaperFill,
  PaperExecutionReason,
  PaperFillEstimate,
} from "@/lib/trading/executionCostModel";
import { ExecutionLedger, TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import { evaluatePortfolioRiskBudget } from "@/lib/trading/portfolioRiskBudget";
import {
  decideSwingExit,
  isOppositeEdgeConfirmed,
  isThesisWeakening,
} from "@/lib/execution/exitPolicy";

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
  portfolio.totalExecutionCostsPaid = portfolio.totalExecutionCostsPaid || portfolio.totalFeesPaid || 0;
  portfolio.totalCarryPaid = portfolio.totalCarryPaid || 0;
  portfolio.openPositions = portfolio.openPositions || {};
  portfolio.balances = portfolio.balances || {};
}

async function getLivePrice(asset: string): Promise<number> {
  return MarketService.getCurrentPrice(asset);
}

function buildCloseTrade(
  asset: string,
  pos: OpenPosition,
  exit: PaperFillEstimate,
  reason: NonNullable<Trade["exitReason"]>,
  grossPnl: number,
  netPnl: number,
  pnlPercent: number,
  entryFee: number,
  carryCost: number
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
    price: exit.fillPrice,
    requestedPrice: exit.requestedPrice,
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
    entryMode: pos.entryMode,
    learningAdjustment: pos.learningAdjustment,
    netRewardRiskRatio: pos.netRewardRiskRatio,
    strategyVersion: pos.strategyVersion || TRADING_STRATEGY_VERSION,
    marketRegime: pos.marketRegime || "UNKNOWN",
    executionCostModelVersion: exit.modelVersion,
    executionVenueModel: exit.venueModel,
    marketDataProvider: pos.marketDataProvider,
    marketDataSource: pos.marketDataSource,
    marketDataVenue: pos.marketDataVenue,
    marketDataInstrument: pos.marketDataInstrument,
    marketDataTimestamp: pos.marketDataTimestamp,
    marketDataBid: pos.marketDataBid,
    marketDataAsk: pos.marketDataAsk,
    notionalUsd: exit.notionalUsd,
    leverageUsed: pos.leverageUsed,
    marginMode: pos.marginMode,
    marginPolicyVersion: pos.marginPolicyVersion,
    riskAmountUsd: pos.riskAmountUsd,
    maxLossUsd: pos.maxLossUsd,
    entryFeeUsd: entryFee,
    exitFeeUsd: exit.feeUsd,
    grossPnlUsd: grossPnl,
    carryCostUsd: carryCost,
    executionCostUsd: exit.totalExecutionCostUsd + carryCost,
    entryExecutionCostUsd: pos.entryExecutionCostUsd,
    exitExecutionCostUsd: exit.totalExecutionCostUsd + carryCost,
    totalRoundTripExecutionCostUsd: Number(pos.entryExecutionCostUsd || entryFee) + exit.totalExecutionCostUsd + carryCost,
    spreadCostUsd: exit.spreadCostUsd,
    slippageCostUsd: exit.slippageCostUsd,
    gapCostUsd: exit.gapCostUsd,
    reasoning: `Swing exit triggered: ${reason.replaceAll("_", " ")} | Net PnL: $${netPnl.toFixed(2)}`,
    pnl: netPnl,
    pnlPercent,
    entryPrice: pos.entryPrice,
    entryTime: pos.entryTime,
    exitPrice: exit.fillPrice,
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

function cooldownSecondsForExit(
  reason: NonNullable<Trade["exitReason"]>,
  netPnl: number,
  entryMode?: OpenPosition["entryMode"]
): number {
  if (reason === "TAKE_PROFIT" || reason === "TRAILING_STOP_PROFIT" || reason === "SIGNAL_REVERSAL") return 0;
  if (netPnl >= 0) return 0;
  if (entryMode === "CONTROLLED_PROBE") return 4 * 60 * 60;
  if (reason === "STOP_LOSS") return 2 * 60 * 60;
  return 60 * 60;
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

function paperExitReason(reason: SwingCloseReason | "PARTIAL_EXIT" | "MARK"): PaperExecutionReason {
  if (reason === "STOP_LOSS") return "STOP_LOSS";
  if (reason === "TAKE_PROFIT") return "TAKE_PROFIT";
  if (reason === "SIGNAL_REVERSAL") return "SIGNAL_REVERSAL";
  if (reason === "SIGNAL_INVALIDATION") return "SIGNAL_INVALIDATION";
  if (reason === "PARTIAL_EXIT") return "PARTIAL_EXIT";
  return "MARK";
}

function estimatePositionExit(
  pos: OpenPosition,
  requestedPrice: number,
  amount: number,
  reason: SwingCloseReason | "PARTIAL_EXIT" | "MARK"
): PaperFillEstimate {
  return estimatePaperFill({
    asset: pos.asset,
    action: pos.direction === "SHORT" ? "COVER" : "SELL",
    requestedPrice,
    amount,
    context: {
      reason: paperExitReason(reason),
      assetMode: isCryptoFastAsset(pos.asset) ? "REALTIME_FAST" : "SLOW_SWING",
      dataQuality: pos.dataQuality,
      isPeakLiquidity: false,
      liquidityState: pos.liquidityState,
      orderbookImbalanceRatio: pos.orderbookImbalanceRatio,
    },
  });
}

function unrealizedNetPnl(asset: string, pos: OpenPosition, currentPrice: number): number {
  const exit = estimatePositionExit(pos, currentPrice, pos.amount, "MARK");
  const grossPnl = calculatePnlUsd(asset, pos.entryPrice, exit.fillPrice, pos.amount, pos.direction);
  const entryFee = pos.entryFeePaid ?? estimateFeeUsd(asset, pos.amount, pos.entryPrice);
  const carryCost = estimateCarryCostUsd({
    asset,
    notionalUsd: pos.notionalUsd ?? estimateNotionalUsd(asset, pos.amount, pos.entryPrice),
    openedAt: pos.entryTime,
    fundingRate: pos.fundingRate,
  });
  return grossPnl - entryFee - exit.feeUsd - carryCost;
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

async function reviewLiveThesis(asset: string, pos: OpenPosition, currentPrice: number) {
  const signal = await SwingEngine.analyze(asset);
  pos.lastThesisCheckTime = new Date().toISOString();

  if (isOppositeEdgeConfirmed(pos, signal)) {
    pos.thesisStatus = "OPPOSITE_EDGE_CONFIRMED";
    pos.thesisReason = `Opposite ${signal.directionBias.toLowerCase()} setup is stronger than the open ${pos.direction.toLowerCase()} trade: conviction ${signal.finalConviction}, trigger ${signal.triggerScore}, data ${signal.dataQuality}.`;
    pos.scaleInBlockedReason = "Opposite edge confirmed; scale-in disabled.";
    return { signal, oppositeEdgeConfirmed: true };
  }

  if (isThesisWeakening(pos, signal)) {
    // Recorded for the dashboard only. Weak opposing evidence no longer
    // tightens the stop: doing so closed trades inside ordinary noise.
    pos.thesisStatus = "WEAKENING";
    pos.thesisReason = "Live evidence is leaning against this trade, but not strongly enough to close it. The original protective stop still governs the risk.";
    pos.scaleInBlockedReason = "Live thesis is weakening; scale-in disabled until the trade proves itself again.";
    return { signal, oppositeEdgeConfirmed: false };
  }

  pos.thesisStatus = "VALID";
  pos.thesisReason = "Live thesis still matches the open trade closely enough to keep managing it normally.";
  pos.scaleInBlockedReason = undefined;
  return { signal, oppositeEdgeConfirmed: false };
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
  const exit = estimatePositionExit(pos, exitPrice, pos.amount, reason);
  const grossPnl = calculatePnlUsd(asset, pos.entryPrice, exit.fillPrice, pos.amount, pos.direction);
  const entryFee = pos.entryFeePaid ?? estimateFeeUsd(asset, pos.amount, pos.entryPrice);
  const carryCost = estimateCarryCostUsd({
    asset,
    notionalUsd: pos.notionalUsd ?? estimateNotionalUsd(asset, pos.amount, pos.entryPrice),
    openedAt: pos.entryTime,
    fundingRate: pos.fundingRate,
  });
  const netPnl = grossPnl - entryFee - exit.feeUsd - carryCost;
  const pnlPercent = pos.usdInvested > 0 ? (netPnl / pos.usdInvested) * 100 : 0;

  portfolio.usd += pos.usdInvested + entryFee + netPnl;
  portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + exit.feeUsd;
  portfolio.totalCarryPaid = (portfolio.totalCarryPaid || 0) + carryCost;
  portfolio.totalExecutionCostsPaid = (portfolio.totalExecutionCostsPaid || 0) + exit.totalExecutionCostUsd + carryCost;

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
  const cooldownSeconds = setCooldown ? cooldownSecondsForExit(exitReason, netPnl, pos.entryMode) : 0;
  if (cooldownSeconds > 0) {
    await redis.set(`swing:cooldown:${asset}`, "1", { ex: cooldownSeconds });
  }

  const closeTrade = buildCloseTrade(
    asset,
    pos,
    exit,
    exitReason,
    grossPnl,
    netPnl,
    pnlPercent,
    entryFee,
    carryCost
  );

  await PortfolioManager.updatePortfolio(portfolio, portfolioType);
  await PortfolioManager.logTrade(closeTrade, portfolioType);
  if (portfolioType === "ai" && pos.strategyType !== "manual" && !pos.isScalp) {
    await TradeReviewJournal.recordSwingClose(closeTrade, pos).catch((error) => {
      console.warn(`[${source}] Failed to record trade review for ${asset}:`, error);
    });
  }
  if (portfolioType === "ai") {
    await ExecutionLedger.recordBestEffort({
      type: "EXIT_FILLED",
      source,
      asset,
      tradeId: closeTrade.id,
      payload: { trade: closeTrade, position: pos, requestedExitPrice: exitPrice, exit },
    });
  }
  await Logger.info(
    `[${source}] ${asset} ${isShort ? "SHORT COVER" : "LONG SELL"} via ${exitReason} at ${exit.fillPrice.toFixed(6)}. Net PnL: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`
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
  const maxTotalMargin = equity * 0.40;
  const remainingRoom = Math.max(0, maxTotalMargin - activeMarginUsd(portfolio));
  const addMarginUsd = Math.min(portfolio.usd * 0.06, pos.usdInvested * 0.5, 600, remainingRoom);
  const leverage = Math.max(1, pos.leverageUsed || 1);
  if (!Number.isFinite(addMarginUsd) || addMarginUsd < 50) return false;

  const addNotionalUsd = addMarginUsd * leverage;
  const addAmount = amountFromNotionalUsd(asset, addNotionalUsd, currentPrice);
  if (addAmount <= 0) return false;
  const scaleFill = estimatePaperFill({
    asset,
    action: pos.direction === "SHORT" ? "SHORT" : "BUY",
    requestedPrice: currentPrice,
    amount: addAmount,
    context: {
      reason: "SCALE_IN",
      assetMode: isCryptoFastAsset(asset) ? "REALTIME_FAST" : "SLOW_SWING",
      dataQuality: pos.dataQuality,
      isPeakLiquidity: false,
      liquidityState: pos.liquidityState,
      orderbookImbalanceRatio: pos.orderbookImbalanceRatio,
    },
  });
  const entryFee = scaleFill.feeUsd;
  if (addMarginUsd + entryFee > portfolio.usd) return false;

  const existingNotional = estimateNotionalUsd(asset, pos.amount, pos.entryPrice);
  const existingAmount = pos.amount;
  const totalAmount = existingAmount + addAmount;
  const projectedEntryPrice = totalAmount > 0
    ? ((pos.entryPrice * existingAmount) + (scaleFill.fillPrice * addAmount)) / totalAmount
    : pos.entryPrice;
  const projectedPosition: OpenPosition = {
    ...pos,
    entryPrice: projectedEntryPrice,
    amount: totalAmount,
    btcAmount: totalAmount,
    entryFeePaid: (pos.entryFeePaid || 0) + entryFee,
  };
  const projectedTargetExit = estimatePositionExit(projectedPosition, pos.takeProfit, totalAmount, "TAKE_PROFIT");
  const projectedStopExit = estimatePositionExit(projectedPosition, pos.stopLoss, totalAmount, "STOP_LOSS");
  const projectedEntryFee = Number(projectedPosition.entryFeePaid || 0);
  const projectedGrossReward = calculatePnlUsd(asset, projectedEntryPrice, projectedTargetExit.fillPrice, totalAmount, pos.direction);
  const projectedGrossStop = calculatePnlUsd(asset, projectedEntryPrice, projectedStopExit.fillPrice, totalAmount, pos.direction);
  const projectedNetReward = projectedGrossReward - projectedEntryFee - projectedTargetExit.feeUsd;
  const projectedNetLoss = Math.abs(Math.min(0, projectedGrossStop - projectedEntryFee - projectedStopExit.feeUsd));
  const projectedPlan = {
    netRewardUsd: projectedNetReward,
    netLossUsd: projectedNetLoss,
    netRewardRiskRatio: projectedNetLoss > 0 ? projectedNetReward / projectedNetLoss : 0,
    targetExit: projectedTargetExit,
    stopExit: projectedStopExit,
  };
  if (projectedPlan.netRewardUsd <= 0 || projectedPlan.netRewardRiskRatio < 1.35) {
    pos.scaleInBlockedReason = "Scale-in would reduce modeled net reward/risk below 1.35.";
    return false;
  }
  const existingMaxLoss = Math.max(0, Number(pos.maxLossUsd || 0));
  const incrementalMaxLoss = Math.max(0, projectedPlan.netLossUsd - existingMaxLoss);
  const portfolioBudget = evaluatePortfolioRiskBudget({
    portfolio,
    trades: await PortfolioManager.getTrades("ai"),
    asset,
    direction: pos.direction,
    candidateNotionalUsd: scaleFill.notionalUsd,
    candidateMaxLossUsd: incrementalMaxLoss,
    candidateEntryCostUsd: scaleFill.totalExecutionCostUsd,
  });
  if (!portfolioBudget.approved) {
    pos.scaleInBlockedReason = portfolioBudget.reason;
    await ExecutionLedger.recordBestEffort({
      type: "RISK_CIRCUIT_BREAKER",
      source,
      asset,
      payload: { scope: "SCALE_IN", portfolioBudget, projectedPlan, scaleFill },
    });
    return false;
  }

  pos.entryPrice = projectedEntryPrice;
  pos.amount += addAmount;
  pos.btcAmount = pos.amount;
  pos.usdInvested += addMarginUsd;
  pos.notionalUsd = (pos.notionalUsd || existingNotional) + scaleFill.notionalUsd;
  pos.entryFeePaid = (pos.entryFeePaid || 0) + entryFee;
  pos.entryExecutionCostUsd = (pos.entryExecutionCostUsd || 0) + scaleFill.totalExecutionCostUsd;
  pos.entryPriceImpactCostUsd = (pos.entryPriceImpactCostUsd || 0) + scaleFill.priceImpactCostUsd;
  if (pos.direction === "LONG" && pos.stopLoss >= pos.entryPrice) {
    pos.stopLoss = pos.entryPrice * 0.995;
  } else if (pos.direction === "SHORT" && pos.stopLoss <= pos.entryPrice) {
    pos.stopLoss = pos.entryPrice * 1.005;
  }
  pos.maxLossUsd = projectedPlan.netLossUsd;
  pos.netRewardRiskRatio = projectedPlan.netRewardRiskRatio;
  pos.expectedNetRewardUsd = projectedPlan.netRewardUsd;
  pos.expectedNetLossUsd = projectedPlan.netLossUsd;
  pos.scaleInCount = (pos.scaleInCount || 0) + 1;
  pos.lastScaleInTime = new Date().toISOString();
  pos.paperSize = pos.paperSize === "Probe" ? "Normal" : pos.paperSize;
  pos.reasoning = `${pos.reasoning} | Scaled into profitable probe after live follow-through.`;

  portfolio.usd -= addMarginUsd + entryFee;
  portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + entryFee;
  portfolio.totalExecutionCostsPaid = (portfolio.totalExecutionCostsPaid || 0) + scaleFill.totalExecutionCostUsd;
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
    price: scaleFill.fillPrice,
    requestedPrice: currentPrice,
    usdValue: addMarginUsd,
    notionalUsd: scaleFill.notionalUsd,
    leverageUsed: leverage,
    marginMode: pos.marginMode,
    marginPolicyVersion: pos.marginPolicyVersion,
    riskAmountUsd: incrementalMaxLoss,
    maxLossUsd: projectedPlan.netLossUsd,
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
    strategyVersion: pos.strategyVersion || TRADING_STRATEGY_VERSION,
    marketRegime: pos.marketRegime || "UNKNOWN",
    executionCostModelVersion: scaleFill.modelVersion,
    executionVenueModel: scaleFill.venueModel,
    marketDataProvider: pos.marketDataProvider,
    marketDataSource: pos.marketDataSource,
    marketDataVenue: pos.marketDataVenue,
    marketDataInstrument: pos.marketDataInstrument,
    marketDataTimestamp: pos.marketDataTimestamp,
    marketDataBid: pos.marketDataBid,
    marketDataAsk: pos.marketDataAsk,
    entryFeeUsd: scaleFill.feeUsd,
    executionCostUsd: scaleFill.totalExecutionCostUsd,
    entryExecutionCostUsd: scaleFill.totalExecutionCostUsd,
    spreadCostUsd: scaleFill.spreadCostUsd,
    slippageCostUsd: scaleFill.slippageCostUsd,
    gapCostUsd: scaleFill.gapCostUsd,
    reasoning: `Scaled into profitable swing winner. Added $${addMarginUsd.toFixed(2)} margin after probe follow-through.`,
  };

  await PortfolioManager.updatePortfolio(portfolio, portfolioType);
  await PortfolioManager.logTrade(scaleTrade, portfolioType);
  await ExecutionLedger.recordBestEffort({
    type: "SCALE_IN_FILLED",
    source,
    asset,
    tradeId: scaleTrade.id,
    payload: { trade: scaleTrade, position: pos, portfolioBudget, projectedPlan, scaleFill },
  });
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
  const entryExecutionCostShare = (pos.entryExecutionCostUsd || entryFeeShare) * exitFraction;
  const entryPriceImpactShare = (pos.entryPriceImpactCostUsd || 0) * exitFraction;
  const previousNotional = pos.notionalUsd || estimateNotionalUsd(asset, pos.amount, pos.entryPrice);
  const partialExit = estimatePositionExit(pos, currentPrice, exitAmount, "PARTIAL_EXIT");
  const grossPnl = calculatePnlUsd(asset, pos.entryPrice, partialExit.fillPrice, exitAmount, pos.direction);
  const carryCost = estimateCarryCostUsd({
    asset,
    notionalUsd: previousNotional * exitFraction,
    openedAt: pos.entryTime,
    fundingRate: pos.fundingRate,
  });
  const netPnl = grossPnl - entryFeeShare - partialExit.feeUsd - carryCost;
  const pnlPercent = releasedMargin > 0 ? (netPnl / releasedMargin) * 100 : 0;

  pos.amount -= exitAmount;
  pos.btcAmount = pos.amount;
  pos.usdInvested -= releasedMargin;
  pos.entryFeePaid = Math.max(0, (pos.entryFeePaid || 0) - entryFeeShare);
  pos.entryExecutionCostUsd = Math.max(0, (pos.entryExecutionCostUsd || 0) - entryExecutionCostShare);
  pos.entryPriceImpactCostUsd = Math.max(0, (pos.entryPriceImpactCostUsd || 0) - entryPriceImpactShare);
  pos.notionalUsd = Math.max(0, previousNotional * (1 - exitFraction));
  const remainingStopExit = estimatePositionExit(pos, pos.stopLoss, pos.amount, "STOP_LOSS");
  const remainingStopPnl = calculatePnlUsd(asset, pos.entryPrice, remainingStopExit.fillPrice, pos.amount, pos.direction);
  pos.maxLossUsd = Math.abs(Math.min(0, remainingStopPnl - Number(pos.entryFeePaid || 0) - remainingStopExit.feeUsd));
  pos.partialExitCount = (pos.partialExitCount || 0) + 1;
  pos.lastPartialExitTime = new Date().toISOString();
  pos.isTrailing = true;

  portfolio.usd += releasedMargin + entryFeeShare + netPnl;
  portfolio.totalPnl += netPnl;
  portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + partialExit.feeUsd;
  portfolio.totalCarryPaid = (portfolio.totalCarryPaid || 0) + carryCost;
  portfolio.totalExecutionCostsPaid = (portfolio.totalExecutionCostsPaid || 0) + partialExit.totalExecutionCostUsd + carryCost;
  if (portfolio.returns) portfolio.returns.push(pnlPercent);
  if (portfolio.returns && portfolio.returns.length > 2000) portfolio.returns.shift();
  if (netPnl >= 0) portfolio.grossProfit = (portfolio.grossProfit || 0) + netPnl;
  else portfolio.grossLoss = (portfolio.grossLoss || 0) + Math.abs(netPnl);
  if (pos.direction === "LONG") {
    portfolio.balances[asset] = Math.max(0, (portfolio.balances[asset] || 0) - exitAmount);
  }

  const partialTrade = buildCloseTrade(
    asset,
    {
      ...pos,
      amount: exitAmount,
      btcAmount: exitAmount,
      usdInvested: releasedMargin,
      entryFeePaid: entryFeeShare,
      entryExecutionCostUsd: entryExecutionCostShare,
      entryPriceImpactCostUsd: entryPriceImpactShare,
    },
    partialExit,
    "TAKE_PROFIT",
    grossPnl,
    netPnl,
    pnlPercent,
    entryFeeShare,
    carryCost
  );
  partialTrade.reasoning = `Partial profit taken on swing winner. Closed ${(exitFraction * 100).toFixed(0)}% and left runner active. Net PnL: $${netPnl.toFixed(2)}`;
  partialTrade.isPartialExit = true;

  await PortfolioManager.updatePortfolio(portfolio, portfolioType);
  await PortfolioManager.logTrade(partialTrade, portfolioType);
  await ExecutionLedger.recordBestEffort({
    type: "PARTIAL_EXIT_FILLED",
    source,
    asset,
    tradeId: partialTrade.id,
    payload: { trade: partialTrade, position: pos, requestedExitPrice: currentPrice, partialExit },
  });
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

      // One watermark update, one hard stop/take-profit check, then a single
      // exit decision. Previously six guards raced each other here, each with
      // its own dollar thresholds, and the tightest one always won.
      const watermark = updateProfitWatermark(asset, pos, currentLivePrice);
      if (watermark.updated) {
        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
      }

      const sltp = RiskManager.checkStopLossOrTakeProfit(pos, currentLivePrice);
      if (sltp.triggered && sltp.reason) {
        await closePosition(portfolio, portfolioType, source, asset, pos, sltp.exitPrice, sltp.reason, result);
        continue;
      }

      if (repairInvalidProtectiveStop(pos, currentLivePrice)) {
        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
        await Logger.warn(
          `[${source}] Repaired invalid ${asset} ${pos.direction} protective stop after confirming no stop trigger. New SL: $${pos.stopLoss.toFixed(4)}`
        );
      }

      let oppositeEdgeConfirmed = false;
      if (checkSignalReversal) {
        const thesisReview = await reviewLiveThesis(asset, pos, currentLivePrice);
        oppositeEdgeConfirmed = thesisReview.oppositeEdgeConfirmed;
        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
      }

      const action = decideSwingExit({
        position: pos,
        currentPrice: currentLivePrice,
        netPnlUsd: watermark.netPnl,
        peakNetPnlUsd: watermark.peakPnl,
        oppositeEdgeConfirmed,
      });

      if (action.kind === "CLOSE") {
        // A reversal or giveback close is a decision, not a risk event, so it
        // does not put the asset into a post-loss cooldown.
        const setCooldown = action.reason === "SIGNAL_INVALIDATION";
        await Logger.info(`[${source}] ${asset} closing via ${action.reason}. ${action.explanation}`);
        await closePosition(
          portfolio, portfolioType, source, asset, pos, currentLivePrice, action.reason, result, setCooldown
        );
        continue;
      }

      if (action.kind === "MOVE_STOP") {
        pos.stopLoss = action.newStopLoss;
        if (action.trailing) pos.isTrailing = true;
        await PortfolioManager.updatePortfolio(portfolio, portfolioType);
        await Logger.info(`[${source}] ${asset} stop moved to $${pos.stopLoss.toFixed(4)}. ${action.explanation}`);
        result.trailed++;
      }

      await manageProfitableWinner(portfolio, portfolioType, source, asset, pos, currentLivePrice, result);
    } catch (error) {
      result.errors++;
      await Logger.error(`[${source}] Sweep error on ${asset}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await redis.set(`swing:lastExitSweep:${portfolioType}`, result, { ex: 120 });
  return result;
}
