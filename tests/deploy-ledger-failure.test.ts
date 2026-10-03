/**
 * The release stops the dashboard and both daemons before ledger
 * compaction. If compaction or verification refuses, the deploy script
 * (set -eu) exits; without a restart the bot and dashboard stay down with
 * open positions unmanaged. The previous containers still exist at that
 * point, so the failure path must start them again before failing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("a refused ledger maintenance restarts the previous services before failing the release", () => {
  const workflow = fs.readFileSync(".github/workflows/deploy.yml", "utf8");
  const call = workflow.split(/\r?\n/).findIndex((line) => line.includes("scripts/release-ledger-maintenance.sh"));
  assert.ok(call >= 0, "the release no longer runs ledger maintenance");
  const block = workflow.split(/\r?\n/).slice(call, call + 8).join("\n");
  assert.match(block, /if ! sh scripts\/release-ledger-maintenance\.sh/, "a refusal is not handled");
  assert.match(block, /docker compose start quant-dashboard swing-daemon xsec-daemon/, "the stopped services are not restarted");
  assert.match(block, /exit 1/, "the release does not fail after restarting");
});
