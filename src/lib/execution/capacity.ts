/**
 * How much capital this strategy could actually run.
 *
 * Paper trading hides the single hardest constraint on a real book: you cannot
 * trade more than the market will absorb. A backtest fills every order at the
 * mark no matter the size, so a strategy that looks identical at $10,000 and
 * at $10,000,000 in simulation can be completely untradeable at the larger
 * figure. Reporting a return percentage without a capacity figure invites
 * exactly that mistake — the percentage is only meaningful up to the point
 * where the trades stop being fillable.
 *
 * The constraint is per name, not per book. A dollar-neutral book holding
 * twelve names a side at ten percent each is limited by its *thinnest*
 * holding: if one name can only absorb $200k of the rebalance, the whole book
 * is capped at whatever equity makes that position $200k, regardless of how
 * deep the other twenty-three markets are.
 */

import type { PerpTicker } from "@/lib/data/perpUniverse";

/**
 * Share of a market's 24-hour turnover this book is willing to be.
 *
 * Two percent is a conservative figure drawn from standard practice rather
 * than from anything measured here: above roughly five percent of daily volume
 * a participant starts moving the price against itself, and the strategy's
 * whole edge is a few basis points, so even modest impact erases it. Being
 * wrong in the optimistic direction here is expensive and hard to detect, so
 * the default sits well below where trouble is thought to begin.
 */
export const DEFAULT_PARTICIPATION_LIMIT = 0.02;

export interface CapacityInput {
  /** Current book weights by symbol; sign is ignored, only size matters. */
  weights: Map<string, number>;
  prices: Map<string, PerpTicker>;
  currentEquityUsd: number;
  participationLimit?: number;
  /**
   * Average one-way turnover of a rebalance, as a fraction of the book. A name
   * whose weight barely moves does not need its whole notional to be fillable.
   */
  rebalanceTurnoverFraction?: number;
}

export interface NameCapacity {
  symbol: string;
  weight: number;
  turnover24hUsd: number;
  /** Book equity at which this name alone becomes the binding constraint. */
  capacityUsd: number;
  /** Notional currently held in this name. */
  currentNotionalUsd: number;
}

export interface CapacityReport {
  /** Largest book equity every current holding could still be traded at. */
  capacityUsd: number;
  /** The name that sets the limit. */
  bindingSymbol: string | null;
  bindingTurnoverUsd: number;
  currentEquityUsd: number;
  /** currentEquityUsd / capacityUsd. Above 1.0 the book is already too big. */
  utilisation: number;
  participationLimit: number;
  namesAssessed: number;
  /** Tightest names first — the ones that would break first on scaling up. */
  tightest: NameCapacity[];
  explanation: string;
}

/**
 * Book equity at which trading this name would exceed the participation limit.
 *
 * A name held at weight w in a book of equity E carries notional w*E. A
 * rebalance trades some fraction f of that. The trade is acceptable while
 * f*w*E stays under participation*turnover, so the limiting equity is
 * participation*turnover / (f*w).
 */
function nameCapacityUsd(
  weight: number,
  turnover24hUsd: number,
  participationLimit: number,
  turnoverFraction: number
): number {
  const size = Math.abs(weight);
  if (!(size > 0)) return Infinity;
  const tradedShare = size * Math.max(0.05, turnoverFraction);
  if (!(turnover24hUsd > 0)) return 0;
  return (participationLimit * turnover24hUsd) / tradedShare;
}

export function estimateBookCapacity(input: CapacityInput): CapacityReport {
  const participationLimit = input.participationLimit ?? DEFAULT_PARTICIPATION_LIMIT;
  const turnoverFraction = input.rebalanceTurnoverFraction ?? 0.45;

  const names: NameCapacity[] = [];
  for (const [symbol, weight] of input.weights) {
    if (!(Math.abs(weight) > 0)) continue;
    const ticker = input.prices.get(symbol);
    const turnover = ticker?.turnover24h ?? 0;
    names.push({
      symbol,
      weight,
      turnover24hUsd: turnover,
      capacityUsd: nameCapacityUsd(weight, turnover, participationLimit, turnoverFraction),
      currentNotionalUsd: Math.abs(weight) * input.currentEquityUsd,
    });
  }

  if (names.length === 0) {
    return {
      capacityUsd: 0,
      bindingSymbol: null,
      bindingTurnoverUsd: 0,
      currentEquityUsd: input.currentEquityUsd,
      utilisation: 0,
      participationLimit,
      namesAssessed: 0,
      tightest: [],
      explanation: "No open positions, so there is nothing to size against yet.",
    };
  }

  const tightest = [...names].sort((a, b) => a.capacityUsd - b.capacityUsd);
  const binding = tightest[0];
  const capacityUsd = binding.capacityUsd;
  const utilisation = capacityUsd > 0 ? input.currentEquityUsd / capacityUsd : Infinity;

  const explanation = capacityUsd === 0
    ? `${binding.symbol} reports no 24-hour turnover, so no size can be justified in it.`
    : `Holding ${names.length} names, the tightest is ${binding.symbol} at ` +
      `$${(binding.turnover24hUsd / 1e6).toFixed(1)}M daily turnover and ${(Math.abs(binding.weight) * 100).toFixed(1)}% weight. ` +
      `Staying under ${(participationLimit * 100).toFixed(0)}% of its daily volume caps the whole book at about ` +
      `$${formatUsd(capacityUsd)}. The book is at $${formatUsd(input.currentEquityUsd)}, ` +
      `which is ${utilisation < 0.01 ? "well under" : `${(utilisation * 100).toFixed(1)}% of`} that ceiling.`;

  return {
    capacityUsd,
    bindingSymbol: binding.symbol,
    bindingTurnoverUsd: binding.turnover24hUsd,
    currentEquityUsd: input.currentEquityUsd,
    utilisation,
    participationLimit,
    namesAssessed: names.length,
    tightest: tightest.slice(0, 5),
    explanation,
  };
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "unbounded";
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}k`;
  return value.toFixed(0);
}

/**
 * Capacity of the strategy in principle, rather than of the book as currently
 * held. Answers "how large could this ever be", by assuming the book always
 * holds its maximum name count at its maximum per-name weight against the
 * given set of eligible markets.
 *
 * This is the number to quote when asked whether the strategy would work with
 * a much larger amount of money, because it does not depend on which names
 * happen to be held today.
 */
export function estimateStrategyCapacity(input: {
  eligibleTurnoversUsd: number[];
  bookSize: number;
  maxWeightPerName: number;
  participationLimit?: number;
  rebalanceTurnoverFraction?: number;
}): { capacityUsd: number; namesUsed: number; thinnestTurnoverUsd: number } {
  const participationLimit = input.participationLimit ?? DEFAULT_PARTICIPATION_LIMIT;
  const turnoverFraction = input.rebalanceTurnoverFraction ?? 0.45;

  // The book takes the extremes of the ranking, which are not chosen for
  // liquidity. Assume it ends up holding the thinnest names it is allowed to,
  // because over enough rebalances it will.
  const sorted = [...input.eligibleTurnoversUsd].sort((a, b) => a - b);
  const namesUsed = Math.min(sorted.length, input.bookSize * 2);
  if (namesUsed === 0) return { capacityUsd: 0, namesUsed: 0, thinnestTurnoverUsd: 0 };

  const thinnest = sorted[0];
  return {
    capacityUsd: nameCapacityUsd(input.maxWeightPerName, thinnest, participationLimit, turnoverFraction),
    namesUsed,
    thinnestTurnoverUsd: thinnest,
  };
}
