/**
 * Report what is actually stored in Redis, and optionally remove the parts
 * that no running code reads any more.
 *
 * Dry-run by default. Nothing is deleted without --apply, and the categories
 * below are deliberately conservative: live portfolios, trade history, the
 * execution ledger and the current strategy's learning rules are never
 * touched, because they are the bot's memory of what it has actually done.
 *
 *   npm run redis:housekeeping
 *   npm run redis:housekeeping -- --apply
 */
import { closeRedis, getRedis } from "@/lib/redis";
import { TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import { CROSS_SECTIONAL_STRATEGY_VERSION } from "@/lib/strategy/crossSectionalMomentum";

const APPLY = process.argv.includes("--apply");

interface Category {
  label: string;
  pattern: string;
  /** True when the key is safe to delete. */
  stale: (key: string, ttl: number) => boolean;
  note: string;
}

/** Keys that must never be removed by housekeeping, whatever they look like. */
const PROTECTED = [
  "ai:portfolio", "ai:trades", "ai:signals",
  "user:portfolio", "user:trades", "user:signals",
  "xsec:portfolio", "xsec:trades",
];

const CATEGORIES: Category[] = [
  {
    label: "Superseded learning rules",
    pattern: "learning:*",
    // Learning rules are namespaced by strategy version. Once the strategy
    // version moves on, the old rule set is never read again but keeps
    // sitting in memory.
    stale: (key) => !key.includes(TRADING_STRATEGY_VERSION) && !key.includes(CROSS_SECTIONAL_STRATEGY_VERSION),
    note: `current versions: ${TRADING_STRATEGY_VERSION}, ${CROSS_SECTIONAL_STRATEGY_VERSION}`,
  },
  {
    label: "Market cache without expiry",
    pattern: "cache:*",
    // Cache entries are written with a TTL. One without an expiry is a leftover
    // from an older code path and will never be evicted on its own.
    stale: (_key, ttl) => ttl === -1,
    note: "only entries missing a TTL are removed; live cache is left alone",
  },
  {
    label: "Stale live-price keys without expiry",
    pattern: "market:*",
    stale: (_key, ttl) => ttl === -1,
    note: "websocket price mirrors should always carry a TTL",
  },
  {
    label: "Old per-symbol series cache (superseded schema)",
    pattern: "perp:closes:v1:*",
    // Replaced by perp:series:v2, which also carries bar coverage.
    stale: () => true,
    note: "v1 schema replaced by perp:series:v2",
  },
  {
    label: "Expired swing cooldowns",
    pattern: "swing:cooldown:*",
    stale: (_key, ttl) => ttl === -1,
    note: "cooldowns are meant to expire; one without a TTL blocks an asset forever",
  },
];

async function main() {
  const redis = getRedis();

  console.log(`Redis housekeeping — ${APPLY ? "APPLY (will delete)" : "DRY RUN (nothing will be deleted)"}`);
  console.log("");

  // ── inventory ─────────────────────────────────────────────────────────────
  const allKeys = await redis.scanKeys("*", 50_000);
  console.log(`Total keys: ${allKeys.length}`);

  const groups = new Map<string, { count: number; bytes: number }>();
  for (const key of allKeys) {
    const prefix = key.split(":").slice(0, 2).join(":");
    const entry = groups.get(prefix) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    groups.set(prefix, entry);
  }

  // Size only the largest groups: MEMORY USAGE is a per-key round trip.
  const ranked = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15);
  for (const [prefix, entry] of ranked) {
    const sample = allKeys.filter((k) => k.startsWith(prefix)).slice(0, 5);
    let bytes = 0;
    for (const key of sample) bytes += await redis.memoryUsage(key);
    entry.bytes = sample.length > 0 ? (bytes / sample.length) * entry.count : 0;
  }

  console.log("");
  console.log("Largest key groups (size is estimated from a sample):");
  for (const [prefix, entry] of ranked) {
    console.log(`  ${prefix.padEnd(28)} ${String(entry.count).padStart(6)} keys  ~${(entry.bytes / 1024).toFixed(0)} KB`);
  }

  // ── stale detection ───────────────────────────────────────────────────────
  console.log("");
  console.log("Housekeeping categories:");
  const protectedSet = new Set(PROTECTED);
  let totalStale = 0;
  const toDelete: string[] = [];

  for (const category of CATEGORIES) {
    const keys = await redis.scanKeys(category.pattern, 50_000);
    const stale: string[] = [];
    for (const key of keys) {
      if (protectedSet.has(key)) continue;
      const ttl = await redis.ttl(key);
      if (category.stale(key, ttl)) stale.push(key);
    }
    totalStale += stale.length;
    toDelete.push(...stale);
    console.log(`  ${category.label}`);
    console.log(`    pattern ${category.pattern} — ${keys.length} matched, ${stale.length} stale`);
    console.log(`    ${category.note}`);
    if (stale.length > 0) {
      console.log(`    e.g. ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? " …" : ""}`);
    }
  }

  console.log("");
  if (totalStale === 0) {
    console.log("Nothing to clean. Redis is tidy.");
  } else if (!APPLY) {
    console.log(`${totalStale} stale key(s) identified. Re-run with --apply to delete them.`);
  } else {
    let deleted = 0;
    for (const key of toDelete) {
      if (protectedSet.has(key)) continue;
      deleted += await redis.del(key);
    }
    console.log(`Deleted ${deleted} stale key(s).`);
  }

  console.log("");
  console.log("Never touched by this script: portfolios, trade history, execution ledger,");
  console.log("journals, and the current strategies' learning rules.");

  await closeRedis();
}

main().catch(async (error) => {
  console.error(`[housekeeping] ${error instanceof Error ? error.message : String(error)}`);
  await closeRedis().catch(() => undefined);
  process.exit(1);
});
