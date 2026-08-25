/**
 * Clean-slate reset from the command line, for use during a deploy.
 *
 * Calls exactly the same code as the admin API route, so a reset run on the
 * box and a reset clicked in the dashboard leave the system in an identical
 * state. Requires --confirm, because it destroys the paper trading history.
 *
 *   npm run reset:arena                    # shows what would be cleared
 *   npm run reset:arena -- --confirm       # actually resets to $10,000
 *   npm run reset:arena -- --confirm --capital 100000
 */
import { PortfolioManager } from "@/lib/portfolio";
import { closeRedis } from "@/lib/redis";
import {
  DEFAULT_RESET_CAPITAL,
  resetArena,
  transientResetKeys,
} from "@/lib/admin/resetArena";

const args = process.argv.slice(2);
const CONFIRMED = args.includes("--confirm");

function readCapital(): number {
  const inline = args.find((a) => a.startsWith("--capital="));
  if (inline) return Number(inline.slice("--capital=".length));
  const index = args.indexOf("--capital");
  if (index >= 0 && args[index + 1]) return Number(args[index + 1]);
  return DEFAULT_RESET_CAPITAL;
}

async function main() {
  const capital = readCapital();
  const keys = transientResetKeys();

  console.log("Arena reset");
  console.log("===========");
  console.log(`Starting capital : $${capital.toLocaleString()}`);
  console.log("Portfolios reset : Human, AI swing, cross-sectional book");
  console.log("Derived state    : local learning rules, opportunity journal, trade-review journal");
  console.log(`Transient keys   : ${keys.length}`);
  for (const key of keys) console.log(`  - ${key}`);
  console.log("");
  console.log("Preserved        : execution ledger history (a reset is recorded in it, not erased from it)");
  console.log("");

  if (!CONFIRMED) {
    console.log("Dry run. Nothing was changed. Re-run with --confirm to apply.");
    await closeRedis();
    return;
  }

  // Take the same write locks the API route takes, so a reset cannot land in
  // the middle of a scan and get half-overwritten by the daemon's own save.
  const aiRelease = await PortfolioManager.acquireWriteLock("ai");
  if (!aiRelease) {
    console.error("AI portfolio is locked by a running scan. Stop the daemons or retry shortly.");
    await closeRedis();
    process.exit(1);
  }
  const userRelease = await PortfolioManager.acquireWriteLock("user");
  if (!userRelease) {
    await aiRelease();
    console.error("User portfolio is locked. Retry shortly.");
    await closeRedis();
    process.exit(1);
  }

  try {
    const result = await resetArena({ capital, source: "CLI_DEPLOY" });
    console.log(`Reset complete. ${result.clearedKeys.length} keys cleared.`);
    console.log(`Swing strategy : ${result.swingStrategyVersion}`);
    console.log(`Book strategy  : ${result.bookStrategyVersion}`);
    console.log("");
    console.log("Both strategies now start from the same capital on the same date,");
    console.log("so the comparison between them is meaningful from here on.");
  } finally {
    await userRelease();
    await aiRelease();
    await closeRedis();
  }
}

main().catch(async (error) => {
  console.error(`[reset] ${error instanceof Error ? error.message : String(error)}`);
  await closeRedis().catch(() => undefined);
  process.exit(1);
});
