/**
 * The swing and cross-sectional daemons are separate processes that append
 * to one hash-chained ledger directory. Appends were serialized only inside
 * a process, so two processes could both read the same head and fork the
 * chain, which then fails verification forever.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExecutionLedger } from "@/lib/trading/executionLedger";

const writer = `
import { ExecutionLedger } from "./src/lib/trading/executionLedger";
import { setRedisClient } from "./src/lib/redis";
import { MemoryRedis } from "./tests/helpers/memoryRedis";
const label = process.argv[2];
setRedisClient(new MemoryRedis());
(async () => {
  for (let i = 0; i < 150; i++) {
    await ExecutionLedger.record({ type: "SYSTEM_ERROR", source: label, payload: { i } });
  }
  process.exit(0);
})();
`;

function run(script: string, label: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, label], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

test("two processes appending at once keep one valid chain", { timeout: 120_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-mp-"));
  const script = path.join(process.cwd(), `_ledger_writer_${process.pid}.ts`);
  fs.writeFileSync(script, writer);
  try {
    const env = { ...process.env, EXECUTION_LEDGER_DIR: directory };
    const results = await Promise.all([run(script, "A", env), run(script, "B", env), run(script, "C", env)]);
    assert.deepEqual(results.map((r) => r.code), [0, 0, 0], results.map((r) => r.stderr.slice(-600)).join(" | "));
    const verification = ExecutionLedger.verify(directory);
    assert.equal(verification.events, 450);
    assert.equal(verification.valid, true, verification.errors.slice(0, 3).join("; "));
  } finally {
    fs.rmSync(script, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
