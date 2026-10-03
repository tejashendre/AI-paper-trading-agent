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

test("the release keeps a verified ledger copy before any compaction deletes history", () => {
  // Codex's release notes required one verified full-ledger recovery copy
  // before the first destructive compaction; the deploy backup held only
  // Redis and source, so this is now part of the release itself.
  const script = fs.readFileSync("scripts/release-ledger-maintenance.sh", "utf8");
  const apply = script.indexOf("ledger-compact.ts --apply");
  const copy = script.indexOf("cp -R data/execution-ledger");
  const verifyCopy = script.search(/verify-execution-ledger\.ts --directory "\$BACKUP_DIR\/execution-ledger"/);
  assert.ok(apply > 0, "compaction no longer runs");
  assert.ok(copy > 0 && copy < apply, "no ledger copy before compaction");
  assert.ok(verifyCopy > copy && verifyCopy < apply, "the copy is not verified before compaction");
  assert.match(script, /WOULD_COMPACT/, "a copy is taken even when nothing would be compacted");
  const workflow = fs.readFileSync(".github/workflows/deploy.yml", "utf8");
  assert.match(workflow, /sh scripts\/release-ledger-maintenance\.sh "\$BACKUP_DIR"/, "the deploy does not pass its backup directory");
});
