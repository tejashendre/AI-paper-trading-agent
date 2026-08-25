import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { getRedis } from "@/lib/redis";
import { ExecutionLedger, TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import { LocalLearningMemory } from "@/lib/trading/localLearning";
import { OpportunityJournal } from "@/lib/trading/opportunityJournal";
import { TradeReviewJournal } from "@/lib/trading/tradeReviewJournal";
import { SUPPORTED_ASSETS } from "@/lib/market";
import {
  BOOK_PORTFOLIO_KEY,
  BOOK_SNAPSHOT_KEY,
  BOOK_TRADES_KEY,
} from "@/lib/execution/bookRebalancer";
import { CROSS_SECTIONAL_STRATEGY_VERSION } from "@/lib/strategy/crossSectionalMomentum";

/**
 * The one implementation of a full arena reset, shared by the admin API route
 * and the CLI. Two copies of this would drift, and a reset that clears
 * different things depending on how it was invoked is worse than no reset:
 * you would never be sure what the next measurement actually started from.
 */

export const DEFAULT_RESET_CAPITAL = 10_000;

export interface ResetResult {
  capital: number;
  clearedKeys: string[];
  swingStrategyVersion: string;
  bookStrategyVersion: string;
}

/**
 * Every key that must not survive a clean slate.
 *
 * Lifetime counters are included deliberately. Leaving them behind is what
 * produced a dashboard reporting 105,642 scan cycles against a handful of
 * trades — the effort counter survived every reset the trade history did not,
 * so the two numbers described different lifetimes.
 */
export function transientResetKeys(): string[] {
  return [
    ...Object.keys(SUPPORTED_ASSETS).map((asset) => `swing:cooldown:${asset}`),
    "swing:lastExitSweep:ai",
    "swing:lastExitSweep:user",
    "swing:scan:request",
    "swing:lifetimeStats:ai",
    "swing:lastScan:ai",
    // The cross-sectional book keeps its own namespace. A reset that does not
    // name it would leave a live book running against a freshly zeroed
    // swing portfolio, and its equity curve would start mid-trade.
    BOOK_PORTFOLIO_KEY,
    BOOK_TRADES_KEY,
    BOOK_SNAPSHOT_KEY,
    "xsec:equity",
    "xsec:lastRebalanceAt",
    "xsec:lock",
  ];
}

/**
 * Reset both paper portfolios, the cross-sectional book, and every piece of
 * derived strategy state built from the old trade history.
 *
 * Callers are responsible for holding the portfolio write locks: the API route
 * acquires them so a reset cannot race an in-flight scan, and the CLI does the
 * same before calling in.
 */
export async function resetArena(input: {
  capital?: number;
  source: string;
}): Promise<ResetResult> {
  const capital = Number.isFinite(input.capital) && (input.capital as number) >= 100 && (input.capital as number) <= 1_000_000
    ? (input.capital as number)
    : DEFAULT_RESET_CAPITAL;

  await Promise.all([
    PortfolioManager.resetPortfolio("user", capital),
    PortfolioManager.resetPortfolio("ai", capital),
  ]);

  // Learning rules, the opportunity journal and the trade-review journal are
  // all derived from closed trades. Carrying them across a reset would mean
  // the new strategy inherits conclusions drawn from the old one's mistakes —
  // which is exactly how the live bot ended up with a -12 learning adjustment
  // that disabled its own entry paths.
  await Promise.all([
    LocalLearningMemory.clearCurrentStrategyState(),
    OpportunityJournal.clearCurrentStrategyState(),
    TradeReviewJournal.clearCurrentStrategyState(),
  ]);

  const redis = getRedis();
  const clearedKeys = transientResetKeys();
  await Promise.all(clearedKeys.map((key) => redis.del(key).catch(() => 0)));

  await ExecutionLedger.recordBestEffort({
    type: "SYSTEM_RESET",
    source: input.source,
    payload: {
      capital,
      portfolios: ["user", "ai", "xsec"],
      clearedStrategyVersion: TRADING_STRATEGY_VERSION,
      clearedBookStrategyVersion: CROSS_SECTIONAL_STRATEGY_VERSION,
      clearedTransientKeys: clearedKeys,
      preservedVersionedHistory: true,
    },
  });

  await Logger.info(
    `[${input.source}] Arena reset. Human, AI swing and cross-sectional book all set to $${capital.toLocaleString()}. ` +
    `${clearedKeys.length} transient keys cleared.`
  );

  return {
    capital,
    clearedKeys,
    swingStrategyVersion: TRADING_STRATEGY_VERSION,
    bookStrategyVersion: CROSS_SECTIONAL_STRATEGY_VERSION,
  };
}
