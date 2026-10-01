import crypto from "crypto";
import { entryInstrumentFor, MarketService } from "@/lib/market";
import { validateExitQuote } from "@/lib/trading/entryEligibility";
import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { getRedis } from "@/lib/redis";
import { RiskManager } from "@/lib/riskManager";
import { OpenPosition, Portfolio, Trade } from "@/lib/types";
import {
  calculateInstrumentPnl,
  decimalString,
  floorOrderQty,
  instrumentFee,
  instrumentNotional,
  instrumentQuantityFromNotional,
  positionInstrument,
  positionLegIdentity,
  validateOrderSize,
} from "@/lib/trading/assetSpecs";
import { evaluateFillCapacity } from "@/lib/execution/liquidityCost";
import { SwingEngine, SwingSignal } from "@/lib/swingEngine";
import { LocalLearningMemory } from "@/lib/trading/localLearning";
import { TradeReviewJournal } from "@/lib/trading/tradeReviewJournal";
import {
  estimateCarryCostUsd,
  estimatePaperFill,
  FundingCashflowEvent,
  FundingDeps,
  PaperExecutionReason,
  PaperFillEstimate,
  planFundingCashflows,
  quantityHeldAt,
  expectedFundingTimes,
} from "@/lib/trading/executionCostModel";
import { liveFundingDeps } from "@/lib/data/bybitPublic";
import { buildPositionOutcomes, CompletedPositionOutcome, outcomeSourceHash } from "@/lib/trading/positionOutcomes";
import { ExecutionLedger, ExecutionLedgerEventInput, TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import { evaluatePortfolioRiskBudget } from "@/lib/trading/portfolioRiskBudget";
import {
  decideSwingExit,
  isOppositeEdgeConfirmed,
  isThesisWeakening,
  PARTIAL_PROFIT_POLICY,
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

// Position economics come from the model frozen on the position, so a legacy
// position keeps its own quantity unit and P&L formula after the upgrade.
function positionPnl(pos: OpenPosition, entryPrice: number, exitPrice: number, quantity: number): number {
  return calculateInstrumentPnl({ instrument: positionInstrument(pos), entryPrice, exitPrice, quantity, direction: pos.direction });
}

function positionNotional(pos: OpenPosition, quantity: number, price: number): number {
  return instrumentNotional(positionInstrument(pos), quantity, price);
}

function positionEntryFee(pos: OpenPosition): number {
  return pos.entryFeePaid ?? instrumentFee(positionInstrument(pos), pos.amount, pos.entryPrice);
}

const isLinearPosition = (pos: OpenPosition) => positionInstrument(pos).economicsModel === "BYBIT_LINEAR_USDT_V1";

/** Funding events for one quantity history, from entry up to `toMs`. */
async function planPositionFunding(
  input: {
    positionId: string;
    symbol: string;
    direction: OpenPosition["direction"];
    legs: Array<{ atMs: number; quantityDelta: number }>;
    settledTimes: number[];
    toMs: number;
  },
  deps: FundingDeps
) {
  const fromMs = Math.min(...input.legs.map((leg) => leg.atMs));
  const intervalMinutes = await deps.intervalMinutes(input.symbol);
  const settled = new Set(input.settledTimes);
  const due = expectedFundingTimes(fromMs, input.toMs, intervalMinutes)
    .filter((at) => !settled.has(at) && quantityHeldAt(input.legs, at) > 0);
  if (due.length === 0) return { events: [], pendingTimes: [], absentTimes: [] };
  let settlements: Awaited<ReturnType<FundingDeps["settlements"]>> = [];
  let fetchSucceeded = true;
  try {
    settlements = await deps.settlements(input.symbol, Math.min(...due) - 1, input.toMs);
  } catch {
    fetchSucceeded = false;
  }
  return planFundingCashflows({
    positionId: input.positionId,
    symbol: input.symbol,
    positionAt: (atMs) => ({ direction: input.direction, quantity: quantityHeldAt(input.legs, atMs) }),
    settlements,
    settledTimes: input.settledTimes,
    fromMs,
    toMs: input.toMs,
    intervalMinutes,
    nowMs: deps.nowMs(),
    fetchSucceeded,
  });
}

/**
 * Book funding for every open Bybit linear position, and for closed ones
 * still awaiting settlement data. Mutates only the portfolio: cash, each
 * position's processed boundaries and the pending ledger events change
 * together, so one portfolio write persists all three. Legacy positions keep
 * the synthetic carry path and are skipped.
 */
export async function settleOpenPositionFunding(
  portfolio: Portfolio,
  deps: FundingDeps = liveFundingDeps,
  options: { onlyAsset?: string; recordLedger?: boolean } = {}
): Promise<{ booked: number; pending: number; errors: string[] }> {
  const now = deps.nowMs();
  const recordLedger = options.recordLedger !== false;
  let booked = 0;
  let pending = 0;
  const errors: string[] = [];
  const book = (event: FundingCashflowEvent, asset: string) => {
    portfolio.usd += event.amountUsdt;
    portfolio.totalCarryPaid = (portfolio.totalCarryPaid || 0) - event.amountUsdt;
    if (recordLedger) {
      (portfolio.pendingLedgerEvents ??= []).push({
        id: event.id,
        type: "FUNDING_SETTLED",
        source: "FUNDING_SETTLEMENT",
        asset,
        positionId: event.positionId,
        timestamp: new Date(now).toISOString(),
        payload: event,
      });
    }
    booked += 1;
  };

  for (const [asset, pos] of Object.entries(portfolio.openPositions || {})) {
    if (options.onlyAsset && asset !== options.onlyAsset) continue;
    if (!isLinearPosition(pos) || !pos.positionId || !pos.quantityLegs?.length) continue;
    try {
      const plan = await planPositionFunding({
        positionId: pos.positionId,
        symbol: positionInstrument(pos).symbol,
        direction: pos.direction,
        legs: pos.quantityLegs,
        settledTimes: pos.fundingSettledTimes ?? [],
        toMs: now,
      }, deps);
      for (const event of plan.events) {
        book(event, asset);
        pos.fundingBookedUsdt = (pos.fundingBookedUsdt ?? 0) + event.amountUsdt;
        (pos.fundingSettledTimes ??= []).push(event.settlementTimeMs);
      }
      // A boundary the venue confirmably did not settle is processed at zero.
      if (plan.absentTimes.length > 0) (pos.fundingSettledTimes ??= []).push(...plan.absentTimes);
      pos.fundingPendingTimes = plan.pendingTimes;
      pending += plan.pendingTimes.length;
    } catch (error) {
      errors.push(`${asset}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const tail of portfolio.fundingTail ?? []) {
    if (options.onlyAsset && tail.asset !== options.onlyAsset) continue;
    try {
      const plan = await planPositionFunding({
        positionId: tail.positionId,
        symbol: tail.symbol,
        direction: tail.direction,
        legs: tail.quantityLegs,
        settledTimes: tail.settledTimes,
        toMs: tail.closedAtMs,
      }, deps);
      for (const event of plan.events) {
        book(event, tail.asset);
        tail.settledTimes.push(event.settlementTimeMs);
      }
      tail.settledTimes.push(...plan.absentTimes);
      tail.pendingTimes = plan.pendingTimes;
      pending += plan.pendingTimes.length;
    } catch (error) {
      errors.push(`${tail.asset} (closed): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (portfolio.fundingTail) portfolio.fundingTail = portfolio.fundingTail.filter((tail) => tail.pendingTimes.length > 0);
  return { booked, pending, errors };
}

/**
 * Cash and reported result of closing `fraction` of a position. Linear
 * positions already booked their funding to cash at each settlement, so it is
 * attributed to the exit leg for reporting and never debited again. Legacy
 * positions keep the modeled carry charged at exit.
 */
export function exitCashSettlement(input: {
  pos: OpenPosition;
  fraction: number;
  grossPnl: number;
  exitFeeUsd: number;
  legacyCarryUsd: number;
}) {
  const { pos, fraction } = input;
  const releasedMargin = pos.usdInvested * fraction;
  const entryFeeShare = positionEntryFee(pos) * fraction;
  if (isLinearPosition(pos)) {
    const fundingAllocatedUsdt = ((pos.fundingBookedUsdt ?? 0) - (pos.fundingAllocatedUsdt ?? 0)) * fraction;
    const netPnl = input.grossPnl - entryFeeShare - input.exitFeeUsd + fundingAllocatedUsdt;
    return {
      releasedMargin,
      entryFeeShare,
      fundingAllocatedUsdt,
      carryCostUsd: -fundingAllocatedUsdt,
      netPnl,
      cashDelta: releasedMargin + entryFeeShare + netPnl - fundingAllocatedUsdt,
    };
  }
  const netPnl = input.grossPnl - entryFeeShare - input.exitFeeUsd - input.legacyCarryUsd;
  return {
    releasedMargin,
    entryFeeShare,
    fundingAllocatedUsdt: 0,
    carryCostUsd: input.legacyCarryUsd,
    netPnl,
    cashDelta: releasedMargin + entryFeeShare + netPnl,
  };
}

interface LedgerSink {
  hasEvent(id: string, sinceIso: string): boolean | Promise<boolean>;
  record(input: ExecutionLedgerEventInput): Promise<unknown>;
}

const executionLedgerSink: LedgerSink = {
  hasEvent: (id, sinceIso) => ExecutionLedger.hasEvent(id, sinceIso),
  record: (input) => ExecutionLedger.record(input),
};

/**
 * Append pending events to the hash ledger with their immutable ids, one at
 * a time, persisting after each. An id the ledger already holds (a crash
 * between append and persist) is acknowledged without appending again. If
 * the persist fails, the in-memory list is restored to what was persisted.
 */
export async function drainPendingLedgerEvents(
  portfolio: Portfolio,
  ledger: LedgerSink = executionLedgerSink,
  persist: () => Promise<void>
): Promise<number> {
  let appended = 0;
  while ((portfolio.pendingLedgerEvents?.length ?? 0) > 0) {
    const event = portfolio.pendingLedgerEvents![0];
    if (!(await ledger.hasEvent(event.id, event.timestamp))) {
      await ledger.record({
        id: event.id,
        type: event.type,
        source: event.source,
        asset: event.asset,
        positionId: event.positionId,
        payload: event.payload,
      });
      appended += 1;
    }
    portfolio.pendingLedgerEvents!.shift();
    try {
      await persist();
    } catch (error) {
      portfolio.pendingLedgerEvents!.unshift(event);
      throw error;
    }
  }
  return appended;
}

/** Book due funding, persist, then drain the resulting ledger events. */
export async function settleAndPersistFunding(portfolio: Portfolio, portfolioType: "ai" | "user", source: string) {
  const outcome = await settleOpenPositionFunding(portfolio, liveFundingDeps, { recordLedger: portfolioType === "ai" });
  if (outcome.booked > 0) {
    await PortfolioManager.updatePortfolio(portfolio, portfolioType);
    await Logger.info(`[${source}] booked ${outcome.booked} funding settlement(s).`);
  }
  if (outcome.pending > 0 || outcome.errors.length > 0) {
    await Logger.warn(`[${source}] funding pending reconciliation: ${outcome.pending} boundary(ies). ${outcome.errors.join("; ")}`.trim());
  }
  if (portfolioType === "ai") {
    await drainPendingLedgerEvents(portfolio, executionLedgerSink, () => PortfolioManager.updatePortfolio(portfolio, portfolioType));
  }
  return outcome;
}

/**
 * A price an exit may act on: the asset's own Bybit instrument, fresh, with
 * correct provenance. Entry warm-up and learning vetoes never apply here.
 * An invalid quote returns NaN, so the position is kept and retried next sweep.
 */
async function getLivePrice(asset: string): Promise<number> {
  const quote = await MarketService.getCurrentPriceSnapshot(asset);
  const check = validateExitQuote({ instrument: entryInstrumentFor(asset), quote, nowMs: Date.now() });
  if (!check.valid) {
    await Logger.warn(`[SWING EXIT] ${asset} quote not usable for exits: ${check.reasons.join("; ")}`).catch(() => undefined);
    return Number.NaN;
  }
  return quote.price;
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
    ...positionLegIdentity(pos),
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
    strategyFamily: pos.strategyFamily, strategyConfigHash: pos.strategyConfigHash,
    strategyDataSchemaVersion: pos.strategyDataSchemaVersion, strategyRegime: pos.strategyRegime,
    candidateId: pos.candidateId, featureCutoffMs: pos.featureCutoffMs,
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
    instrument: positionInstrument(pos),
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
  const grossPnl = positionPnl(pos, pos.entryPrice, exit.fillPrice, pos.amount);
  const entryFee = positionEntryFee(pos);
  // Linear positions book funding to cash at each settlement; only legacy
  // positions carry a modeled charge until exit.
  const carryCost = isLinearPosition(pos) ? 0 : estimateCarryCostUsd({
    asset,
    notionalUsd: pos.notionalUsd ?? positionNotional(pos, pos.amount, pos.entryPrice),
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
    : Math.abs(positionPnl(pos, pos.entryPrice, pos.stopLoss, pos.amount));
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
  const linear = isLinearPosition(pos);
  // Every boundary up to now is booked before the position leaves the book;
  // a settlement that is not yet published follows it as a funding tail.
  if (linear) {
    await settleOpenPositionFunding(portfolio, liveFundingDeps, { onlyAsset: asset, recordLedger: portfolioType === "ai" })
      .catch((error) => console.warn(`[${source}] funding catch-up failed for ${asset}:`, error));
  }
  const exit = estimatePositionExit(pos, exitPrice, pos.amount, reason);
  const grossPnl = positionPnl(pos, pos.entryPrice, exit.fillPrice, pos.amount);
  const entryFee = positionEntryFee(pos);
  const settlement = exitCashSettlement({
    pos,
    fraction: 1,
    grossPnl,
    exitFeeUsd: exit.feeUsd,
    legacyCarryUsd: linear ? 0 : estimateCarryCostUsd({
      asset,
      notionalUsd: pos.notionalUsd ?? positionNotional(pos, pos.amount, pos.entryPrice),
      openedAt: pos.entryTime,
      fundingRate: pos.fundingRate,
    }),
  });
  const carryCost = settlement.carryCostUsd;
  const netPnl = settlement.netPnl;
  const pnlPercent = pos.usdInvested > 0 ? (netPnl / pos.usdInvested) * 100 : 0;

  portfolio.usd += settlement.cashDelta;
  portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + exit.feeUsd;
  // Linear funding was counted in the carry totals when it was booked.
  const exitCarry = linear ? 0 : carryCost;
  portfolio.totalCarryPaid = (portfolio.totalCarryPaid || 0) + exitCarry;
  portfolio.totalExecutionCostsPaid = (portfolio.totalExecutionCostsPaid || 0) + exit.totalExecutionCostUsd + exitCarry;
  const closedAtMs = Date.now();
  if (linear && pos.positionId && pos.quantityLegs?.length && (pos.fundingPendingTimes?.length ?? 0) > 0) {
    (portfolio.fundingTail ??= []).push({
      positionId: pos.positionId,
      asset,
      symbol: positionInstrument(pos).symbol,
      direction: pos.direction,
      quantityLegs: [...pos.quantityLegs, { atMs: closedAtMs, quantityDelta: -pos.amount }],
      settledTimes: [...(pos.fundingSettledTimes ?? [])],
      pendingTimes: [...(pos.fundingPendingTimes ?? [])],
      closedAtMs,
    });
  }

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
  if (linear) {
    closeTrade.fundingCashflowUsdt = settlement.fundingAllocatedUsdt;
    closeTrade.fundingStatus = (pos.fundingPendingTimes?.length ?? 0) > 0 ? "PENDING_RECONCILIATION" : "SETTLED";
  }

  await PortfolioManager.updatePortfolio(portfolio, portfolioType);
  await PortfolioManager.logTrade(closeTrade, portfolioType);
  if (portfolioType === "ai") {
    await drainPendingLedgerEvents(portfolio, executionLedgerSink, () => PortfolioManager.updatePortfolio(portfolio, portfolioType))
      .catch((error) => console.warn(`[${source}] funding ledger drain deferred:`, error));
  }
  // The fill is recorded before the completion it causes, so a ledger reader
  // never sees a position completed by an exit that is not yet in the chain.
  if (portfolioType === "ai") {
    await ExecutionLedger.recordBestEffort({
      type: "EXIT_FILLED",
      source,
      asset,
      tradeId: closeTrade.id,
      positionId: pos.positionId,
      payload: { trade: closeTrade, position: pos, requestedExitPrice: exitPrice, exit },
    });
  }
  const outcome = await completePositionOutcome(portfolio, portfolioType, closeTrade, source);
  if (portfolioType === "ai" && pos.strategyType !== "manual" && !pos.isScalp) {
    await TradeReviewJournal.recordSwingClose(closeTrade, pos, outcome).catch((error) => {
      console.warn(`[${source}] Failed to record trade review for ${asset}:`, error);
    });
  }
  await Logger.info(
    `[${source}] ${asset} ${isShort ? "SHORT COVER" : "LONG SELL"} via ${exitReason} at ${exit.fillPrice.toFixed(6)}. Net PnL: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`
  );

  result.closed++;
  if (reason === "SIGNAL_REVERSAL") result.signalReversals++;
}

/**
 * The closed position's single economic outcome, built from all of its legs
 * (partial exits included), persisted once with its source-event hash and
 * announced once in the ledger. Returns null when the legs cannot be
 * reconciled; the conflict is then visible in learning summaries.
 */
async function completePositionOutcome(
  portfolio: Portfolio,
  portfolioType: "ai" | "user",
  closeTrade: Trade,
  source: string
): Promise<CompletedPositionOutcome | null> {
  try {
    const trades = await PortfolioManager.getTrades(portfolioType);
    const { completed } = buildPositionOutcomes({
      trades: [closeTrade, ...trades],
      openPositions: Object.values(portfolio.openPositions || {}),
    });
    const outcome = completed.find((candidate) => candidate.legIds.includes(closeTrade.id)) ?? null;
    if (!outcome) return null;
    const firstRecord = await PortfolioManager.recordPositionOutcome(outcome, portfolioType);
    const eventId = `position-completed:${outcome.positionId}`;
    if (firstRecord && portfolioType === "ai" && !ExecutionLedger.hasEvent(eventId, new Date(outcome.openedAtMs).toISOString())) {
      await ExecutionLedger.recordBestEffort({
        id: eventId,
        type: "POSITION_COMPLETED",
        source,
        asset: outcome.asset,
        positionId: outcome.positionId,
        payload: { outcome, sourceEventHash: outcomeSourceHash(outcome) },
      });
    }
    return outcome;
  } catch (error) {
    console.warn(`[${source}] position outcome not recorded:`, error);
    return null;
  }
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
  // Only Bybit linear positions may grow: adding venue-priced quantity to a
  // legacy-model position would mix two quantity units in one position.
  const instrument = positionInstrument(pos);
  if (instrument.economicsModel !== "BYBIT_LINEAR_USDT_V1") return false;
  // The added quantity obeys the same venue lot rules and capacity limits as
  // an entry; missing metadata or liquidity simply means no scale-in now.
  const [metadata, liquidity] = await Promise.all([
    MarketService.getInstrumentMetadata(asset).catch(() => null),
    MarketService.getLiquiditySnapshot(asset).catch(() => null),
  ]);
  if (!metadata) return false;
  const addAmount = Number(floorOrderQty(decimalString(instrumentQuantityFromNotional(instrument, addNotionalUsd, currentPrice)), metadata));
  if (addAmount <= 0) return false;
  const venueSize = validateOrderSize({
    quantity: decimalString(addAmount),
    price: currentPrice,
    metadata,
    maxNotionalUsdt: addNotionalUsd,
  });
  if (!venueSize.allowed) return false;
  const scaleFill = estimatePaperFill({
    asset,
    instrument: positionInstrument(pos),
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
  const capacity = evaluateFillCapacity({
    side: pos.direction === "SHORT" ? "SELL" : "BUY",
    quantity: addAmount,
    entryPrice: scaleFill.fillPrice,
    stopPrice: pos.stopLoss,
    impactBps: scaleFill.slippageBps,
    liquidity,
  });
  if (!capacity.allowed) return false;

  const existingNotional = positionNotional(pos, pos.amount, pos.entryPrice);
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
  const projectedGrossReward = positionPnl(pos, projectedEntryPrice, projectedTargetExit.fillPrice, totalAmount);
  const projectedGrossStop = positionPnl(pos, projectedEntryPrice, projectedStopExit.fillPrice, totalAmount);
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
      positionId: pos.positionId,
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
  (pos.quantityLegs ??= []).push({ atMs: Date.parse(pos.lastScaleInTime), quantityDelta: addAmount });
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
    ...positionLegIdentity(pos),
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
    strategyFamily: pos.strategyFamily, strategyConfigHash: pos.strategyConfigHash,
    strategyDataSchemaVersion: pos.strategyDataSchemaVersion, strategyRegime: pos.strategyRegime,
    candidateId: pos.candidateId, featureCutoffMs: pos.featureCutoffMs,
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
    positionId: pos.positionId,
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
  if (profitMultiple(asset, pos, currentPrice) < PARTIAL_PROFIT_POLICY.activationR) return false;
  if (pos.amount <= 0 || pos.usdInvested <= 0) return false;

  const linear = isLinearPosition(pos);
  const targetFraction = PARTIAL_PROFIT_POLICY.fraction;
  let exitAmount = pos.amount * targetFraction;
  if (linear) {
    // A venue reduction is a whole number of lot steps; a step too small to
    // take simply means no partial exit this time.
    const metadata = await MarketService.getInstrumentMetadata(asset).catch(() => null);
    if (!metadata) return false;
    exitAmount = Number(floorOrderQty(decimalString(exitAmount), metadata));
    if (!(exitAmount > 0) || exitAmount >= pos.amount) return false;
    await settleOpenPositionFunding(portfolio, liveFundingDeps, { onlyAsset: asset, recordLedger: true })
      .catch((error) => console.warn(`[${source}] funding catch-up failed for ${asset}:`, error));
  }
  const exitFraction = exitAmount / pos.amount;
  const entryExecutionCostShare = (pos.entryExecutionCostUsd || (pos.entryFeePaid || 0) * exitFraction) * exitFraction;
  const entryPriceImpactShare = (pos.entryPriceImpactCostUsd || 0) * exitFraction;
  const previousNotional = pos.notionalUsd || positionNotional(pos, pos.amount, pos.entryPrice);
  const partialExit = estimatePositionExit(pos, currentPrice, exitAmount, "PARTIAL_EXIT");
  const grossPnl = positionPnl(pos, pos.entryPrice, partialExit.fillPrice, exitAmount);
  const settlement = exitCashSettlement({
    pos,
    fraction: exitFraction,
    grossPnl,
    exitFeeUsd: partialExit.feeUsd,
    legacyCarryUsd: linear ? 0 : estimateCarryCostUsd({
      asset,
      notionalUsd: previousNotional * exitFraction,
      openedAt: pos.entryTime,
      fundingRate: pos.fundingRate,
    }),
  });
  const { releasedMargin, entryFeeShare, netPnl } = settlement;
  const carryCost = settlement.carryCostUsd;
  const pnlPercent = releasedMargin > 0 ? (netPnl / releasedMargin) * 100 : 0;

  pos.amount -= exitAmount;
  pos.btcAmount = pos.amount;
  pos.usdInvested -= releasedMargin;
  pos.entryFeePaid = Math.max(0, (pos.entryFeePaid || 0) - entryFeeShare);
  pos.entryExecutionCostUsd = Math.max(0, (pos.entryExecutionCostUsd || 0) - entryExecutionCostShare);
  pos.entryPriceImpactCostUsd = Math.max(0, (pos.entryPriceImpactCostUsd || 0) - entryPriceImpactShare);
  pos.notionalUsd = Math.max(0, previousNotional * (1 - exitFraction));
  const remainingStopExit = estimatePositionExit(pos, pos.stopLoss, pos.amount, "STOP_LOSS");
  const remainingStopPnl = positionPnl(pos, pos.entryPrice, remainingStopExit.fillPrice, pos.amount);
  pos.maxLossUsd = Math.abs(Math.min(0, remainingStopPnl - Number(pos.entryFeePaid || 0) - remainingStopExit.feeUsd));
  pos.partialExitCount = (pos.partialExitCount || 0) + 1;
  pos.lastPartialExitTime = new Date().toISOString();
  pos.isTrailing = true;
  if (linear) {
    pos.fundingAllocatedUsdt = (pos.fundingAllocatedUsdt ?? 0) + settlement.fundingAllocatedUsdt;
    (pos.quantityLegs ??= []).push({ atMs: Date.parse(pos.lastPartialExitTime), quantityDelta: -exitAmount });
  }

  portfolio.usd += settlement.cashDelta;
  portfolio.totalPnl += netPnl;
  portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + partialExit.feeUsd;
  // Linear funding was counted in the carry totals when it was booked.
  const exitCarry = linear ? 0 : carryCost;
  portfolio.totalCarryPaid = (portfolio.totalCarryPaid || 0) + exitCarry;
  portfolio.totalExecutionCostsPaid = (portfolio.totalExecutionCostsPaid || 0) + partialExit.totalExecutionCostUsd + exitCarry;
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
  if (linear) {
    partialTrade.fundingCashflowUsdt = settlement.fundingAllocatedUsdt;
    partialTrade.fundingStatus = (pos.fundingPendingTimes?.length ?? 0) > 0 ? "PENDING_RECONCILIATION" : "SETTLED";
  }

  await PortfolioManager.updatePortfolio(portfolio, portfolioType);
  await PortfolioManager.logTrade(partialTrade, portfolioType);
  await drainPendingLedgerEvents(portfolio, executionLedgerSink, () => PortfolioManager.updatePortfolio(portfolio, portfolioType))
    .catch((error) => console.warn(`[${source}] funding ledger drain deferred:`, error));
  await ExecutionLedger.recordBestEffort({
    type: "PARTIAL_EXIT_FILLED",
    source,
    asset,
    tradeId: partialTrade.id,
    positionId: pos.positionId,
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
