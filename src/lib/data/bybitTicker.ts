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

