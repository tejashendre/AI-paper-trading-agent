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

export class TradeAdmissionController {
  static evaluate(input: TradeAdmissionInput): TradeAdmissionResult {
    const spec = getAssetSpec(input.asset);
    const equity = estimateEquity(input.portfolio);
    const currentActiveMargin = activeMarginUsd(input.portfolio);
    const maxTradeMarginUsd = equity * marginPercentFromConviction(spec.maxMarginPercent, input.finalConviction);
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

    const riskPercent = drawdownAdjustedRiskPercent(input.portfolio) * riskMultiplierFromConviction(input.finalConviction);
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

    if (maxLossUsd > riskAmountUsd * 1.01) {
      return emptyResult("Calculated max loss exceeds approved risk budget.");
    }

    return {
      approved: true,
      reason: rawNotionalUsd > notionalUsd
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
      maxTradeMarginUsd,
      maxTotalMarginUsd,
    };
  }
}
