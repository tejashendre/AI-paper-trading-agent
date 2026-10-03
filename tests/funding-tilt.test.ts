import test from "node:test";
import assert from "node:assert/strict";
import { PROJECTED_HOLD_HOURS, projectedFundingCostUsdt } from "@/lib/trading/executionCostModel";

const base = { notionalUsd: 10_000, fundingIntervalMinutes: 480 };
const settlements = PROJECTED_HOLD_HOURS / 8;

test("projected funding is sign-aware and covers a multi-day hold", async (t) => {
  await t.test("the paying side is charged its full rate over the hold", () => {
    // Gold longs paid about 16% a year: roughly 0.015% per 8h settlement.
    const cost = projectedFundingCostUsdt({ ...base, direction: "LONG", fundingRate: 0.00015 });
    assert.ok(Math.abs(cost - 10_000 * 0.00015 * settlements) < 1e-9);
  });

  await t.test("the receiving side is never credited; it pays only the conservative floor", () => {
    // Oil longs received about 33% a year: a negative rate pays longs.
    const cost = projectedFundingCostUsdt({ ...base, direction: "LONG", fundingRate: -0.0003 });
    assert.ok(Math.abs(cost - 10_000 * 0.0001 * settlements) < 1e-9);
    const short = projectedFundingCostUsdt({ ...base, direction: "SHORT", fundingRate: -0.0003 });
    assert.ok(Math.abs(short - 10_000 * 0.0003 * settlements) < 1e-9, "shorts pay a negative rate");
  });

  await t.test("a missing rate falls back to the floor and shorter intervals settle more often", () => {
    assert.ok(Math.abs(projectedFundingCostUsdt({ ...base, direction: "SHORT" }) - 10_000 * 0.0001 * settlements) < 1e-9);
    const hourly = projectedFundingCostUsdt({ notionalUsd: 10_000, fundingIntervalMinutes: 60, direction: "LONG", fundingRate: 0.0002 });
    assert.ok(Math.abs(hourly - 10_000 * 0.0002 * PROJECTED_HOLD_HOURS) < 1e-9);
  });
});
