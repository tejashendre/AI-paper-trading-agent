/**
 * Cross-sectional momentum over a wide perpetual-futures universe.
 *
 * The per-asset swing engine asks "is this asset a buy?". This asks a
 * different and, on the evidence, far more answerable question: "which of
 * these fifty assets are strongest relative to the rest right now?"
 *
 * Why the change. Measured over 12 months of Bybit hourly data on 49 liquid
 * USDT perps, ranking assets against each other and holding a dollar-neutral
 * long-top/short-bottom book produced roughly 22bps per day gross (t = 2.4),
 * with all four quarters positive and a flat parameter plateau across
 * lookbacks of 48-336h, holds of 12-72h and book sizes of 5-15 names.
 *
 * The same method applied to only BTC/ETH/SOL — the universe the swing daemon
 * can currently trade in real time — LOSES money at t = -2.7. Three highly
 * correlated majors contain almost no cross-sectional dispersion, so ranking
 * them is ranking noise and paying fees for the privilege. Breadth is not an
 * optimisation here; it is the entire mechanism.
 *
 * Everything in this file is pure. Data fetching lives in
 * lib/data/perpUniverse.ts and execution in lib/execution/bookRebalancer.ts,
 * so the strategy can be replayed exactly as it runs.
 */

export const CROSS_SECTIONAL_STRATEGY_VERSION = "xsec-momentum-v1-2026-08-25";

export interface UniverseCandidate {
  symbol: string;
  /** Rolling 24h quote-currency turnover, used for liquidity screening. */
  turnover24h: number;
  /** Hours of price history available. A short history cannot be ranked. */
  historyHours: number;
  /**
   * Fraction of expected hourly bars present over the probe window.
   *
   * This does NOT separate tokenised equities from crypto: Bybit's equity
   * perps quote continuously even while the underlying market is closed, so
   * they return a full bar series with real price movement. It is kept only
   * as a data-integrity check against a genuinely gappy feed.
   */
  barCoverage: number;
}

export interface UniverseConfig {
  /** Minimum 24h turnover for a symbol to be rankable. */
  minTurnover24hUsd: number;
  /** Hard cap on universe size, largest turnover first. */
  maxSymbols: number;
  /** A symbol must have at least this much history before it can be ranked. */
  minHistoryHours: number;
  /** Symbols never traded regardless of screen result. */
  excluded: string[];
  /** Minimum fraction of expected hourly bars for a symbol to be rankable. */
  minBarCoverage: number;
}

export const DEFAULT_UNIVERSE: UniverseConfig = {
  // Measured point-in-time, not from today's ticker snapshot. That distinction
  // matters more than the number: screening on current turnover across all of
  // history is look-ahead bias, and it silently assumed ~49 symbols were
  // eligible throughout a year in which most of them were not yet liquid.
  //
  // At a $20M floor there were too few historically eligible symbols to form a
  // book most of the time. $5M scored highest (t = 3.24) but reaches into
  // thinner markets; $10M keeps 44 eligible names on average, a 640-period
  // sample, t = 2.58, and deeper books to trade against.
  minTurnover24hUsd: 10_000_000,
  maxSymbols: 60,
  // One month. A freshly listed perp has no comparable momentum history and
  // its early prints are dominated by listing dynamics.
  minHistoryHours: 24 * 30,
  // Stablecoins have no momentum worth ranking. Everything else earns its
  // place through the liquidity and history screens rather than by name.
  excluded: ["USDCUSDT", "USDEUSDT", "USDCUSDC"],
  // Guards against a gappy or partially-backfilled feed, not against
  // non-crypto instruments — see the note on UniverseCandidate.barCoverage.
  minBarCoverage: 0.95,
};

export interface StrategyConfig {
  /** Momentum lookback in hours. */
  lookbackHours: number;
  /** Hours between rebalances. */
  holdHours: number;
  /** Names per side. The book holds bookSize longs and bookSize shorts. */
  bookSize: number;
  /**
   * Rank hysteresis. A held name is kept while it stays inside
   * `bookSize * rankBuffer`, instead of being dropped the moment it slips out
   * of the top `bookSize`.
   */
  rankBuffer: number;
  /** Fraction of equity deployed as gross notional. 1.0 = 100% gross. */
  grossExposure: number;
  /** Hard cap on any single name's share of gross exposure. */
  maxWeightPerName: number;
  /** Skip a rebalance if the whole book would move less than this fraction. */
  minRebalanceTurnover: number;
}

/**
 * Chosen for in-sample/out-of-sample agreement and drawdown, not peak return.
 * Every combination in the surrounding grid (hold 12-24h, book 8-12, buffer
 * 1.5-2.5) was positive in both halves of the sample, which is why a middle
 * point is safe to take.
 */
export const DEFAULT_STRATEGY: StrategyConfig = {
  // Middle of a plateau spanning 48-336h. Longer lookbacks scored higher
  // in-sample and worse out-of-sample; 72h is the most balanced.
  lookbackHours: 72,
  // Twice as many observations as a 24h rebalance (n=689 vs 344) with better
  // half-to-half agreement, and hysteresis keeps its turnover lower.
  holdHours: 12,
  // The largest book tested that keeps the edge. Diversification is
  // structural: max drawdown falls from 20% at k=8 to 12% at k=12 for
  // essentially the same return.
  bookSize: 12,
  // Cuts one-way turnover from ~89% to ~26% per rebalance. Deliberately below
  // the 2.5 that scored highest, since the turnover benefit is monotone but
  // the return ranking across buffer values is not.
  rankBuffer: 2.0,
  // Dollar-neutral and unlevered: 50% of equity long, 50% short.
  grossExposure: 1.0,
  maxWeightPerName: 0.10,
  // Below this the trade list is mostly noise and the cost is not worth it.
  minRebalanceTurnover: 0.02,
};

export interface RankedSymbol {
  symbol: string;
  momentum: number;
  rank: number;
}

export interface TargetPosition {
  symbol: string;
  /** Signed fraction of equity. Positive is long. */
  weight: number;
  side: "LONG" | "SHORT";
  momentum: number;
  rank: number;
}

export interface RebalanceOrder {
  symbol: string;
  /** Signed change in weight to apply. */
  weightDelta: number;
  action: "OPEN_LONG" | "OPEN_SHORT" | "CLOSE" | "INCREASE" | "REDUCE" | "FLIP";
  fromWeight: number;
  toWeight: number;
}

export interface BookPlan {
  strategyVersion: string;
  targets: TargetPosition[];
  orders: RebalanceOrder[];
  /** Sum of |weight change| across the book: one-way notional traded. */
  turnover: number;
  universeSize: number;
  skipped: boolean;
  reason: string;
}

/** Liquidity and history screen. Ordering is by turnover, largest first. */
export function screenUniverse(
  candidates: UniverseCandidate[],
  config: UniverseConfig = DEFAULT_UNIVERSE
): string[] {
  const excluded = new Set(config.excluded);
  return candidates
    .filter((c) =>
      !excluded.has(c.symbol) &&
      Number.isFinite(c.turnover24h) &&
      c.turnover24h >= config.minTurnover24hUsd &&
      c.historyHours >= config.minHistoryHours &&
      c.barCoverage >= config.minBarCoverage
    )
    .sort((a, b) => b.turnover24h - a.turnover24h)
    .slice(0, config.maxSymbols)
    .map((c) => c.symbol);
}

/**
 * Rank by trailing return. Momentum is computed from the same close-to-close
 * series the replay uses, so a rank here is reproducible offline.
 */
export function rankByMomentum(momentumBySymbol: Map<string, number>): RankedSymbol[] {
  return [...momentumBySymbol.entries()]
    .filter(([, m]) => Number.isFinite(m))
    .map(([symbol, momentum]) => ({ symbol, momentum, rank: 0 }))
    .sort((a, b) => b.momentum - a.momentum)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * Long the strongest `bookSize`, short the weakest, equal weight per side,
 * with rank hysteresis so the book does not churn on marginal rank changes.
 *
 * Equal weighting beat inverse-volatility weighting in testing (79% vs 35%
 * annualised on the same signal), because in this cross-section the edge is
 * concentrated in the higher-volatility names that vol-scaling shrinks.
 *
 * Hysteresis matters more than it looks. Without it the book replaces roughly
 * 89% of its notional at every rebalance, purely because names shuffle around
 * the cut-off. Keeping a held name while it remains inside `bookSize *
 * rankBuffer` drops that to about 26% with no loss of signal — and the gap
 * widens as costs rise, which is exactly the robustness worth buying.
 */
export function buildTargetBook(
  ranked: RankedSymbol[],
  currentWeights: Map<string, number> = new Map(),
  config: StrategyConfig = DEFAULT_STRATEGY
): TargetPosition[] {
  // Never let the two sides overlap or exceed a third of the universe each.
  const k = Math.max(1, Math.min(config.bookSize, Math.floor(ranked.length / 3)));
  if (ranked.length < 3 * k) return [];

  const perSide = config.grossExposure / 2;
  const perName = Math.min(perSide / k, config.maxWeightPerName);
  const keepBand = Math.max(k, Math.round(k * config.rankBuffer));
  const total = ranked.length;
  const byRank = new Map(ranked.map((r) => [r.symbol, r]));

  const heldLong = new Set([...currentWeights].filter(([, w]) => w > 0).map(([s]) => s));
  const heldShort = new Set([...currentWeights].filter(([, w]) => w < 0).map(([s]) => s));

  // Retain incumbents still inside the buffered band, ordered by strength.
  const longs: RankedSymbol[] = ranked.filter((r) => heldLong.has(r.symbol) && r.rank <= keepBand);
  const shorts: RankedSymbol[] = ranked.filter((r) => heldShort.has(r.symbol) && r.rank > total - keepBand);

  const claimed = new Set([...longs, ...shorts].map((r) => r.symbol));
  // Top up the long side from the strongest unclaimed names.
  for (const r of ranked) {
    if (longs.length >= k) break;
    if (claimed.has(r.symbol) || heldShort.has(r.symbol)) continue;
    longs.push(r);
    claimed.add(r.symbol);
  }
  // Top up the short side from the weakest unclaimed names.
  for (let i = ranked.length - 1; i >= 0 && shorts.length < k; i--) {
    const r = ranked[i];
    if (claimed.has(r.symbol) || heldLong.has(r.symbol)) continue;
    shorts.push(r);
    claimed.add(r.symbol);
  }

  if (longs.length < k || shorts.length < k) return [];

  return [
    ...longs.slice(0, k).map<TargetPosition>((r) => ({
      symbol: r.symbol, weight: perName, side: "LONG",
      momentum: byRank.get(r.symbol)!.momentum, rank: r.rank,
    })),
    ...shorts.slice(0, k).map<TargetPosition>((r) => ({
      symbol: r.symbol, weight: -perName, side: "SHORT",
      momentum: byRank.get(r.symbol)!.momentum, rank: r.rank,
    })),
  ];
}

function classify(from: number, to: number): RebalanceOrder["action"] {
  if (from === 0) return to > 0 ? "OPEN_LONG" : "OPEN_SHORT";
  if (to === 0) return "CLOSE";
  if (Math.sign(from) !== Math.sign(to)) return "FLIP";
  return Math.abs(to) > Math.abs(from) ? "INCREASE" : "REDUCE";
}

/**
 * Difference the current book against the target and emit only the changes.
 *
 * This is the reason the strategy survives its own costs. A ranked book keeps
 * most of its names from one rebalance to the next, so charging a full
 * round-trip on every position every period — as a naive backtest does —
 * overstates cost by roughly a factor of two and turns a profitable strategy
 * into a losing one on paper.
 */
export function planRebalance(
  currentWeights: Map<string, number>,
  targets: TargetPosition[],
  config: StrategyConfig = DEFAULT_STRATEGY,
  universeSize = 0
): BookPlan {
  const targetWeights = new Map(targets.map((t) => [t.symbol, t.weight]));
  const symbols = new Set([...currentWeights.keys(), ...targetWeights.keys()]);

  const orders: RebalanceOrder[] = [];
  let turnover = 0;

  for (const symbol of symbols) {
    const from = currentWeights.get(symbol) ?? 0;
    const to = targetWeights.get(symbol) ?? 0;
    const delta = to - from;
    if (Math.abs(delta) < 1e-9) continue;
    turnover += Math.abs(delta);
    orders.push({ symbol, weightDelta: delta, action: classify(from, to), fromWeight: from, toWeight: to });
  }

  // Largest reductions first: freeing margin before consuming it keeps the
  // account solvent through the rebalance.
  orders.sort((a, b) => Math.abs(b.toWeight) - Math.abs(a.toWeight))
        .sort((a, b) => (a.action === "CLOSE" || a.action === "REDUCE" ? -1 : 0) - (b.action === "CLOSE" || b.action === "REDUCE" ? -1 : 0));

  if (targets.length === 0) {
    return {
      strategyVersion: CROSS_SECTIONAL_STRATEGY_VERSION,
      targets, orders: [], turnover: 0, universeSize, skipped: true,
      reason: "Universe is too small to form a balanced long/short book.",
    };
  }

  if (turnover < config.minRebalanceTurnover) {
    return {
      strategyVersion: CROSS_SECTIONAL_STRATEGY_VERSION,
      targets, orders: [], turnover, universeSize, skipped: true,
      reason: `Book drift ${(turnover * 100).toFixed(2)}% is below the ${(config.minRebalanceTurnover * 100).toFixed(0)}% rebalance threshold; holding.`,
    };
  }

  return {
    strategyVersion: CROSS_SECTIONAL_STRATEGY_VERSION,
    targets, orders, turnover, universeSize, skipped: false,
    reason: `Rebalancing ${orders.length} names, ${(turnover * 100).toFixed(1)}% one-way turnover.`,
  };
}

/** Convenience: full decision from momentum values to an executable plan. */
export function decideBook(input: {
  momentumBySymbol: Map<string, number>;
  currentWeights: Map<string, number>;
  config?: StrategyConfig;
}): BookPlan {
  const config = input.config ?? DEFAULT_STRATEGY;
  const ranked = rankByMomentum(input.momentumBySymbol);
  const targets = buildTargetBook(ranked, input.currentWeights, config);
  return planRebalance(input.currentWeights, targets, config, ranked.length);
}
