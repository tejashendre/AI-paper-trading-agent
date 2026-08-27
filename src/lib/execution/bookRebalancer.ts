import crypto from "crypto";
import { getRedis } from "@/lib/redis";
import {
  BOOK_EQUITY_CURVE_KEY as SHARED_BOOK_KEY,
  EquityPoint,
  getEquityCurve as readCurve,
  recordEquityPoint as recordCurvePoint,
} from "./equityCurve";
import { Logger } from "@/lib/logger";
import {
  deriveExecutionCostProfile,
  estimatePaperFill,
  PaperFillEstimate,
} from "@/lib/trading/executionCostModel";
import {
  BookPlan,
  CROSS_SECTIONAL_STRATEGY_VERSION,
  DEFAULT_STRATEGY,
  StrategyConfig,
} from "@/lib/strategy/crossSectionalMomentum";
import { PerpTicker } from "@/lib/data/perpUniverse";
import { recordFillForReconciliation } from "@/lib/execution/costModelReconciliation";

/**
 * Paper execution for the cross-sectional book.
 *
 * A long/short rebalancing book is a different object from a stop-managed
 * swing position: it has no per-name stop, no take-profit and no entry/exit
 * lifecycle, only a target weight that changes on a schedule. Forcing it into
 * OpenPosition — which requires a stopLoss and takeProfit — would mean
 * inventing levels that never get used, so it keeps its own store.
 */

export const BOOK_PORTFOLIO_KEY = "xsec:portfolio";
export const BOOK_TRADES_KEY = "xsec:trades";
export const BOOK_SNAPSHOT_KEY = "xsec:lastRebalance";
/**
 * One equity point per rebalance, not per mark. The strategy's period is its
 * hold window, so sampling equity at that cadence gives the return series the
 * decay analysis actually needs; minute marks would measure noise between
 * decisions rather than the decisions themselves.
 */
export { BOOK_EQUITY_CURVE_KEY } from "./equityCurve";

/** Bybit VIP0 maker fee. Rebalances are scheduled, so they can rest as limits. */
export const MAKER_FEE_RATE = 0.0002;
/** Taker, for anything that must cross the spread immediately. */
export const TAKER_FEE_RATE = 0.00055;

export interface BookPosition {
  symbol: string;
  /** Signed quantity. Negative is short. */
  quantity: number;
  entryPrice: number;
  notionalUsd: number;
  weight: number;
  openedAt: string;
  lastRebalancedAt: string;
  feesPaidUsd: number;
  fundingPaidUsd: number;
  realizedPnlUsd: number;
}

export interface BookTrade {
  id: string;
  timestamp: string;
  symbol: string;
  action: BookPlan["orders"][number]["action"];
  quantity: number;
  price: number;
  requestedPrice: number;
  notionalUsd: number;
  feeUsd: number;
  executionCostUsd: number;
  realizedPnlUsd: number;
  weightFrom: number;
  weightTo: number;
  strategyVersion: string;
}

export interface BookPortfolio {
  cashUsd: number;
  initialCapitalUsd: number;
  positions: Record<string, BookPosition>;
  realizedPnlUsd: number;
  feesPaidUsd: number;
  fundingPaidUsd: number;
  executionCostsUsd: number;
  totalRebalances: number;
  totalFills: number;
  peakEquityUsd: number;
  maxDrawdownPercent: number;
  strategyVersion: string;
  createdAt: string;
  updatedAt: string;
}

export function emptyBookPortfolio(initialCapitalUsd = 10_000): BookPortfolio {
  const now = new Date().toISOString();
  return {
    cashUsd: initialCapitalUsd,
    initialCapitalUsd,
    positions: {},
    realizedPnlUsd: 0,
    feesPaidUsd: 0,
    fundingPaidUsd: 0,
    executionCostsUsd: 0,
    totalRebalances: 0,
    totalFills: 0,
    peakEquityUsd: initialCapitalUsd,
    maxDrawdownPercent: 0,
    strategyVersion: CROSS_SECTIONAL_STRATEGY_VERSION,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Equity is cash plus the mark-to-market value of open positions.
 *
 * Positions are held on margin, so their notional is not deducted from cash;
 * only realised results, fees and funding move it. Unrealised PnL is added
 * here rather than being folded into cash, which keeps the accounting
 * reconcilable at any instant.
 */
export function bookEquityUsd(portfolio: BookPortfolio, prices: Map<string, PerpTicker>): number {
  let unrealized = 0;
  for (const position of Object.values(portfolio.positions)) {
    const mark = prices.get(position.symbol)?.markPrice;
    if (!Number.isFinite(mark) || !mark) continue;
    unrealized += position.quantity * (mark - position.entryPrice);
  }
  return portfolio.cashUsd + unrealized;
}

export function currentWeights(portfolio: BookPortfolio, prices: Map<string, PerpTicker>): Map<string, number> {
  const equity = bookEquityUsd(portfolio, prices);
  const weights = new Map<string, number>();
  if (!(equity > 0)) return weights;
  for (const position of Object.values(portfolio.positions)) {
    const mark = prices.get(position.symbol)?.markPrice ?? position.entryPrice;
    weights.set(position.symbol, (position.quantity * mark) / equity);
  }
  return weights;
}

function fillFor(
  symbol: string,
  ticker: PerpTicker,
  quantity: number,
  isReducing: boolean
): PaperFillEstimate {
  const profile = deriveExecutionCostProfile(symbol, ticker.turnover24h);
  return estimatePaperFill({
    asset: symbol,
    action: quantity > 0 ? "BUY" : "SELL",
    requestedPrice: ticker.markPrice,
    amount: Math.abs(quantity),
    context: {
      // A scheduled rebalance can rest as a limit order; a risk-driven
      // reduction cannot wait, so it pays the taker side.
      reason: isReducing ? "SIGNAL_INVALIDATION" : "ENTRY",
      assetMode: "REALTIME_FAST",
      dataQuality: 92,
      isPeakLiquidity: false,
    },
    profile,
    feeRate: isReducing ? TAKER_FEE_RATE : MAKER_FEE_RATE,
  });
}

export interface PendingReconciliation {
  symbol: string;
  side: "BUY" | "SELL";
  ticker: PerpTicker;
  fill: PaperFillEstimate;
}

export interface RebalanceResult {
  executed: number;
  skipped: number;
  turnover: number;
  equityBefore: number;
  equityAfter: number;
  feesUsd: number;
  trades: BookTrade[];
  reason: string;
  /** Fills to hand to the cost-model reconciler. Kept out of applyBookPlan's
   *  own I/O so the function stays pure and replayable. */
  reconciliation: PendingReconciliation[];
}

/**
 * Apply a plan to the book. Reductions run before increases so margin is
 * freed before it is consumed, which the plan ordering already guarantees.
 */
export function applyBookPlan(input: {
  portfolio: BookPortfolio;
  plan: BookPlan;
  prices: Map<string, PerpTicker>;
  config?: StrategyConfig;
}): RebalanceResult {
  const { portfolio, plan, prices } = input;
  const equityBefore = bookEquityUsd(portfolio, prices);
  const trades: BookTrade[] = [];
  const reconciliation: PendingReconciliation[] = [];
  let executed = 0;
  let skipped = 0;
  let feesUsd = 0;

  if (plan.skipped || plan.orders.length === 0) {
    return {
      executed: 0, skipped: plan.orders.length, turnover: plan.turnover,
      equityBefore, equityAfter: equityBefore, feesUsd: 0, trades, reason: plan.reason,
      reconciliation,
    };
  }

  for (const order of plan.orders) {
    const ticker = prices.get(order.symbol);
    if (!ticker || !(ticker.markPrice > 0)) {
      skipped++;
      continue;
    }

    const existing = portfolio.positions[order.symbol];
    const existingQty = existing?.quantity ?? 0;
    const targetQty = (order.toWeight * equityBefore) / ticker.markPrice;
    const deltaQty = targetQty - existingQty;
    if (!Number.isFinite(deltaQty) || Math.abs(deltaQty * ticker.markPrice) < 1) {
      skipped++;
      continue;
    }

    const isReducing = existingQty !== 0 && Math.abs(targetQty) < Math.abs(existingQty);
    const fill = fillFor(order.symbol, ticker, deltaQty, isReducing);
    const fillPrice = fill.fillPrice;
    reconciliation.push({
      symbol: order.symbol,
      side: deltaQty > 0 ? "BUY" : "SELL",
      ticker,
      fill,
    });

    // Realise PnL on whatever part of the trade closes existing exposure.
    let realized = 0;
    if (existing && existingQty !== 0 && Math.sign(deltaQty) !== Math.sign(existingQty)) {
      const closedQty = Math.min(Math.abs(deltaQty), Math.abs(existingQty)) * Math.sign(existingQty);
      realized = closedQty * (fillPrice - existing.entryPrice);
    }

    portfolio.cashUsd += realized - fill.feeUsd;
    portfolio.realizedPnlUsd += realized;
    portfolio.feesPaidUsd += fill.feeUsd;
    portfolio.executionCostsUsd += fill.totalExecutionCostUsd;
    feesUsd += fill.feeUsd;

    const now = new Date().toISOString();
    if (Math.abs(targetQty * ticker.markPrice) < 1) {
      delete portfolio.positions[order.symbol];
    } else {
      // Averaging only applies when adding in the same direction; a flip or a
      // reduction leaves the remaining lot at its original basis.
      const addingSameWay = existingQty === 0 || Math.sign(targetQty) === Math.sign(existingQty);
      const nextEntry = existing && addingSameWay && Math.abs(targetQty) > Math.abs(existingQty)
        ? ((existing.entryPrice * existingQty) + (fillPrice * deltaQty)) / targetQty
        : existing && addingSameWay
          ? existing.entryPrice
          : fillPrice;

      portfolio.positions[order.symbol] = {
        symbol: order.symbol,
        quantity: targetQty,
        entryPrice: nextEntry,
        notionalUsd: Math.abs(targetQty * fillPrice),
        weight: order.toWeight,
        openedAt: existing?.openedAt ?? now,
        lastRebalancedAt: now,
        feesPaidUsd: (existing?.feesPaidUsd ?? 0) + fill.feeUsd,
        fundingPaidUsd: existing?.fundingPaidUsd ?? 0,
        realizedPnlUsd: (existing?.realizedPnlUsd ?? 0) + realized,
      };
    }

    trades.push({
      id: crypto.randomUUID(),
      timestamp: now,
      symbol: order.symbol,
      action: order.action,
      quantity: deltaQty,
      price: fillPrice,
      requestedPrice: ticker.markPrice,
      notionalUsd: Math.abs(deltaQty * fillPrice),
      feeUsd: fill.feeUsd,
      executionCostUsd: fill.totalExecutionCostUsd,
      realizedPnlUsd: realized,
      weightFrom: order.fromWeight,
      weightTo: order.toWeight,
      strategyVersion: plan.strategyVersion,
    });
    executed++;
  }

  portfolio.totalRebalances += 1;
  portfolio.totalFills += executed;
  portfolio.updatedAt = new Date().toISOString();

  const equityAfter = bookEquityUsd(portfolio, prices);
  if (equityAfter > portfolio.peakEquityUsd) portfolio.peakEquityUsd = equityAfter;
  if (portfolio.peakEquityUsd > 0) {
    const drawdown = ((portfolio.peakEquityUsd - equityAfter) / portfolio.peakEquityUsd) * 100;
    if (drawdown > portfolio.maxDrawdownPercent) portfolio.maxDrawdownPercent = drawdown;
  }

  return { executed, skipped, turnover: plan.turnover, equityBefore, equityAfter, feesUsd, trades, reason: plan.reason, reconciliation };
}

/**
 * Charge funding on open positions. Longs pay a positive rate, shorts receive
 * it. Funding is a real and sometimes dominant cost for a perpetual book, so
 * it is settled explicitly rather than folded into an assumed spread.
 */
export function settleFunding(portfolio: BookPortfolio, prices: Map<string, PerpTicker>): number {
  let total = 0;
  for (const position of Object.values(portfolio.positions)) {
    const ticker = prices.get(position.symbol);
    if (!ticker || !Number.isFinite(ticker.fundingRate)) continue;
    const notional = Math.abs(position.quantity) * ticker.markPrice;
    const payment = notional * ticker.fundingRate * Math.sign(position.quantity);
    total += payment;
    position.fundingPaidUsd += payment;
  }
  portfolio.cashUsd -= total;
  portfolio.fundingPaidUsd += total;
  return total;
}

// ── persistence ──────────────────────────────────────────────────────────────

export async function loadBookPortfolio(initialCapitalUsd = 10_000): Promise<BookPortfolio> {
  const stored = await getRedis().get<BookPortfolio>(BOOK_PORTFOLIO_KEY).catch(() => null);
  if (!stored || !Number.isFinite(stored.cashUsd)) return emptyBookPortfolio(initialCapitalUsd);
  return { ...emptyBookPortfolio(initialCapitalUsd), ...stored, positions: stored.positions || {} };
}

export async function saveBookPortfolio(portfolio: BookPortfolio): Promise<void> {
  await getRedis().set(BOOK_PORTFOLIO_KEY, portfolio);
}

/** Hand the rebalance's fills to the cost-model reconciler. */
export async function recordReconciliation(pending: PendingReconciliation[]): Promise<void> {
  for (const item of pending) await recordFillForReconciliation(item).catch(() => undefined);
}

export async function recordBookTrades(trades: BookTrade[]): Promise<void> {
  if (trades.length === 0) return;
  const redis = getRedis();
  for (const trade of trades) await redis.lpush(BOOK_TRADES_KEY, trade);
  await redis.ltrim(BOOK_TRADES_KEY, 0, 999);
}

export async function recordEquityPoint(portfolio: BookPortfolio, equityUsd: number): Promise<void> {
  await recordCurvePoint(SHARED_BOOK_KEY, {
    equityUsd,
    // Closed-trade equity, so the sleeve comparison is measuring realised
    // outcomes on both sides rather than one sleeve's marking schedule.
    realizedEquityUsd: portfolio.initialCapitalUsd + portfolio.realizedPnlUsd,
  });
}

export async function getEquityCurve(limit?: number): Promise<EquityPoint[]> {
  return readCurve(SHARED_BOOK_KEY, limit);
}

export async function getBookTrades(limit = 100): Promise<BookTrade[]> {
  const rows = await getRedis().lrange(BOOK_TRADES_KEY, 0, limit - 1).catch(() => [] as string[]);
  return rows
    .map((row) => { try { return JSON.parse(row) as BookTrade; } catch { return null; } })
    .filter((t): t is BookTrade => t !== null);
}

export async function logRebalance(result: RebalanceResult, plan: BookPlan): Promise<void> {
  await getRedis().set(BOOK_SNAPSHOT_KEY, {
    at: new Date().toISOString(),
    strategyVersion: plan.strategyVersion,
    universeSize: plan.universeSize,
    executed: result.executed,
    skipped: result.skipped,
    turnover: result.turnover,
    equityBefore: result.equityBefore,
    equityAfter: result.equityAfter,
    feesUsd: result.feesUsd,
    reason: result.reason,
    targets: plan.targets.map((t) => ({ symbol: t.symbol, side: t.side, weight: t.weight, rank: t.rank, momentum: t.momentum })),
  }, { ex: 86_400 }).catch(() => undefined);

  await Logger.info(
    `[XSEC] rebalance: ${result.executed} fills, ${(result.turnover * 100).toFixed(1)}% turnover, ` +
    `equity $${result.equityAfter.toFixed(2)}, fees $${result.feesUsd.toFixed(2)}. ${result.reason}`
  ).catch(() => undefined);
}
