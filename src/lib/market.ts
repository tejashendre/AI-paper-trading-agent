import { Candle, Timeframe } from "@/lib/types";
import { getRedis } from "@/lib/redis";

interface AssetConfig {
  name: string;
  category: "crypto" | "forex" | "commodity";
  bybitLinearSymbol: string;
  krakenPair: string;
  yahooTicker: string;
  coingeckoId: string;
}

interface CandleRequestOptions {
  allowStale?: boolean;
}

export const SUPPORTED_ASSETS: Record<string, AssetConfig> = {
  BTC: { name: "Bitcoin", category: "crypto", bybitLinearSymbol: "BTCUSDT", krakenPair: "XBTUSD", yahooTicker: "BTC-USD", coingeckoId: "bitcoin" },
  ETH: { name: "Ethereum", category: "crypto", bybitLinearSymbol: "ETHUSDT", krakenPair: "ETHUSD", yahooTicker: "ETH-USD", coingeckoId: "ethereum" },
  SOL: { name: "Solana", category: "crypto", bybitLinearSymbol: "SOLUSDT", krakenPair: "SOLUSD", yahooTicker: "SOL-USD", coingeckoId: "solana" },
  EURUSD: { name: "EUR/USD", category: "forex", bybitLinearSymbol: "", krakenPair: "", yahooTicker: "EURUSD=X", coingeckoId: "" },
  GBPUSD: { name: "GBP/USD", category: "forex", bybitLinearSymbol: "", krakenPair: "", yahooTicker: "GBPUSD=X", coingeckoId: "" },
  USDJPY: { name: "USD/JPY", category: "forex", bybitLinearSymbol: "", krakenPair: "", yahooTicker: "USDJPY=X", coingeckoId: "" },
  GOLD: { name: "Gold", category: "commodity", bybitLinearSymbol: "", krakenPair: "", yahooTicker: "GC=F", coingeckoId: "" },
  OIL: { name: "Crude Oil", category: "commodity", bybitLinearSymbol: "", krakenPair: "", yahooTicker: "CL=F", coingeckoId: "" },
  SILVER: { name: "Silver", category: "commodity", bybitLinearSymbol: "", krakenPair: "", yahooTicker: "SI=F", coingeckoId: "" }
};

export const CRYPTO_EXECUTION_PROVIDER = "BYBIT_LINEAR" as const;
export const CRYPTO_EXECUTION_SOURCE = "BYBIT_LINEAR_WS" as const;

export type PrimaryMarketDataProvider = typeof CRYPTO_EXECUTION_PROVIDER | "YAHOO";

export interface MarketPriceSnapshot {
  price: number;
  provider: string;
  source: "WEBSOCKET" | "HTTP";
  venue: string;
  instrument: string;
  updatedAt: string;
  bid?: number;
  ask?: number;
}

export function marketLivePriceKey(source: string, assetKey: string): string {
  return `market:live:${source}:${assetKey}`;
}

export function marketLiveMetaKey(source: string, assetKey: string): string {
  return `market:liveMeta:${source}:${assetKey}`;
}

export function marketImbalanceKey(source: string, assetKey: string): string {
  return `market:imbalance:${source}:${assetKey}`;
}

export function primaryMarketDataProvider(assetKey: string): PrimaryMarketDataProvider {
  const config = SUPPORTED_ASSETS[assetKey] || SUPPORTED_ASSETS.BTC;
  return config.category === "crypto" ? CRYPTO_EXECUTION_PROVIDER : "YAHOO";
}

export function marketPriceCacheKey(assetKey: string): string {
  return `cache:price:instrument-v3:${primaryMarketDataProvider(assetKey)}:${assetKey}`;
}

function marketPriceMetaCacheKey(assetKey: string): string {
  return `cache:priceMeta:instrument-v3:${primaryMarketDataProvider(assetKey)}:${assetKey}`;
}

function marketCandleCacheKey(assetKey: string, timeframe: Timeframe): string {
  return `cache:candles:instrument-v3:${primaryMarketDataProvider(assetKey)}:${assetKey}:${timeframe}`;
}

export class MarketService {
  private static normalizeCandles(assetKey: string, timeframe: Timeframe, candles: Candle[]): Candle[] {
    const config = SUPPORTED_ASSETS[assetKey] || SUPPORTED_ASSETS.BTC;
    const ordered = candles
      .filter((c) => (
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.time > 0 &&
        c.open > 0 &&
        c.high > 0 &&
        c.low > 0 &&
        c.close > 0
      ))
      .sort((a, b) => a.time - b.time);

    const deduped = new Map<number, Candle>();
    for (const candle of ordered) {
      deduped.set(candle.time, candle);
    }

    const unique = Array.from(deduped.values());
    const maxRangePercent =
      config.category === "forex" ? 0.035 :
      config.category === "commodity" ? 0.08 :
      timeframe === "1m" || timeframe === "5m" ? 0.08 : 0.16;

    return unique.map((candle, index) => {
      const repaired: Candle = {
        ...candle,
        volume: Number.isFinite(candle.volume) && candle.volume >= 0 ? candle.volume : 0,
      };

      const previousClose = unique[index - 1]?.close;
      const nextOpen = unique[index + 1]?.open;
      const anchors = [repaired.open, repaired.close, previousClose, nextOpen].filter(
        (value): value is number => Number.isFinite(value) && value > 0
      );
      const reference = anchors.reduce((sum, value) => sum + value, 0) / Math.max(anchors.length, 1);
      const upperLimit = reference * (1 + maxRangePercent);
      const lowerLimit = reference * (1 - maxRangePercent);

      const bodyHigh = Math.max(repaired.open, repaired.close);
      const bodyLow = Math.min(repaired.open, repaired.close);

      if (repaired.high < bodyHigh) repaired.high = bodyHigh;
      if (repaired.low > bodyLow) repaired.low = bodyLow;

      if (repaired.high > upperLimit && bodyHigh <= upperLimit) {
        repaired.high = bodyHigh;
      }
      if (repaired.low < lowerLimit && bodyLow >= lowerLimit) {
        repaired.low = bodyLow;
      }

      return repaired;
    });
  }

  private static maxCandleAgeMs(assetKey: string, timeframe: Timeframe): number {
    const config = SUPPORTED_ASSETS[assetKey] || SUPPORTED_ASSETS.BTC;
    const timeframeMs: Record<Timeframe, number> = {
      "1m": 60_000,
      "5m": 5 * 60_000,
      "15m": 15 * 60_000,
      "30m": 30 * 60_000,
      "1h": 60 * 60_000,
      "4h": 4 * 60 * 60_000,
    };
    const ageMultiplier = config.category === "crypto" ? 2.5 : 8.0;
    return (timeframeMs[timeframe] || 60 * 60_000) * ageMultiplier;
  }

  private static candlesAreFresh(assetKey: string, timeframe: Timeframe, candles: Candle[]): boolean {
    const latest = candles[candles.length - 1]?.time;
    if (!latest) return false;
    return Date.now() - latest * 1000 <= this.maxCandleAgeMs(assetKey, timeframe);
  }

  static getCandleSeriesStatus(assetKey: string, timeframe: Timeframe, candles: Candle[]) {
    const latest = candles[candles.length - 1]?.time;
    return {
      fresh: this.candlesAreFresh(assetKey, timeframe, candles),
      asOf: latest ? new Date(latest * 1000).toISOString() : null,
    };
  }

  private static async fetchBybitJson(path: string, timeoutMs = 8_000): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`https://api.bybit.com${path}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Bybit API HTTP error: ${response.status}`);
      const data = await response.json();
      if (Number(data?.retCode) !== 0) {
        throw new Error(`Bybit API error ${data?.retCode}: ${data?.retMsg || "unknown error"}`);
      }
      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private static async fetchBybitTicker(symbol: string): Promise<any> {
    const data = await this.fetchBybitJson(
      `/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`,
      5_000
    );
    const ticker = data?.result?.list?.[0];
    if (!ticker) throw new Error(`Bybit returned no ticker for ${symbol}`);
    return { ...ticker, serverTime: Number(data?.time) || Date.now() };
  }

  static async getDeepSensors(assetKey: string): Promise<{ fundingRate?: number, openInterest?: number }> {
    const config = SUPPORTED_ASSETS[assetKey];
    if (!config || config.category !== "crypto" || !config.bybitLinearSymbol) return {};

    const redis = getRedis();
    const cacheKey = `cache:deep_sensors:v2:${CRYPTO_EXECUTION_PROVIDER}:${assetKey}`;
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;
    } catch {}

    try {
      const ticker = await this.fetchBybitTicker(config.bybitLinearSymbol);
      const fundingRate = Number(ticker.fundingRate);
      const openInterest = Number(ticker.openInterest);
      const sensors = {
        ...(Number.isFinite(fundingRate) ? { fundingRate } : {}),
        ...(Number.isFinite(openInterest) ? { openInterest } : {}),
      };
      if (Object.keys(sensors).length > 0) {
        await redis.set(cacheKey, JSON.stringify(sensors), { ex: 60 });
      }
      return sensors;
    } catch (err) {
      console.warn(`[MarketService] Failed to fetch Bybit sensors for ${assetKey}:`, err);
      return {};
    }
  }

  private static getBybitInterval(timeframe: Timeframe | "1w"): string {
    switch (timeframe) {
      case "1m": return "1";
      case "5m": return "5";
      case "15m": return "15";
      case "30m": return "30";
      case "1h": return "60";
      case "4h": return "240";
      case "1w": return "W";
      default: return "60";
    }
  }

  private static getYahooInterval(timeframe: Timeframe): string {
    switch (timeframe) {
      case "1m": return "1m";
      case "5m": return "5m";
      case "15m": return "15m";
      case "30m": return "30m";
      case "1h": return "60m";
      case "4h": return "60m"; // Yahoo doesn't support 4h directly on open widgets, so fetch 1h and downsample or use 1h as proxy
      default: return "60m";
    }
  }

  static async getCandles(
    timeframe: Timeframe,
    limit: number = 200,
    assetKey: string = "BTC",
    options: CandleRequestOptions = {}
  ): Promise<Candle[]> {
    const redis = getRedis();
    const cacheKey = marketCandleCacheKey(assetKey, timeframe);
    let staleCandidate: Candle[] | null = null;
    
    // Attempt cache check first
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const normalized = this.normalizeCandles(assetKey, timeframe, parsed);
          if (this.candlesAreFresh(assetKey, timeframe, normalized)) {
            return normalized.slice(-limit);
          }
          staleCandidate = normalized;
        }
      }
    } catch {}

    const config = SUPPORTED_ASSETS[assetKey] || SUPPORTED_ASSETS.BTC;
    const fetchLimit = Math.max(720, limit); // Always fetch at least 720 candles to keep the cache rich

    // Crypto signals, entries, and lifecycle prices must all describe the same
    // Bybit USDT perpetual instrument. Comparison venues never become hidden
    // execution fallbacks.
    if (config.category === "crypto" && config.bybitLinearSymbol) {
      try {
        const candles = this.normalizeCandles(
          assetKey,
          timeframe,
          await this.fetchBybitLinearCandles(config.bybitLinearSymbol, timeframe, fetchLimit)
        );
        if (candles && candles.length > 0) {
          if (this.candlesAreFresh(assetKey, timeframe, candles)) {
            const ttl = timeframe === "1m" ? 10 : timeframe === "5m" ? 30 : timeframe === "15m" ? 60 : 300;
            await redis.set(cacheKey, JSON.stringify(candles), { ex: ttl });
            return candles.slice(-limit);
          }
          staleCandidate = candles;
        }
      } catch (bybitError) {
        console.warn(`Bybit linear candle feed failed for ${assetKey}.`, bybitError);
      }

      if (staleCandidate && staleCandidate.length > 0 && options.allowStale) {
        return staleCandidate.slice(-limit);
      }
      throw new Error(`Selected Bybit linear candle feed is unavailable or stale for ${assetKey}/${timeframe}.`);
    }

    // Yahoo is the selected instrument family for FX and commodities.
    try {
      // Fix 3: For 4h timeframe, fetch 4× as many 1h candles then downsample to real 4h OHLCV.
      // This gives ~17 days of true 4h history instead of just ~4 days.
      const yahooFetchLimit = timeframe === "4h" ? fetchLimit * 4 : fetchLimit;
      const yahooTimeframe: Timeframe = timeframe === "4h" ? "1h" : timeframe;
      let candles = await this.fetchYahooCandles(config.yahooTicker, yahooTimeframe, yahooFetchLimit);
      if (timeframe === "4h" && candles.length > 0) {
        candles = this.downsampleTo4h(candles);
      }
      candles = this.normalizeCandles(assetKey, timeframe, candles);
      if (candles && candles.length > 0) {
        if (this.candlesAreFresh(assetKey, timeframe, candles)) {
          const ttl = timeframe === "1m" ? 10 : timeframe === "5m" ? 30 : timeframe === "15m" ? 60 : 300;
          await redis.set(cacheKey, JSON.stringify(candles), { ex: ttl });
          return candles.slice(-limit);
        }
        staleCandidate = candles;
      }
    } catch (yahooError) {
      console.error(`Selected Yahoo instrument feed failed for ${assetKey}:`, yahooError);
    }

    // Trading callers fail closed by default. Read-only callers may explicitly
    // request the latest historical series for a closed market.
    if (staleCandidate && staleCandidate.length > 0) {
      if (options.allowStale) return staleCandidate.slice(-limit);
      throw new Error(`Market data for ${assetKey}/${timeframe} is stale after all feed attempts.`);
    }

    throw new Error(`Failed to fetch candles for asset ${assetKey} from all data feeds.`);
  }

  private static async fetchBybitLinearCandles(
    symbol: string,
    timeframe: Timeframe | "1w",
    limit: number
  ): Promise<Candle[]> {
    const boundedLimit = Math.max(1, Math.min(1_000, limit));
    const interval = this.getBybitInterval(timeframe);
    const data = await this.fetchBybitJson(
      `/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${boundedLimit}`
    );
    const rows = Array.isArray(data?.result?.list) ? data.result.list : [];
    return rows
      .map((row: any[]) => ({
        time: Math.floor(Number(row?.[0]) / 1_000),
        open: Number(row?.[1]),
        high: Number(row?.[2]),
        low: Number(row?.[3]),
        close: Number(row?.[4]),
        volume: Number(row?.[5] || 0),
      }))
      .sort((a: Candle, b: Candle) => a.time - b.time)
      .slice(-boundedLimit);
  }

  private static async fetchYahooCandles(ticker: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const interval = this.getYahooInterval(timeframe);
    
    // Yahoo API restrictions: 1m max is 7d, 5m/15m/30m max is 60d
    let range = "5d";
    if (interval === "1m") {
      range = "7d"; // Max allowed for 1m
    } else if (interval === "5m" || interval === "15m" || interval === "30m") {
      range = limit > 500 ? "1mo" : "5d";
    } else {
      // 1h or higher
      range = limit > 500 ? "3mo" : "1mo";
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`,
      {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        }
      }
    );
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`Yahoo HTTP error: ${res.status}`);
    const data = await res.json();

    const chartResult = data.chart?.result?.[0];
    if (!chartResult) throw new Error("Yahoo returned empty chart result");

    const timestamps = chartResult.timestamp || [];
    const quote = chartResult.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];

    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (
        opens[i] !== null && opens[i] !== undefined &&
        closes[i] !== null && closes[i] !== undefined
      ) {
        candles.push({
          time: timestamps[i],
          open: parseFloat(opens[i]),
          high: parseFloat(highs[i] ?? opens[i]),
          low: parseFloat(lows[i] ?? opens[i]),
          close: parseFloat(closes[i]),
          volume: parseFloat(volumes[i] ?? 0)
        });
      }
    }

    return candles.slice(-limit);
  }

  // Fix 3: Downsample consecutive 1h candles into true 4h OHLCV candles.
  // Groups candles by strict UTC 4-hour buckets (00:00, 04:00, 08:00, 12:00, 16:00, 20:00).
  private static downsampleTo4h(candles1h: Candle[]): Candle[] {
    const buckets = new Map<number, Candle[]>();
    
    for (const c of candles1h) {
      // 4 hours = 14400 seconds. Floor to nearest 4h bucket.
      const bucketTime = Math.floor(c.time / 14400) * 14400;
      if (!buckets.has(bucketTime)) buckets.set(bucketTime, []);
      buckets.get(bucketTime)!.push(c);
    }

    const result: Candle[] = [];
    // Sort buckets chronologically
    const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
    
    for (const [bucketTime, group] of sortedBuckets) {
      if (group.length === 0) continue;
      // Sort group chronologically just in case
      group.sort((a, b) => a.time - b.time);
      result.push({
        time:   bucketTime,
        open:   group[0].open,
        high:   Math.max(...group.map((c) => c.high)),
        low:    Math.min(...group.map((c) => c.low)),
        close:  group[group.length - 1].close,
        volume: group.reduce((sum, c) => sum + (c.volume || 0), 0),
      });
    }
    return result;
  }

  static async getCurrentPriceSnapshot(assetKey: string = "BTC"): Promise<MarketPriceSnapshot> {
    const redis = getRedis();
    const config = SUPPORTED_ASSETS[assetKey] || SUPPORTED_ASSETS.BTC;
    const cacheKey = marketPriceCacheKey(assetKey);
    const cacheMetaKey = marketPriceMetaCacheKey(assetKey);

    if (config.category === "crypto") {
      try {
        const [livePrice, liveMeta] = await Promise.all([
          redis.get<number | string>(marketLivePriceKey(CRYPTO_EXECUTION_SOURCE, assetKey)),
          redis.get<any>(marketLiveMetaKey(CRYPTO_EXECUTION_SOURCE, assetKey)),
        ]);
        const price = Number(livePrice);
        const updatedAt = String(liveMeta?.providerEventTime || liveMeta?.updatedAt || "");
        const timestamp = new Date(updatedAt).getTime();
        const ageMs = Date.now() - timestamp;
        if (Number.isFinite(price) && price > 0 && Number.isFinite(timestamp) && ageMs >= 0 && ageMs <= 5_000) {
          return {
            price,
            provider: CRYPTO_EXECUTION_SOURCE,
            source: "WEBSOCKET",
            venue: CRYPTO_EXECUTION_PROVIDER,
            instrument: config.bybitLinearSymbol,
            updatedAt: new Date(timestamp).toISOString(),
            ...(Number.isFinite(Number(liveMeta?.bid)) ? { bid: Number(liveMeta.bid) } : {}),
            ...(Number.isFinite(Number(liveMeta?.ask)) ? { ask: Number(liveMeta.ask) } : {}),
          };
        }
      } catch {}

      try {
        const [cachedPrice, cachedMeta] = await Promise.all([
          redis.get<number | string>(cacheKey),
          redis.get<MarketPriceSnapshot>(cacheMetaKey),
        ]);
        const price = Number(cachedPrice);
        const timestamp = new Date(cachedMeta?.updatedAt || 0).getTime();
        const ageMs = Date.now() - timestamp;
        if (
          Number.isFinite(price) && price > 0 &&
          cachedMeta?.venue === CRYPTO_EXECUTION_PROVIDER &&
          cachedMeta?.instrument === config.bybitLinearSymbol &&
          Number.isFinite(timestamp) && ageMs >= 0 && ageMs <= 5_000
        ) {
          return { ...cachedMeta, price };
        }
      } catch {}

      try {
        const ticker = await this.fetchBybitTicker(config.bybitLinearSymbol);
        const price = Number(ticker.lastPrice);
        if (!Number.isFinite(price) || price <= 0) throw new Error("Bybit returned an invalid last price");
        const updatedAt = new Date(Number(ticker.serverTime) || Date.now()).toISOString();
        const snapshot: MarketPriceSnapshot = {
          price,
          provider: `${CRYPTO_EXECUTION_PROVIDER}_HTTP`,
          source: "HTTP",
          venue: CRYPTO_EXECUTION_PROVIDER,
          instrument: config.bybitLinearSymbol,
          updatedAt,
          ...(Number.isFinite(Number(ticker.bid1Price)) ? { bid: Number(ticker.bid1Price) } : {}),
          ...(Number.isFinite(Number(ticker.ask1Price)) ? { ask: Number(ticker.ask1Price) } : {}),
        };
        await Promise.all([
          redis.set(cacheKey, price, { ex: 10 }),
          redis.set(cacheMetaKey, snapshot, { ex: 10 }),
        ]);
        return snapshot;
      } catch (error) {
        throw new Error(`Selected Bybit linear price feed failed for ${assetKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const [cachedPrice, cachedMeta] = await Promise.all([
        redis.get<number | string>(cacheKey),
        redis.get<MarketPriceSnapshot>(cacheMetaKey),
      ]);
      const price = Number(cachedPrice);
      if (
        Number.isFinite(price) && price > 0 &&
        cachedMeta?.venue === "YAHOO" &&
        cachedMeta?.instrument === config.yahooTicker
      ) {
        return { ...cachedMeta, price };
      }
    } catch {}

    try {
      const candles = await this.fetchYahooCandles(config.yahooTicker, "15m", 1);
      if (candles.length > 0) {
        const candle = candles[candles.length - 1];
        const price = candle.close;
        const snapshot: MarketPriceSnapshot = {
          price,
          provider: "YAHOO",
          source: "HTTP",
          venue: "YAHOO",
          instrument: config.yahooTicker,
          updatedAt: new Date(candle.time * 1_000).toISOString(),
        };
        await Promise.all([
          redis.set(cacheKey, price, { ex: 10 }),
          redis.set(cacheMetaKey, snapshot, { ex: 10 }),
        ]);
        return snapshot;
      }
    } catch {}

    throw new Error(`Failed to retrieve selected-instrument price for ${assetKey}`);
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
    const redis = getRedis();
    const cacheKey = `cache:stats24h:v2:${primaryMarketDataProvider(assetKey)}:${assetKey}`;

    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;
    } catch {}

    const config = SUPPORTED_ASSETS[assetKey] || SUPPORTED_ASSETS.BTC;

    if (config.category === "crypto" && config.bybitLinearSymbol) {
      try {
        const ticker = await this.fetchBybitTicker(config.bybitLinearSymbol);
        const close = Number(ticker.lastPrice);
        const open = Number(ticker.prevPrice24h);
        const stats = {
          priceChange: close - open,
          priceChangePercent: Number(ticker.price24hPcnt) * 100,
          volume: Number(ticker.volume24h),
          high: Number(ticker.highPrice24h),
          low: Number(ticker.lowPrice24h),
        };
        if (Object.values(stats).every(Number.isFinite)) {
          await redis.set(cacheKey, JSON.stringify(stats), { ex: 60 });
          return stats;
        }
      } catch {}

      return { priceChange: 0, priceChangePercent: 0, volume: 0, high: 0, low: 0 };
    }

    // FX and commodity statistics stay in the same Yahoo instrument family.
    try {
      const candles = await this.fetchYahooCandles(config.yahooTicker, "1h", 24);
      if (candles.length > 0) {
        const open = candles[0].open;
        const close = candles[candles.length - 1].close;
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumeSum = candles.reduce((sum, c) => sum + c.volume, 0);

        const stats = {
          priceChange: close - open,
          priceChangePercent: open > 0 ? ((close - open) / open) * 100 : 0,
          volume: volumeSum,
          high: Math.max(...highs),
          low: Math.min(...lows)
        };

        await redis.set(cacheKey, JSON.stringify(stats), { ex: 60 });
        return stats;
      }
    } catch {}

    return {
      priceChange: 0,
      priceChangePercent: 0,
      volume: 0,
      high: 0,
      low: 0
    };
  }

  static async getOrderbookImbalance(assetKey: string = "BTC"): Promise<{ bidVolume: number; askVolume: number; imbalanceRatio: number; isBullish: boolean; isBearish: boolean }> {
    const redis = getRedis();
    try {
      const [liveImbalanceStr, liveMeta] = await Promise.all([
        redis.get<string>(marketImbalanceKey(CRYPTO_EXECUTION_SOURCE, assetKey)),
        redis.get<any>(marketLiveMetaKey(CRYPTO_EXECUTION_SOURCE, assetKey)),
      ]);
      const providerTimestamp = new Date(liveMeta?.providerEventTime || liveMeta?.updatedAt || 0).getTime();
      const ageMs = Date.now() - providerTimestamp;
      if (liveImbalanceStr && Number.isFinite(providerTimestamp) && ageMs >= 0 && ageMs <= 5_000) {
        const imbalance = parseFloat(liveImbalanceStr);
        // Ratio = Bids / Asks. Since imbalance = (B - A)/(B + A) => B/A = (1 + imbalance)/(1 - imbalance)
        const ratio = (1 - imbalance) !== 0 ? (1 + imbalance) / (1 - imbalance) : 1;
        return {
          bidVolume: imbalance > 0 ? 100 * (1 + imbalance) : 100,
          askVolume: imbalance < 0 ? 100 * (1 - imbalance) : 100,
          imbalanceRatio: ratio,
          isBullish: ratio >= 1.5,
          isBearish: ratio <= 0.66
        };
      }
    } catch (e) {
      console.warn("Failed to retrieve live imbalance from Redis:", e);
    }

    const config = SUPPORTED_ASSETS[assetKey];
    if (!config || config.category !== "crypto" || !config.bybitLinearSymbol) {
      return { bidVolume: 0, askVolume: 0, imbalanceRatio: 1, isBullish: false, isBearish: false };
    }

    try {
      const data = await this.fetchBybitJson(
        `/v5/market/orderbook?category=linear&symbol=${encodeURIComponent(config.bybitLinearSymbol)}&limit=50`,
        5_000
      );
      const bids = Array.isArray(data?.result?.b) ? data.result.b : [];
      const asks = Array.isArray(data?.result?.a) ? data.result.a : [];
      const bidVolume = bids.reduce((sum: number, bid: any[]) => sum + Number(bid?.[1] || 0), 0);
      const askVolume = asks.reduce((sum: number, ask: any[]) => sum + Number(ask?.[1] || 0), 0);
      const ratio = askVolume > 0 ? bidVolume / askVolume : 1;

      return {
        bidVolume,
        askVolume,
        imbalanceRatio: ratio,
        isBullish: ratio >= 1.5,
        isBearish: ratio <= 0.66
      };
    } catch (err) {
      return { bidVolume: 0, askVolume: 0, imbalanceRatio: 1, isBullish: false, isBearish: false };
    }
  }

  // Upgrade 3: Fetch weekly candles from Yahoo Finance (1wk interval, 6-month range).
  // Used by SwingEngine for the weekly trend bias gate.
  // Cached in Redis for 1 hour — weekly data changes very slowly.
  static async getWeeklyCandles(limit: number = 20, assetKey: string = "BTC"): Promise<Candle[]> {
    const config = SUPPORTED_ASSETS[assetKey] || SUPPORTED_ASSETS.BTC;
    const redis = getRedis();
    const cacheKey = `cache:candles:instrument-v3:${primaryMarketDataProvider(assetKey)}:${assetKey}:1w`;

    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
        if (Array.isArray(parsed) && parsed.length > 0) return parsed.slice(-limit);
      }
    } catch {}

    if (config.category === "crypto" && config.bybitLinearSymbol) {
      try {
        const candles = await this.fetchBybitLinearCandles(config.bybitLinearSymbol, "1w", Math.max(limit, 26));
        if (candles.length > 0) {
          await redis.set(cacheKey, JSON.stringify(candles), { ex: 3600 });
          return candles.slice(-limit);
        }
      } catch {}
      return [];
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${config.yahooTicker}?interval=1wk&range=6mo`,
        {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          }
        }
      );
      clearTimeout(timeoutId);
      if (!res.ok) return [];

      const data = await res.json();
      const chartResult = data.chart?.result?.[0];
      if (!chartResult) return [];

      const timestamps = chartResult.timestamp || [];
      const quote = chartResult.indicators?.quote?.[0] || {};
      const candles: Candle[] = [];

      for (let i = 0; i < timestamps.length; i++) {
        if (quote.open?.[i] != null && quote.close?.[i] != null) {
          candles.push({
            time:   timestamps[i],
            open:   parseFloat(quote.open[i]),
            high:   parseFloat(quote.high?.[i] ?? quote.open[i]),
            low:    parseFloat(quote.low?.[i]  ?? quote.open[i]),
            close:  parseFloat(quote.close[i]),
            volume: parseFloat(quote.volume?.[i] ?? 0),
          });
        }
      }

      if (candles.length > 0) {
        // 1-hour TTL — weekly candles barely change intraday
        await redis.set(cacheKey, JSON.stringify(candles), { ex: 3600 });
      }
      return candles.slice(-limit);
    } catch {
      return [];
    }
  }
}
