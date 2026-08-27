/**
 * Turnover-dependent execution cost, for backtests only.
 *
 * The live book does not need this: it reads the actual bid and ask at fill
 * time, and costModelReconciliation.ts checks those readings against what the
 * market subsequently did. A replay has no quotes, so it needs an estimate —
 * and a single flat rate is not a neutral one. Charging every name the same
 * basis points makes thin markets look as cheap as deep ones, which biases
 * any test of "does trading more names help" in favour of adding thin names.
 * That is precisely the question the universe screen exists to answer, so the
 * flat rate would have decided it in advance.
 *
 * The curve below is measured rather than assumed. It is the median observed
 * half-spread across all 740 Bybit USDT perpetuals, bucketed by 24-hour
 * turnover, sampled 2026-08-27:
 *
 *   turnover        names   median   p75     p90
 *   under $1M        450    4.9bps   7.9     14.8
 *   $1M - $2M        103    3.1bps   5.1      7.5
 *   $2M - $5M         70    2.5bps   4.8      6.6
 *   $5M - $10M        40    1.3bps   3.2      4.6
 *   $10M - $25M       35    1.4bps   2.3      4.6
 *   $25M - $100M      29    0.7bps   1.5      3.3
 *   over $100M        13    0.3bps   0.5      0.6
 *
 * Two deliberate conservatisms. The p75 column is used rather than the median,
 * because a rebalance trades at whatever moment it arrives rather than at the
 * best moment, and because the sample is one instant in one market regime.
 * And spreads widen in exactly the conditions that make momentum books trade
 * most, which a calm-market snapshot cannot capture.
 *
 * This is a single-day snapshot of one venue. It is good enough to stop a
 * backtest flattering illiquid names, and not good enough to be quoted as a
 * cost forecast.
 */

export interface LiquidityCostConfig {
  /** Exchange fee per side, in basis points. Bybit taker is 5.5, maker 2.0. */
  feeBps: number;
  /**
   * Extra slippage charged on top of the half-spread, as a multiple of it.
   * Crossing the book moves the price beyond the touch when the order is
   * larger than what rests at the best quote.
   */
  slippageMultiple: number;
}

export const DEFAULT_LIQUIDITY_COST: LiquidityCostConfig = {
  // Assumes limit orders that mostly rest. A book rebalancing every 12 hours
  // has no urgency, so paying taker on every leg would be a pessimistic and
  // unrealistic assumption in the other direction.
  feeBps: 2.0,
  slippageMultiple: 1.0,
};

/** p75 observed half-spread by 24h turnover bucket, in basis points. */
const HALF_SPREAD_P75_BPS: Array<{ minTurnoverUsd: number; halfSpreadBps: number }> = [
  { minTurnoverUsd: 100e6, halfSpreadBps: 0.5 },
  { minTurnoverUsd: 25e6, halfSpreadBps: 1.5 },
  { minTurnoverUsd: 10e6, halfSpreadBps: 2.3 },
  { minTurnoverUsd: 5e6, halfSpreadBps: 3.2 },
  { minTurnoverUsd: 2e6, halfSpreadBps: 4.8 },
  { minTurnoverUsd: 1e6, halfSpreadBps: 5.1 },
  { minTurnoverUsd: 0, halfSpreadBps: 7.9 },
];

/** Expected half-spread for a market with this 24-hour turnover. */
export function estimateHalfSpreadBps(turnover24hUsd: number): number {
  for (const bucket of HALF_SPREAD_P75_BPS) {
    if (turnover24hUsd >= bucket.minTurnoverUsd) return bucket.halfSpreadBps;
  }
  return HALF_SPREAD_P75_BPS[HALF_SPREAD_P75_BPS.length - 1].halfSpreadBps;
}

/**
 * All-in one-way cost of trading a name with this turnover, in basis points.
 * Multiply by one-way turnover to get the cost of a rebalance.
 */
export function estimateOneWayCostBps(
  turnover24hUsd: number,
  config: LiquidityCostConfig = DEFAULT_LIQUIDITY_COST
): number {
  const halfSpread = estimateHalfSpreadBps(turnover24hUsd);
  return config.feeBps + halfSpread * (1 + config.slippageMultiple);
}
