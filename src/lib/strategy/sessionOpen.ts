import type { Candle } from "@/lib/types";

/**
 * Session-open breakout, research family SESSION_BREAKOUT (SHADOW). The
 * TradFi perpetuals trade around the clock, but volume and volatility
 * concentrate when the underlying market opens. Opening range: the first hour
 * of 15m bars from the open (floored to a 15m boundary). Signal: the first
 * closed 15m bar within three hours after that hour that closes outside the
 * range. Stop at the range midpoint; target two range heights beyond the entry.
 */
export interface SessionOpen {
  timeZone: string;
  hour: number;
  minute: number;
  label: string;
}

export const SESSION_OPENS: Record<string, SessionOpen> = {
  EURUSD: { timeZone: "Europe/London", hour: 8, minute: 0, label: "London open" },
  GBPUSD: { timeZone: "Europe/London", hour: 8, minute: 0, label: "London open" },
  USDJPY: { timeZone: "Europe/London", hour: 8, minute: 0, label: "London open" },
  GOLD: { timeZone: "America/New_York", hour: 8, minute: 20, label: "COMEX gold open" },
  SILVER: { timeZone: "America/New_York", hour: 8, minute: 25, label: "COMEX silver open" },
  OIL: { timeZone: "America/New_York", hour: 9, minute: 0, label: "NYMEX crude open" },
};

export const OPENING_RANGE_MS = 60 * 60_000;
export const BREAKOUT_WINDOW_MS = 3 * 60 * 60_000;
export const BREAKOUT_TARGET_RANGES = 2;
const BAR_MS = 15 * 60_000;

function zonedParts(utcMs: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  }).formatToParts(utcMs).map((part) => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second, weekday: parts.weekday };
}

/** UTC time of a local wall-clock time on the local date that contains utcMs. */
export function sessionOpenUtcMs(utcMs: number, open: SessionOpen): number {
  const local = zonedParts(utcMs, open.timeZone);
  const wall = Date.UTC(local.year, local.month - 1, local.day, open.hour, open.minute);
  const offset = (ms: number) => {
    const p = zonedParts(ms, open.timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  const guess = wall - offset(wall);
  return wall - offset(guess);
}

export interface SessionBreakout {
  direction: "LONG" | "SHORT";
  stop: number;
  target: number;
  rangeHigh: number;
  rangeLow: number;
  reason: string;
}

/** Closed 15m bars only (bar.time in seconds). */
export function evaluateSessionBreakout(asset: string, closed15m: Candle[], nowMs: number): SessionBreakout | null {
  const open = SESSION_OPENS[asset];
  if (!open) return null;
  if (["Sat", "Sun"].includes(zonedParts(nowMs, open.timeZone).weekday)) return null;
  const rangeStart = Math.floor(sessionOpenUtcMs(nowMs, open) / BAR_MS) * BAR_MS;
  const rangeEnd = rangeStart + OPENING_RANGE_MS;
  const bars = closed15m.filter((bar) => bar.time * 1000 + BAR_MS <= nowMs);
  const range = bars.filter((bar) => bar.time * 1000 >= rangeStart && bar.time * 1000 < rangeEnd);
  const latest = bars.at(-1);
  if (range.length !== OPENING_RANGE_MS / BAR_MS || !latest) return null;
  const latestMs = latest.time * 1000;
  if (latestMs < rangeEnd || latestMs + BAR_MS > rangeEnd + BREAKOUT_WINDOW_MS) return null;
  const high = Math.max(...range.map((bar) => bar.high));
  const low = Math.min(...range.map((bar) => bar.low));
  if (!(high > low)) return null;
  const outside = (bar: Candle) => bar.close > high || bar.close < low;
  // Only the first breakout of the session counts.
  if (bars.some((bar) => bar.time * 1000 >= rangeEnd && bar.time < latest.time && outside(bar))) return null;
  if (!outside(latest)) return null;
  const direction = latest.close > high ? "LONG" : "SHORT";
  const sign = direction === "LONG" ? 1 : -1;
  return {
    direction, rangeHigh: high, rangeLow: low,
    stop: (high + low) / 2,
    target: latest.close + sign * BREAKOUT_TARGET_RANGES * (high - low),
    reason: `${open.label} opening range ${low}-${high} broken ${direction === "LONG" ? "upward" : "downward"} by a closed 15m bar`,
  };
}
