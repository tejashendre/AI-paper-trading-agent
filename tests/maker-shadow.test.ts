import test from "node:test";
import assert from "node:assert/strict";
import { compareMakerEntry, loadMakerShadowSummary, recordMakerComparison, summarizeMakerShadow } from "@/lib/research/makerShadow";
import { setRedisClient } from "@/lib/redis";
import { MemoryRedis } from "./helpers/memoryRedis";
import type { Candle } from "@/lib/types";

const T0 = Date.parse("2026-10-06T12:00:00Z");
const Q = 15 * 60_000;
const bar = (i: number, low: number, high: number, close: number): Candle => ({ time: (T0 + i * Q) / 1000, open: (low + high) / 2, high, low, close, volume: 1 });
const base = { direction: "LONG" as const, entryPrice: 100, stopLoss: 98, takeProfit: 104, barIntervalMs: Q, startMs: T0,
  tickSize: 0.01, makerFeeRate: 0.0002, takerFeeRate: 0.00055, halfSpreadBps: 1 };

test("maker entries fill only on a trade-through and misses are recorded", async (t) => {
  await t.test("a trade-through inside the window fills at the limit and saves the taker costs", () => {
    const bars = [bar(0, 99.9, 100.5, 100.3), bar(1, 100.2, 104.2, 104)];
    const result = compareMakerEntry({ ...base, bars })!;
    assert.equal(result.makerFilled, true);
    assert.ok(result.makerNetR > result.takerNetR, "same path, lower entry costs");
    assert.ok(result.makerNetR < 2, "fees are still charged");
  });

  await t.test("touching the limit without trading through is not a fill", () => {
    const bars = [bar(0, 100, 100.5, 100.3), bar(1, 100.2, 104.2, 104)];
    const result = compareMakerEntry({ ...base, bars })!;
    assert.equal(result.makerFilled, false);
    assert.equal(result.makerNetR, 0, "a missed winner is a skipped trade");
    assert.ok(result.takerNetR > 1.9);
  });

  await t.test("a trade-through after the 30-minute window is a miss", () => {
    const bars = [bar(0, 100.1, 100.5, 100.3), bar(1, 100.1, 100.6, 100.4), bar(2, 99.5, 100.2, 99.8)];
    assert.equal(compareMakerEntry({ ...base, bars })!.makerFilled, false);
  });

  await t.test("shorts mirror the rule; a stop in the fill bar counts against the maker", () => {
    const short = { ...base, direction: "SHORT" as const, stopLoss: 102, takeProfit: 96 };
    const bars = [bar(0, 99.8, 102.5, 101)];
    const result = compareMakerEntry({ ...short, bars })!;
    assert.equal(result.makerFilled, true);
    assert.ok(result.makerNetR < -1, "stopped out in the fill bar");
  });

  await t.test("summary reports fill rate and mean R for both styles", async () => {
    assert.deepEqual(summarizeMakerShadow([]), { comparisons: 0, makerFillRate: null, makerMeanNetR: null, takerMeanNetR: null });
    setRedisClient(new MemoryRedis());
    try {
      await recordMakerComparison({ candidateId: "a", asset: "BTC", evaluatedAt: "x", makerFilled: true, makerNetR: 1, takerNetR: 1 });
      await recordMakerComparison({ candidateId: "b", asset: "BTC", evaluatedAt: "x", makerFilled: false, makerNetR: 0, takerNetR: -1.5 });
      assert.deepEqual(await loadMakerShadowSummary(), { comparisons: 2, makerFillRate: 0.5, makerMeanNetR: 0.5, takerMeanNetR: -0.25 });
    } finally { setRedisClient(null); }
  });
});
