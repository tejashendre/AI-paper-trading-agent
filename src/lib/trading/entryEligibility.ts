import type { MarketPriceSnapshot } from "@/lib/market";
import {
  BybitInstrumentMetadata,
  getConfiguredInstrument,
  InstrumentRef,
  isMetadataUsable,
} from "@/lib/trading/instrumentRegistry";

/**
 * One data-eligibility decision for a new entry, shared by the daemon, trade
 * admission and the health API. It answers only "is this instrument's data
 * fit to act on"; cost, risk and strategy are separate facets and are never
 * folded into `allowed` here.
 *
 * Every reason is "CODE: explanation", so callers can match the code and show
 * the text.
 */

export const QUOTE_MAX_AGE_MS = 10_000;
export const QUOTE_FUTURE_TOLERANCE_MS = 2_000;
/** A REST quote received this long after its server time has an unknown clock offset. */
export const REST_CLOCK_UNCERTAINTY_MS = 2_000;
/** Completed 15m, 1h and 4h bars each signal timeframe needs before an entry. */
export const REQUIRED_CLOSED_BARS = 100;
/** The weekly bias is an EMA of eight closed weeks; with fewer it contributes nothing. */
export const WEEKLY_FEATURE_MIN_BARS = 8;

const VENUE = "BYBIT_LINEAR";
const PROVIDER_FOR_TRANSPORT: Record<MarketPriceSnapshot["transport"], string> = {
  WS: "BYBIT_LINEAR_WS",
  REST: "BYBIT_LINEAR_HTTP",
};

export type EntryEligibilityState = "READY" | "BLOCKED_DATA" | "WARMING_UP" | "BLOCKED_LIQUIDITY";

export interface EntryEligibility {
  allowed: boolean;
  state: EntryEligibilityState;
  reasons: string[];
  instrumentVersion: string;
}

export interface ClosedBarCounts {
  m15: number;
  h1: number;
  h4: number;
  w1: number;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function ageProblem(field: string, code: string, atMs: number | null | undefined, nowMs: number): string | null {
  if (atMs === null || atMs === undefined || !Number.isFinite(atMs)) return null;
  const age = nowMs - atMs;
  if (age > QUOTE_MAX_AGE_MS) return `${code}: ${field} is ${seconds(age)} old (limit ${seconds(QUOTE_MAX_AGE_MS)})`;
  if (age < -QUOTE_FUTURE_TOLERANCE_MS) return `FUTURE_QUOTE: ${field} is ${seconds(-age)} ahead of the local clock`;
  return null;
}

/**
 * Whether a quote really is this instrument's current price. Shared by entries
 * and exits; it never looks at warm-up, metadata age or learning state.
 */
function quoteProblems(instrument: InstrumentRef, quote: MarketPriceSnapshot | null, nowMs: number): string[] {
  if (!quote) return ["QUOTE_MISSING: no current quote for this instrument"];
  const problems: string[] = [];
  if (quote.venue !== VENUE) problems.push(`WRONG_VENUE: quote came from ${quote.venue}, not ${VENUE}`);
  if (quote.provider !== PROVIDER_FOR_TRANSPORT[quote.transport]) {
    problems.push(`WRONG_PROVIDER: ${quote.provider} is not a Bybit ${quote.transport ?? "unknown"} quote`);
  }
  if (quote.instrument !== instrument.symbol) problems.push(`WRONG_SYMBOL: quote is for ${quote.instrument}, expected ${instrument.symbol}`);
  if (quote.instrumentVersion !== instrument.instrumentVersion) {
    problems.push(`WRONG_INSTRUMENT_VERSION: quote is ${quote.instrumentVersion}, expected ${instrument.instrumentVersion}`);
  }
  if (!Number.isFinite(quote.price) || quote.price <= 0) problems.push(`INVALID_PRICE: last price ${quote.price} is not a positive number`);

  const lastPriceMs = quote.quoteTimes?.lastPriceMs;
  if (lastPriceMs === undefined || lastPriceMs === null || !Number.isFinite(lastPriceMs)) {
    problems.push("MISSING_QUOTE_TIME: the last price has no exchange timestamp");
  } else {
    const age = ageProblem("last price", "STALE_QUOTE", lastPriceMs, nowMs);
    if (age) problems.push(age);
  }
  if (quote.transport === "REST") {
    const offset = quote.receivedAtMs - quote.eventTimeMs;
    if (!Number.isFinite(offset) || Math.abs(offset) > REST_CLOCK_UNCERTAINTY_MS) {
      problems.push(`CLOCK_UNCERTAIN: REST quote received ${seconds(offset)} from its server time`);
    }
  }
  return problems;
}

/** Risk-reducing exits need a true, current price for the instrument, and nothing more. */
export function validateExitQuote(input: {
  instrument: InstrumentRef;
  quote: MarketPriceSnapshot | null;
  nowMs: number;
}): { valid: boolean; reasons: string[] } {
  const reasons = quoteProblems(input.instrument, input.quote, input.nowMs);
  return { valid: reasons.length === 0, reasons };
}

export function evaluateEntryEligibility(input: {
  instrument: InstrumentRef;
  metadata: BybitInstrumentMetadata | null;
  quote: MarketPriceSnapshot | null;
  closedBarCounts: ClosedBarCounts;
  nowMs: number;
  fastExecution: boolean;
  depthAvailable: boolean;
}): EntryEligibility {
  const { instrument, metadata, quote, nowMs } = input;
  const blockedData: string[] = [];
  const blockedLiquidity: string[] = [];
  const warming: string[] = [];
  const notes: string[] = [];

  let expected: InstrumentRef | null = null;
  try {
    expected = getConfiguredInstrument(instrument.asset);
  } catch {
    blockedData.push(`WRONG_INSTRUMENT: ${instrument.asset} is not a configured asset`);
  }
  if (expected && (instrument.venue !== "BYBIT" || instrument.instrumentVersion !== expected.instrumentVersion)) {
    blockedData.push(`WRONG_INSTRUMENT: ${instrument.instrumentVersion} is not the configured ${expected.instrumentVersion}`);
  }

  if (!metadata || metadata.symbol !== instrument.symbol || !isMetadataUsable(metadata, nowMs)) {
    blockedData.push(metadata
      ? `METADATA_UNUSABLE: ${metadata.symbol} metadata verified ${seconds(nowMs - metadata.verifiedAtMs)} ago is not usable for ${instrument.symbol}`
      : "METADATA_UNUSABLE: no validated instrument metadata");
  }

  blockedData.push(...quoteProblems(instrument, quote, nowMs));
  if (quote) {
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    if (!(Number.isFinite(bid) && Number.isFinite(ask)) || quote.quoteTimes?.bidAskMs === null || quote.quoteTimes?.bidAskMs === undefined) {
      blockedData.push("MISSING_BID_ASK: no executable bid and ask");
    } else if (bid <= 0 || ask <= 0 || bid >= ask) {
      blockedData.push(`CROSSED_BOOK: bid ${bid} is not below ask ${ask}`);
    } else {
      const age = ageProblem("bid/ask", "STALE_BID_ASK", quote.quoteTimes.bidAskMs, nowMs);
      if (age) blockedData.push(age);
    }
    if (input.fastExecution && quote.transport !== "WS") {
      blockedData.push("FAST_REQUIRES_STREAM_QUOTE: a fast entry needs a fresh Bybit stream quote, not REST");
    }
  }
  if (input.fastExecution && !input.depthAvailable) {
    blockedLiquidity.push("DEPTH_UNAVAILABLE: a fast entry needs observed order book depth");
  }

  for (const key of ["m15", "h1", "h4"] as const) {
    const count = input.closedBarCounts[key];
    if (!(count >= REQUIRED_CLOSED_BARS)) {
      warming.push(`WARMING_UP_${key.toUpperCase()}: ${count} of ${REQUIRED_CLOSED_BARS} completed ${key} bars`);
    }
  }
  if (!(input.closedBarCounts.w1 >= WEEKLY_FEATURE_MIN_BARS)) {
    notes.push(`WEEKLY_FEATURE_UNAVAILABLE: ${input.closedBarCounts.w1} of ${WEEKLY_FEATURE_MIN_BARS} completed weeks; the weekly bias contributes nothing`);
  }

  const state: EntryEligibilityState = blockedData.length > 0
    ? "BLOCKED_DATA"
    : blockedLiquidity.length > 0
      ? "BLOCKED_LIQUIDITY"
      : warming.length > 0
        ? "WARMING_UP"
        : "READY";
  return {
    allowed: state === "READY",
    state,
    reasons: [...blockedData, ...blockedLiquidity, ...warming, ...notes],
    instrumentVersion: instrument.instrumentVersion,
  };
}
