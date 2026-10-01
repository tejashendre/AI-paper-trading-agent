import { z } from "zod";
import {
  BybitInstrumentMetadata,
  isMetadataUsable,
  validateBybitMetadata,
} from "@/lib/trading/instrumentRegistry";
import type { FundingDeps, FundingSettlement } from "@/lib/trading/executionCostModel";

/**
 * Bybit V5 public market transport. No API key, and by construction it can
 * only reach `/v5/market/*`: no account or order endpoint is reachable here.
 */

const BYBIT_BASE = "https://api.bybit.com";
export const BYBIT_ATTEMPT_TIMEOUT_MS = 8_000;
export const BYBIT_TOTAL_BUDGET_MS = 30_000;
const MAX_ATTEMPTS = 3;
const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;
/** Cached metadata is revalidated before admitting an entry past this age. */
export const METADATA_REFRESH_MS = 6 * 3_600_000;
const MAX_INSTRUMENT_PAGES = 20;

export interface BybitRequestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  nowMs?: () => number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** An error retrying cannot fix: bad request, forbidden, or a rejected payload. */
class PermanentBybitError extends Error {}

const envelopeSchema = z.object({
  retCode: z.literal(0),
  result: z.object({}).passthrough(),
  time: z.number().int().positive(),
});

function publicMarketUrl(path: string): string {
  const url = new URL(path, BYBIT_BASE);
  if (url.origin !== BYBIT_BASE || !path.startsWith("/v5/market/") || !url.pathname.startsWith("/v5/market/")) {
    throw new PermanentBybitError(`Refusing "${path}": not a Bybit public market path`);
  }
  return url.toString();
}

function abortError(): Error {
  return new Error("Bybit request aborted by caller");
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  const cap = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt);
  return MIN_BACKOFF_MS + Math.random() * (cap - MIN_BACKOFF_MS);
}

async function attemptOnce(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ result: unknown; serverTimeMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Bybit request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  const onAbort = () => controller.abort(abortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "User-Agent": "quant-paper-trader/1.0" },
    });
    if (!response.ok) {
      const message = `Bybit HTTP ${response.status}`;
      // Rate limits and server faults are worth another bounded try; any
      // other refusal (403 geo/IP block, 404, 400) will not change.
      if (response.status === 429 || response.status >= 500) throw new Error(message);
      throw new PermanentBybitError(message);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PermanentBybitError("Bybit returned an invalid payload (not JSON)");
    }
    const retCode = (payload as { retCode?: unknown } | null)?.retCode;
    if (typeof retCode === "number" && retCode !== 0) {
      const retMsg = (payload as { retMsg?: unknown }).retMsg;
      throw new PermanentBybitError(`Bybit ${retCode}: ${String(retMsg ?? "")}`);
    }
    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new PermanentBybitError(`Bybit returned an invalid payload at ${issue.path.join(".") || "(root)"}`);
    }
    return { result: parsed.data.result, serverTimeMs: parsed.data.time };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * GET a public market endpoint with at most three attempts inside a 30s
 * budget. Each attempt has its own timeout; backoff is jittered between
 * 250ms and 2s. A caller abort stops immediately and is never retried.
 */
export async function bybitPublicGet<T>(
  path: string,
  options: BybitRequestOptions = {}
): Promise<{ result: T; serverTimeMs: number }> {
  const url = publicMarketUrl(path);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.nowMs ?? Date.now;
  const sleep = options.sleepImpl ?? abortableSleep;
  const attemptTimeout = options.timeoutMs ?? BYBIT_ATTEMPT_TIMEOUT_MS;
  const startedAt = now();
  let lastError: Error = new Error(`Bybit request to ${path} was not attempted`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    const remaining = BYBIT_TOTAL_BUDGET_MS - (now() - startedAt);
    if (remaining <= 0) break;
    try {
      const out = await attemptOnce(url, fetchImpl, Math.min(attemptTimeout, remaining), options.signal);
      return { result: out.result as T, serverTimeMs: out.serverTimeMs };
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      if (error instanceof PermanentBybitError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt === MAX_ATTEMPTS) break;
    const delay = backoffMs(attempt);
    if (now() - startedAt + delay >= BYBIT_TOTAL_BUDGET_MS) break;
    await sleep(delay, options.signal);
  }
  throw lastError;
}

export interface BybitMetadataCache {
  /** Metadata fit for admitting a new entry; throws when it cannot be trusted. */
  get(symbol: string): Promise<BybitInstrumentMetadata>;
  /** Last validated copy regardless of age, for describing existing positions. */
  lastValid(symbol: string): BybitInstrumentMetadata | null;
}

/**
 * Six-hour cache with fail-closed expiry: past six hours a refresh is tried;
 * if it fails, the last valid copy is served only while it is under 24 hours
 * old. The last valid copy is never discarded, so exits can still be sized.
 */
export function createBybitMetadataCache(options: BybitRequestOptions = {}): BybitMetadataCache {
  const entries = new Map<string, BybitInstrumentMetadata>();
  const now = options.nowMs ?? Date.now;

  async function refresh(symbol: string): Promise<BybitInstrumentMetadata> {
    const { result } = await bybitPublicGet<{ list?: unknown[] }>(
      `/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(symbol)}`,
      options
    );
    const row = Array.isArray(result.list) ? result.list[0] : undefined;
    const metadata = validateBybitMetadata(symbol, row, now());
    entries.set(symbol, metadata);
    return metadata;
  }

  return {
    async get(symbol) {
      const cached = entries.get(symbol);
      if (cached && now() - cached.verifiedAtMs <= METADATA_REFRESH_MS) return cached;
      try {
        return await refresh(symbol);
      } catch (error) {
        if (cached && isMetadataUsable(cached, now())) return cached;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${symbol}: instrument metadata unavailable for new entries (${reason})`);
      }
    },
    lastValid(symbol) {
      return entries.get(symbol) ?? null;
    },
  };
}

const defaultMetadataCache = createBybitMetadataCache();

export function getBybitInstrumentMetadata(symbol: string): Promise<BybitInstrumentMetadata> {
  return defaultMetadataCache.get(symbol);
}

export function lastValidBybitMetadata(symbol: string): BybitInstrumentMetadata | null {
  return defaultMetadataCache.lastValid(symbol);
}

/**
 * Every Trading USDT linear perpetual, following the cursor across pages.
 * A single default page is not the whole market. Rows that are not Trading
 * USDT linear perpetuals (USDC contracts, dated futures, pre-launch) are
 * not tradeable here and are left out.
 */
export async function listBybitLinearInstruments(
  options: BybitRequestOptions = {}
): Promise<BybitInstrumentMetadata[]> {
  const now = options.nowMs ?? Date.now;
  const out: BybitInstrumentMetadata[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_INSTRUMENT_PAGES; page += 1) {
    const query = `category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const { result } = await bybitPublicGet<{ list?: unknown[]; nextPageCursor?: string }>(
      `/v5/market/instruments-info?${query}`,
      options
    );
    for (const row of Array.isArray(result.list) ? result.list : []) {
      const symbol = (row as { symbol?: unknown } | null)?.symbol;
      if (typeof symbol !== "string") continue;
      try {
        out.push(validateBybitMetadata(symbol, row, now()));
      } catch {
        // Not a tradeable USDT linear perpetual.
      }
    }
    cursor = result.nextPageCursor ?? "";
    if (!cursor) return out;
  }
  throw new Error(`Bybit instrument list exceeded ${MAX_INSTRUMENT_PAGES} pages`);
}

// ---------------------------------------------------------------------------
// Public linear ticker stream state. Pure: no socket, clock or store here, so
// the daemon and the tests share exactly the same merge rules.
// ---------------------------------------------------------------------------

/**
 * Latest known quote for one symbol in the current socket session. Each field
 * group keeps its own exchange event time: a funding update must never make a
 * quiet last price or bid/ask look fresh.
 */
export interface BybitTickerState {
  symbol: string;
  /** Newest exchange time applied to this state. */
  lastEventMs: number;
  receivedAtMs: number;
  lastPrice?: number;
  lastPriceEventMs?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  bidAskEventMs?: number;
  markPrice?: number;
  indexPrice?: number;
  markEventMs?: number;
  fundingRate?: number;
  nextFundingTimeMs?: number;
  openInterest?: number;
  sensorEventMs?: number;
}

const FIELD_GROUPS = {
  last: [["lastPrice", "lastPrice"]],
  bidAsk: [["bid1Price", "bid"], ["ask1Price", "ask"], ["bid1Size", "bidSize"], ["ask1Size", "askSize"]],
  mark: [["markPrice", "markPrice"], ["indexPrice", "indexPrice"]],
  sensor: [["fundingRate", "fundingRate"], ["nextFundingTime", "nextFundingTimeMs"], ["openInterest", "openInterest"]],
} as const;
const GROUP_TIME = { last: "lastPriceEventMs", bidAsk: "bidAskEventMs", mark: "markEventMs", sensor: "sensorEventMs" } as const;

function finiteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function applyTickerFields(state: BybitTickerState, data: Record<string, unknown>, eventMs: number) {
  const target = state as unknown as Record<string, number | undefined>;
  for (const group of Object.keys(FIELD_GROUPS) as Array<keyof typeof FIELD_GROUPS>) {
    let touched = false;
    for (const [wire, field] of FIELD_GROUPS[group]) {
      const value = finiteNumber(data[wire]);
      if (value === undefined) continue;
      // Prices and sizes must be positive; a funding rate may be negative.
      if (group !== "sensor" && value <= 0) continue;
      target[field] = value;
      touched = true;
    }
    if (touched) target[GROUP_TIME[group]] = eventMs;
  }
}

/**
 * Apply one public stream message. Returns the new state; the unchanged
 * `previous` for an out-of-order update; or null when the message is not a
 * usable quote (acks, pongs, malformed frames, or a delta with no snapshot in
 * this session to apply it to).
 */
export function mergeBybitTicker(
  previous: BybitTickerState | null,
  message: unknown,
  receivedAtMs: number
): BybitTickerState | null {
  if (!message || typeof message !== "object") return null;
  const frame = message as { topic?: unknown; type?: unknown; ts?: unknown; data?: unknown };
  if (typeof frame.topic !== "string") return null;

  if (frame.topic.startsWith("tickers.")) {
    const data = frame.data as Record<string, unknown> | undefined;
    const eventMs = finiteNumber(frame.ts);
    const symbol = frame.topic.slice("tickers.".length);
    if (!data || typeof data !== "object" || eventMs === undefined || !symbol) return null;
    if (frame.type === "snapshot") {
      const state: BybitTickerState = { symbol, lastEventMs: eventMs, receivedAtMs };
      applyTickerFields(state, data, eventMs);
      return state;
    }
    if (frame.type !== "delta" || !previous || previous.symbol !== symbol) return null;
    if (eventMs < previous.lastEventMs) return previous;
    const state: BybitTickerState = { ...previous, lastEventMs: eventMs, receivedAtMs };
    applyTickerFields(state, data, eventMs);
    return state;
  }

  if (frame.topic.startsWith("publicTrade.")) {
    const symbol = frame.topic.slice("publicTrade.".length);
    if (!previous || previous.symbol !== symbol || !Array.isArray(frame.data)) return null;
    const latest = frame.data
      .map((trade: { T?: unknown; p?: unknown }) => ({ at: finiteNumber(trade?.T), price: finiteNumber(trade?.p) }))
      .filter((trade): trade is { at: number; price: number } => trade.at !== undefined && trade.price !== undefined && trade.price > 0)
      .sort((a, b) => a.at - b.at)
      .pop();
    if (!latest) return null;
    if (latest.at < (previous.lastPriceEventMs ?? 0)) return previous;
    return {
      ...previous,
      lastPrice: latest.price,
      lastPriceEventMs: latest.at,
      lastEventMs: Math.max(previous.lastEventMs, latest.at),
      receivedAtMs,
    };
  }

  return null;
}

/** Per-session ticker state for every subscribed symbol. */
export class BybitTickerBook {
  private states = new Map<string, BybitTickerState>();

  /** The new state when the message changed one, otherwise null. */
  apply(message: unknown, receivedAtMs: number): BybitTickerState | null {
    const topic = (message as { topic?: unknown } | null)?.topic;
    if (typeof topic !== "string") return null;
    const symbol = topic.slice(topic.indexOf(".") + 1);
    const previous = this.states.get(symbol) ?? null;
    const next = mergeBybitTicker(previous, message, receivedAtMs);
    if (!next || next === previous) return null;
    this.states.set(symbol, next);
    return next;
  }

  get(symbol: string): BybitTickerState | null {
    return this.states.get(symbol) ?? null;
  }

  /** A new connection has no state until its own snapshots arrive. */
  reset(): void {
    this.states.clear();
  }
}

// ---------------------------------------------------------------------------
// Funding settlement history. Each settlement carries the mark price at its
// boundary, taken from the one-minute mark-price bar that opens there; when
// that bar is unavailable the mark is NaN and the boundary stays pending.
// ---------------------------------------------------------------------------

export async function fetchFundingSettlements(
  symbol: string,
  fromMs: number,
  toMs: number,
  options: BybitRequestOptions = {}
): Promise<FundingSettlement[]> {
  const encoded = encodeURIComponent(symbol);
  const { result } = await bybitPublicGet<{ list?: Array<{ fundingRate?: string; fundingRateTimestamp?: string }> }>(
    `/v5/market/funding/history?category=linear&symbol=${encoded}&startTime=${Math.floor(fromMs) + 1}&endTime=${Math.floor(toMs)}&limit=200`,
    options
  );
  const rows = (result.list ?? [])
    .map((row) => ({ at: Number(row.fundingRateTimestamp), rate: Number(row.fundingRate) }))
    .filter((row) => Number.isFinite(row.at) && row.at > fromMs && row.at <= toMs && Number.isFinite(row.rate));
  const settlements: FundingSettlement[] = [];
  for (const row of rows) {
    let markPrice = Number.NaN;
    try {
      const { result: bars } = await bybitPublicGet<{ list?: unknown[][] }>(
        `/v5/market/mark-price-kline?category=linear&symbol=${encoded}&interval=1&start=${row.at}&end=${row.at + 59_999}&limit=1`,
        options
      );
      const bar = (bars.list ?? []).find((entry) => Number(entry?.[0]) === row.at);
      markPrice = Number(bar?.[1]);
    } catch {
      // Left as NaN: the boundary stays pending rather than priced at a guess.
    }
    settlements.push({ symbol, settlementTimeMs: row.at, rate: row.rate, markPrice });
  }
  return settlements;
}

/** Live funding inputs: published settlements and each symbol's current interval. */
export const liveFundingDeps: FundingDeps = {
  nowMs: () => Date.now(),
  settlements: (symbol, fromMs, toMs) => fetchFundingSettlements(symbol, fromMs, toMs),
  intervalMinutes: async (symbol) => {
    // Funding is risk-reducing bookkeeping, so the last validated interval is
    // acceptable when a refresh fails; it never admits a new entry.
    const metadata = await getBybitInstrumentMetadata(symbol).catch(() => lastValidBybitMetadata(symbol));
    if (!metadata) throw new Error(`${symbol}: funding interval unknown`);
    return metadata.fundingIntervalMinutes;
  },
};
