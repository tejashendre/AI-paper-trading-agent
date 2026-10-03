/**
 * The signal is a pure function of its inputs, so replay and live agree.
 * Data quality used the wall clock, so every historical replay saw its bars
 * as stale and the non-crypto assets could never trade in replay.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreDataQuality } from "@/lib/swingEngine";
import type { Candle } from "@/lib/types";

const bars = (endSec: number, intervalSec: number, n = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: endSec - (n - i) * intervalSec, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));

test("data quality judges bar age at the evaluation time, not the wall clock", () => {
  const evaluatedAtMs = Date.UTC(2024, 7, 30, 12, 0, 0);
  const end = evaluatedAtMs / 1000;
  const fresh = scoreDataQuality("SLOW_SWING", 100, 100, bars(end, 900), bars(end, 3600), bars(end, 14400), evaluatedAtMs);
  assert.equal(fresh, 72, "two-year-old historical bars are fresh at their own evaluation time");
  const stale = scoreDataQuality("SLOW_SWING", 100, 100, bars(end - 86400, 900), bars(end, 3600), bars(end, 14400), evaluatedAtMs);
  assert.equal(stale, 52, "bars a day behind the evaluation time are still stale");
});
