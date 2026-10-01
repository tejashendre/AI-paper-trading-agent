import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BYBIT_ATTEMPT_TIMEOUT_MS,
  BYBIT_TOTAL_BUDGET_MS,
  bybitPublicGet,
  createBybitMetadataCache,
  listBybitLinearInstruments,
} from "@/lib/data/bybitPublic";

const evidence = JSON.parse(
  readFileSync(path.join(__dirname, "..", "docs", "BYBIT_ALL_ASSETS_MARKET_EVIDENCE_2026-10-01.json"), "utf8")
);
const NOW = evidence.assets[0].instrument.serverTime as number;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ok(result: unknown, time = NOW): Response {
  return response(200, { retCode: 0, retMsg: "OK", result, time });
}

/** Fake clock: sleeps advance time instantly and are recorded. */
function fakeClock(start = NOW) {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    nowMs: () => now,
    advance: (ms: number) => { now += ms; },
    sleepImpl: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("aborted");
      sleeps.push(ms);
      now += ms;
    },
  };
}

test("public_client_retries_boundedly_and_rejects_bad_payloads", async (t) => {
  await t.test("429 then success within three attempts", async () => {
    const clock = fakeClock();
    const replies = [response(429, {}), ok({ list: [] }, NOW + 5)];
    let calls = 0;
    const out = await bybitPublicGet<{ list: unknown[] }>("/v5/market/time", {
      fetchImpl: (async () => { calls += 1; return replies.shift()!; }) as typeof fetch,
      nowMs: clock.nowMs,
      sleepImpl: clock.sleepImpl,
    });
    assert.equal(calls, 2);
    assert.deepEqual(out.result, { list: [] });
    assert.equal(out.serverTimeMs, NOW + 5);
    assert.equal(clock.sleeps.length, 1);
    assert.ok(clock.sleeps[0] >= 250 && clock.sleeps[0] <= 2_000, `backoff ${clock.sleeps[0]}`);
  });

  await t.test("persistent 5xx stops after three attempts", async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      bybitPublicGet("/v5/market/time", {
        fetchImpl: (async () => { calls += 1; return response(503, {}); }) as typeof fetch,
        nowMs: clock.nowMs,
        sleepImpl: clock.sleepImpl,
      }),
      /503/
    );
    assert.equal(calls, 3);
    for (const ms of clock.sleeps) assert.ok(ms >= 250 && ms <= 2_000);
  });

  await t.test("403 is permanent", async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      bybitPublicGet("/v5/market/time", {
        fetchImpl: (async () => { calls += 1; return response(403, {}); }) as typeof fetch,
        nowMs: clock.nowMs,
        sleepImpl: clock.sleepImpl,
      }),
      /403/
    );
    assert.equal(calls, 1);
  });

  await t.test("nonzero retCode rejects", async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      bybitPublicGet("/v5/market/time", {
        fetchImpl: (async () => {
          calls += 1;
          return response(200, { retCode: 10001, retMsg: "params error", result: {}, time: NOW });
        }) as typeof fetch,
        nowMs: clock.nowMs,
        sleepImpl: clock.sleepImpl,
      }),
      /10001/
    );
    assert.equal(calls, 1);
  });

  await t.test("malformed payload rejects", async () => {
    const clock = fakeClock();
    for (const body of [{ retCode: 0, retMsg: "OK" }, { retCode: 0, result: {}, time: "soon" }, "nope"]) {
      await assert.rejects(
        bybitPublicGet("/v5/market/time", {
          fetchImpl: (async () => response(200, body)) as typeof fetch,
          nowMs: clock.nowMs,
          sleepImpl: clock.sleepImpl,
        }),
        /payload/
      );
    }
  });

  await t.test("paths outside the public market API are refused", async () => {
    for (const bad of ["https://evil.example/v5/market/time", "/v5/order/create", "//x/v5/market/time"]) {
      await assert.rejects(
        bybitPublicGet(bad, { fetchImpl: (async () => ok({})) as typeof fetch }),
        /public market path/
      );
    }
  });

  await t.test("default per-attempt timeout is 8s and the total budget is 30s", () => {
    assert.equal(BYBIT_ATTEMPT_TIMEOUT_MS, 8_000);
    assert.equal(BYBIT_TOTAL_BUDGET_MS, 30_000);
  });

  await t.test("a hanging request is aborted by the per-attempt timer", async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      bybitPublicGet("/v5/market/time", {
        // Tiny timer keeps the test fast; the default is asserted above.
        timeoutMs: 5,
        fetchImpl: ((_url: string, init: RequestInit) => {
          calls += 1;
          return new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
          });
        }) as unknown as typeof fetch,
        nowMs: clock.nowMs,
        sleepImpl: clock.sleepImpl,
      }),
      /timed out/
    );
    assert.equal(calls, 3);
  });

  await t.test("no attempt starts once the 30s budget is spent", async () => {
    const clock = fakeClock();
    const startedAt: number[] = [];
    await assert.rejects(
      bybitPublicGet("/v5/market/time", {
        fetchImpl: (async () => {
          startedAt.push(clock.nowMs() - NOW);
          clock.advance(15_000);
          return response(502, {});
        }) as typeof fetch,
        nowMs: clock.nowMs,
        sleepImpl: clock.sleepImpl,
      }),
      /502/
    );
    assert.ok(startedAt.length < 3, `attempts at ${startedAt}`);
    assert.ok(startedAt.every((ms) => ms < 30_000));
  });

  await t.test("an aborted caller is not retried", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(
      bybitPublicGet("/v5/market/time", {
        signal: controller.signal,
        fetchImpl: (async () => { calls += 1; controller.abort(); return response(503, {}); }) as typeof fetch,
        nowMs: clock.nowMs,
        sleepImpl: clock.sleepImpl,
      }),
      /abort/i
    );
    assert.equal(calls, 1);
  });
});

function instrumentRow(symbol: string): Record<string, any> {
  return JSON.parse(JSON.stringify(evidence.assets.find((a: any) => a.instrument.symbol === symbol).instrument));
}

test("metadata_cache_revalidates_after_6h_and_fails_closed_after_24h", async () => {
  const clock = fakeClock();
  let fail = false;
  let calls = 0;
  const cache = createBybitMetadataCache({
    nowMs: clock.nowMs,
    fetchImpl: (async () => {
      calls += 1;
      if (fail) return response(403, {});
      return ok({ category: "linear", list: [instrumentRow("XAGUSDT")] }, clock.nowMs());
    }) as typeof fetch,
    sleepImpl: clock.sleepImpl,
  });

  const first = await cache.get("XAGUSDT");
  assert.equal(first.symbol, "XAGUSDT");
  await cache.get("XAGUSDT");
  assert.equal(calls, 1, "served from cache inside six hours");

  clock.advance(6 * 3_600_000 + 1);
  fail = true;
  const stale = await cache.get("XAGUSDT");
  assert.equal(calls, 2, "revalidation attempted after six hours");
  assert.equal(stale.verifiedAtMs, first.verifiedAtMs, "last valid copy served while under 24h");

  clock.advance(18 * 3_600_000);
  await assert.rejects(cache.get("XAGUSDT"), /XAGUSDT/);
  // Existing positions can still be described by the last valid copy.
  assert.equal(cache.lastValid("XAGUSDT")?.verifiedAtMs, first.verifiedAtMs);
});

test("metadata_cache_rejects_a_mismatched_response", async () => {
  const clock = fakeClock();
  const cache = createBybitMetadataCache({
    nowMs: clock.nowMs,
    fetchImpl: (async () => ok({ category: "linear", list: [instrumentRow("BTCUSDT")] })) as typeof fetch,
    sleepImpl: clock.sleepImpl,
  });
  await assert.rejects(cache.get("ETHUSDT"), /symbol/);
  assert.equal(cache.lastValid("ETHUSDT"), null);
});

test("instrument_list_follows_every_cursor_page", async () => {
  const clock = fakeClock();
  const urls: string[] = [];
  const pages = [
    ok({ category: "linear", list: [instrumentRow("BTCUSDT")], nextPageCursor: "page2" }),
    ok({ category: "linear", list: [instrumentRow("XAUUSDT")], nextPageCursor: "" }),
  ];
  const rows = await listBybitLinearInstruments({
    fetchImpl: (async (url: string) => { urls.push(String(url)); return pages.shift()!; }) as unknown as typeof fetch,
    nowMs: clock.nowMs,
    sleepImpl: clock.sleepImpl,
  });
  assert.deepEqual(rows.map((r) => r.symbol), ["BTCUSDT", "XAUUSDT"]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /limit=1000/);
  assert.match(urls[1], /cursor=page2/);
});
