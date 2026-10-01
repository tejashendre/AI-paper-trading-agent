import { z } from "zod";
import {
  BybitInstrumentMetadata,
  isMetadataUsable,
  validateBybitMetadata,
} from "@/lib/trading/instrumentRegistry";

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
