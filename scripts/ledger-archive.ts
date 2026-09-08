/**
 * Compress old execution-ledger days.
 *
 * The ledger writes one NDJSON file per day and never removed anything, so on
 * the VPS it had reached 1.38GB across 52 files and was growing about 26MB a
 * day. Deleting old events is not an option: the records are hash-chained, so
 * removing any of them breaks verification of everything after. Compression
 * keeps every event and still reclaims most of the space.
 *
 * The chain is verified before and after, and the run aborts without touching
 * anything if it was already broken beforehand.
 *
 *   npm run ledger:archive            # keep 7 days uncompressed
 *   npm run ledger:archive -- --keep 14
 *   npm run ledger:archive -- --dry-run
 */
import { archiveLedgerDays, ExecutionLedger } from "@/lib/trading/executionLedger";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return Number(process.argv[index + 1]);
  return fallback;
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)}MB`;
}

async function main() {
  const keepDays = arg("--keep", 7);
  const dryRun = process.argv.includes("--dry-run");

  const before = ExecutionLedger.verify();
  console.log(`Ledger before: ${before.files} file(s), ${before.events} event(s), valid=${before.valid}`);
  if (!before.valid) {
    console.error("Chain is already broken. Refusing to archive, because compressing a");
    console.error("broken chain would make the original damage much harder to diagnose.");
    for (const error of before.errors.slice(0, 5)) console.error(`  ${error}`);
    process.exit(1);
  }

  if (dryRun) {
    const status = ExecutionLedger.status();
    console.log(`Dry run: ${mb(status.bytes)} on disk, keeping the newest ${keepDays} day(s) uncompressed.`);
    return;
  }

  const result = archiveLedgerDays({ keepDays });
  console.log(`Archived ${result.archived.length} day(s): ${result.archived.join(", ") || "none"}`);
  if (result.skipped.length > 0) {
    console.log(`Skipped ${result.skipped.length}: ${result.skipped.join(", ")}`);
  }
  const saved = result.bytesBefore - result.bytesAfter;
  console.log(
    `Disk: ${mb(result.bytesBefore)} -> ${mb(result.bytesAfter)} ` +
    `(${mb(saved)} reclaimed${result.bytesBefore > 0 ? `, ${((saved / result.bytesBefore) * 100).toFixed(1)}%` : ""})`
  );

  // The point of the exercise is that nothing was lost. Prove it rather than
  // asserting it: the same chain, the same event count, still verifying.
  const after = ExecutionLedger.verify();
  console.log(`Ledger after:  ${after.files} file(s), ${after.events} event(s), valid=${after.valid}`);
  if (!after.valid || after.events !== before.events || after.headHash !== before.headHash) {
    console.error("ARCHIVE DAMAGED THE CHAIN. Event count or head hash changed.");
    for (const error of after.errors.slice(0, 5)) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log("Chain intact: same event count, same head hash, still verifying.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
