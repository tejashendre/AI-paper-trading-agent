import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSessionBreakout, SESSION_OPENS, sessionOpenUtcMs } from "@/lib/strategy/sessionOpen";
import { strategyFamilyConfigHash } from "@/lib/swingEngine";
import type { Candle } from "@/lib/types";

const Q = 15 * 60_000;
const bar = (startMs: number, low: number, high: number, close: number): Candle => ({ time: startMs / 1000, open: (low + high) / 2, high, low, close, volume: 1 });

// Tuesday 2026-10-06: New York is on daylight time, so the NYMEX 09:00 open is 13:00 UTC.
const OPEN = Date.parse("2026-10-06T13:00:00Z");
const range = [0, 1, 2, 3].map((i) => bar(OPEN + i * Q, 70, 71, 70.5));

test("session-open breakout research family", async (t) => {
  await t.test("opens follow each exchange's own clock, including daylight saving", () => {
    assert.equal(new Date(sessionOpenUtcMs(OPEN, SESSION_OPENS.OIL)).toISOString(), "2026-10-06T13:00:00.000Z");
    assert.equal(new Date(sessionOpenUtcMs(OPEN, SESSION_OPENS.EURUSD)).toISOString(), "2026-10-06T07:00:00.000Z");
    const winter = Date.parse("2026-12-08T12:00:00Z");
    assert.equal(new Date(sessionOpenUtcMs(winter, SESSION_OPENS.EURUSD)).toISOString(), "2026-12-08T08:00:00.000Z");
    assert.equal(new Date(sessionOpenUtcMs(winter, SESSION_OPENS.GOLD)).toISOString(), "2026-12-08T13:20:00.000Z");
  });

  await t.test("the first close outside the opening hour's range is a breakout", () => {
    const bars = [...range, bar(OPEN + 4 * Q, 70.4, 70.9, 70.6), bar(OPEN + 5 * Q, 70.9, 71.4, 71.3)];
    const signal = evaluateSessionBreakout("OIL", bars, OPEN + 6 * Q);
    assert.ok(signal);
    assert.equal(signal.direction, "LONG");
    assert.equal(signal.stop, 70.5, "stop at the range midpoint");
    assert.ok(Math.abs(signal.target - 73.3) < 1e-9, "target two range heights beyond the entry");
  });

  await t.test("a later breakout, a forming bar, crypto, weekends and the end of the window give nothing", () => {
    const first = [...range, bar(OPEN + 4 * Q, 69.5, 70.2, 69.8)];
    assert.equal(evaluateSessionBreakout("OIL", first, OPEN + 5 * Q)?.direction, "SHORT");
    assert.equal(evaluateSessionBreakout("OIL", [...first, bar(OPEN + 5 * Q, 69, 69.6, 69.2)], OPEN + 6 * Q), null);
    assert.equal(evaluateSessionBreakout("OIL", first, OPEN + 5 * Q - 1), null, "the bar is still forming");
    assert.equal(evaluateSessionBreakout("BTC", first, OPEN + 5 * Q), null);
    const saturday = Date.parse("2026-10-10T13:00:00Z");
    const weekend = [0, 1, 2, 3].map((i) => bar(saturday + i * Q, 70, 71, 70.5));
    assert.equal(evaluateSessionBreakout("OIL", [...weekend, bar(saturday + 4 * Q, 71, 72, 71.8)], saturday + 5 * Q), null);
    const late = [...range, ...Array.from({ length: 12 }, (_, i) => bar(OPEN + (4 + i) * Q, 70.2, 70.8, 70.5)), bar(OPEN + 16 * Q, 71, 72, 71.8)];
    assert.equal(evaluateSessionBreakout("OIL", late, OPEN + 17 * Q), null, "more than three hours after the range");
  });

  await t.test("the new family has its own config hash and the old ones are unchanged", () => {
    assert.equal(strategyFamilyConfigHash("TREND_PULLBACK", "BTC"), "9c09834af2750d27cc4f035543e228f07dd59207dec3629e6d45606a290acaa0");
    assert.equal(strategyFamilyConfigHash("RANGE_REVERSION", "OIL"), "e68a3854c2a979db55268b30a7b37ba21133a0a1b0750f3f974d315ab3f9c545");
    assert.notEqual(strategyFamilyConfigHash("SESSION_BREAKOUT", "OIL"), strategyFamilyConfigHash("SESSION_BREAKOUT", "GOLD"));
  });
});
