import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryRedis } from "./helpers/memoryRedis";
import * as reset from "@/lib/admin/resetAiRun";
import { runAiRunResetCli } from "../scripts/reset-ai-run";
import { ExecutionLedger } from "@/lib/trading/executionLedger";
import { setRedisClient, type RawRedisValue } from "@/lib/redis";

async function fixture(t: test.TestContext) {
  const redis = new MemoryRedis();
  const archiveDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "v6-reset-"));
  t.after(() => fs.rmSync(archiveDirectory, { recursive: true, force: true }));
  await redis.set("ai:portfolio", { usd: 8123, balances: {}, openPositions: {}, totalTrades: 25 });
  await redis.set("user:portfolio", '{ "usd": 9999, "openPositions": {} }');
  await redis.lpush("user:trades", '{ "id": "human" }');
  await redis.set("swing:lastExitSweep:user", "human-transient");
  await redis.set("xsec:portfolio", { cashUsd: 6543, positions: {}, fundingTail: [] });
  await redis.lpush("ai:trades", '{"id":"old-ai"}');
  await redis.lpush("xsec:trades", '{"id":"old-xsec"}');
  await redis.set("execution:ledger:head", "old-ledger-head");
  const leases = Object.fromEntries(reset.REQUIRED_AI_RESET_LEASE_KEYS.map((key) => [key, `token:${key}`]));
  for (const [key, token] of Object.entries(leases)) await redis.set(key, token, { ex: 300 });
  const preview = () => reset.previewAiRunReset({ runId: "run-one", archiveDirectory, redis, now: "2026-10-24T12:00:00.000Z" });
  return { redis, archiveDirectory, leases, preview };
}

test("preview is read-only and exposes flatness requirements without mutating raw human bytes", async (t) => {
  const f = await fixture(t);
  const before = await f.redis.readRaw(["ai:portfolio", "user:portfolio", "user:trades", "swing:lastExitSweep:user"]);
  const p = await f.preview();
  assert.equal(p.canReset, true);
  assert.deepEqual(await f.redis.readRaw(Object.keys(before)), before);
  assert.deepEqual(fs.readdirSync(f.archiveDirectory), []);
  assert.equal(await reset.activeAiRun(f.redis), null);
  await f.redis.set("ai:portfolio", { usd: 8000, balances: { BTC: 1 }, openPositions: { BTC: { amount: 1 } }, pendingLedgerEvents: [{ id: "unsettled" }] });
  const blocked = await f.preview();
  assert.equal(blocked.canReset, false);
  assert.match(blocked.blockers.join(" "), /BTC/);
  assert.match(blocked.blockers.join(" "), /pendingLedgerEvents/);
});

test("reset archives old records and starts exactly one $10000 AI account while preserving human and XSEC", async (t) => {
  const f = await fixture(t);
  const untouched = ["user:portfolio", "user:trades", "swing:lastExitSweep:user", "ai:trades", "xsec:trades", "xsec:portfolio", "execution:ledger:head"];
  const before = await f.redis.readRaw(untouched);
  const p = await f.preview();
  const result = await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined });
  assert.equal(result.initialCapital, 10000);
  assert.equal(result.mode, "SHADOW");
  assert.equal(result.xsecMode, "HISTORICAL_ONLY");
  const portfolio = await f.redis.get<Record<string, unknown>>("ai:portfolio");
  assert.equal(portfolio?.usd, 10000);
  assert.equal(portfolio?.peakValue, 10000);
  assert.equal(portfolio?.totalTrades, 0);
  assert.equal(portfolio?.totalPnl, 0);
  assert.equal(portfolio?.totalFeesPaid, 0);
  assert.deepEqual(portfolio?.openPositions, {});
  assert.deepEqual(await f.redis.readRaw(untouched), before);
  assert.deepEqual(await f.redis.lrange(reset.aiRunKeys(result.runId).trades, 0, -1), []);
  const archive = JSON.parse(fs.readFileSync(result.archive.path, "utf8"));
  assert.equal(archive.preview.sources["ai:portfolio"].value.includes("8123"), true);
  assert.deepEqual(await reset.activeAiRun(f.redis), result);
  const again = await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined });
  assert.deepEqual(again, result);
});

test("stale leases, changed human raw bytes and changed AI source abort before switch", async (t) => {
  for (const change of ["lease", "human", "ai"]) {
    const f = await fixture(t);
    const p = await f.preview();
    if (change === "lease") await f.redis.set("xsec:lock", "other-owner");
    if (change === "human") await f.redis.set("user:portfolio", '{"usd":9999,"openPositions":{}}');
    if (change === "ai") await f.redis.set("ai:portfolio", { usd: 7000, balances: {}, openPositions: {} });
    await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /lease|changed/i);
    assert.equal(await reset.activeAiRun(f.redis), null);
  }
});

test("pending funding and ledger tails refuse reset even with no positions", async (t) => {
  for (const liability of ["fundingTail", "pendingLedgerEvents"]) {
    const f = await fixture(t);
    await f.redis.set("xsec:portfolio", { cashUsd: 10, positions: {}, [liability]: [{}] });
    const p = await f.preview();
    assert.equal(p.canReset, false);
    await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /not ready/i);
    assert.equal(await reset.activeAiRun(f.redis), null);
  }
});

test("later resets inspect the authoritative active-run portfolio rather than its flat legacy mirror", async (t) => {
  for (const state of ["open", "pending", "missing", "malformed", "invalid-run-id"]) {
    const f = await fixture(t);
    await f.redis.set(reset.ACTIVE_AI_RUN_KEY, { runId: state === "invalid-run-id" ? "../invalid" : "old-run" });
    const oldKey = reset.aiRunKeys("old-run").portfolio;
    if (state === "open") await f.redis.set(oldKey, { usd: 8000, openPositions: { BTC: { amount: 1 } }, balances: {} });
    if (state === "pending") await f.redis.set(oldKey, { usd: 8000, openPositions: {}, fundingTail: [{}] });
    if (state === "malformed") await f.redis.set(oldKey, "malformed");
    const p = await f.preview();
    assert.equal(p.canReset, false, state);
    assert.match(p.blockers.join(" "), /active|old-run|run ID/i);
    await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /not ready/i);
  }
});

test("flat settled active-run portfolios are explicitly archived and can be switched safely", async (t) => {
  const f = await fixture(t);
  await f.redis.set(reset.ACTIVE_AI_RUN_KEY, { runId: "old-run" });
  const oldKey = reset.aiRunKeys("old-run").portfolio;
  await f.redis.set(oldKey, { usd: 8123, openPositions: {}, balances: {}, fundingTail: [] });
  const p = await f.preview();
  assert.equal(p.canReset, true);
  assert.equal(p.sources[oldKey].type, "string");
  const before = await f.redis.readRaw([oldKey]);
  await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined });
  assert.deepEqual(await f.redis.readRaw([oldKey]), before);
});

test("archive write failure and tampered preview cannot mutate Redis", async (t) => {
  const f = await fixture(t);
  const p = await f.preview();
  const badPath = path.join(f.archiveDirectory, "file");
  fs.writeFileSync(badPath, "occupied");
  const bad = await reset.previewAiRunReset({ runId: "blocked", archiveDirectory: badPath, redis: f.redis });
  await assert.rejects(reset.resetAiRun({ preview: bad, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }));
  await assert.rejects(reset.resetAiRun({ preview: { ...p, sourceDigest: "tampered" }, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /digest|preview/i);
  assert.equal(await reset.activeAiRun(f.redis), null);
});

test("archive survives a commit crash, retry commits once, lost acknowledgement resumes without capital injection", async (t) => {
  const f = await fixture(t);
  const p = await f.preview();
  const commit = f.redis.commitAiRunReset.bind(f.redis);
  f.redis.commitAiRunReset = async () => { throw new Error("crash before commit"); };
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /crash before commit/);
  assert.equal(await reset.activeAiRun(f.redis), null);
  assert.equal(fs.readdirSync(f.archiveDirectory).length > 0, true);
  f.redis.commitAiRunReset = commit;
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => { throw new Error("ledger acknowledgement lost"); } }), /acknowledgement lost/);
  const active = await reset.activeAiRun(f.redis);
  assert.equal(active?.runId, "run-one");
  await f.redis.set("ai:portfolio", { usd: 9950, openPositions: {} });
  const recovered = await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined });
  assert.deepEqual(recovered, active);
  assert.equal((await f.redis.get<{usd: number}>("ai:portfolio"))?.usd, 9950);
});

test("committed reset recovery permits human activity between protection windows and preserves its current bytes", async (t) => {
  const f = await fixture(t);
  const p = await f.preview();
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => {
    throw new Error("crash after committed epoch switch");
  } }), /crash/);
  const active = await reset.activeAiRun(f.redis);
  await f.redis.set("user:portfolio", '{ "usd": 9998, "openPositions": {} }');
  await f.redis.lpush("user:trades", '{"id":"legitimate-later-human-trade"}');
  const humanBeforeRetry = await f.redis.readRaw(Object.keys(p.human));
  const recovered = await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined });
  assert.deepEqual(recovered, active);
  assert.equal(await f.redis.get(reset.aiRunKeys(p.runId).ledgerAcknowledged), true);
  assert.deepEqual(await f.redis.readRaw(Object.keys(p.human)), humanBeforeRetry);
  assert.equal((await f.redis.get<{usd: number}>("ai:portfolio"))?.usd, 10000);
});

test("recovery still refuses a human write inside its newly fenced acknowledgement window", async (t) => {
  const f = await fixture(t);
  const p = await f.preview();
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => {
    throw new Error("crash after commit");
  } }), /crash/);
  await f.redis.set("user:portfolio", '{"usd":9998,"openPositions":{}}');
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => {
    await f.redis.set("user:portfolio", '{"usd":9997,"openPositions":{}}');
  } }), /changed/i);
  assert.equal(await f.redis.get(reset.aiRunKeys(p.runId).ledgerAcknowledged), null);
});

test("corrupt archive on retry fails closed and run ID cannot be reused with another preview", async (t) => {
  const f = await fixture(t);
  const p = await f.preview();
  const result = await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined });
  const changed = await f.preview();
  await assert.rejects(reset.resetAiRun({ preview: changed, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /archive|run ID/i);
  fs.appendFileSync(result.archive.path, "tampered");
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /archive|hash/i);
});

test("durable acknowledgement is fenced and retry does not acknowledge twice", async (t) => {
  const f = await fixture(t);
  const p = await f.preview();
  let acknowledgements = 0;
  const acknowledge = async () => { acknowledgements++; };
  await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge });
  assert.equal(await f.redis.get(reset.aiRunKeys(p.runId).ledgerAcknowledged), true);
  await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge });
  assert.equal(acknowledgements, 1);
});

test("archived previews resume when Redis reorders snapshot keys and raw-value metadata without changing human bytes", async (t) => {
  const f = await fixture(t), p = await f.preview();
  const commit = f.redis.commitAiRunReset.bind(f.redis);
  f.redis.commitAiRunReset = async () => { throw new Error("crash before commit"); };
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /crash before commit/);
  const archivePath = path.join(f.archiveDirectory, p.runId + ".json"), archivedBytes = fs.readFileSync(archivePath, "utf8");
  const archivedPreview = JSON.parse(archivedBytes).preview as typeof p;
  function metadata(value: RawRedisValue, reordered = false): RawRedisValue {
    if (value.type === "none") return { type: "none" };
    if (value.type === "string") return reordered ? { value: value.value, type: "string" } : { type: "string", value: value.value };
    return reordered ? { value: value.value, type: "list" } : { type: "list", value: value.value };
  }
  // The memory adapter compares JSON text. Match production Lua's field-based
  // comparison of metadata while retaining every original string/list byte.
  f.redis.commitAiRunReset = async (input) => commit({ ...input, expected: Object.fromEntries(Object.entries(input.expected).map(([key, value]) =>
    [key, metadata(value)])) });
  const read = f.redis.readRaw.bind(f.redis), humanKeys = Object.keys(p.human);
  f.redis.readRaw = async (keys) => {
    const values = await read(keys);
    return keys.length === humanKeys.length && keys.every(key => Object.hasOwn(p.human, key))
      ? Object.fromEntries(Object.entries(values).reverse().map(([key, value]) =>
        [key, metadata(value, true)])) : values;
  };
  let acknowledgements = 0;
  const acknowledge = async () => { acknowledgements++; };
  const active = await reset.resetAiRun({ preview: archivedPreview, leases: f.leases, redis: f.redis, acknowledge });
  assert.equal(await f.redis.get(reset.aiRunKeys(active.runId).ledgerAcknowledged), true);
  assert.deepEqual(await read(humanKeys), p.human);
  assert.equal(fs.readFileSync(archivePath, "utf8"), archivedBytes);
  assert.equal(JSON.parse(fs.readFileSync(archivePath, "utf8")).preview.humanDigest, p.humanDigest);
  await f.redis.set("ai:portfolio", { usd: 9950, openPositions: {} });
  assert.deepEqual(await reset.resetAiRun({ preview: archivedPreview, leases: f.leases, redis: f.redis, acknowledge }), active);
  assert.equal((await f.redis.get<{ usd: number }>("ai:portfolio"))?.usd, 9950);
  assert.equal(acknowledgements, 1);
});

for (const change of ["portfolio-whitespace", "list-order", "list-item-whitespace"] as const) test(`post-commit human ${change} changes still refuse acknowledgement`, async (t) => {
  const f = await fixture(t);
  await f.redis.lpush("user:trades", '{ "id": "second-human" }');
  const p = await f.preview(), read = f.redis.readRaw.bind(f.redis), humanKeys = Object.keys(p.human);
  let changed = false;
  f.redis.readRaw = async (keys) => {
    if (!changed && keys.length === humanKeys.length && keys.every(key => Object.hasOwn(p.human, key))) {
      changed = true;
      if (change === "portfolio-whitespace") await f.redis.set("user:portfolio", '{"usd":9999,"openPositions":{}}');
      else {
        const rows = await f.redis.lrange("user:trades", 0, -1);
        await f.redis.del("user:trades");
        for (const row of change === "list-order" ? rows : rows.reverse().map(raw => JSON.stringify(JSON.parse(raw)))) await f.redis.lpush("user:trades", row);
      }
    }
    return read(keys);
  };
  let acknowledgements = 0;
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => { acknowledgements++; } }), /human values changed after commit/i);
  assert.equal(acknowledgements, 0);
  assert.equal(await f.redis.get(reset.aiRunKeys(p.runId).ledgerAcknowledged), null);
});

test("losing a lease during acknowledgement leaves transition pending", async (t) => {
  const f = await fixture(t);
  const p = await f.preview();
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => {
    await f.redis.set("portfolio:write-lock:user", "new-owner", { ex: 300 });
  } }), /lease/i);
  assert.equal(await f.redis.get(reset.aiRunKeys(p.runId).ledgerAcknowledged), null);
});

test("expiring leases cannot commit and primitive rejects human writes", async (t) => {
  const f = await fixture(t);
  const p = await f.preview();
  await f.redis.set("xsec:lock", f.leases["xsec:lock"], { ex: -1 });
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /lease/i);
  await assert.rejects(f.redis.commitAiRunReset({ receiptKey: "brain:v6:reset:illegal", receipt: "x", leases: f.leases, expected: {}, writes: { "user:portfolio": "{}" } }), /forbidden/i);
  assert.equal(await reset.activeAiRun(f.redis), null);
});

test("CLI defaults to read-only preview and requires explicit safe archive and run ID", async (t) => {
  const f = await fixture(t);
  const output: string[] = [];
  const args = ["--run-id", "cli-run", "--archive-dir", f.archiveDirectory];
  await runAiRunResetCli(args, { redis: f.redis, output: (line) => output.push(line) });
  assert.equal(await reset.activeAiRun(f.redis), null);
  assert.deepEqual(fs.readdirSync(f.archiveDirectory), []);
  assert.equal(JSON.parse(output[0]).mode, "PREVIEW");
  assert.equal(output.join("").includes("human-transient"), false);
  await assert.rejects(runAiRunResetCli(["--execute"], { redis: f.redis }), /run.id|archive/i);
  await assert.rejects(runAiRunResetCli(["--run-id", "../bad", "--archive-dir", f.archiveDirectory], { redis: f.redis }), /run ID/);
  await assert.rejects(runAiRunResetCli([...args, "--redis-url", "redis://example.com:6379"], { redis: f.redis }), /loopback/i);
});

test("default durable ledger append continues the old chain and ambiguous commit replies cannot duplicate capital", async (t) => {
  const f = await fixture(t);
  const ledgerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "v6-reset-ledger-"));
  const priorDirectory = process.env.EXECUTION_LEDGER_DIR;
  process.env.EXECUTION_LEDGER_DIR = ledgerDirectory;
  setRedisClient(f.redis);
  t.after(() => {
    if (priorDirectory === undefined) delete process.env.EXECUTION_LEDGER_DIR;
    else process.env.EXECUTION_LEDGER_DIR = priorDirectory;
    setRedisClient(null);
    fs.rmSync(ledgerDirectory, { recursive: true, force: true });
  });
  await ExecutionLedger.record({ id: "old-event", type: "SCAN_COMPLETED", source: "test", payload: {} });
  const old = ExecutionLedger.verify(ledgerDirectory);
  const p = await f.preview();
  const commit = f.redis.commitAiRunReset.bind(f.redis);
  let loseReply = true;
  f.redis.commitAiRunReset = async (request) => {
    const result = await commit(request);
    if (loseReply) { loseReply = false; throw new Error("commit reply lost"); }
    return result;
  };
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis }), /reply lost/);
  assert.equal(ExecutionLedger.verify(ledgerDirectory).events, 1);
  await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis });
  await reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis });
  const verified = ExecutionLedger.verify(ledgerDirectory);
  assert.equal(verified.valid, true);
  assert.equal(verified.events, 2);
  assert.equal(ExecutionLedger.verify(ledgerDirectory, old.headHash!).events, 1);
  assert.equal(ExecutionLedger.hasEvent("AI_RUN_STARTED:run-one", "1970-01-01", ledgerDirectory), true);
});

test("malformed portfolios are printable CLI refusals", async (t) => {
  const f = await fixture(t);
  await f.redis.set("ai:portfolio", "malformed");
  const output: string[] = [];
  await runAiRunResetCli(["--run-id", "malformed", "--archive-dir", f.archiveDirectory], { redis: f.redis, output: (line) => output.push(line) });
  assert.equal(JSON.parse(output[0]).canReset, false);
  assert.equal(await reset.activeAiRun(f.redis), null);
});

test("old exact v6 evidence is archived and an evidence inventory race cannot omit a new cohort", async (t) => {
  const f = await fixture(t);
  await f.redis.set("brain:v6:run:old:registration:cohort", { evidence: "old-proof" });
  const p = await f.preview();
  assert.equal(p.sources["brain:v6:run:old:registration:cohort"]?.type, "string");
  await f.redis.set("research:old:outcomes:new-cohort", { result: "arrived-after-preview" });
  await assert.rejects(reset.resetAiRun({ preview: p, leases: f.leases, redis: f.redis, acknowledge: async () => undefined }), /inventory|changed/i);
  assert.equal(await reset.activeAiRun(f.redis), null);
});
