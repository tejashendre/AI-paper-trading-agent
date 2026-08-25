import { getRedis } from "@/lib/redis";
import { Logger } from "@/lib/logger";
import {
  DEFAULT_UNIVERSE,
  screenUniverse,
  UniverseCandidate,
  UniverseConfig,
} from "@/lib/strategy/crossSectionalMomentum";

/**
 * Market data for the cross-sectional book, from Bybit's public v5 endpoints.
 * No API key, no paid tier.
 *
 * The request budget is deliberately tiny: one `tickers` call returns the
 * price and 24h turnover for every perpetual at once, and momentum needs one
 * `kline` call per symbol per rebalance. At a daily rebalance over 50 symbols
 * that is ~51 requests a day, which sits far inside the free rate limits.
 */

const BYBIT = "https://api.bybit.com";
const TICKER_KEY = "perp:tickers:v1";
const TICKER_TTL_SECONDS = 20;
const CLOSES_TTL_SECONDS = 15 * 60;
const UNIVERSE_KEY = "perp:universe:v1";

export interface PerpTicker {
  symbol: string;
  lastPrice: number;
  markPrice: number;
  bid: number;
  ask: number;
  turnover24h: number;
  fundingRate: number;
}

export interface MomentumSnapshot {
  takenAt: string;
  lookbackHours: number;
  universe: string[];
  /** Trailing return over the lookback window, by symbol. */
  momentum: Map<string, number>;
  prices: Map<string, PerpTicker>;
  warnings: string[];
}

async function bybit<T>(path: string, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BYBIT}${path}`, {
      signal: controller.signal,
      headers: { "User-Agent": "quant-paper-trader/1.0" },
    });
    if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.retCode !== 0) throw new Error(`Bybit ${payload.retCode}: ${payload.retMsg}`);
    return payload.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Every linear USDT perpetual with its current price and 24h turnover. */
export async function fetchTickers(): Promise<Map<string, PerpTicker>> {
  const redis = getRedis();
  const cached = await redis.get<PerpTicker[]>(TICKER_KEY).catch(() => null);
  if (Array.isArray(cached) && cached.length > 0) {
    return new Map(cached.map((t) => [t.symbol, t]));
  }

  const result = await bybit<{ list: any[] }>("/v5/market/tickers?category=linear");
  const tickers: PerpTicker[] = (result.list || [])
    .filter((row) => typeof row.symbol === "string" && row.symbol.endsWith("USDT"))
    .map((row) => ({
      symbol: row.symbol,
      lastPrice: Number(row.lastPrice),
      markPrice: Number(row.markPrice ?? row.lastPrice),
      bid: Number(row.bid1Price ?? row.lastPrice),
      ask: Number(row.ask1Price ?? row.lastPrice),
      turnover24h: Number(row.turnover24h ?? 0),
      fundingRate: Number(row.fundingRate ?? 0),
    }))
    .filter((t) => Number.isFinite(t.lastPrice) && t.lastPrice > 0);

  await redis.set(TICKER_KEY, tickers, { ex: TICKER_TTL_SECONDS }).catch(() => undefined);
  return new Map(tickers.map((t) => [t.symbol, t]));
}

export interface HourlySeries {
  closes: number[];
  /** Fraction of expected hourly bars present between first and last bar. */
  coverage: number;
}

/** Hourly closes, oldest first. Cached because momentum only moves hourly. */
export async function fetchHourlySeries(symbol: string, hours: number): Promise<HourlySeries> {
  const redis = getRedis();
  const key = `perp:series:v2:${symbol}:${hours}`;
  const cached = await redis.get<HourlySeries>(key).catch(() => null);
  if (cached && Array.isArray(cached.closes) && cached.closes.length > 0) return cached;

  const limit = Math.min(1000, Math.max(2, hours + 2));
  const result = await bybit<{ list: string[][] }>(
    `/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=${limit}`
  );
  // Bybit returns newest first; the strategy wants oldest first.
  const bars = (result.list || [])
    .map((row) => ({ time: Number(row[0]), close: Number(row[4]) }))
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);

  const closes = bars.map((b) => b.close);
  // Span in hours between the first and last bar we received. A continuously
  // traded perp fills essentially all of them; an instrument that closes at
  // night or at the weekend leaves visible holes.
  const spanHours = bars.length >= 2
    ? Math.round((bars[bars.length - 1].time - bars[0].time) / 3_600_000) + 1
    : bars.length;
  const series: HourlySeries = {
    closes,
    coverage: spanHours > 0 ? Math.min(1, bars.length / spanHours) : 0,
  };

  if (closes.length > 0) {
    await redis.set(key, series, { ex: CLOSES_TTL_SECONDS }).catch(() => undefined);
  }
  return series;
}

/** Backwards-compatible accessor for callers that only need the closes. */
export async function fetchHourlyCloses(symbol: string, hours: number): Promise<number[]> {
  return (await fetchHourlySeries(symbol, hours)).closes;
}

/**
 * Screen the universe and compute each survivor's trailing return.
 *
 * Symbols that fail to return enough history are dropped with a warning
 * rather than silently defaulting to zero momentum — a zero would rank them
 * in the middle of the book and quietly put real capital behind missing data.
 */
export async function buildMomentumSnapshot(input: {
  lookbackHours: number;
  universeConfig?: UniverseConfig;
}): Promise<MomentumSnapshot> {
  const universeConfig = input.universeConfig ?? DEFAULT_UNIVERSE;
  const warnings: string[] = [];
  const prices = await fetchTickers();

  // Screen on turnover first so history is only probed for plausible names.
  const shortlist = [...prices.values()]
    .filter((t) => t.turnover24h >= universeConfig.minTurnover24hUsd)
    .sort((a, b) => b.turnover24h - a.turnover24h)
    .slice(0, universeConfig.maxSymbols * 2);

  const needed = Math.max(input.lookbackHours + 1, 2);
  const candidates: UniverseCandidate[] = [];
  const closesBySymbol = new Map<string, number[]>();

  // Small concurrency: enough to stay quick, low enough to stay polite.
  const queue = [...shortlist];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length > 0) {
      const ticker = queue.shift();
      if (!ticker) return;
      try {
        const series = await fetchHourlySeries(ticker.symbol, Math.max(needed, universeConfig.minHistoryHours));
        closesBySymbol.set(ticker.symbol, series.closes);
        candidates.push({
          symbol: ticker.symbol,
          turnover24h: ticker.turnover24h,
          historyHours: series.closes.length,
          barCoverage: series.coverage,
        });
      } catch (error) {
        warnings.push(`${ticker.symbol}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  await Promise.all(workers);

  const universe = screenUniverse(candidates, universeConfig);
  const momentum = new Map<string, number>();

  for (const symbol of universe) {
    const closes = closesBySymbol.get(symbol);
    if (!closes || closes.length < needed) {
      warnings.push(`${symbol}: only ${closes?.length ?? 0}h history, needs ${needed}h — excluded from ranking.`);
      continue;
    }
    const past = closes[closes.length - 1 - input.lookbackHours];
    const now = closes[closes.length - 1];
    if (!Number.isFinite(past) || past <= 0) {
      warnings.push(`${symbol}: invalid lookback price — excluded from ranking.`);
      continue;
    }
    momentum.set(symbol, (now - past) / past);
  }

  const snapshot: MomentumSnapshot = {
    takenAt: new Date().toISOString(),
    lookbackHours: input.lookbackHours,
    universe: [...momentum.keys()],
    momentum,
    prices,
    warnings,
  };

  await getRedis()
    .set(UNIVERSE_KEY, {
      takenAt: snapshot.takenAt,
      lookbackHours: snapshot.lookbackHours,
      size: snapshot.universe.length,
      symbols: snapshot.universe,
      warnings: warnings.slice(0, 10),
    }, { ex: 3600 })
    .catch(() => undefined);

  if (warnings.length > 0) {
    await Logger.warn(`[UNIVERSE] ${warnings.length} symbol(s) excluded: ${warnings.slice(0, 3).join("; ")}`).catch(() => undefined);
  }

  return snapshot;
}
