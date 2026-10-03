/**
 * The cross-sectional daemon's own tasks share one Redis lock. A rebalance
 * that found the lock busy used to return silently and retry five minutes
 * later, in the same phase as the task holding it, so on the live VPS the
 * 12-hour rebalance stopped for good while the minute mark kept running.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { CONFIGURED_ASSETS, CONFIGURED_INSTRUMENTS } from "@/lib/trading/instrumentRegistry";
import { MemoryRedis } from "./helpers/memoryRedis";
import { createVenue, installVenue, minuteBars } from "./helpers/fakeBybitVenue";

const originalCwd = process.cwd();
let m: {
  xsec: typeof import("@/daemon/crossSectionalDaemon");
  redis: typeof import("@/lib/redis");
};
let restoreFetch: () => void;

before(async () => {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "xsec-scheduler-")));
  const venue = createVenue(Date.now());
  for (const asset of CONFIGURED_ASSETS) {
    venue.series.set(CONFIGURED_INSTRUMENTS[asset].symbol, minuteBars(100, 0, Date.now(), 400));
  }
  restoreFetch = installVenue(venue).restore;
  m = {
    xsec: await import("@/daemon/crossSectionalDaemon"),
    redis: await import("@/lib/redis"),
  };
});

after(() => {
  restoreFetch();
  m.redis.setRedisClient(null);
  process.chdir(originalCwd);
});

describe("cross-sectional scheduling", () => {
  it("a due rebalance waits out a briefly held lock instead of skipping", async () => {
    const memory = new MemoryRedis();
    m.redis.setRedisClient(memory);
    await memory.set("xsec:lock", "another-task", { ex: 300 });
    setTimeout(() => { void memory.del("xsec:lock"); }, 200);

    const startedAt = Date.now();
    await m.xsec.runRebalance();

    const last = await memory.get<number>("xsec:lastRebalanceAt");
    assert.ok(typeof last === "number" && last >= startedAt, `rebalance did not run: lastRebalanceAt=${last}`);
    assert.equal(await memory.get("xsec:lock"), null, "the rebalance left its lock behind");
  });

  it("one daemon cycle runs a due rebalance even when funding and marking run in the same tick", async () => {
    const memory = new MemoryRedis();
    m.redis.setRedisClient(memory);
    const startedAt = Date.now();
    await m.xsec.runCycle();
    const last = await memory.get<number>("xsec:lastRebalanceAt");
    assert.ok(typeof last === "number" && last >= startedAt, "a due rebalance did not run in the cycle");
    assert.ok(await memory.get("xsec:equity"), "the cycle did not mark the book");
  });

  it("reports a rebalance as overdue once a full period plus grace has passed", () => {
    const now = Date.UTC(2026, 9, 2, 9, 0, 0);
    const hour = 3_600_000;
    assert.equal(m.xsec.rebalanceStatus(now - 11 * hour, now).overdue, false);
    assert.equal(m.xsec.rebalanceStatus(now - 14 * hour, now).overdue, true);
    assert.equal(m.xsec.rebalanceStatus(null, now).overdue, true);
    assert.equal(m.xsec.rebalanceStatus(now - 14 * hour, now).nextDueAtMs, now - 2 * hour);
  });
});
