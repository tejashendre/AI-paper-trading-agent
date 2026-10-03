/**
 * Storage option 1 (Tejas, 2026-10-02): drop old per-minute scan records
 * from the ledger, keep every trade, funding, research and risk event, and
 * re-seal the chain with a checkpoint that names the old head.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, describe, it } from "node:test";
import { setRedisClient } from "@/lib/redis";
import { archiveLedgerDays, compactLedger, ExecutionLedger, refreshLedgerMirror } from "@/lib/trading/executionLedger";
import { MemoryRedis } from "./helpers/memoryRedis";

const originalDir = process.env.EXECUTION_LEDGER_DIR;
before(() => setRedisClient(new MemoryRedis()));
after(() => {
  setRedisClient(null);
  if (originalDir === undefined) delete process.env.EXECUTION_LEDGER_DIR;
  else process.env.EXECUTION_LEDGER_DIR = originalDir;
});

const rows = (dir: string) => fs.readdirSync(dir).filter((f) => /\.ndjson(\.gz)?$/.test(f)).sort()
  .flatMap((f) => (f.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString("utf8") : fs.readFileSync(path.join(dir, f), "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));

async function seededLedger(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-compact-"));
  process.env.EXECUTION_LEDGER_DIR = dir;
  const day = (d: number, h: number) => new Date(Date.UTC(2026, 8, d, h)).toISOString();
  for (const d of [1, 2, 3]) {
    for (let h = 0; h < 6; h++) {
      await ExecutionLedger.record({ type: "SCAN_COMPLETED", source: "SWING_DAEMON", timestamp: day(d, h), payload: { filler: "x".repeat(2000) } });
    }
    await ExecutionLedger.record({ id: `fill-${d}`, type: "ENTRY_FILLED", source: "SWING_DAEMON", asset: "GOLD", timestamp: day(d, 7), payload: { d } });
    await ExecutionLedger.record({ id: `funding-${d}`, type: "FUNDING_SETTLED", source: "SWING_DAEMON", asset: "GOLD", timestamp: day(d, 8), payload: { d } });
  }
  return dir;
}

describe("ledger compaction", () => {
  it("refuses requests to discard financial or learning evidence", async () => {
    const dir = await seededLedger();
    const snapshot = rows(dir);
    const report = compactLedger({ directory: dir, dropTypes: ["ENTRY_FILLED"], minDropBytes: 0 });
    assert.match(report.status, /^REFUSED/);
    assert.deepEqual(rows(dir), snapshot);
  });

  it("retains recovery files from an interrupted previous compaction", async () => {
    const dir = await seededLedger();
    const recovery = `${dir}.pre-compaction`;
    fs.mkdirSync(recovery);
    fs.writeFileSync(path.join(recovery, "recovery.txt"), "irreplaceable evidence");
    const report = compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0 });
    assert.match(report.status, /^REFUSED/);
    assert.equal(fs.readFileSync(path.join(recovery, "recovery.txt"), "utf8"), "irreplaceable evidence");
    assert.equal(ExecutionLedger.verify(dir).events, 24);
  });
  it("drops scan records, keeps every other event, and re-seals a verifiable chain", async () => {
    const dir = await seededLedger();
    const before = rows(dir);
    const oldHead = ExecutionLedger.verify(dir).headHash;
    const report = compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0 });
    assert.equal(report.status, "COMPACTED");
    const after = rows(dir);
    const verification = ExecutionLedger.verify(dir);
    assert.equal(verification.valid, true, verification.errors.join("; "));
    assert.equal(after[0].type, "LEDGER_COMPACTED");
    assert.equal(after[0].previousHash, null);
    assert.equal(after[0].payload.compactedFromHeadHash, oldHead);
    assert.equal(after[0].payload.droppedByType.SCAN_COMPLETED, 18);
    const kept = before.filter((r) => r.type !== "SCAN_COMPLETED");
    assert.deepEqual(after.slice(1).map((r) => r.id), kept.map((r) => r.id));
    assert.deepEqual(after.slice(1).map((r) => r.originalHash), kept.map((r) => r.hash));
    assert.deepEqual(after.slice(1).map((r) => r.payload), kept.map((r) => r.payload));
    assert.ok(!after.some((r) => r.type === "SCAN_COMPLETED"));
    assert.ok(ExecutionLedger.hasEvent("funding-2", "2026-09-01T00:00:00Z", dir), "idempotency ids still resolve");
    // The next append chains onto the new head.
    await ExecutionLedger.record({ type: "EXIT_FILLED", source: "SWING_DAEMON", payload: {} });
    assert.equal(ExecutionLedger.verify(dir).valid, true);
    assert.ok(!fs.readdirSync(path.dirname(dir)).some((f) => f.startsWith(path.basename(dir) + ".")), "no staging or old copy left behind");
  });

  it("dry run changes nothing, and the Redis mirror follows the re-sealed head", async () => {
    const memory = new MemoryRedis();
    setRedisClient(memory);
    const dir = await seededLedger();
    const snapshot = rows(dir);
    assert.equal(compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0, dryRun: true }).status, "WOULD_COMPACT");
    assert.deepEqual(rows(dir), snapshot);
    const report = compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0 });
    await refreshLedgerMirror(dir);
    assert.equal((await memory.get<{ hash: string }>("execution:ledger:head"))?.hash, report.newHeadHash);
    assert.equal(memory.listRows("execution:ledger:recent").length, rows(dir).length);
  });

  it("keeps archived days archived", async () => {
    const dir = await seededLedger();
    const archived = archiveLedgerDays({ directory: dir, keepDays: 1 });
    assert.ok(archived.archived.length >= 3);
    compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0 });
    assert.ok(fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson.gz")).length >= 3);
    assert.equal(ExecutionLedger.verify(dir).valid, true);
  });

  it("refuses a ledger that does not verify and leaves it untouched", async () => {
    const dir = await seededLedger();
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".ndjson"))!;
    const full = path.join(dir, file);
    fs.writeFileSync(full, fs.readFileSync(full, "utf8").replace('"d":1', '"d":9'));
    const snapshot = fs.readFileSync(full);
    const report = compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0 });
    assert.equal(report.status, "REFUSED_INVALID_SOURCE");
    assert.ok(fs.readFileSync(full).equals(snapshot));
  });

  it("skips when too little would be reclaimed, and a second run finds nothing to drop", async () => {
    const dir = await seededLedger();
    assert.equal(compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 10_000_000 }).status, "SKIPPED_BELOW_THRESHOLD");
    assert.equal(compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0 }).status, "COMPACTED");
    assert.equal(compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0 }).status, "SKIPPED_BELOW_THRESHOLD");
  });

  it("refuses unsafe work, but a lock left by a killed writer does not block it forever", async () => {
    const dir = await seededLedger();
    assert.equal(compactLedger({ directory: dir, dropTypes: ["ENTRY_FILLED"], minDropBytes: 0 }).status, "REFUSED_UNSAFE_OPERATION",
      "only scan telemetry may ever be removed");
    const lock = path.join(dir, ".append.lock");
    fs.writeFileSync(lock, "4242 live");
    assert.equal(compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0 }).status, "REFUSED_UNSAFE_OPERATION",
      "a live writer holds the lock");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    assert.equal(compactLedger({ directory: dir, dropTypes: ["SCAN_COMPLETED"], minDropBytes: 0 }).status, "COMPACTED",
      "a lock older than the append stale limit is a dead writer's leftover");
    assert.equal(ExecutionLedger.verify(dir).valid, true);
  });
});

