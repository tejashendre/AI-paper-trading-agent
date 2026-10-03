import { Candle, Timeframe, TIMEFRAME_MS } from "@/lib/types";
import { getRedis } from "@/lib/redis";
import {
  BybitInstrumentMetadata,
  CONFIGURED_ASSETS,
  CONFIGURED_INSTRUMENTS,
  getConfiguredInstrument,
  InstrumentRef,
  isConfiguredAsset,
} from "@/lib/trading/instrumentRegistry";
import { BybitTickerState, bybitPublicGet, getBybitInstrumentMetadata } from "@/lib/data/bybitPublic";
import type { LiquiditySnapshot } from "@/lib/execution/liquidityCost";

interface AssetConfig {
  name: string;
  category: "crypto" | "forex" | "commodity";
  /** The Bybit USDT linear perpetual every market path for this asset uses. */
  bybitLinearSymbol: string;
}

interface CandleRequestOptions {
  allowStale?: boolean;
}

// Every configured asset is priced, charted and traded on its Bybit USDT
// linear perpetual (verified 2026-10-01), so one venue story covers all nine.
// OIL is WTI (CLUSDT), not Brent; FX perpetuals are not MT5 CFDs or spot FX.
// Kraken, Yahoo, Binance and CoinGecko are not requested on any active path;
// their names survive only as historical DataSource values.
export const SUPPORTED_ASSETS: Record<string, AssetConfig> = Object.fromEntries(
  CONFIGURED_ASSETS.map((asset) => [
    asset,
    {
      name: CONFIGURED_INSTRUMENTS[asset].name,
      category: CONFIGURED_INSTRUMENTS[asset].riskClass,
      bybitLinearSymbol: CONFIGURED_INSTRUMENTS[asset].symbol,
    },
  ])
);

export const CRYPTO_EXECUTION_PROVIDER = "BYBIT_LINEAR" as const;
export const CRYPTO_EXECUTION_SOURCE = "BYBIT_LINEAR_WS" as const;

export type PrimaryMarketDataProvider = typeof CRYPTO_EXECUTION_PROVIDER;

/** How candles, quotes and sensors are fetched and cleaned; part of every cache key. */
export const MARKET_DATA_SCHEMA_VERSION = "bybit-data-v1";
/** A streamed last price older than this is not the current quote. */
const WS_QUOTE_MAX_AGE_MS = 5_000;
/** Exchange times this far ahead of the local clock are still accepted. */
const CLOCK_TOLERANCE_MS = 2_000;
const REST_QUOTE_CACHE_MS = 5_000;
const DEPTH_CACHE_MS = 15_000;
const SENSOR_MAX_AGE_MS = 60_000;

export interface MarketPriceSnapshot {
  /** Last traded price. */
  price: number;
  provider: string;
  /** Legacy alias of `transport`. */
  source: "WEBSOCKET" | "HTTP";
  /** WS and REST are two transports from one venue, not two sources. */
  transport: "WS" | "REST";
  venue: string;
  instrument: string;
  instrumentVersion: string;
  /** Exchange time of the last price, ISO. */
  updatedAt: string;
  eventTimeMs: number;
  receivedAtMs: number;
  bid?: number;
  ask?: number;
  markPrice?: number;
  indexPrice?: number;
  /** Exchange time of each field group; null when that group was not observed. */
  quoteTimes: { lastPriceMs: number; bidAskMs: number | null; markMs: number | null };
}

export interface MarketCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { ex?: number }): Promise<unknown>;
}

export interface MarketServiceDeps {
  bybitGet: <T>(path: string) => Promise<{ result: T; serverTimeMs: number }>;
  cache: MarketCache;
  nowMs: () => number;
  metadata: (symbol: string) => Promise<BybitInstrumentMetadata>;
}

// Redis is reached lazily so importing this module never opens a connection.
const lazyRedis: MarketCache = {
  get: (key) => getRedis().get(key),
  set: (key, value, options) => getRedis().set(key, value, options),
};

let deps: MarketServiceDeps = {
  bybitGet: (path) => bybitPublicGet(path),
  cache: lazyRedis,
  nowMs: () => Date.now(),
  metadata: (symbol) => getBybitInstrumentMetadata(symbol),
};

/** Swap the transport, cache or clock (tests, offline tools). Returns a restore function. */
export function setMarketServiceDeps(overrides: Partial<MarketServiceDeps>): () => void {
  const previous = deps;
  deps = { ...previous, ...overrides };
  return () => {
    deps = previous;
  };
}

/** The instrument a new entry in this asset trades, frozen onto the position at entry. */
export function entryInstrumentFor(assetKey: string): InstrumentRef {
  return getConfiguredInstrument(assetKey);
}

/** Where the stream daemon keeps the current session's ticker state for an asset. */
export function liveQuoteKey(assetKey: string): string {
  return `market:liveQuote:${MARKET_DATA_SCHEMA_VERSION}:${getConfiguredInstrument(assetKey).instrumentVersion}`;
}

/**
 * Whether this asset is quoted from a continuously traded perpetual. True for
 * every configured asset. Session liquidity for the TradFi underlyings is a
 * separate question answered by marketSession, and risk treatment still
 * follows the asset's class.
 */
export function tradesContinuously(assetKey: string): boolean {
  return isConfiguredAsset(assetKey);
}

export function primaryMarketDataProvider(assetKey: string): PrimaryMarketDataProvider {
  getConfiguredInstrument(assetKey);
  return CRYPTO_EXECUTION_PROVIDER;
}

type CandleInterval = Timeframe | "1w";

const BYBIT_INTERVAL: Record<CandleInterval, string> = {
  "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1w": "W",
};
const INTERVAL_MS: Record<CandleInterval, number> = { ...TIMEFRAME_MS, "1w": 7 * 24 * 3_600_000 };
/** Bybit weekly bars open on Monday 00:00 UTC; 1970-01-05 was a Monday. */
const WEEK_ANCHOR_MS = Date.UTC(1970, 0, 5);
/** Higher-timeframe features read only completed bars. */
const CLOSED_BARS_ONLY = new Set<CandleInterval>(["4h", "1w"]);

function barOpenMs(interval: CandleInterval, atMs: number): number {
  const ms = INTERVAL_MS[interval];
  if (interval === "1w") return WEEK_ANCHOR_MS + Math.floor((atMs - WEEK_ANCHOR_MS) / ms) * ms;
  return Math.floor(atMs / ms) * ms;
}

/**
 * Bars whose period has ended by exchange time. A forming bar still changes,
 * so a feature computed from it would not reproduce on a later run.
 */
export function closedCandles(candles: Candle[], timeframe: CandleInterval, serverTimeMs: number): Candle[] {
  const ms = INTERVAL_MS[timeframe];
  return candles.filter((candle) => candle.time * 1000 + ms <= serverTimeMs);
}

/**
 * Structurally valid bars, oldest first, one per open time. Invalid bars are
 * dropped and show up as gaps; no value is ever repaired, clipped or invented,
 * and a bar never depends on the bar after it.
 */
function validCandles(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  candles
    .filter((c) =>
      [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
      c.time > 0 && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.volume >= 0 &&
      c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)
    )
    .sort((a, b) => a.time - b.time)
    .forEach((candle) => byTime.set(candle.time, candle));
  return [...byTime.values()];
}

function missingBarCount(candles: Candle[], interval: CandleInterval): number {
  const ms = INTERVAL_MS[interval];
  let missing = 0;
  for (let index = 1; index < candles.length; index += 1) {
    missing += Math.max(0, Math.round(((candles[index].time - candles[index - 1].time) * 1000) / ms) - 1);
  }
  return missing;
}

function candleCacheKey(instrument: InstrumentRef, interval: CandleInterval, nowMs: number): string {
  // The bar cutoff in the key means a series cached during one bar is never
  // served once that bar has closed.
  return `cache:candles:${MARKET_DATA_SCHEMA_VERSION}:${instrument.instrumentVersion}:${BYBIT_INTERVAL[interval]}:${barOpenMs(interval, nowMs)}`;
}

function candleTtlSeconds(interval: CandleInterval): number {
  if (interval === "1m") return 10;
  if (interval === "5m") return 30;
  if (interval === "15m") return 60;
  if (interval === "1w") return 3_600;
  return 300;
}

function positive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function finite(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type BybitTickerRow = Record<string, string | undefined>;

async function fetchTicker(symbol: string): Promise<{ row: BybitTickerRow; serverTimeMs: number }> {
  const { result, serverTimeMs } = await deps.bybitGet<{ list?: BybitTickerRow[] }>(
    `/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`
  );
  const row = result.list?.find((entry) => entry?.symbol === symbol);
  if (!row) throw new Error(`Bybit returned no ticker for ${symbol}`);
  return { row, serverTimeMs };
}

async function fetchCandles(symbol: string, interval: CandleInterval, limit: number, range?: {startMs?:number;endMs:number}) {
  const bounded = Math.max(1, Math.min(1_000, limit));
  const { result, serverTimeMs } = await deps.bybitGet<{ list?: unknown[][] }>(
    `/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${BYBIT_INTERVAL[interval]}&limit=${bounded}` +
    (range ? `${range.startMs === undefined ? '' : `&start=${range.startMs}`}&end=${range.endMs-1}` : '')
  );
  const candles = validCandles((result.list ?? []).map((row) => ({
    time: Math.floor(Number(row?.[0]) / 1_000),
    open: Number(row?.[1]),
    high: Number(row?.[2]),
    low: Number(row?.[3]),
    close: Number(row?.[4]),
    volume: Number(row?.[5]),
  })));
  return { candles, serverTimeMs };
}

function snapshotFromTickerState(instrument: InstrumentRef, state: BybitTickerState, nowMs: number): MarketPriceSnapshot | null {
  const price = positive(state.lastPrice);
  const lastAt = state.lastPriceEventMs;
  if (state.symbol !== instrument.symbol || price === undefined || lastAt === undefined) return null;
  const age = nowMs - lastAt;
  if (age < -CLOCK_TOLERANCE_MS || age > WS_QUOTE_MAX_AGE_MS) return null;
  const hasBook = state.bidAskEventMs !== undefined && positive(state.bid) && positive(state.ask);
  return {
    price,
    provider: CRYPTO_EXECUTION_SOURCE,
    source: "WEBSOCKET",
    transport: "WS",
    venue: CRYPTO_EXECUTION_PROVIDER,
    instrument: instrument.symbol,
    instrumentVersion: instrument.instrumentVersion,
    updatedAt: new Date(lastAt).toISOString(),
    eventTimeMs: lastAt,
    receivedAtMs: state.receivedAtMs,
    ...(hasBook ? { bid: state.bid, ask: state.ask } : {}),
    ...(positive(state.markPrice) ? { markPrice: state.markPrice } : {}),
    ...(positive(state.indexPrice) ? { indexPrice: state.indexPrice } : {}),
    quoteTimes: {
      lastPriceMs: lastAt,
      bidAskMs: hasBook ? state.bidAskEventMs! : null,
      markMs: state.markEventMs ?? null,
    },
  };
}

export class MarketService {
  private static maxCandleAgeMs(timeframe: CandleInterval): number {
    // Every instrument is a continuously quoted perpetual: a bar older than
    // two and a half periods is stale. A closed-only series lags by up to two
    // periods by construction, which this allowance still covers.
    return INTERVAL_MS[timeframe] * 2.5;
  }

  private static candlesAreFresh(timeframe: CandleInterval, candles: Candle[], nowMs: number): boolean {
    const latest = candles[candles.length - 1]?.time;
    if (!latest) return false;
    return nowMs - latest * 1000 <= this.maxCandleAgeMs(timeframe);
  }

  static getCandleSeriesStatus(assetKey: string, timeframe: Timeframe, candles: Candle[]) {
    getConfiguredInstrument(assetKey);
    const latest = candles[candles.length - 1]?.time;
    return {
      fresh: this.candlesAreFresh(timeframe, candles, deps.nowMs()),
      asOf: latest ? new Date(latest * 1000).toISOString() : null,
      missingBars: missingBarCount(candles, timeframe),
    };
  }

  static async getInstrumentMetadata(assetKey: string): Promise<BybitInstrumentMetadata> {
    return deps.metadata(getConfiguredInstrument(assetKey).symbol);
  }

  /**
   * Funding and open interest from the mapped perpetual. A value Bybit did not
   * report is absent, never zero.
   */
  static async getDeepSensors(assetKey: string): Promise<{ fundingRate?: number; openInterest?: number; nextFundingTimeMs?: number; observedAtMs?: number }> {
    const instrument = getConfiguredInstrument(assetKey);
    const now = deps.nowMs();
    const pick = (source: { fundingRate?: unknown; openInterest?: unknown; nextFundingTimeMs?: unknown }) => {
      const fundingRate = finite(source.fundingRate);
      const openInterest = positive(source.openInterest);
      const nextFundingTimeMs = positive(source.nextFundingTimeMs);
      return {
        ...(fundingRate !== undefined ? { fundingRate } : {}),
        ...(openInterest !== undefined ? { openInterest } : {}),
        ...(nextFundingTimeMs !== undefined ? { nextFundingTimeMs } : {}),
      };
    };

    try {
      const state = await deps.cache.get<BybitTickerState>(liveQuoteKey(assetKey));
      if (state?.symbol === instrument.symbol && state.sensorEventMs !== undefined && now - state.sensorEventMs <= SENSOR_MAX_AGE_MS) {
        const sensors = pick(state);
        if (Object.keys(sensors).length > 0) return {...sensors,observedAtMs:state.sensorEventMs};
      }
    } catch {}

    try {
      const { row, serverTimeMs } = await fetchTicker(instrument.symbol);
      const sensors = pick({ fundingRate: row.fundingRate, openInterest: row.openInterest, nextFundingTimeMs: row.nextFundingTime });
      return Object.keys(sensors).length ? {...sensors,observedAtMs:serverTimeMs} : sensors;
    } catch (error) {
      console.warn(`[MarketService] Bybit sensors unavailable for ${assetKey}:`, error);
      return {};
    }
  }

  static async getCandles(
    timeframe: Timeframe,
    limit: number = 200,
    assetKey: string = "BTC",
    options: CandleRequestOptions = {}
  ): Promise<Candle[]> {
    const instrument = getConfiguredInstrument(assetKey);
    const now = deps.nowMs();
    const cacheKey = candleCacheKey(instrument, timeframe, now);
    let staleCandidate: Candle[] | null = null;

    try {
      const cached = await deps.cache.get<Candle[]>(cacheKey);
      if (Array.isArray(cached) && cached.length > 0) {
        if (this.candlesAreFresh(timeframe, cached, now)) return cached.slice(-limit);
        staleCandidate = cached;
      }
    } catch {}

    try {
      const { candles, serverTimeMs } = await fetchCandles(instrument.symbol, timeframe, Math.max(720, limit));
      const usable = CLOSED_BARS_ONLY.has(timeframe) ? closedCandles(candles, timeframe, serverTimeMs) : candles;
      if (usable.length > 0) {
        if (this.candlesAreFresh(timeframe, usable, now)) {
          await deps.cache.set(cacheKey, usable, { ex: candleTtlSeconds(timeframe) }).catch(() => undefined);
          return usable.slice(-limit);
        }
        staleCandidate = usable;
      }
    } catch (error) {
      console.warn(`[MarketService] Bybit ${instrument.symbol} ${timeframe} candles failed.`, error);
    }

    // Trading callers fail closed; read-only callers may ask for the latest
    // series even if it is old.
    if (staleCandidate && options.allowStale) return staleCandidate.slice(-limit);
    throw new Error(`Bybit ${instrument.symbol} ${timeframe} candles are unavailable or stale for ${assetKey}.`);
  }

  /** Read-only chart history: one public request, no historical cache or strategy changes. */
  static async getChartCandlePage(timeframe: Timeframe, limit: number, asset: string, beforeMs?: number) {
    if (!TIMEFRAME_MS[timeframe] || !Number.isInteger(limit) || limit < 50 || limit > 1000 ||
      (beforeMs !== undefined && (!Number.isSafeInteger(beforeMs) || beforeMs <= 0 || beforeMs > deps.nowMs()))) {
      throw new Error('Invalid chart page');
    }
    const { candles: raw, serverTimeMs } = await fetchCandles(getConfiguredInstrument(asset).symbol, timeframe,
      limit, beforeMs === undefined ? undefined : { endMs: beforeMs });
    if (beforeMs !== undefined && raw.some(c => c.time * 1000 >= beforeMs)) {
      throw new Error('History provider did not respect the chart cursor');
    }
    // History pages hold completed bars only. The latest page keeps the bar
    // still forming on 1m to 1h, as the live chart always showed; 4h stays
    // completed-only, matching the strategy's own higher-timeframe view.
    const candles = beforeMs === undefined && !CLOSED_BARS_ONLY.has(timeframe) ? raw : closedCandles(raw, timeframe, serverTimeMs);
    return { candles, hasMore: candles.length > 0 && raw.length === limit,
      nextBeforeMs: candles.length ? candles[0].time * 1000 : null };
  }

  /** One bounded historical request for a matured label, independent of live caches. */
  static async getLabelCandles(timeframe:Timeframe, asset:string, startMs:number, endMs:number):Promise<Candle[]> {
    const interval=({ '1m':60000,'5m':300000,'15m':900000 } as Record<string,number>)[timeframe];
    if (!interval || !Number.isFinite(startMs) || !(endMs>startMs) || endMs>Date.now() ||
      Math.ceil((endMs-startMs)/interval)+2>1000) throw new Error('Invalid bounded label window');
    const {candles,serverTimeMs}=await fetchCandles(getConfiguredInstrument(asset).symbol,timeframe,
      Math.ceil((endMs-startMs)/interval)+2,{startMs,endMs});
    return candles.filter(c=>c.time*1000>=startMs && c.time*1000+interval<=Math.min(endMs,serverTimeMs));
  }

  /**
   * Current quote for the mapped perpetual: the streamed quote when its last
   * price is fresh, otherwise REST. `transport` pins one of the two, which is
   * how transport consistency is checked.
   */
  static async getCurrentPriceSnapshot(
    assetKey: string = "BTC",
    options: { transport?: "WS" | "REST" } = {}
  ): Promise<MarketPriceSnapshot> {
    const instrument = getConfiguredInstrument(assetKey);
    const now = deps.nowMs();

    // Streamed quote first, judged on the last price's own event time.
    if (options.transport !== "REST") {
      try {
        const state = await deps.cache.get<BybitTickerState>(liveQuoteKey(assetKey));
        const streamed = state ? snapshotFromTickerState(instrument, state, now) : null;
        if (streamed) return streamed;
      } catch {}
      if (options.transport === "WS") {
        throw new Error(`No fresh Bybit stream quote for ${assetKey}`);
      }
    }

    // A quiet market refreshes over REST and says so.
    const restKey = `cache:quote:${MARKET_DATA_SCHEMA_VERSION}:${instrument.instrumentVersion}`;
    try {
      const cached = await deps.cache.get<MarketPriceSnapshot>(restKey);
      const age = cached ? now - cached.receivedAtMs : Number.POSITIVE_INFINITY;
      if (cached?.instrumentVersion === instrument.instrumentVersion && age >= 0 && age <= REST_QUOTE_CACHE_MS) return cached;
    } catch {}

    try {
      const { row, serverTimeMs } = await fetchTicker(instrument.symbol);
      const price = positive(row.lastPrice);
      if (price === undefined) throw new Error("Bybit returned an invalid last price");
      const bid = positive(row.bid1Price);
      const ask = positive(row.ask1Price);
      const markPrice = positive(row.markPrice);
      const indexPrice = positive(row.indexPrice);
      const snapshot: MarketPriceSnapshot = {
        price,
        provider: `${CRYPTO_EXECUTION_PROVIDER}_HTTP`,
        source: "HTTP",
        transport: "REST",
        venue: CRYPTO_EXECUTION_PROVIDER,
        instrument: instrument.symbol,
        instrumentVersion: instrument.instrumentVersion,
        updatedAt: new Date(serverTimeMs).toISOString(),
        eventTimeMs: serverTimeMs,
        receivedAtMs: now,
        ...(bid !== undefined && ask !== undefined ? { bid, ask } : {}),
        ...(markPrice !== undefined ? { markPrice } : {}),
        ...(indexPrice !== undefined ? { indexPrice } : {}),
        quoteTimes: {
          lastPriceMs: serverTimeMs,
          bidAskMs: bid !== undefined && ask !== undefined ? serverTimeMs : null,
          markMs: markPrice !== undefined ? serverTimeMs : null,
        },
      };
      await deps.cache.set(restKey, snapshot, { ex: 10 }).catch(() => undefined);
      return snapshot;
    } catch (error) {
      throw new Error(`Bybit ${instrument.symbol} quote unavailable for ${assetKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  static async getCurrentPrice(assetKey: string = "BTC"): Promise<number> {
    return (await this.getCurrentPriceSnapshot(assetKey)).price;
  }

  static async get24hStats(assetKey: string = "BTC"): Promise<{
    priceChange: number;
    priceChangePercent: number;
    volume: number;
    high: number;
    low: number;
  }> {
    const instrument = getConfiguredInstrument(assetKey);
    const cacheKey = `cache:stats24h:${MARKET_DATA_SCHEMA_VERSION}:${instrument.instrumentVersion}`;
    try {
      const cached = await deps.cache.get<{ priceChange: number; priceChangePercent: number; volume: number; high: number; low: number }>(cacheKey);
      if (cached) return cached;
    } catch {}

    const { row } = await fetchTicker(instrument.symbol);
    const stats = {
      priceChange: Number(row.lastPrice) - Number(row.prevPrice24h),
      priceChangePercent: Number(row.price24hPcnt) * 100,
      volume: Number(row.volume24h),
      high: Number(row.highPrice24h),
      low: Number(row.lowPrice24h),
    };
    if (!Object.values(stats).every(Number.isFinite)) {
      throw new Error(`Bybit ${instrument.symbol} returned incomplete 24h statistics`);
    }
    await deps.cache.set(cacheKey, stats, { ex: 60 }).catch(() => undefined);
    return stats;
  }

  /**
   * Fifty-level book imbalance for the mapped perpetual. Throws when depth is
   * unavailable rather than reporting a neutral book that was never observed.
   */
  static async getOrderbookImbalance(assetKey: string = "BTC"): Promise<{ bidVolume: number; askVolume: number; imbalanceRatio: number; isBullish: boolean; isBearish: boolean; observedAtMs?: number }> {
    const instrument = getConfiguredInstrument(assetKey);
    const now = deps.nowMs();
    const cacheKey = `cache:depth:${MARKET_DATA_SCHEMA_VERSION}:${instrument.instrumentVersion}`;
    type Depth = { bidVolume: number; askVolume: number; observedAtMs: number };
    const shape = (depth: Depth) => {
      const ratio = depth.bidVolume / depth.askVolume;
      return { bidVolume: depth.bidVolume, askVolume: depth.askVolume, imbalanceRatio: ratio, isBullish: ratio >= 1.5, isBearish: ratio <= 0.66, observedAtMs:depth.observedAtMs };
    };

    try {
      const cached = await deps.cache.get<Depth>(cacheKey);
      if (cached && now - cached.observedAtMs >= 0 && now - cached.observedAtMs <= DEPTH_CACHE_MS) return shape(cached);
    } catch {}

    const { result, serverTimeMs } = await deps.bybitGet<{ b?: unknown[][]; a?: unknown[][] }>(
      `/v5/market/orderbook?category=linear&symbol=${encodeURIComponent(instrument.symbol)}&limit=50`
    );
    const sum = (levels: unknown[][] | undefined) =>
      (levels ?? []).reduce((total, level) => total + (positive(level?.[1]) ?? 0), 0);
    const depth: Depth = { bidVolume: sum(result.b), askVolume: sum(result.a), observedAtMs: serverTimeMs };
    if (depth.bidVolume <= 0 || depth.askVolume <= 0) {
      throw new Error(`Bybit ${instrument.symbol} order book depth is unavailable`);
    }
    await deps.cache.set(cacheKey, depth, { ex: 30 }).catch(() => undefined);
    return shape(depth);
  }

  /**
   * Fifty levels each side plus 24h turnover, for per-fill capacity checks.
   * Levels are kept as observed; an empty side stays empty.
   */
  static async getLiquiditySnapshot(assetKey: string): Promise<LiquiditySnapshot> {
    const instrument = getConfiguredInstrument(assetKey);
    const [book, ticker] = await Promise.all([
      deps.bybitGet<{ b?: unknown[][]; a?: unknown[][] }>(
        `/v5/market/orderbook?category=linear&symbol=${encodeURIComponent(instrument.symbol)}&limit=50`
      ),
      fetchTicker(instrument.symbol),
    ]);
    const levels = (rows: unknown[][] | undefined): Array<[number, number]> =>
      (rows ?? [])
        .map((level): [number, number] => [Number(level?.[0]), Number(level?.[1])])
        .filter(([price, qty]) => price > 0 && qty > 0);
    const bids = levels(book.result.b);
    const asks = levels(book.result.a);
    return {
      bestBid: bids[0]?.[0] ?? Number.NaN,
      bestAsk: asks[0]?.[0] ?? Number.NaN,
      bids,
      asks,
      turnover24hUsdt: Number(ticker.row.turnover24h),
      observedAtMs: book.serverTimeMs,
    };
  }

  /**
   * Completed weekly bars from the mapped perpetual, for every asset class.
   * A new contract simply has few bars; an empty result means the weekly
   * feature is unavailable, never a fabricated or spliced history.
   */
  static async getWeeklyCandles(limit: number = 20, assetKey: string = "BTC"): Promise<Candle[]> {
    const instrument = getConfiguredInstrument(assetKey);
    const now = deps.nowMs();
    const cacheKey = candleCacheKey(instrument, "1w", now);
    try {
      const cached = await deps.cache.get<Candle[]>(cacheKey);
      if (Array.isArray(cached) && cached.length > 0) return cached.slice(-limit);
    } catch {}

    try {
      const { candles, serverTimeMs } = await fetchCandles(instrument.symbol, "1w", Math.max(limit + 1, 26));
      const closed = closedCandles(candles, "1w", serverTimeMs);
      if (closed.length > 0) {
        await deps.cache.set(cacheKey, closed, { ex: candleTtlSeconds("1w") }).catch(() => undefined);
      }
      return closed.slice(-limit);
    } catch (error) {
      console.warn(`[MarketService] Bybit ${instrument.symbol} weekly candles failed.`, error);
      return [];
    }
  }
}
