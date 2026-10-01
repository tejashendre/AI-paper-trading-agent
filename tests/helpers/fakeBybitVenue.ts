import type { Candle } from "@/lib/types";
import { CONFIGURED_INSTRUMENTS } from "@/lib/trading/instrumentRegistry";
import { evidenceInstrument } from "./fakeBybitMarket";

/**
 * A stand-in for Bybit's public market API behind the global fetch, so the
 * production transport, metadata cache, market service, stream fallback and
 * funding fetchers all run unmodified. Prices come from one-minute bars per
 * symbol; every other interval is aggregated from them, exactly once, so
 * all timeframes describe the same market. Any request that is not a Bybit
 * public market call fails the test.
 */

export const MINUTE = 60_000;
const INTERVAL_MINUTES: Record<string, number> = { "1": 1, "5": 5, "15": 15, "30": 30, "60": 60, "240": 240, W: 10_080 };
const WEEK_ANCHOR_MS = Date.UTC(1970, 0, 5);

/**
 * A deterministic causal path: 15-minute bars with a drift, a slow wave and
 * periodic impulses carrying volume, split into one-minute bars whose
 * aggregate reproduces each 15-minute bar exactly.
 */
export function minuteBars(startPrice: number, drift: number, endMs: number, fifteenMinuteBars = 2_080): Candle[] {
  const startMs = Math.floor(endMs / (15 * MINUTE)) * 15 * MINUTE - fifteenMinuteBars * 15 * MINUTE;
  const bars: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < fifteenMinuteBars; i += 1) {
    const wave = Math.sin(i / 8) * startPrice * 0.0015;
    const impulse = i % 34 === 0 ? startPrice * 0.004 * Math.sign(drift || 1) : 0;
    const open = price;
    const close = Math.max(startPrice * 0.01, open * (1 + drift) + wave + impulse);
    const high = Math.max(open, close) * (1 + 0.003 + (i % 10 === 0 ? 0.004 : 0));
    const low = Math.min(open, close) * (1 - 0.003 - (i % 13 === 0 ? 0.003 : 0));
    const volume = 1000 + (i % 21 === 0 ? 900 : 0) + (i % 34 === 0 ? 1800 : 0) + Math.abs(wave / startPrice) * 1e6;
    for (let k = 0; k < 15; k += 1) {
      const o = open + ((close - open) * k) / 15;
      const c = open + ((close - open) * (k + 1)) / 15;
      bars.push({
        time: (startMs + (i * 15 + k) * MINUTE) / 1000,
        open: o,
        close: c,
        high: k === 5 ? high : Math.max(o, c),
        low: k === 9 ? low : Math.min(o, c),
        volume: volume / 15,
      });
    }
    price = close;
  }
  return bars;
}

function bucketStart(timeMs: number, interval: string): number {
  if (interval === "W") return WEEK_ANCHOR_MS + Math.floor((timeMs - WEEK_ANCHOR_MS) / (7 * 86_400_000)) * 7 * 86_400_000;
  const size = INTERVAL_MINUTES[interval] * MINUTE;
  return Math.floor(timeMs / size) * size;
}

function aggregate(bars: Candle[], interval: string): Candle[] {
  const out: Candle[] = [];
  for (const bar of bars) {
    const start = bucketStart(bar.time * 1000, interval) / 1000;
    const last = out[out.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
      last.volume += bar.volume;
    } else {
      out.push({ ...bar, time: start });
    }
  }
  return out;
}

export interface VenueState {
  nowMs: number;
  /** One-minute bars by symbol; only bars that have opened by now are served. */
  series: Map<string, Candle[]>;
  /** Replace the last price (and the quote around it) for a symbol. */
  priceOverride: Map<string, number>;
  /** Shift the REST server time, e.g. negative to simulate a stale quote. */
  serverTimeOffsetMs: number;
  /** Scale order book depth; small values model a thin book. */
  depthScale: number;
  /** Return at most this many bars per kline request. */
  klineCap: number | null;
  /** Serve metadata for another symbol, keyed by the requested symbol. */
  metadataSwap: Map<string, string>;
  /** Every public request fails, as in a venue outage. */
  outage: boolean;
}

export function createVenue(nowMs: number): VenueState {
  return {
    nowMs,
    series: new Map(),
    priceOverride: new Map(),
    serverTimeOffsetMs: 0,
    depthScale: 1,
    klineCap: null,
    metadataSwap: new Map(),
    outage: false,
  };
}

const symbols = Object.values(CONFIGURED_INSTRUMENTS).map((spec) => spec.symbol);

function visibleBars(venue: VenueState, symbol: string): Candle[] {
  const bars = venue.series.get(symbol) ?? [];
  const cutoff = venue.nowMs / 1000;
  return bars.filter((bar) => bar.time < cutoff);
}

function lastPrice(venue: VenueState, symbol: string): number {
  const override = venue.priceOverride.get(symbol);
  if (override !== undefined) return override;
  const bars = visibleBars(venue, symbol);
  if (bars.length === 0) throw new Error(`fake venue has no bars for ${symbol}`);
  return bars[bars.length - 1].close;
}

function tickerRow(venue: VenueState, symbol: string) {
  const price = lastPrice(venue, symbol);
  return {
    symbol,
    lastPrice: String(price),
    bid1Price: String(price * (1 - 0.00002)),
    ask1Price: String(price * (1 + 0.00002)),
    bid1Size: "50",
    ask1Size: "50",
    markPrice: String(price),
    indexPrice: String(price),
    fundingRate: "0.0001",
    nextFundingTime: String(bucketStart(venue.nowMs, "240") + 8 * 3_600_000),
    openInterest: "1000000",
    prevPrice24h: String(price),
    price24hPcnt: "0",
    volume24h: "100000",
    highPrice24h: String(price * 1.01),
    lowPrice24h: String(price * 0.99),
    turnover24h: "5000000000",
  };
}

function route(venue: VenueState, url: URL): unknown {
  const symbol = url.searchParams.get("symbol") ?? "";
  switch (url.pathname) {
    case "/v5/market/instruments-info": {
      if (!symbol) return { category: "linear", list: symbols.map(evidenceInstrument), nextPageCursor: "" };
      return { category: "linear", list: [evidenceInstrument(venue.metadataSwap.get(symbol) ?? symbol)] };
    }
    case "/v5/market/tickers":
      return { category: "linear", list: (symbol ? [symbol] : symbols).map((s) => tickerRow(venue, s)) };
    case "/v5/market/kline": {
      const interval = url.searchParams.get("interval") ?? "60";
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const rows = aggregate(visibleBars(venue, symbol), interval)
        .slice(-Math.min(limit, venue.klineCap ?? limit))
        .reverse()
        .map((bar) => [String(bar.time * 1000), String(bar.open), String(bar.high), String(bar.low), String(bar.close), String(bar.volume), String(bar.volume * bar.close)]);
      return { category: "linear", symbol, list: rows };
    }
    case "/v5/market/orderbook": {
      const price = lastPrice(venue, symbol);
      const perLevel = String((5_000 * venue.depthScale) / price);
      const levels = (side: 1 | -1) => Array.from({ length: 50 }, (_, i) => [String(price * (1 + side * 0.00002) * (1 + side * 0.00005 * i)), perLevel]);
      return { s: symbol, b: levels(-1), a: levels(1), ts: venue.nowMs };
    }
    case "/v5/market/funding/history": {
      const start = Number(url.searchParams.get("startTime") ?? 0);
      const end = Number(url.searchParams.get("endTime") ?? venue.nowMs);
      const step = Number(evidenceInstrument(symbol).fundingInterval) * MINUTE;
      const list = [];
      for (let at = Math.ceil(start / step) * step; at <= end; at += step) {
        list.push({ symbol, fundingRate: "0.0001", fundingRateTimestamp: String(at) });
      }
      return { category: "linear", list: list.reverse() };
    }
    case "/v5/market/mark-price-kline": {
      const at = Number(url.searchParams.get("start") ?? 0);
      const bar = (venue.series.get(symbol) ?? []).find((candle) => candle.time * 1000 === at);
      return { category: "linear", symbol, list: bar ? [[String(at), String(bar.open), String(bar.high), String(bar.low), String(bar.close)]] : [] };
    }
    default:
      throw new Error(`fake venue has no route for ${url.pathname}`);
  }
}

/** Route the global fetch to the venue. Returns a restore function. */
export function installVenue(venue: VenueState): { calls: string[]; stray: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const stray: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.bybit.com") {
      stray.push(url.toString());
      throw new Error(`network is disabled: ${url.origin}`);
    }
    calls.push(`${url.pathname}?${url.searchParams.toString()}`);
    if (venue.outage) throw new TypeError("fetch failed (simulated Bybit outage)");
    const body = { retCode: 0, retMsg: "OK", result: route(venue, url), time: venue.nowMs + venue.serverTimeOffsetMs };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, stray, restore: () => { globalThis.fetch = original; } };
}
