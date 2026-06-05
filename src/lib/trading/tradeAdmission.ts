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
  maxTradeMarginUsd: number;
  maxTotalMarginUsd: number;
}

const BASE_RISK_PERCENT = 0.015;
const MAX_TOTAL_MARGIN_PERCENT = 0.25;

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

function leverageFromScore(signalScore: number, maxLeverage: number): { leverage: number; admissionScore: number } {
  const admissionScore = Math.max(0, Math.min(100, signalScore * 4));

  let leverage = 1;
  if (signalScore >= 22) leverage = 5;
  else if (signalScore >= 19) leverage = 3;
  else if (signalScore >= 16) leverage = 2;
  else if (signalScore >= 14) leverage = 1.5;

  return {
    leverage: Math.min(leverage, maxLeverage),
    admissionScore,
  };
}

export class TradeAdmissionController {
  static evaluate(input: TradeAdmissionInput): TradeAdmissionResult {
    const spec = getAssetSpec(input.asset);
    const equity = estimateEquity(input.portfolio);
    const currentActiveMargin = activeMarginUsd(input.portfolio);
    const maxTradeMarginUsd = equity * spec.maxMarginPercent;
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

    if (remainingTotalMarginRoom < spec.minMarginUsd) {
      return emptyResult("Total portfolio margin cap reached.");
    }

    const riskPercent = drawdownAdjustedRiskPercent(input.portfolio);
    const riskAmountUsd = equity * riskPercent;
    const usdMovePerUnit = getUsdMovePerUnit(input.asset, input.entryPrice, input.stopLoss);

    if (!Number.isFinite(usdMovePerUnit) || usdMovePerUnit <= 0) {
      return emptyResult("Invalid stop distance for asset contract.");
    }

    const { leverage, admissionScore } = leverageFromScore(input.signalScore, spec.maxLeverage);
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

    if (maxLossUsd > riskAmountUsd * 1.01) {
      return emptyResult("Calculated max loss exceeds approved risk budget.");
    }

    return {
      approved: true,
      reason: rawNotionalUsd > notionalUsd
        ? `Approved with capped margin. Requested risk size exceeded ${spec.assetClass} margin limits.`
        : "Approved by trade admission controller.",
      amount,
      notionalUsd,
      requiredMarginUsd,
      entryFeeUsd,
      leverage,
      riskAmountUsd,
      maxLossUsd,
      admissionScore,
      maxTradeMarginUsd,
      maxTotalMarginUsd,
    };
  }
}

