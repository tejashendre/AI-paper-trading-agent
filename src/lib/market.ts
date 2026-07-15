import { Candle, Timeframe } from "@/lib/types";
import { getRedis } from "@/lib/redis";

interface AssetConfig {
  name: string;
  category: "crypto" | "forex" | "commodity";
  krakenPair: string;
  yahooTicker: string;
  coingeckoId: string;
}

export const SUPPORTED_ASSETS: Record<string, AssetConfig> = {
  BTC: { name: "Bitcoin", category: "crypto", krakenPair: "XBTUSD", yahooTicker: "BTC-USD", coingeckoId: "bitcoin" },
  ETH: { name: "Ethereum", category: "crypto", krakenPair: "ETHUSD", yahooTicker: "ETH-USD", coingeckoId: "ethereum" },
  SOL: { name: "Solana", category: "crypto", krakenPair: "SOLUSD", yahooTicker: "SOL-USD", coingeckoId: "solana" },
  EURUSD: { name: "EUR/USD", category: "forex", krakenPair: "EURUSD", yahooTicker: "EURUSD=X", coingeckoId: "" },
  GBPUSD: { name: "GBP/USD", category: "forex", krakenPair: "GBPUSD", yahooTicker: "GBPUSD=X", coingeckoId: "" },
  USDJPY: { name: "USD/JPY", category: "forex", krakenPair: "USDJPY", yahooTicker: "USDJPY=X", coingeckoId: "" },
  GOLD: { name: "Gold", category: "commodity", krakenPair: "PAXGUSD", yahooTicker: "GC=F", coingeckoId: "" },
  OIL: { name: "Crude Oil", category: "commodity", krakenPair: "", yahooTicker: "CL=F", coingeckoId: "" },
  SILVER: { name: "Silver", category: "commodity", krakenPair: "", yahooTicker: "SI=F", coingeckoId: "" }
};

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

  static async getDeepSensors(assetKey: string): Promise<{ fundingRate?: number, openInterest?: number }> {
    const config = SUPPORTED_ASSETS[assetKey];
    if (!config || config.category !== 'crypto') return {};

    const redis = getRedis();
    const cacheKey = `cache:deep_sensors:${assetKey}`;
    
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        return typeof cached === "string" ? JSON.parse(cached) : cached;
      }
    } catch {}

    try {
      const symbol = `${assetKey}USDT`;
      
      const [fundingRes, oiRes] = await Promise.allSettled([
        fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
        fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`)
      ]);

      const sensors: { fundingRate?: number, openInterest?: number } = {};

      if (fundingRes.status === 'fulfilled' && fundingRes.value.ok) {
        const data = await fundingRes.value.json();
        sensors.fundingRate = parseFloat(data.lastFundingRate);
      }

      if (oiRes.status === 'fulfilled' && oiRes.value.ok) {
        const data = await oiRes.value.json();
        sensors.openInterest = parseFloat(data.openInterest);
      }

      if (sensors.fundingRate !== undefined || sensors.openInterest !== undefined) {
        await redis.set(cacheKey, JSON.stringify(sensors), { ex: 300 }); // Cache for 5 mins
      }

      return sensors;
    } catch (err) {
      console.warn(`[MarketService] Failed to fetch deep sensors for ${assetKey}:`, err);
      return {};
    }
  }

  private static getKrakenMinutes(timeframe: Timeframe): number {
    switch (timeframe) {
      case "1m": return 1;
      case "5m": return 5;
      case "15m": return 15;
      case "30m": return 30;
      case "1h": return 60;
      case "4h": return 240;
      default: return 60;
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

  static async getCandles(timeframe: Timeframe, limit: number = 200, assetKey: string = "BTC"): Promise<Candle[]> {
    const redis = getRedis();
    const cacheKey = `cache:candles:${assetKey}:${timeframe}`;
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

    // Try Kraken first (Primary institutional feed)
    if (config.krakenPair) {
      try {
        const candles = this.normalizeCandles(assetKey, timeframe, await this.fetchKrakenCandles(config.krakenPair, timeframe, fetchLimit));
        if (candles && candles.length > 0) {
          if (this.candlesAreFresh(assetKey, timeframe, candles)) {
            const ttl = timeframe === "1m" ? 10 : timeframe === "5m" ? 30 : timeframe === "15m" ? 60 : 300;
            await redis.set(cacheKey, JSON.stringify(candles), { ex: ttl });
            return candles.slice(-limit);
          }
          staleCandidate = candles;
        }
      } catch (krakenError) {
        console.warn(`Kraken feed failed for ${assetKey}, trying Yahoo Finance fallback...`, krakenError);
      }
    }

    // Fallback to Yahoo Finance (Secondary unblocked feed)
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
      console.error(`Yahoo Finance fallback also failed for ${assetKey}:`, yahooError);
    }

    // Never silently feed stale candles into signal generation. Callers can
    // decide how to present the unavailable feed, but trading must fail closed.
    if (staleCandidate && staleCandidate.length > 0) {
      throw new Error(`Market data for ${assetKey}/${timeframe} is stale after all feed attempts.`);
    }

    throw new Error(`Failed to fetch candles for asset ${assetKey} from all data feeds.`);
  }

  private static async fetchKrakenCandles(pair: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const interval = this.getKrakenMinutes(timeframe);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`Kraken API HTTP error: ${res.status}`);
    const data = await res.json();

    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken API error: ${data.error.join(", ")}`);
    }

    const resultKeys = Object.keys(data.result).filter(k => k !== "last");
    const candlesRaw = data.result[resultKeys[0]] || [];

    const candles: Candle[] = candlesRaw.map((c: any) => ({
      time: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[6])
    }));

    // Downsample/slice to match limit
    return candles.slice(-limit);
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

  private static async fetchCoinGeckoPrice(coingeckoId: string): Promise<number> {
    if (!coingeckoId) throw new Error('No CoinGecko ID for this asset');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`CoinGecko HTTP error: ${res.status}`);
    const data = await res.json();
    const price = data[coingeckoId]?.usd;
    if (!price || isNaN(price)) throw new Error('CoinGecko returned invalid price');
    return price;
  }

  static async getCurrentPrice(assetKey: string = "BTC"): Promise<number> {
    const redis = getRedis();

    // 1. Live WebSocket Feed. The timestamp is authoritative so a retained
    // value cannot be mistaken for a fresh execution price.
    try {
      const [livePrice, liveMeta] = await Promise.all([
        redis.get<number>(`market:live:${assetKey}`),
        redis.get<any>(`market:liveMeta:${assetKey}`),
      ]);
      const updatedAt = new Date(liveMeta?.updatedAt || 0).getTime();
      const ageMs = Date.now() - updatedAt;
      if (livePrice && Number.isFinite(Number(livePrice)) && ageMs >= 0 && ageMs <= 45_000) {
        return Number(livePrice);
      }
    } catch {}

    // 2. HTTP Cache Fallback
    const cacheKey = `cache:price:${assetKey}`;
    try {
      const cached = await redis.get<number>(cacheKey);
      if (cached) return Number(cached);
    } catch {}

    const config = SUPPORTED_ASSETS[assetKey] || SUPPORTED_ASSETS.BTC;

    // Kraken Primary
    if (config.krakenPair) {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${config.krakenPair}`, {
          signal: controller.signal
        });
        clearTimeout(id);

        if (res.ok) {
          const data = await res.json();
          const pairKey = Object.keys(data.result)[0];
          const price = parseFloat(data.result[pairKey].c[0]);
          if (!isNaN(price)) {
            await redis.set(cacheKey, price, { ex: 10 });
            return price;
          }
        }
      } catch {}
    }

    // Yahoo Fallback
    try {
      const candles = await this.fetchYahooCandles(config.yahooTicker, "15m", 1);
      if (candles.length > 0) {
        const price = candles[candles.length - 1].close;
        await redis.set(cacheKey, price, { ex: 10 });
        return price;
      }
    } catch {}

    // CoinGecko Tertiary Fallback
    try {
      if (config.coingeckoId) {
        const price = await this.fetchCoinGeckoPrice(config.coingeckoId);
        await redis.set(cacheKey, price, { ex: 10 });
        return price;
      }
    } catch {}

    throw new Error(`Failed to retrieve live price for ${assetKey}`);
  }

  static async get24hStats(assetKey: string = "BTC"): Promise<{
    priceChange: number;
    priceChangePercent: number;
    volume: number;
    high: number;
    low: number;
  }> {
    const redis = getRedis();
    const cacheKey = `cache:stats24h:${assetKey}`;

    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;
    } catch {}

    const config = SUPPORTED_ASSETS[assetKey] || SUPPORTED_ASSETS.BTC;

    // Try Kraken
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${config.krakenPair}`, {
        signal: controller.signal
      });
      clearTimeout(id);

      if (res.ok) {
        const data = await res.json();
        const pairKey = Object.keys(data.result)[0];
        const ticker = data.result[pairKey];

        const getVal = (val: any, index: number) => {
          if (Array.isArray(val)) return val[index] !== undefined ? val[index] : val[0];
          return val;
        };

        const open = parseFloat(getVal(ticker.o, 0));
        const close = parseFloat(getVal(ticker.c, 0));
        const change = close - open;
        const changePercent = open > 0 ? (change / open) * 100 : 0;

        const stats = {
          priceChange: change,
          priceChangePercent: changePercent,
          volume: parseFloat(getVal(ticker.v, 1)),
          high: parseFloat(getVal(ticker.h, 1)),
          low: parseFloat(getVal(ticker.l, 1))
        };

        await redis.set(cacheKey, JSON.stringify(stats), { ex: 60 });
        return stats;
      }
    } catch {}

    // Try Yahoo
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
      const liveImbalanceStr = await redis.get<string>(`market:imbalance:${assetKey}`);
      if (liveImbalanceStr) {
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
    if (!config || !config.krakenPair) {
      return { bidVolume: 0, askVolume: 0, imbalanceRatio: 1, isBullish: false, isBearish: false };
    }

    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`https://api.kraken.com/0/public/Depth?pair=${config.krakenPair}&count=100`, {
        signal: controller.signal
      });
      clearTimeout(id);

      if (!res.ok) throw new Error("Failed to fetch Kraken depth");
      const data = await res.json();
      const pairKey = Object.keys(data.result)[0];
      const depth = data.result[pairKey];

      let bidVolume = 0;
      let askVolume = 0;

      // Depth arrays are [price, volume, timestamp]
      depth.bids.forEach((bid: string[]) => {
        bidVolume += parseFloat(bid[1]);
      });

      depth.asks.forEach((ask: string[]) => {
        askVolume += parseFloat(ask[1]);
      });

      // Ratio: Bids / Asks. 
      // > 1.5 means massive buy walls (bullish)
      // < 0.66 means massive sell walls (bearish)
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
    const cacheKey = `cache:candles:${assetKey}:1w`;

    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
        if (Array.isArray(parsed) && parsed.length > 0) return parsed.slice(-limit);
      }
    } catch {}

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
