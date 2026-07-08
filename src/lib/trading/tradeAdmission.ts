import { OpenPosition, Portfolio } from "@/lib/types";
import {
  estimateFeeUsd,
  estimateNotionalUsd,
  getAssetSpec,
  getUsdMovePerUnit,
} from "./assetSpecs";

export interface TradeAdmissionInput {
  portfolio: Portfolio;
  asset: string;
  direction: OpenPosition["direction"];
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  signalScore: number;
  reasoning: string;
  strategyType: "swing" | "manual" | "scalp";
  requestedMarginUsd?: number;
  finalConviction?: number;
  learningAdjustment?: number;
  setupTags?: string[];
}

export interface TradeAdmissionResult {
  approved: boolean;
  reason: string;
  amount: number;
  notionalUsd: number;
  requiredMarginUsd: number;
  entryFeeUsd: number;
  leverage: number;
  riskAmountUsd: number;
  maxLossUsd: number;
  admissionScore: number;
  learningRiskMultiplier: number;
  setupRiskMultiplier: number;
  setupRiskReason: string;
  maxTradeMarginUsd: number;
  maxTotalMarginUsd: number;
}

const BASE_RISK_PERCENT = 0.015;
const MAX_TOTAL_MARGIN_PERCENT = 0.55;

function activeMarginUsd(portfolio: Portfolio): number {
  const swingMargin = Object.values(portfolio.openPositions || {}).reduce(
    (sum, pos) => sum + (pos?.usdInvested || 0),
    0
  );
  const scalpMargin = Object.values(portfolio.scalpPositions || {}).reduce(
    (sum, pos) => sum + (pos?.usdInvested || 0),
    0
  );
  return swingMargin + scalpMargin;
}

function estimateEquity(portfolio: Portfolio): number {
  return Math.max(portfolio.usd + activeMarginUsd(portfolio), portfolio.usd, 0);
}

function drawdownAdjustedRiskPercent(portfolio: Portfolio): number {
  const equity = estimateEquity(portfolio);
  if (!portfolio.peakValue || portfolio.peakValue <= 0) return BASE_RISK_PERCENT;

  const drawdown = (portfolio.peakValue - equity) / portfolio.peakValue;
  if (drawdown > 0.08) return BASE_RISK_PERCENT * 0.25;
  if (drawdown > 0.05) return BASE_RISK_PERCENT * 0.5;
  if (drawdown > 0.03) return BASE_RISK_PERCENT * 0.75;
  return BASE_RISK_PERCENT;
}

function leverageFromConviction(signalScore: number, maxLeverage: number, finalConviction?: number): { leverage: number; admissionScore: number } {
  const admissionScore = Math.max(0, Math.min(100, finalConviction ?? signalScore * 4));

  let leverage = 1;
  if (admissionScore >= 88) leverage = 5;
  else if (admissionScore >= 78) leverage = 3;
  else if (admissionScore >= 68) leverage = 2;
  else if (admissionScore >= 60) leverage = 1.5;

  return {
    leverage: Math.min(leverage, maxLeverage),
    admissionScore,
  };
}

function marginPercentFromConviction(specMaxMarginPercent: number, finalConviction?: number): number {
  const conviction = finalConviction ?? 0;
  let target = specMaxMarginPercent;
  if (conviction >= 90) target = 0.30;
  else if (conviction >= 80) target = 0.25;
  else if (conviction >= 70) target = 0.20;
  else if (conviction >= 60) target = 0.12;
  else target = Math.min(0.05, specMaxMarginPercent);

  return Math.max(0.01, Math.min(0.30, target));
}

function riskMultiplierFromConviction(finalConviction?: number): number {
  const conviction = finalConviction ?? 0;
  if (conviction >= 90) return 2.25;
  if (conviction >= 80) return 1.8;
  if (conviction >= 70) return 1.4;
  if (conviction >= 60) return 1.0;
  return 0.5;
}

function learningRiskMultiplier(learningAdjustment?: number): number {
  const adjustment = learningAdjustment ?? 0;
  if (adjustment <= -12) return 0.45;
  if (adjustment <= -8) return 0.6;
  if (adjustment <= -4) return 0.8;
  return 1;
}

function setupRiskProfile(input: TradeAdmissionInput): { multiplier: number; reason: string } {
  const tags = (input.setupTags || []).map((tag) => String(tag).toUpperCase());
  const hasTag = (...needles: string[]) => tags.some((tag) => needles.some((needle) => tag.includes(needle)));
  const conviction = Number(input.finalConviction || 0);
  const learningAdjustment = Number(input.learningAdjustment || 0);
  const reasons: string[] = [];
  let multiplier = 1;

  const longContinuation =
    input.direction === "LONG" &&
    hasTag(
      "VWAP_RECLAIM",
      "LIVE_BREAK_CONFIRMATION",
      "5M_DIRECTIONAL_BODY",
      "BUY_SIDE_BREAKOUT_CONTINUATION",
      "MOMENTUM_CONTINUATION",
      "STRUCTURAL UPTREND"
    );

  if (longContinuation) {
    const haircut = conviction >= 88 && learningAdjustment >= 0 ? 0.8 : 0.65;
    multiplier *= haircut;
    reasons.push("long-continuation/reclaim evidence is sized smaller until its closed-trade expectancy improves");
  }

  const provenRejection =
    input.direction === "SHORT" &&
    hasTag(
      "VWAP_REJECTION",
      "BUY_SIDE_LIQUIDITY_REJECTION",
      "SELL_SIDE_BREAKDOWN_CONTINUATION",
      "STRUCTURAL DOWNTREND",
      "ASK_PRESSURE_SUPPORTS_SHORT"
    );

  if (provenRejection && conviction >= 78 && learningAdjustment >= 0) {
    const boost = learningAdjustment > 0 || conviction >= 88 ? 1.25 : 1.15;
    multiplier *= boost;
    reasons.push("rejection/downtrend setup has enough conviction to receive controlled extra size");
  }

  const bounded = Math.max(0.45, Math.min(1.35, multiplier));
  return {
    multiplier: bounded,
    reason: reasons.length > 0
      ? reasons.join("; ")
      : "no setup-specific size adjustment",
  };
}

export class TradeAdmissionController {
  static evaluate(input: TradeAdmissionInput): TradeAdmissionResult {
    const spec = getAssetSpec(input.asset);
    const equity = estimateEquity(input.portfolio);
    const currentActiveMargin = activeMarginUsd(input.portfolio);
    const learningMultiplier = learningRiskMultiplier(input.learningAdjustment);
    const setupProfile = setupRiskProfile(input);
    const combinedRiskMultiplier = learningMultiplier * setupProfile.multiplier;
    const maxTradeMarginUsd = equity * marginPercentFromConviction(spec.maxMarginPercent, input.finalConviction) * combinedRiskMultiplier;
    const maxTotalMarginUsd = equity * MAX_TOTAL_MARGIN_PERCENT;
    const remainingTotalMarginRoom = Math.max(0, maxTotalMarginUsd - currentActiveMargin);

    const emptyResult = (reason: string): TradeAdmissionResult => ({
      approved: false,
      reason,
      amount: 0,
      notionalUsd: 0,
      requiredMarginUsd: 0,
      entryFeeUsd: 0,
      leverage: 1,
      riskAmountUsd: 0,
      maxLossUsd: 0,
      admissionScore: 0,
      learningRiskMultiplier: learningMultiplier,
      setupRiskMultiplier: setupProfile.multiplier,
      setupRiskReason: setupProfile.reason,
      maxTradeMarginUsd,
      maxTotalMarginUsd,
    });

    if (!Number.isFinite(equity) || equity <= 0) {
      return emptyResult("Invalid or empty portfolio equity.");
    }

    if (input.portfolio.openPositions?.[input.asset]) {
      return emptyResult(`Active position in ${input.asset} already exists.`);
    }

    if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
      return emptyResult("Invalid entry price.");
    }

    if (!Number.isFinite(input.stopLoss) || input.stopLoss <= 0) {
      return emptyResult("Invalid stop loss.");
    }

    if (input.direction === "LONG" && input.stopLoss >= input.entryPrice) {
      return emptyResult("LONG stop loss must be below entry price.");
    }

    if (input.direction === "SHORT" && input.stopLoss <= input.entryPrice) {
      return emptyResult("SHORT stop loss must be above entry price.");
    }

    if (!Number.isFinite(input.takeProfit) || input.takeProfit <= 0) {
      return emptyResult("Invalid take profit.");
    }

    if (input.direction === "LONG" && input.takeProfit <= input.entryPrice) {
      return emptyResult("LONG take profit must be above entry price.");
    }

    if (input.direction === "SHORT" && input.takeProfit >= input.entryPrice) {
      return emptyResult("SHORT take profit must be below entry price.");
    }

    if (remainingTotalMarginRoom < spec.minMarginUsd) {
      return emptyResult("Total portfolio margin cap reached.");
    }

    const riskPercent = drawdownAdjustedRiskPercent(input.portfolio) * riskMultiplierFromConviction(input.finalConviction) * combinedRiskMultiplier;
    const riskAmountUsd = equity * riskPercent;
    const usdMovePerUnit = getUsdMovePerUnit(input.asset, input.entryPrice, input.stopLoss);

    if (!Number.isFinite(usdMovePerUnit) || usdMovePerUnit <= 0) {
      return emptyResult("Invalid stop distance for asset contract.");
    }

    const { leverage, admissionScore } = leverageFromConviction(input.signalScore, spec.maxLeverage, input.finalConviction);
    const rawAmount = riskAmountUsd / usdMovePerUnit;
    const rawNotionalUsd = estimateNotionalUsd(input.asset, rawAmount, input.entryPrice);
    const requestedMarginCap = input.requestedMarginUsd && input.requestedMarginUsd > 0
      ? Math.min(input.requestedMarginUsd, input.portfolio.usd)
      : Infinity;
    const availableMarginUsd = Math.max(
      0,
      Math.min(input.portfolio.usd, maxTradeMarginUsd, remainingTotalMarginRoom, requestedMarginCap)
    );

    const notionalCapUsd = availableMarginUsd * leverage;
    const notionalUsd = Math.min(rawNotionalUsd, notionalCapUsd);

    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
      return emptyResult("Position notional was reduced to zero by risk caps.");
    }

    let amount = rawAmount;
    if (rawNotionalUsd > notionalUsd) {
      amount = rawAmount * (notionalUsd / rawNotionalUsd);
    }

    const requiredMarginUsd = notionalUsd / leverage;
    const entryFeeUsd = estimateFeeUsd(input.asset, amount, input.entryPrice);
    const maxLossUsd = usdMovePerUnit * amount;

    if (requiredMarginUsd < spec.minMarginUsd) {
      return emptyResult(`Required margin is below minimum useful size ($${spec.minMarginUsd}).`);
    }

    if (requiredMarginUsd + entryFeeUsd > input.portfolio.usd) {
      return emptyResult("Insufficient free cash for required margin plus entry fee.");
    }

    if (entryFeeUsd > Math.max(1, maxLossUsd * 0.25)) {
      return emptyResult("Fee drag is too high compared with the planned max loss.");
    }

    // Trailing stops and thesis-invalidation exits typically capture only a
    // fraction of the full take-profit distance before closing. Sizing the
    // fee guard off the full TP target let through trades whose *realistic*
    // captured profit (what actually happens on a trailing-stop exit) was
    // still smaller than the round-trip fee, netting near-zero or negative
    // "wins". Use a conservative capture fraction instead of the full move.
    const REALISTIC_CAPTURE_FRACTION = 0.5;
    const fullMoveProfitUsd = Math.abs(input.takeProfit - input.entryPrice) * amount;
    const realisticProfitUsd = fullMoveProfitUsd * REALISTIC_CAPTURE_FRACTION;
    const roundTripFeeUsd = entryFeeUsd * 2;
    if (realisticProfitUsd < roundTripFeeUsd * 3) {
      return emptyResult(`Realistic captured profit ($${realisticProfitUsd.toFixed(2)}) is less than 3x round-trip fee ($${(roundTripFeeUsd * 3).toFixed(2)}). Position is too small to be fee-viable.`);
    }

    if (maxLossUsd > riskAmountUsd * 1.01) {
      return emptyResult("Calculated max loss exceeds approved risk budget.");
    }

    return {
      approved: true,
      reason: setupProfile.multiplier !== 1
        ? `Approved with setup-specific sizing (${Math.round(setupProfile.multiplier * 100)}%). ${setupProfile.reason}.`
        : learningMultiplier < 1
        ? `Approved with local-learning risk reduction (${Math.round(learningMultiplier * 100)}% size). Recent evidence is weaker, so margin is deliberately smaller.`
        : rawNotionalUsd > notionalUsd
        ? `Approved with conviction-based capped margin. Requested risk size exceeded ${spec.assetClass} risk limits.`
        : "Approved by conviction and risk controller.",
      amount,
      notionalUsd,
      requiredMarginUsd,
      entryFeeUsd,
      leverage,
      riskAmountUsd,
      maxLossUsd,
      admissionScore,
      learningRiskMultiplier: learningMultiplier,
      setupRiskMultiplier: setupProfile.multiplier,
      setupRiskReason: setupProfile.reason,
      maxTradeMarginUsd,
      maxTotalMarginUsd,
    };
  }
}
