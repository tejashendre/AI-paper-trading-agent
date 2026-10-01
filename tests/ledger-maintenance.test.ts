import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeExecutionEventHash, ExecutionLedger } from "@/lib/trading/executionLedger";

test("maintenance verifies its original ledger prefix while live records continue", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-maintenance-"));
  try {
    const fixture = path.resolve("tests/fixtures/upgrade/ledger");
    fs.cpSync(fixture, directory, { recursive: true });
    const before = ExecutionLedger.verify(directory);
    assert.ok(before.valid && before.headHash);
    const file = fs.readdirSync(directory).find((name) => name.endsWith(".ndjson"))!;
    const rows = fs.readFileSync(path.join(directory, file), "utf8").trim().split("\n");
    const { hash: _hash, ...previous } = JSON.parse(rows.at(-1)!);
    const appended = { ...previous, id: "concurrent-live-event", previousHash: before.headHash };
    fs.appendFileSync(path.join(directory, file), `${JSON.stringify({ ...appended, hash: computeExecutionEventHash(appended) })}\n`);
    const after = ExecutionLedger.verify(directory, before.headHash);
    assert.ok(after.valid);
    assert.equal(after.events, before.events);
    assert.equal(after.headHash, before.headHash);
    assert.equal(ExecutionLedger.verify(directory).events, before.events + 1);
    assert.equal(ExecutionLedger.verify(directory, "missing-head").valid, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
