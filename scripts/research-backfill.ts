// One-off, bounded research backfill for the nine contracts. Read-only against
// Bybit's public market endpoints; writes only under <archive>/backfill.
// Usage: tsx scripts/research-backfill.ts [--archive data/research]
import path from "node:path";
import { DEFAULT_RESEARCH_ARCHIVE_BYTES } from "@/lib/research/researchArchive";
import { refreshAllBackfill } from "@/lib/research/backfill";

async function main() {
  const flag = process.argv.indexOf("--archive");
  const archiveDirectory = flag > 0 ? process.argv[flag + 1] : path.join(process.cwd(), "data", "research");
  const result = await refreshAllBackfill({ archiveDirectory, nowMs: Date.now(),
    maxBytes: Number(process.env.RESEARCH_ARCHIVE_MAX_BYTES || DEFAULT_RESEARCH_ARCHIVE_BYTES) });
  for (const line of result.lines) console.log(line);
  process.exitCode = result.failed ? 1 : 0;
}

void main();
