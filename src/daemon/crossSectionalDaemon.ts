/**
 * Cross-sectional momentum daemon.
 *
 * Two loops, deliberately far apart in frequency:
 *   - Rebalance every `holdHours`, which is when the strategy has anything to
 *     say. Rebalancing more often only adds turnover cost.
 *   - Mark to market every minute so the dashboard and drawdown guard see a
 *     current equity figure between rebalances.
 *
 * Request budget on the free tier is small by design: one tickers call gives
 * every price at once, and momentum needs one kline call per symbol per
 * rebalance. At a 12-hour cadence over 50 symbols that is about a hundred
 * requests a day.
 */
import { Logger } from "../lib/logger";
import { getRedis } from "../lib/redis";
import { buildMomentumSnapshot, fetchTickers } from "../lib/data/perpUniverse";
import { decideBook, DEFAULT_STRATEGY } from "../lib/strategy/crossSectionalMomentum";
import {
  applyBookPlan,
  bookEquityUsd,
  currentWeights,
  getEquityCurve,
  loadBookPortfolio,
  logRebalance,
  recordBookTrades,
  recordEquityPoint,
  recordReconciliation,
  saveBookPortfolio,
  settleFunding,
} from "../lib/execution/bookRebalancer";
import {
  buildCostVerdict,
  settlePendingSlippageSamples,
} from "../lib/execution/costModelReconciliation";
import { summariseRealisedEdge } from "../lib/research/edgeDecay";

const CONFIG = DEFAULT_STRATEGY;
const REBALANCE_INTERVAL_MS = CONFIG.holdHours * 60 * 60 * 1000;
const MARK_INTERVAL_MS = 60_000;
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const LAST_REBALANCE_KEY = "xsec:lastRebalanceAt";
const EQUITY_KEY = "xsec:equity";
const LOCK_KEY = "xsec:lock";
const EDGE_VERDICT_KEY = "xsec:edgeVerdict";
/**
 * Rolling window for live re-validation, in rebalance periods. Thirty 12-hour
 * periods is roughly a fortnight of trading: long enough that a couple of bad
 * days do not dominate, short enough to notice decay while it matters.
 */
const EDGE_WINDOW_PERIODS = 30;

/** Circuit breaker: stop opening new risk if the book bleeds this far. */
const MAX_DRAWDOWN_PERCENT = 25;

let rebalancing = false;
let marking = false;

async function withLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const redis = getRedis();
  const token = `${process.pid}-${Date.now()}`;
  const acquired = await redis.set(LOCK_KEY, token, { ex: 300, nx: true }).catch(() => null);
  if (!acquired) return null;
  try {
    return await fn();
  } finally {
    await redis.compareAndDelete(LOCK_KEY, token).catch(() => undefined);
  }
}

async function runRebalance() {
  if (rebalancing) return;
  rebalancing = true;
  try {
    await withLock(async () => {
      const portfolio = await loadBookPortfolio();

      if (portfolio.maxDrawdownPercent >= MAX_DRAWDOWN_PERCENT) {
        await Logger.warn(
          `[XSEC] drawdown ${portfolio.maxDrawdownPercent.toFixed(1)}% has reached the ${MAX_DRAWDOWN_PERCENT}% circuit breaker; holding the book without adding risk.`
        );
        return;
      }

      const snapshot = await buildMomentumSnapshot({ lookbackHours: CONFIG.lookbackHours });
      if (snapshot.momentum.size < 3 * CONFIG.bookSize) {
        await Logger.warn(
          `[XSEC] only ${snapshot.momentum.size} rankable symbols, need ${3 * CONFIG.bookSize}. Skipping this rebalance rather than trading a thin cross-section.`
        );
        return;
      }

      // Sample equity at the period boundary, before trading, so the return
      // series describes what the last period's book earned rather than what
      // this period's orders cost.
      await recordEquityPoint(portfolio, bookEquityUsd(portfolio, snapshot.prices));
      const edge = await reviewEdge();
      if (edge?.shouldHalt) {
        await Logger.warn(
          `[XSEC] edge re-validation stood the book down: ${edge.explanation} ` +
          `Holding the existing positions and adding no new risk until a window comes back positive.`
        );
        // Deliberately a hold rather than an automatic liquidation. A single
        // negative window is a weak signal on a strategy this noisy, and
        // flattening on it would also deadlock the recovery test: a flat book
        // produces flat returns, which can never clear the bar to resume.
        // Unwinding is left to the owner, who can see this on the dashboard.
        return;
      }

      const weights = currentWeights(portfolio, snapshot.prices);
      const plan = decideBook({ momentumBySymbol: snapshot.momentum, currentWeights: weights, config: CONFIG });
      const result = applyBookPlan({ portfolio, plan, prices: snapshot.prices, config: CONFIG });

      await saveBookPortfolio(portfolio);
      await recordBookTrades(result.trades);
      await recordReconciliation(result.reconciliation);
      await logRebalance(result, plan);
      await getRedis().set(LAST_REBALANCE_KEY, Date.now());
    });
  } catch (error) {
    await Logger.error(`[XSEC] rebalance failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rebalancing = false;
  }
}

/**
 * Re-run the edge test on the book's own realised returns and publish the
 * verdict. A backtest is a claim about the past; this is the running check
 * that the claim still holds.
 */
async function reviewEdge() {
  try {
    const curve = await getEquityCurve();
    if (curve.length < 4) return null;
    const report = summariseRealisedEdge(curve, CONFIG.holdHours, EDGE_WINDOW_PERIODS);
    await getRedis().set(EDGE_VERDICT_KEY, {
      at: new Date().toISOString(),
      verdict: report.verdict,
      explanation: report.explanation,
      baselineMeanBps: report.baselineMeanBps,
      recentMeanBps: report.recentMeanBps,
      retentionRatio: report.retentionRatio,
      trendBpsPerWindow: report.trendBpsPerWindow,
      windowPeriods: EDGE_WINDOW_PERIODS,
      windowsAnalysed: report.windows.length,
      periodsRecorded: curve.length,
      shouldHalt: report.shouldHalt,
    });
    return report;
  } catch (error) {
    await Logger.warn(`[XSEC] edge re-validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function runMark() {
  if (marking) return;
  marking = true;
  try {
    const prices = await fetchTickers();

    // Fills become measurable a minute after execution, so the mark loop is
    // where the cost model gets checked against what the market actually did.
    const settled = await settlePendingSlippageSamples(prices).catch(() => 0);
    if (settled > 0) await buildCostVerdict().catch(() => undefined);

    const portfolio = await loadBookPortfolio();
    const equity = bookEquityUsd(portfolio, prices);

    if (equity > portfolio.peakEquityUsd) {
      portfolio.peakEquityUsd = equity;
      await saveBookPortfolio(portfolio);
    } else if (portfolio.peakEquityUsd > 0) {
      const drawdown = ((portfolio.peakEquityUsd - equity) / portfolio.peakEquityUsd) * 100;
      if (drawdown > portfolio.maxDrawdownPercent) {
        portfolio.maxDrawdownPercent = drawdown;
        await saveBookPortfolio(portfolio);
      }
    }

    const positions = Object.values(portfolio.positions);
    const grossNotional = positions.reduce(
      (sum, p) => sum + Math.abs(p.quantity) * (prices.get(p.symbol)?.markPrice ?? p.entryPrice), 0
    );
    const netNotional = positions.reduce(
      (sum, p) => sum + p.quantity * (prices.get(p.symbol)?.markPrice ?? p.entryPrice), 0
    );

    await getRedis().set(EQUITY_KEY, {
      at: new Date().toISOString(),
      equityUsd: equity,
      cashUsd: portfolio.cashUsd,
      initialCapitalUsd: portfolio.initialCapitalUsd,
      returnPercent: ((equity - portfolio.initialCapitalUsd) / portfolio.initialCapitalUsd) * 100,
      openPositions: positions.length,
      longs: positions.filter((p) => p.quantity > 0).length,
      shorts: positions.filter((p) => p.quantity < 0).length,
      grossNotionalUsd: grossNotional,
      netNotionalUsd: netNotional,
      grossExposure: equity > 0 ? grossNotional / equity : 0,
      netExposure: equity > 0 ? netNotional / equity : 0,
      realizedPnlUsd: portfolio.realizedPnlUsd,
      feesPaidUsd: portfolio.feesPaidUsd,
      fundingPaidUsd: portfolio.fundingPaidUsd,
      maxDrawdownPercent: portfolio.maxDrawdownPercent,
      totalRebalances: portfolio.totalRebalances,
      strategyVersion: portfolio.strategyVersion,
    }, { ex: 300 });
  } catch (error) {
    await Logger.warn(`[XSEC] mark failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    marking = false;
  }
}

async function runFunding() {
  try {
    await withLock(async () => {
      const prices = await fetchTickers();
      const portfolio = await loadBookPortfolio();
      if (Object.keys(portfolio.positions).length === 0) return;
      const paid = settleFunding(portfolio, prices);
      await saveBookPortfolio(portfolio);
      await Logger.info(`[XSEC] funding settled: ${paid >= 0 ? "paid" : "received"} $${Math.abs(paid).toFixed(2)}.`);
    });
  } catch (error) {
    await Logger.warn(`[XSEC] funding settlement failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function maybeRebalance() {
  const last = Number(await getRedis().get<number>(LAST_REBALANCE_KEY).catch(() => 0)) || 0;
  if (Date.now() - last >= REBALANCE_INTERVAL_MS) await runRebalance();
}

async function main() {
  await Logger.info(
    `[XSEC] starting cross-sectional daemon: ${CONFIG.lookbackHours}h momentum, ` +
    `${CONFIG.holdHours}h rebalance, ${CONFIG.bookSize} names per side, ${CONFIG.rankBuffer}x rank buffer.`
  );

  await runMark().catch(() => undefined);
  await maybeRebalance().catch(() => undefined);

  setInterval(() => { void maybeRebalance(); }, 5 * 60 * 1000);
  setInterval(() => { void runMark(); }, MARK_INTERVAL_MS);
  setInterval(() => { void runFunding(); }, FUNDING_INTERVAL_MS);
}

main().catch(async (error) => {
  await Logger.error(`[XSEC] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
