/**
 * A scale-in must stand on its own: the added quantity needs its own room to
 * the target. On 22 Sept a BTC add filled at 85,125, above that position's
 * 85,082 target, and closed at the target the same minute.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scaleInRoom } from "@/lib/execution/exitPolicy";

test("an add needs its own reward to target of at least 1.35x its risk to the stop", () => {
  // Long, stop 100, target 130: an add at 110 risks 10 for 20 (2.0x).
  assert.equal(scaleInRoom({ direction: "LONG", fillPrice: 110, stopLoss: 100, takeProfit: 130 }).allowed, true);
  // At 120 it risks 20 for 10 (0.5x).
  assert.equal(scaleInRoom({ direction: "LONG", fillPrice: 120, stopLoss: 100, takeProfit: 130 }).allowed, false);
  // Beyond the target there is no reward at all (the 22 Sept case).
  const beyond = scaleInRoom({ direction: "LONG", fillPrice: 85_125, stopLoss: 84_000, takeProfit: 85_082 });
  assert.equal(beyond.allowed, false);
  assert.match(beyond.reason, /target/i);
  // Shorts mirror it.
  assert.equal(scaleInRoom({ direction: "SHORT", fillPrice: 90, stopLoss: 100, takeProfit: 70 }).allowed, true);
  assert.equal(scaleInRoom({ direction: "SHORT", fillPrice: 69, stopLoss: 100, takeProfit: 70 }).allowed, false);
  // A stop already beyond the fill would make the add's risk meaningless.
  assert.equal(scaleInRoom({ direction: "LONG", fillPrice: 99, stopLoss: 100, takeProfit: 130 }).allowed, false);
});
