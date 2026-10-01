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
  // Taker. Maker status is earned only by simulating a resting order, and no
  // replay here does; a scheduled rebalance is not evidence of a maker fill.
  feeBps: 5.5,
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

// ---------------------------------------------------------------------------
// Per-fill capacity. Initial conservative limits, versioned as part of the
// risk policy; they are not claims of optimal parameters.
// ---------------------------------------------------------------------------

export const FILL_CAPACITY_POLICY = {
  version: "fill-capacity-v1-2026-10-01",
  /** A fill may be at most this share of 24h turnover. */
  maxTurnoverShare: 0.01,
  /** ...and at most this share of opposing depth within the band. */
  maxDepthShare: 0.1,
  depthBandBps: 10,
  /** One-way spread plus impact may use at most this share of the stop distance. */
  maxCostToStopShare: 0.1,
} as const;

export interface LiquiditySnapshot {
  bestBid: number;
  bestAsk: number;
  /** [price, quantity], best first. */
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  turnover24hUsdt: number;
  observedAtMs: number;
}

type Side = "BUY" | "SELL";

function bookProblem(liquidity: LiquiditySnapshot | null, side: Side): string | null {
  if (!liquidity) return "no order book observation";
  const { bestBid, bestAsk } = liquidity;
  if (!(Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk > 0)) return "best bid or ask is missing";
  if (bestBid >= bestAsk) return `book is crossed or locked (bid ${bestBid}, ask ${bestAsk})`;
  if ((side === "BUY" ? liquidity.asks : liquidity.bids).length === 0) return "no opposing depth";
  if (!(liquidity.turnover24hUsdt > 0)) return "24h turnover is unavailable";
  return null;
}

/** Opposing notional resting within the depth band of the touch. */
function depthWithinBand(side: Side, liquidity: LiquiditySnapshot): number {
  const band = FILL_CAPACITY_POLICY.depthBandBps / 10_000;
  const levels = side === "BUY" ? liquidity.asks : liquidity.bids;
  const limit = side === "BUY" ? liquidity.bestAsk * (1 + band) : liquidity.bestBid * (1 - band);
  return levels
    .filter(([price, qty]) => price > 0 && qty > 0 && (side === "BUY" ? price <= limit : price >= limit))
    .reduce((sum, [price, qty]) => sum + price * qty, 0);
}

/** The largest notional the capacity limits allow, or null when liquidity is unobserved. */
export function capacityNotionalCap(input: { side: Side; liquidity: LiquiditySnapshot | null }): number | null {
  if (bookProblem(input.liquidity, input.side)) return null;
  const liquidity = input.liquidity!;
  return Math.min(
    FILL_CAPACITY_POLICY.maxTurnoverShare * liquidity.turnover24hUsdt,
    FILL_CAPACITY_POLICY.maxDepthShare * depthWithinBand(input.side, liquidity)
  );
}

/**
 * Whether a proposed fill fits observed liquidity. An outage or a broken
 * book is never treated as a free fill at the last price.
 */
export function evaluateFillCapacity(input: {
  side: Side;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  impactBps: number;
  liquidity: LiquiditySnapshot | null;
}) {
  const problem = bookProblem(input.liquidity, input.side);
  const notionalUsdt = input.quantity * input.entryPrice;
  if (problem) {
    return {
      allowed: false,
      reasons: [`LIQUIDITY_UNAVAILABLE: ${problem}`],
      snapshot: { policyVersion: FILL_CAPACITY_POLICY.version, notionalUsdt, observedAtMs: input.liquidity?.observedAtMs ?? null },
    };
  }
  const liquidity = input.liquidity!;
  const mid = (liquidity.bestBid + liquidity.bestAsk) / 2;
  const spreadBps = ((liquidity.bestAsk - liquidity.bestBid) / mid) * 10_000;
  const halfSpreadBps = spreadBps / 2;
  const depth = depthWithinBand(input.side, liquidity);
  const stopDistanceBps = (Math.abs(input.entryPrice - input.stopPrice) / input.entryPrice) * 10_000;
  const costBps = halfSpreadBps + Math.max(0, input.impactBps);
  const costToStopShare = stopDistanceBps > 0 ? costBps / stopDistanceBps : Number.POSITIVE_INFINITY;

  const reasons: string[] = [];
  const turnoverCap = FILL_CAPACITY_POLICY.maxTurnoverShare * liquidity.turnover24hUsdt;
  if (notionalUsdt > turnoverCap) {
    reasons.push(`TURNOVER_CAPACITY: ${notionalUsdt.toFixed(2)} USDT exceeds ${(FILL_CAPACITY_POLICY.maxTurnoverShare * 100).toFixed(0)}% of 24h turnover (${turnoverCap.toFixed(2)})`);
  }
  if (notionalUsdt > FILL_CAPACITY_POLICY.maxDepthShare * depth) {
    reasons.push(`DEPTH_CAPACITY: ${notionalUsdt.toFixed(2)} USDT exceeds ${(FILL_CAPACITY_POLICY.maxDepthShare * 100).toFixed(0)}% of ${depth.toFixed(2)} USDT resting within ${FILL_CAPACITY_POLICY.depthBandBps} bps`);
  }
  if (costToStopShare > FILL_CAPACITY_POLICY.maxCostToStopShare) {
    reasons.push(`COST_TO_STOP: ${costBps.toFixed(2)} bps of spread and impact is ${(costToStopShare * 100).toFixed(0)}% of a ${stopDistanceBps.toFixed(2)} bps stop`);
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    snapshot: {
      policyVersion: FILL_CAPACITY_POLICY.version,
      observedAtMs: liquidity.observedAtMs,
      bestBid: liquidity.bestBid,
      bestAsk: liquidity.bestAsk,
      spreadBps,
      halfSpreadBps,
      depthWithinBandUsdt: depth,
      turnover24hUsdt: liquidity.turnover24hUsdt,
      notionalUsdt,
      costToStopShare,
    },
  };
}
