import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { getRedis } from "@/lib/redis";
import { ExecutionLedger } from "@/lib/trading/executionLedger";
import { DEFAULT_RESET_CAPITAL } from "@/lib/admin/resetArena";

/**
 * Reset only the Human paper portfolio.
 *
 * The full arena reset also wipes the AI swing account, the cross-sectional
 * book and the learning journals, and it is refused while a V6 AI run is
 * active. A human who just wants a fresh start should not have to touch any
 * of that, so this clears the human namespace and nothing else.
 *
 * The caller holds the "user" write lock.
 */
export function humanResetKeys(): string[] {
  return ["user:positionOutcomes", "swing:lastExitSweep:user"];
}

export function normalizeResetCapital(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 100 && value <= 1_000_000
    ? value
    : DEFAULT_RESET_CAPITAL;
}

export async function resetHumanPortfolio(input: { capital?: unknown; source: string }) {
  const capital = normalizeResetCapital(input.capital);
  const before = await PortfolioManager.getPortfolio("user", { readOnly: true });
  const closedOpenPositions = Object.keys(before?.openPositions || {}).length
    + Object.keys(before?.scalpPositions || {}).length;

  await PortfolioManager.resetPortfolio("user", capital);
  const redis = getRedis();
  const clearedKeys = humanResetKeys();
  await Promise.all(clearedKeys.map((key) => redis.del(key).catch(() => 0)));

  await ExecutionLedger.recordBestEffort({
    type: "SYSTEM_RESET",
    source: input.source,
    payload: { capital, portfolios: ["user"], discardedOpenPositions: closedOpenPositions, clearedTransientKeys: clearedKeys },
  });
  await Logger.info(`[${input.source}] Human portfolio reset to $${capital.toLocaleString()}. AI and book state untouched.`);
  return { capital, discardedOpenPositions: closedOpenPositions, clearedKeys };
}
