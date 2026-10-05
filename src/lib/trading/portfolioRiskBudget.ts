import { OpenPosition, Portfolio, Trade } from "@/lib/types";
import { instrumentFee, instrumentNotional, positionInstrument, tradeInstrument, positionFeeScheduleVersion } from "./assetSpecs";
import { markedEquity } from './markedEquity';

// v3: named factors in true USDT notional, factor stop-risk cap, gross notional ceiling.
export const PORTFOLIO_RISK_POLICY_VERSION = "portfolio-budget-v3-2026-10-01";

export interface PortfolioRiskBudgetInput {
  portfolio: Portfolio;
  trades: Trade[];
  asset: string;
  direction: OpenPosition["direction"];
  candidateNotionalUsd: number;
  candidateMaxLossUsd: number;
  candidateEntryCostUsd: number;
  now?: Date;
}

export interface PortfolioRiskBudgetDecision {
  approved: boolean;
  reason: string;
  policyVersion: string;
  diagnostics: {
    equityUsd: number;
    currentDrawdownPercent: number;
    entriesAsset1h: number;
    entriesAsset24h: number;
    entriesTotal24h: number;
    entryNotional24h: number;
    executionCosts24h: number;
    grossEdge24h: number;
    costToGrossEdgeRatio: number | null;
    netPnl24h: number;
    netPnl7d: number;
    plannedOpenRiskUsd: number;
    candidateMaxLossUsd: number;
    expectedShortfallUsd: number;
    stressLossUsd: number;
    correlatedSameDirectionCount: number;
    consecutiveFullStopLosses: number;
    correlatedFullStopLosses: number;
    accountingDriftUsd: number;
    factorExposure: Record<string, FactorExposure>;
    grossNotionalUsdt: number;
    lossStreakProbation: boolean;
  };
  limits: {
    maxEntriesAsset1h: number;
    maxEntriesAsset24h: number;
    maxEntriesTotal24h: number;
    maxEntryNotional24hUsd: number;
    maxExecutionCosts24hUsd: number;
    maxCostToGrossEdgeRatio: number;
    maxDailyLossUsd: number;
    maxWeeklyLossUsd: number;
    maxPlannedRiskUsd: number;
    maxStressLossUsd: number;
    maxCorrelatedSameDirection: number;
    maxConsecutiveFullStopLosses: number;
    maxCorrelatedFullStopLosses: number;
    hardDrawdownPercent: number;
    maxFactorPlannedRiskUsd: number;
    maxGrossNotionalUsdt: number;
  };
}

const HOUR_MS = 60 * 60 * 1000;
/**
 * A full-stop loss streak blocks entries for this long after its newest loss.
 * After that the book may hold one probation position at a time: a win ends
 * the streak, another full stop extends it and restarts the cool-off. Without
 * this the streak could only be cleared by a reset, so the bot stopped for good.
 */
export const LOSS_STREAK_COOL_OFF_HOURS = 72;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function tradeTimestamp(trade: Trade): number {
  const value = new Date(trade.exitTime || trade.timestamp || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function isEntry(trade: Trade): boolean {
  return trade.action === "BUY" || trade.action === "SHORT" || trade.action === "SCALP_BUY" || trade.action === "SCALP_SHORT";
}

function isClosed(trade: Trade): boolean {
  return Number.isFinite(Number(trade.pnl));
}

function tradeNotionalUsd(trade: Trade): number {
  const explicit = Number(trade.notionalUsd);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const margin = Number(trade.usdValue || 0);
  const leverage = Math.max(1, Number(trade.leverageUsed || 1));
  return Math.max(0, margin * leverage);
}

function eventExecutionCostUsd(trade: Trade): number {
  const explicit = Number(trade.executionCostUsd);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (!Number.isFinite(Number(trade.amount)) || !Number.isFinite(Number(trade.price))) return 0;
  try {
    // Each row is costed under the model it was written with.
    const instrument=tradeInstrument(trade);
    return instrumentFee(instrument, Number(trade.amount), Number(trade.price), 'taker',
      positionFeeScheduleVersion({asset:trade.asset,instrument,feeScheduleVersion:trade.feeScheduleVersion}));
  } catch {
    return 0;
  }
}

export interface RiskFactorClassification {
  riskClass: "crypto" | "forex" | "commodity" | "unknown";
  /** Shared driver. Grouping states exposure; it does not assume a fixed correlation. */
  factor: string;
  /** Direction of exposure to the factor, e.g. long EURUSD is short USD. */
  factorDirection: OpenPosition["direction"];
}

export function classifyRiskFactor(asset: string, direction: OpenPosition["direction"]): RiskFactorClassification {
  const opposite = direction === "LONG" ? "SHORT" : "LONG";
  if (["BTC", "ETH", "SOL"].includes(asset)) return { riskClass: "crypto", factor: "CRYPTO", factorDirection: direction };
  if (asset === "EURUSD" || asset === "GBPUSD") return { riskClass: "forex", factor: "USD", factorDirection: opposite };
  if (asset === "USDJPY") return { riskClass: "forex", factor: "USD", factorDirection: direction };
  if (asset === "GOLD" || asset === "SILVER") return { riskClass: "commodity", factor: "METALS", factorDirection: direction };
  if (asset === "OIL") return { riskClass: "commodity", factor: "ENERGY", factorDirection: direction };
  return { riskClass: "unknown", factor: asset, factorDirection: direction };
}

function exposureKey(asset: string, direction: OpenPosition["direction"]): string {
  const { factor, factorDirection } = classifyRiskFactor(asset, direction);
  return `${factor}:${factorDirection}`;
}

export interface FactorExposure {
  positions: number;
  /** True USDT notional under each position's own economic model. */
  notionalUsdt: number;
  plannedRiskUsdt: number;
}

export function portfolioFactorExposure(positions: OpenPosition[]): Record<string, FactorExposure> {
  const exposure: Record<string, FactorExposure> = {};
  for (const position of positions) {
    if (!position) continue;
    const key = exposureKey(position.asset, position.direction);
    const bucket = (exposure[key] ??= { positions: 0, notionalUsdt: 0, plannedRiskUsdt: 0 });
    bucket.positions += 1;
    bucket.notionalUsdt += instrumentNotional(positionInstrument(position), position.amount, position.entryPrice);
    bucket.plannedRiskUsdt += Math.max(0, Number(position.maxLossUsd ?? position.riskAmountUsd ?? 0));
  }
  return exposure;
}

function riskCluster(asset: string): string {
  if (["BTC", "ETH", "SOL"].includes(asset)) return "CRYPTO";
  if (["GOLD", "SILVER"].includes(asset)) return "PRECIOUS_METALS";
  if (["EURUSD", "GBPUSD", "USDJPY"].includes(asset)) return "FX_USD";
  return asset;
}

function isFullStopLoss(trade: Trade): boolean {
  // Probe-sized positions are bounded by their own small risk, the loss
  // budgets and research demotion; they do not freeze full-quality entries.
  if (trade.entryMode === "CONTROLLED_PROBE") return false;
  if (trade.exitReason !== "STOP_LOSS" || Number(trade.pnl) >= 0) return false;
  const maxLossUsd = Number(trade.maxLossUsd);
  if (!Number.isFinite(maxLossUsd) || maxLossUsd <= 0) return true;
  return Math.abs(Number(trade.pnl)) >= maxLossUsd * 0.75;
}

function countLeadingFullStopLosses(trades: Trade[]): number {
  let count = 0;
  for (const trade of trades) {
    if (!isFullStopLoss(trade)) break;
    count++;
  }
  return count;
}

function expectedShortfallUsd(closedTrades: Trade[], minimumSample = 20): number {
  const losses = closedTrades
    .map((trade) => Number(trade.pnl))
    .filter((pnl) => Number.isFinite(pnl))
    .sort((a, b) => a - b);
  if (losses.length < minimumSample) return 0;
  const tailSize = Math.max(1, Math.ceil(losses.length * 0.2));
  const tail = losses.slice(0, tailSize);
  const averageTail = tail.reduce((sum, pnl) => sum + pnl, 0) / tail.length;
  return Math.abs(Math.min(0, averageTail));
}

export function evaluatePortfolioRiskBudget(input: PortfolioRiskBudgetInput): PortfolioRiskBudgetDecision {
  const nowMs = (input.now || new Date()).getTime();
  const equity = markedEquity(input.portfolio);
  const hourEntries = input.trades.filter((trade) => isEntry(trade) && tradeTimestamp(trade) >= nowMs - HOUR_MS);
  const dayTrades = input.trades.filter((trade) => tradeTimestamp(trade) >= nowMs - DAY_MS);
  const weekTrades = input.trades.filter((trade) => tradeTimestamp(trade) >= nowMs - WEEK_MS);
  const dayEntries = dayTrades.filter(isEntry);
  const dayClosed = dayTrades.filter(isClosed);
  const weekClosed = weekTrades.filter(isClosed);
  const allClosed = input.trades
    .filter(isClosed)
    .sort((a, b) => tradeTimestamp(b) - tradeTimestamp(a))
    .slice(0, 100);
  const entriesAsset1h = hourEntries.filter((trade) => trade.asset === input.asset).length;
  const entriesAsset24h = dayEntries.filter((trade) => trade.asset === input.asset).length;
  const entryNotional24h = dayEntries.reduce((sum, trade) => sum + tradeNotionalUsd(trade), 0);
  const executionCosts24h = dayTrades.reduce((sum, trade) => sum + eventExecutionCostUsd(trade), 0);
  const grossEdge24h = dayClosed.reduce((sum, trade) => {
    const gross = Number(trade.grossPnlUsd);
    if (Number.isFinite(gross) && gross > 0) return sum + gross;
    const net = Number(trade.pnl || 0);
    return net > 0 ? sum + net + eventExecutionCostUsd(trade) : sum;
  }, 0);
  const costToGrossEdgeRatio = grossEdge24h > 0 ? executionCosts24h / grossEdge24h : null;
  const netPnl24h = dayClosed.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const netPnl7d = weekClosed.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const plannedOpenRiskUsd = Object.values(input.portfolio.openPositions || {}).reduce(
    (sum, position) => sum + Math.max(0, Number(position?.maxLossUsd ?? position?.riskAmountUsd ?? 0)),
    0
  );
  const expectedShortfall = expectedShortfallUsd(allClosed);
  const stressLossUsd = plannedOpenRiskUsd + input.candidateMaxLossUsd + expectedShortfall;
  const candidateExposureKey = exposureKey(input.asset, input.direction);
  const correlatedSameDirectionCount = Object.values(input.portfolio.openPositions || {}).filter(
    (position) => exposureKey(position.asset, position.direction) === candidateExposureKey
  ).length;
  const openPositions = Object.values(input.portfolio.openPositions || {});
  const factorExposure = portfolioFactorExposure(openPositions);
  const grossNotionalUsdt = Object.values(factorExposure).reduce((sum, bucket) => sum + bucket.notionalUsdt, 0);
  const consecutiveFullStopLosses = countLeadingFullStopLosses(allClosed);
  const candidateCluster = riskCluster(input.asset);
  const correlatedFullStopLosses = countLeadingFullStopLosses(
    allClosed.filter((trade) => riskCluster(trade.asset) === candidateCluster)
  );
  const newestClosedMs = allClosed.length ? tradeTimestamp(allClosed[0]) : 0;
  const newestClusterMs = tradeTimestamp(allClosed.find((trade) => riskCluster(trade.asset) === candidateCluster) ?? ({} as Trade));
  const accountingReconciliation = Number(input.portfolio.grossProfit || 0) - Number(input.portfolio.grossLoss || 0);
  const accountingDriftUsd = Math.abs(Number(input.portfolio.totalPnl || 0) - accountingReconciliation);
  const currentDrawdownPercent = input.portfolio.peakValue > 0
    ? Math.max(0, ((input.portfolio.peakValue - equity) / input.portfolio.peakValue) * 100)
    : 0;

  const limits = {
    maxEntriesAsset1h: 2,
    maxEntriesAsset24h: 5,
    maxEntriesTotal24h: 12,
    maxEntryNotional24hUsd: equity * 2.5,
    maxExecutionCosts24hUsd: Math.max(10, equity * 0.005),
    maxCostToGrossEdgeRatio: 0.35,
    maxDailyLossUsd: equity * 0.02,
    maxWeeklyLossUsd: equity * 0.04,
    maxPlannedRiskUsd: equity * 0.03,
    maxStressLossUsd: equity * 0.06,
    maxCorrelatedSameDirection: 2,
    maxConsecutiveFullStopLosses: 4,
    maxCorrelatedFullStopLosses: 3,
    hardDrawdownPercent: 10,
    // A factor may carry no more planned stop risk than the whole book.
    maxFactorPlannedRiskUsd: equity * 0.03,
    // No higher than the existing daily entry notional budget.
    maxGrossNotionalUsdt: equity * 2.5,
  };

  const diagnostics = {
    equityUsd: equity,
    currentDrawdownPercent,
    entriesAsset1h,
    entriesAsset24h,
    entriesTotal24h: dayEntries.length,
    entryNotional24h,
    executionCosts24h,
    grossEdge24h,
    costToGrossEdgeRatio,
    netPnl24h,
    netPnl7d,
    plannedOpenRiskUsd,
    candidateMaxLossUsd: input.candidateMaxLossUsd,
    expectedShortfallUsd: expectedShortfall,
    stressLossUsd,
    correlatedSameDirectionCount,
    consecutiveFullStopLosses,
    correlatedFullStopLosses,
    accountingDriftUsd,
    factorExposure,
    grossNotionalUsdt,
    lossStreakProbation: false,
  };

  const reject = (reason: string): PortfolioRiskBudgetDecision => ({
    approved: false,
    reason,
    policyVersion: PORTFOLIO_RISK_POLICY_VERSION,
    diagnostics,
    limits,
  });

  if (!Number.isFinite(equity) || equity <= 0) return reject("Portfolio equity is invalid.");
  if (currentDrawdownPercent >= limits.hardDrawdownPercent) return reject(`Hard ${limits.hardDrawdownPercent}% drawdown circuit breaker is active.`);
  if (accountingDriftUsd > Math.max(5, equity * 0.005)) return reject(`Accounting reconciliation drift is $${accountingDriftUsd.toFixed(2)}; new entries are quarantined pending review.`);
  if (entriesAsset1h >= limits.maxEntriesAsset1h) return reject(`${input.asset} already reached its rolling hourly entry limit.`);
  if (entriesAsset24h >= limits.maxEntriesAsset24h) return reject(`${input.asset} already reached its rolling daily entry limit.`);
  if (dayEntries.length >= limits.maxEntriesTotal24h) return reject("Portfolio rolling daily entry limit is reached.");
  if (entryNotional24h + input.candidateNotionalUsd > limits.maxEntryNotional24hUsd) return reject("Rolling daily entry notional budget would be exceeded.");
  if (executionCosts24h + input.candidateEntryCostUsd > limits.maxExecutionCosts24hUsd) return reject("Rolling daily execution-cost budget would be exceeded.");
  if (dayClosed.length >= 3 && costToGrossEdgeRatio !== null && costToGrossEdgeRatio > limits.maxCostToGrossEdgeRatio) return reject("Execution costs consumed too much of the rolling daily gross edge.");
  if (netPnl24h <= -limits.maxDailyLossUsd) return reject("Rolling 24-hour loss circuit breaker is active.");
  if (netPnl7d <= -limits.maxWeeklyLossUsd) return reject("Rolling seven-day loss circuit breaker is active.");
  const streaks = [
    { active: consecutiveFullStopLosses >= limits.maxConsecutiveFullStopLosses, newestMs: newestClosedMs, label: "Portfolio" },
    { active: correlatedFullStopLosses >= limits.maxCorrelatedFullStopLosses, newestMs: newestClusterMs, label: candidateCluster },
  ].filter((streak) => streak.active);
  for (const streak of streaks) {
    const coolOffEndsMs = streak.newestMs + LOSS_STREAK_COOL_OFF_HOURS * HOUR_MS;
    if (nowMs < coolOffEndsMs) {
      return reject(`${streak.label} full-stop loss streak: entries resume on probation after the ${LOSS_STREAK_COOL_OFF_HOURS}h cool-off (${new Date(coolOffEndsMs).toISOString()}).`);
    }
    if (openPositions.length > 0) return reject(`${streak.label} full-stop loss streak probation allows one open position at a time.`);
  }
  diagnostics.lossStreakProbation = streaks.length > 0;
  const factorRisk = (factorExposure[candidateExposureKey]?.plannedRiskUsdt ?? 0) + input.candidateMaxLossUsd;
  if (factorRisk > limits.maxFactorPlannedRiskUsd) {
    return reject(`FACTOR_RISK: ${candidateExposureKey} planned stop risk would be $${factorRisk.toFixed(2)}, above the $${limits.maxFactorPlannedRiskUsd.toFixed(2)} cap.`);
  }
  if (plannedOpenRiskUsd + input.candidateMaxLossUsd > limits.maxPlannedRiskUsd) return reject("Aggregate planned stop risk would exceed 3% of equity.");
  if (stressLossUsd > limits.maxStressLossUsd) return reject("Historical expected-shortfall stress plus planned risk would exceed 6% of equity.");
  if (correlatedSameDirectionCount >= limits.maxCorrelatedSameDirection) {
    return reject(`Correlated ${candidateExposureKey} exposure budget is full (${correlatedSameDirectionCount} open).`);
  }
  if (grossNotionalUsdt + input.candidateNotionalUsd > limits.maxGrossNotionalUsdt) {
    return reject(`GROSS_NOTIONAL: total notional would be $${(grossNotionalUsdt + input.candidateNotionalUsd).toFixed(2)}, above the $${limits.maxGrossNotionalUsdt.toFixed(2)} ceiling.`);
  }

  return {
    approved: true,
    reason: diagnostics.lossStreakProbation
      ? "Loss-streak probation: one position after the cool-off; a win ends the streak, another full stop restarts the cool-off."
      : "Rolling turnover, loss, correlation, accounting, and stress budgets allow this entry.",
    policyVersion: PORTFOLIO_RISK_POLICY_VERSION,
    diagnostics,
    limits,
  };
}
