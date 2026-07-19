import { PortfolioManager } from "../src/lib/portfolio";
import { buildWalkForwardResearchReport } from "../src/lib/research/walkForward";
import { TRADING_STRATEGY_VERSION } from "../src/lib/trading/executionLedger";

function cohortStartFromArgs(): string | undefined {
  const index = process.argv.indexOf("--since");
  if (index < 0) return process.env.PROBATION_STARTED_AT || undefined;
  const value = process.argv[index + 1];
  if (!value || !Number.isFinite(new Date(value).getTime())) {
    throw new Error("--since requires a valid ISO timestamp");
  }
  return value;
}

async function main() {
  const trades = await PortfolioManager.getTrades("ai");
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
