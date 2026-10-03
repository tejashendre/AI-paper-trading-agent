import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchBackfill, readBackfill, writeBackfill } from "@/lib/research/backfill";

const H = 3_600_000, D = 86_400_000;
const NOW = Date.parse("2026-10-03T12:30:00Z");

function fakeBybit() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const end = Number(url.searchParams.get("end") ?? url.searchParams.get("endTime"));
    let list: unknown[] = [];
    if (url.pathname.endsWith("/kline")) {
      const step = url.searchParams.get("interval") === "D" ? D : H;
      // Two full pages for hourly, then a short one; newest first like Bybit.
      const count = step === H && end === NOW ? 1000 : step === H ? 5 : 3;
      const top = Math.floor(end / step) * step;
      list = Array.from({ length: count }, (_, i) => [String(top - i * step), "1", "2", "0.5", "1.5", "10"]);
    } else if (url.pathname.endsWith("/funding/history")) {
      list = [{ fundingRate: "0.0001", fundingRateTimestamp: String(NOW - 8 * H) }];
    } else if (url.pathname.endsWith("/account-ratio")) {
      list = [{ buyRatio: "0.6", timestamp: String(NOW - D) }, { buyRatio: "0.6", timestamp: String(NOW - D) }];
    }
    return new Response(JSON.stringify({ retCode: 0, result: { list }, time: NOW }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("research backfill pages history, keeps closed bars and stays inside the archive cap", async () => {
  const { calls, fetchImpl } = fakeBybit();
  const series = await fetchBackfill("BTCUSDT", NOW - 400 * D, NOW, { fetchImpl });
  assert.ok(calls.filter((c) => c.includes("interval=60")).length >= 2, "hourly history is paged");
  assert.ok(series.candles1h.every((bar) => bar[0] + H <= NOW), "the forming hour is excluded");
  assert.ok(series.candles1d.every((bar) => bar[0] + D <= NOW), "the forming day is excluded");
  assert.ok(series.candles1h.every((bar, i) => i === 0 || bar[0] > series.candles1h[i - 1][0]), "oldest first, no duplicates");
  assert.equal(series.accountRatio1d.length, 1, "duplicates removed");

  const archive = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-"));
  try {
    assert.equal(writeBackfill(archive, series, 10).status, "STORAGE_LIMIT");
    assert.equal(readBackfill(archive, "BTCUSDT"), null);
    assert.equal(writeBackfill(archive, series, 10_000_000).status, "WRITTEN");
    assert.deepEqual(readBackfill(archive, "BTCUSDT"), series);
  } finally { fs.rmSync(archive, { recursive: true, force: true }); }
});
