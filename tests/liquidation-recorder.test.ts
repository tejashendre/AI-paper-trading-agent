import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLiquidationMinutes, LiquidationMinutes, readLiquidationMinutes } from "@/lib/data/liquidationRecorder";

const T0 = Date.parse("2026-10-03T12:00:00Z");
const message = (rows: Array<Record<string, unknown>>) => ({ topic: "allLiquidation.BTCUSDT", type: "snapshot", ts: T0, data: rows });

test("liquidations are recorded as per-minute totals inside the research archive", async (t) => {
  await t.test("rows aggregate per symbol and minute, split by liquidated side", () => {
    const minutes = new LiquidationMinutes();
    assert.equal(minutes.add({ topic: "tickers.BTCUSDT", data: {} }), false);
    minutes.add(message([
      { T: T0 + 1_000, s: "BTCUSDT", S: "Buy", v: "0.5", p: "60000" },
      { T: T0 + 2_000, s: "BTCUSDT", S: "Sell", v: "0.1", p: "60000" },
      { T: T0 + 61_000, s: "BTCUSDT", S: "Buy", v: "1", p: "60000" },
      { T: T0 + 3_000, s: "BTCUSDT", S: "Buy", v: "bad", p: "60000" },
    ]));
    assert.deepEqual(minutes.drainClosed(T0 + 60_000), [
      { symbol: "BTCUSDT", minuteStartMs: T0, count: 2, longLiquidatedUsdt: 30_000, shortLiquidatedUsdt: 6_000 },
    ]);
    assert.equal(minutes.drainClosed(T0 + 60_000).length, 0, "a drained minute is not returned twice");
    assert.equal(minutes.drainClosed(T0 + 120_000)[0].longLiquidatedUsdt, 60_000);
  });

  await t.test("minutes are written per day, read back, and kept under the archive cap", () => {
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), "liq-"));
    const day1 = { symbol: "XAUUSDT", minuteStartMs: Date.parse("2026-10-01T00:00:00Z"), count: 1, longLiquidatedUsdt: 5, shortLiquidatedUsdt: 0 };
    const day2 = { ...day1, minuteStartMs: Date.parse("2026-10-02T00:00:00Z") };
    assert.equal(appendLiquidationMinutes({ archiveDirectory: archive, minutes: [day1], maxBytes: 1_000_000 }).status, "CAPTURED");
    assert.equal(appendLiquidationMinutes({ archiveDirectory: archive, minutes: [day2], maxBytes: 1_000_000 }).written, 1);
    assert.deepEqual(readLiquidationMinutes(archive), [day1, day2]);
    // A cap that only fits one day rotates the oldest day out.
    const oneDay = fs.statSync(path.join(archive, "liquidations", "2026-10-01.ndjson.gz")).size;
    const day3 = { ...day1, minuteStartMs: Date.parse("2026-10-03T00:00:00Z") };
    const result = appendLiquidationMinutes({ archiveDirectory: archive, minutes: [day3], maxBytes: oneDay * 2 + 5 });
    assert.equal(result.status, "CAPTURED");
    assert.deepEqual(result.rotatedOut, ["2026-10-01.ndjson.gz"]);
    assert.deepEqual(readLiquidationMinutes(archive).map((m) => m.minuteStartMs), [day2.minuteStartMs, day3.minuteStartMs]);
    fs.rmSync(archive, { recursive: true, force: true });
  });
});
