import { OpenPosition } from "@/lib/types";
import {
  calculatePnlUsd,
  estimateFeeUsd,
  estimateNotionalUsd,
} from "./assetSpecs";

export const EXECUTION_COST_MODEL_VERSION = "paper-cost-v2-2026-07-19";

export type PaperExecutionAction = "BUY" | "SELL" | "SHORT" | "COVER";
export type PaperExecutionReason =
  | "ENTRY"
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "SIGNAL_REVERSAL"
  | "SIGNAL_INVALIDATION"
  | "TIME_STOP"
  | "SCALE_IN"
  | "PARTIAL_EXIT"
  | "END_REPLAY"
  | "MARK";

export interface ExecutionCostProfile {
  asset: string;
  venueModel: string;
  halfSpreadBps: number;
  baseSlippageBps: number;
  sizeImpactBps: number;
  referenceNotionalUsd: number;
  stopGapBps: number;
  carryBpsPerDay: number;
}

export interface PaperExecutionContext {
  reason: PaperExecutionReason;
  assetMode?: "REALTIME_FAST" | "CONDITIONAL_FAST" | "SLOW_SWING";
  dataQuality?: number;
  isPeakLiquidity?: boolean;
  liquidityState?: string;
  orderbookImbalanceRatio?: number;
}

export interface PaperFillEstimate {
  modelVersion: string;
  venueModel: string;
  action: PaperExecutionAction;
  reason: PaperExecutionReason;
  requestedPrice: number;
  fillPrice: number;
  amount: number;
  notionalUsd: number;
  feeUsd: number;
  spreadBps: number;
  slippageBps: number;
  gapBps: number;
  totalAdverseBps: number;
  spreadCostUsd: number;
  slippageCostUsd: number;
  gapCostUsd: number;
  priceImpactCostUsd: number;
  totalExecutionCostUsd: number;
}

export interface PaperExecutionPlan {
  modelVersion: string;
  entry: PaperFillEstimate;
  targetExit: PaperFillEstimate;
  stopExit: PaperFillEstimate;
  grossRewardUsd: number;
  grossStopPnlUsd: number;
  netRewardUsd: number;
  netLossUsd: number;
  netRewardRiskRatio: number;
  estimatedRoundTripExecutionCostUsd: number;
}

export interface PaperExecutionPlanInput {
  asset: string;
  direction: OpenPosition["direction"];
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  amount: number;
  context?: Omit<PaperExecutionContext, "reason">;
}

const PROFILES: Record<string, ExecutionCostProfile> = {
  BTC: { asset: "BTC", venueModel: "BYBIT_VIP0_PERPETUAL", halfSpreadBps: 0.8, baseSlippageBps: 0.8, sizeImpactBps: 0.4, referenceNotionalUsd: 25_000, stopGapBps: 2.0, carryBpsPerDay: 3.0 },
  ETH: { asset: "ETH", venueModel: "BYBIT_VIP0_PERPETUAL", halfSpreadBps: 1.2, baseSlippageBps: 1.2, sizeImpactBps: 0.6, referenceNotionalUsd: 15_000, stopGapBps: 3.0, carryBpsPerDay: 3.5 },
  SOL: { asset: "SOL", venueModel: "BYBIT_VIP0_PERPETUAL", halfSpreadBps: 2.5, baseSlippageBps: 2.5, sizeImpactBps: 1.2, referenceNotionalUsd: 7_500, stopGapBps: 6.0, carryBpsPerDay: 5.0 },
  EURUSD: { asset: "EURUSD", venueModel: "SYNTHETIC_FX_PROXY", halfSpreadBps: 0.5, baseSlippageBps: 0.4, sizeImpactBps: 0.2, referenceNotionalUsd: 100_000, stopGapBps: 1.5, carryBpsPerDay: 1.0 },
  GBPUSD: { asset: "GBPUSD", venueModel: "SYNTHETIC_FX_PROXY", halfSpreadBps: 0.8, baseSlippageBps: 0.6, sizeImpactBps: 0.3, referenceNotionalUsd: 100_000, stopGapBps: 2.0, carryBpsPerDay: 1.2 },
  USDJPY: { asset: "USDJPY", venueModel: "SYNTHETIC_FX_PROXY", halfSpreadBps: 0.7, baseSlippageBps: 0.5, sizeImpactBps: 0.3, referenceNotionalUsd: 100_000, stopGapBps: 2.0, carryBpsPerDay: 1.2 },
  GOLD: { asset: "GOLD", venueModel: "SYNTHETIC_COMMODITY_PROXY", halfSpreadBps: 1.5, baseSlippageBps: 1.0, sizeImpactBps: 0.5, referenceNotionalUsd: 20_000, stopGapBps: 4.0, carryBpsPerDay: 1.5 },
  OIL: { asset: "OIL", venueModel: "SYNTHETIC_COMMODITY_PROXY", halfSpreadBps: 2.5, baseSlippageBps: 2.0, sizeImpactBps: 0.8, referenceNotionalUsd: 15_000, stopGapBps: 8.0, carryBpsPerDay: 2.0 },
  SILVER: { asset: "SILVER", venueModel: "SYNTHETIC_COMMODITY_PROXY", halfSpreadBps: 3.0, baseSlippageBps: 2.5, sizeImpactBps: 1.0, referenceNotionalUsd: 12_500, stopGapBps: 8.0, carryBpsPerDay: 2.0 },
};

export function getExecutionCostProfile(asset: string): ExecutionCostProfile {
  const profile = PROFILES[asset];
  if (!profile) throw new Error(`Missing execution-cost profile for ${asset}`);
  return profile;
}

/**
 * Cost profile for an arbitrary Bybit linear perpetual, derived from its
 * observed turnover. The cross-sectional book trades roughly fifty symbols
 * that cannot each have a hand-written profile, but a blanket assumption
 * would either flatter thin names or punish liquid ones. Spread, slippage and
 * stop-gap all scale with the inverse square root of turnover, which is the
 * usual empirical shape, anchored on the hand-calibrated BTC and SOL entries.
 */
export function deriveExecutionCostProfile(asset: string, turnover24hUsd: number): ExecutionCostProfile {
  const known = PROFILES[asset];
  if (known) return known;

  const reference = 1_000_000_000; // BTC-scale daily turnover
  const liquidity = Math.max(1e6, Number(turnover24hUsd) || 1e6);
  // 1 at BTC-scale, ~7 at the $20M screen floor.
  const scale = Math.min(12, Math.sqrt(reference / liquidity));

  return {
    asset,
    venueModel: "BYBIT_LINEAR_DERIVED",
    halfSpreadBps: Math.min(15, 0.8 * scale),
    baseSlippageBps: Math.min(15, 0.8 * scale),
    sizeImpactBps: Math.min(8, 0.4 * scale),
    referenceNotionalUsd: Math.max(2_000, liquidity / 1_000),
    stopGapBps: Math.min(40, 2.0 * scale),
    carryBpsPerDay: 3.0,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function marketConditionMultiplier(context: PaperExecutionContext): number {
  const dataQuality = clamp(Number(context.dataQuality ?? 100), 0, 100);
  const dataPenalty = 1 + ((100 - dataQuality) / 100) * 0.75;
  const sessionPenalty = context.isPeakLiquidity === false ? 1.25 : 1;
  const slowFeedPenalty = context.assetMode === "SLOW_SWING" ? 1.15 : 1;
  const state = String(context.liquidityState || "").toUpperCase();
  const trapPenalty = state.includes("TRAP_RISK") ? 1.35 : 1;
  const continuationDiscount = state.includes("CONTINUATION") ? 0.92 : 1;
  return clamp(dataPenalty * sessionPenalty * slowFeedPenalty * trapPenalty * continuationDiscount, 0.85, 2.5);
}

export function estimatePaperFill(input: {
  asset: string;
  action: PaperExecutionAction;
  requestedPrice: number;
  amount: number;
  context: PaperExecutionContext;
  /** Overrides the catalogued profile, for symbols priced by turnover. */
  profile?: ExecutionCostProfile;
  /** Overrides the catalogued fee rate, e.g. maker instead of taker. */
  feeRate?: number;
}): PaperFillEstimate {
  if (!Number.isFinite(input.requestedPrice) || input.requestedPrice <= 0) {
    throw new Error(`Invalid requested execution price for ${input.asset}`);
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error(`Invalid execution amount for ${input.asset}`);
  }

  const profile = input.profile ?? getExecutionCostProfile(input.asset);
  // A supplied profile means the symbol is outside the hand-written catalogue,
  // so contract lookups would throw. Linear USDT perps are all USD-quoted with
  // a unit contract, which is exactly `amount * price`.
  const isDerived = input.profile !== undefined;
  const requestedNotionalUsd = isDerived
    ? input.amount * input.requestedPrice
    : estimateNotionalUsd(input.asset, input.amount, input.requestedPrice);
  const conditionMultiplier = marketConditionMultiplier(input.context);
  const sizeRatio = Math.max(0, requestedNotionalUsd / Math.max(profile.referenceNotionalUsd, 1));
  const sizeImpactBps = profile.sizeImpactBps * Math.sqrt(sizeRatio);
  const spreadBps = profile.halfSpreadBps * conditionMultiplier;
  const slippageBps = (profile.baseSlippageBps + sizeImpactBps) * conditionMultiplier;
  const gapBps = input.context.reason === "STOP_LOSS"
    ? profile.stopGapBps * conditionMultiplier
    : 0;
  const totalAdverseBps = spreadBps + slippageBps + gapBps;
  const adverseDirection = input.action === "BUY" || input.action === "COVER" ? 1 : -1;
  const fillPrice = input.requestedPrice * (1 + adverseDirection * totalAdverseBps / 10_000);
  const notionalUsd = isDerived
    ? input.amount * fillPrice
    : estimateNotionalUsd(input.asset, input.amount, fillPrice);
  const feeUsd = input.feeRate !== undefined
    ? notionalUsd * input.feeRate
    : estimateFeeUsd(input.asset, input.amount, fillPrice, "taker");
  const spreadCostUsd = requestedNotionalUsd * spreadBps / 10_000;
  const slippageCostUsd = requestedNotionalUsd * slippageBps / 10_000;
  const gapCostUsd = requestedNotionalUsd * gapBps / 10_000;
  const priceImpactCostUsd = spreadCostUsd + slippageCostUsd + gapCostUsd;

  return {
    modelVersion: EXECUTION_COST_MODEL_VERSION,
    venueModel: profile.venueModel,
    action: input.action,
    reason: input.context.reason,
    requestedPrice: input.requestedPrice,
    fillPrice,
    amount: input.amount,
    notionalUsd,
    feeUsd,
    spreadBps,
    slippageBps,
    gapBps,
    totalAdverseBps,
    spreadCostUsd,
    slippageCostUsd,
    gapCostUsd,
    priceImpactCostUsd,
    totalExecutionCostUsd: priceImpactCostUsd + feeUsd,
  };
}

export function buildPaperExecutionPlan(input: PaperExecutionPlanInput): PaperExecutionPlan {
  const entryAction: PaperExecutionAction = input.direction === "LONG" ? "BUY" : "SHORT";
  const exitAction: PaperExecutionAction = input.direction === "LONG" ? "SELL" : "COVER";
  const context = input.context || {};
  const entry = estimatePaperFill({
    asset: input.asset,
    action: entryAction,
    requestedPrice: input.entryPrice,
    amount: input.amount,
    context: { ...context, reason: "ENTRY" },
  });
  const targetExit = estimatePaperFill({
    asset: input.asset,
    action: exitAction,
    requestedPrice: input.takeProfit,
    amount: input.amount,
    context: { ...context, reason: "TAKE_PROFIT" },
  });
  const stopExit = estimatePaperFill({
    asset: input.asset,
    action: exitAction,
    requestedPrice: input.stopLoss,
    amount: input.amount,
    context: { ...context, reason: "STOP_LOSS" },
  });

  const grossRewardUsd = calculatePnlUsd(
    input.asset,
    entry.fillPrice,
    targetExit.fillPrice,
    input.amount,
    input.direction
  );
  const grossStopPnlUsd = calculatePnlUsd(
    input.asset,
    entry.fillPrice,
    stopExit.fillPrice,
    input.amount,
    input.direction
  );
  const netRewardUsd = grossRewardUsd - entry.feeUsd - targetExit.feeUsd;
  const netStopPnlUsd = grossStopPnlUsd - entry.feeUsd - stopExit.feeUsd;
  const netLossUsd = Math.abs(Math.min(0, netStopPnlUsd));
  const netRewardRiskRatio = netLossUsd > 0 ? netRewardUsd / netLossUsd : 0;

  return {
    modelVersion: EXECUTION_COST_MODEL_VERSION,
    entry,
    targetExit,
    stopExit,
    grossRewardUsd,
    grossStopPnlUsd,
    netRewardUsd,
    netLossUsd,
    netRewardRiskRatio,
    estimatedRoundTripExecutionCostUsd: entry.totalExecutionCostUsd + targetExit.totalExecutionCostUsd,
  };
}

export function fitPaperExecutionPlanToRiskBudget(
  input: PaperExecutionPlanInput & { riskBudgetUsd: number }
): { plan: PaperExecutionPlan; riskScale: number; resized: boolean } {
  const initial = buildPaperExecutionPlan(input);
  if (!Number.isFinite(input.riskBudgetUsd) || input.riskBudgetUsd <= 0) {
    return { plan: initial, riskScale: 1, resized: false };
  }
  if (initial.netLossUsd <= input.riskBudgetUsd) {
    return { plan: initial, riskScale: 1, resized: false };
  }

  const riskScale = Math.min(1, (input.riskBudgetUsd * 0.995) / initial.netLossUsd);
  const plan = buildPaperExecutionPlan({ ...input, amount: input.amount * riskScale });
  return { plan, riskScale, resized: true };
}

export function estimateCarryCostUsd(input: {
  asset: string;
  notionalUsd: number;
  openedAt: string;
  closedAt?: string;
  fundingRate?: number;
}): number {
  const openedAt = new Date(input.openedAt).getTime();
  const closedAt = input.closedAt ? new Date(input.closedAt).getTime() : Date.now();
  if (!Number.isFinite(openedAt) || !Number.isFinite(closedAt) || closedAt <= openedAt) return 0;
  if (!Number.isFinite(input.notionalUsd) || input.notionalUsd <= 0) return 0;

  const profile = getExecutionCostProfile(input.asset);
  const heldDays = (closedAt - openedAt) / 86_400_000;
  const modeledCarry = input.notionalUsd * (profile.carryBpsPerDay / 10_000) * heldDays;
  const fundingPeriods = (closedAt - openedAt) / (8 * 60 * 60 * 1000);
  const observedFunding = Number.isFinite(Number(input.fundingRate))
    ? input.notionalUsd * Math.abs(Number(input.fundingRate)) * fundingPeriods
    : 0;
  return Math.max(0, modeledCarry, observedFunding);
}
