import { readFileSync } from "node:fs";
import path from "node:path";
import { validateBybitMetadata } from "@/lib/trading/instrumentRegistry";

/**
 * A recording stand-in for Bybit's public market API and the Redis cache, so
 * MarketService can be exercised for real with no network and no Redis.
 */

const evidence = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "docs", "BYBIT_ALL_ASSETS_MARKET_EVIDENCE_2026-10-01.json"), "utf8")
);

/** Thursday 2026-10-01 06:50 UTC: inside a week, a 4h bar and an hour. */
export const SERVER_NOW = Date.parse("2026-10-01T06:50:00.000Z");

export const INTERVAL_MS: Record<string, number> = {
  "1": 60_000,
  "5": 5 * 60_000,
  "15": 15 * 60_000,
  "30": 30 * 60_000,
  "60": 60 * 60_000,
  "240": 4 * 60 * 60_000,
  W: 7 * 24 * 60 * 60_000,
};

const WEEK_ANCHOR_MONDAY = Date.parse("2026-09-28T00:00:00.000Z");

export function barOpen(interval: string, nowMs: number): number {
  const ms = INTERVAL_MS[interval];
  if (interval === "W") return WEEK_ANCHOR_MONDAY + Math.floor((nowMs - WEEK_ANCHOR_MONDAY) / ms) * ms;
  return Math.floor(nowMs / ms) * ms;
}

export function evidenceInstrument(symbol: string): Record<string, unknown> {
  const row = evidence.assets.find((a: any) => a.instrument.symbol === symbol);
  if (!row) throw new Error(`no evidence for ${symbol}`);
  return JSON.parse(JSON.stringify(row.instrument));
}

function evidencePrice(symbol: string): number {
  return Number(evidence.assets.find((a: any) => a.instrument.symbol === symbol)?.ticker.lastPrice ?? 100);
}

/** Newest-first kline rows, as Bybit returns them, including the forming bar. */
export function klineRows(symbol: string, interval: string, limit: number, nowMs: number): string[][] {
  const ms = INTERVAL_MS[interval];
  const current = barOpen(interval, nowMs);
  const base = evidencePrice(symbol);
  const rows: string[][] = [];
  for (let i = 0; i < limit; i += 1) {
    const open = current - i * ms;
    // A function of the bar's own open time, so history is stable as time moves.
    const drift = 1 + ((Math.floor(open / ms) % 7) - 3) * 0.001;
    const o = base * drift;
    const c = o * 1.0005;
    rows.push([String(open), String(o), String(c * 1.001), String(o * 0.999), String(c), "12.5", String(12.5 * c)]);
  }
  return rows;
}

export function tickerRow(symbol: string): Record<string, string> {
  const price = evidencePrice(symbol);
  return {
    symbol,
    lastPrice: String(price),
    bid1Price: String(price * 0.9999),
    ask1Price: String(price * 1.0001),
    bid1Size: "4",
    ask1Size: "2",
    markPrice: String(price * 1.00002),
    indexPrice: String(price * 1.00004),
    fundingRate: "0.0001",
    nextFundingTime: String(barOpen("240", SERVER_NOW) + INTERVAL_MS["240"]),
    openInterest: "123456",
    prevPrice24h: String(price * 0.99),
    price24hPcnt: "0.0101",
    volume24h: "1000",
    highPrice24h: String(price * 1.02),
    lowPrice24h: String(price * 0.98),
    turnover24h: "100000",
  };
}

export interface FakeBybitOptions {
  nowMs?: number;
  /** Replace kline rows for a symbol/interval; return undefined to use the default. */
  kline?: (symbol: string, interval: string, limit: number, nowMs: number) => string[][] | undefined;
  ticker?: (symbol: string) => Record<string, string> | undefined;
}

export function makeFakeBybit(options: FakeBybitOptions = {}) {
  const calls: string[] = [];
  const store = new Map<string, unknown>();
  let now = options.nowMs ?? SERVER_NOW;

  async function bybitGet<T>(requestPath: string): Promise<{ result: T; serverTimeMs: number }> {
    calls.push(requestPath);
    const url = new URL(requestPath, "https://api.bybit.com");
    const symbol = url.searchParams.get("symbol") ?? "";
    const respond = (result: unknown) => ({ result: result as T, serverTimeMs: now });
    switch (url.pathname) {
      case "/v5/market/kline": {
        const interval = url.searchParams.get("interval") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const list = options.kline?.(symbol, interval, limit, now) ?? klineRows(symbol, interval, limit, now);
        return respond({ symbol, category: "linear", list });
      }
      case "/v5/market/tickers":
        return respond({ category: "linear", list: [options.ticker?.(symbol) ?? tickerRow(symbol)] });
      case "/v5/market/orderbook":
        return respond({ s: symbol, b: [["1", "6"], ["0.9", "3"]], a: [["1.1", "2"], ["1.2", "1"]], ts: now });
      default:
        throw new Error(`fake Bybit has no route for ${url.pathname}`);
    }
  }

  const cache = {
    async get<T>(key: string): Promise<T | null> {
      return (store.has(key) ? (JSON.parse(JSON.stringify(store.get(key))) as T) : null);
    },
    async set(key: string, value: unknown): Promise<"OK"> {
      store.set(key, value);
      return "OK";
    },
  };

  return {
    calls,
    store,
    setNow: (ms: number) => { now = ms; },
    deps: {
      bybitGet,
      cache,
      nowMs: () => now,
      metadata: async (symbol: string) => {
        calls.push(`metadata:${symbol}`);
        return validateBybitMetadata(symbol, evidenceInstrument(symbol), now);
      },
    },
  };
}

/** Any request that bypasses the injected transport fails the test. */
export function forbidNetwork(): { stray: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const stray: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    stray.push(String(input));
    throw new Error("network is disabled in this test");
  }) as typeof fetch;
  return { stray, restore: () => { globalThis.fetch = original; } };
}
