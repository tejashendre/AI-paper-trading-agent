/**
 * Owner-approved storage reduction (2026-10-02): re-seal the execution ledger
 * without the per-minute SCAN_COMPLETED records. Every other event is kept
 * with its original hash. Dry run by default.
 *
 *   tsx scripts/ledger-compact.ts [--apply] [--min-drop-mb 50] [--directory PATH]
 *
 * Run only while the daemons are stopped; the deploy does this for you.
 */
import path from "path";
import { compactLedger, refreshLedgerMirror } from "../src/lib/trading/executionLedger";
import { getRedis } from "../src/lib/redis";

const args = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const apply = args.includes("--apply");
const directory = value("--directory") ? path.resolve(value("--directory")!) : undefined;
const minDropMb = Number(value("--min-drop-mb") ?? 50);

(async () => {
  const report = compactLedger({ directory, dropTypes: ["SCAN_COMPLETED"], minDropBytes: minDropMb * 1024 * 1024, dryRun: !apply });
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report }, null, 2));
  if (report.status === "COMPACTED") {
    await refreshLedgerMirror(directory).catch((error) => console.warn("Redis ledger mirror not refreshed:", error));
  }
  await getRedis().quit().catch(() => undefined);
  process.exit(report.status.startsWith("REFUSED") ? 1 : 0);
})();
