import fs from "fs";
import { PortfolioManager } from "../src/lib/portfolio";
import { buildWalkForwardResearchReport } from "../src/lib/research/walkForward";
import { TRADING_STRATEGY_VERSION } from "../src/lib/trading/executionLedger";
import { closeRedis } from "../src/lib/redis";

function cohortStartFromArgs(): string | undefined {
  const index = process.argv.indexOf("--since");
  if (index < 0) return process.env.PROBATION_STARTED_AT || undefined;
  const value = process.argv[index + 1];
  if (!value || !Number.isFinite(new Date(value).getTime())) {
    throw new Error("--since requires a valid ISO timestamp");
  }
  return value;
}

/**
 * --input <file> reads { schemaVersion: 1, trades } offline, so research can
 * run on a fixture or an exported snapshot without Redis or credentials.
 */
async function loadTrades() {
  const index = process.argv.indexOf("--input");
  if (index < 0) return PortfolioManager.getTrades("ai");
  const file = process.argv[index + 1];
  if (!file) throw new Error("--input requires a file path");
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.trades)) {
    throw new Error(`${file} must be { schemaVersion: 1, trades: Trade[] }`);
  }
  return snapshot.trades;
}

async function main() {
  const trades = await loadTrades();
  const includeAllVersions = process.argv.includes("--all-versions");
  const report = buildWalkForwardResearchReport({
    trades,
    cohortStart: cohortStartFromArgs(),
    strategyVersion: includeAllVersions
      ? undefined
      : process.env.RESEARCH_STRATEGY_VERSION || TRADING_STRATEGY_VERSION,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function run() {
  try {
    await main();
  } finally {
    // Only an online run opened Redis.
    if (!process.argv.includes("--input")) await closeRedis();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
