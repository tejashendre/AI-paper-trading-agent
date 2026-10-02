/**
 * Cross-sectional momentum daemon.
 *
 * One serialized cycle every minute, so the daemon's own tasks never contend
 * for the book lock with each other:
 *   - Mark to market (and, when reducing, one staged risk step) every cycle.
 *   - Rebalance when `holdHours` have passed, which is when the strategy has
 *     anything to say. Rebalancing more often only adds turnover cost.
 *   - Look for newly published funding every five minutes.
 * Separate timers with the same period used to collide on the lock in a fixed
 * phase; the loser skipped silently and the 12-hour rebalance stopped for good.
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
  BookPortfolio,
  bookEquityUsd,
  currentWeights,
  getEquityCurve,
  LAST_REBALANCE_KEY,
  loadBookPortfolio,
  logRebalance,
  recordBookTrades,
  recordEquityPoint,
  rebalanceStatus,
  recordReconciliation,
  saveBookPortfolio,
  settleBookFunding,
  SHADOW_BOOK_EQUITY_CURVE_KEY,
  SHADOW_BOOK_PORTFOLIO_KEY,
} from "../lib/execution/bookRebalancer";
import {
  BOOK_RISK_POLICY_VERSION,
  BookRiskDecision,
  epochDrawdownPercent,
  evaluateBookRisk,
  evaluateShadowEvidence,
  makeReduceOnlyPlan,
  PROMOTION_EVIDENCE_PASSED,
} from "../lib/execution/bookRiskPolicy";
import { getEquityCurve as getCurve } from "../lib/execution/equityCurve";
import { ExecutionLedger } from "../lib/trading/executionLedger";
import { FILL_CAPACITY_POLICY } from "../lib/execution/liquidityCost";
import type { PerpTicker } from "../lib/data/perpUniverse";
import { liveFundingDeps } from "../lib/data/bybitPublic";
import {
  buildCostVerdict,
  RECONCILIATION_VERDICT_KEY,
  settlePendingSlippageSamples,
} from "../lib/execution/costModelReconciliation";
import { summariseRealisedEdge } from "../lib/research/edgeDecay";

const CONFIG = DEFAULT_STRATEGY;
const REBALANCE_INTERVAL_MS = CONFIG.holdHours * 60 * 60 * 1000;
const MARK_INTERVAL_MS = 60_000;
/** How often to look for newly published settlements; charges follow each symbol's own boundaries. */
const FUNDING_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const EQUITY_KEY = "xsec:equity";
const LOCK_KEY = "xsec:lock";
const EDGE_VERDICT_KEY = "xsec:edgeVerdict";
/**
 * Rolling window for live re-validation, in rebalance periods. Thirty 12-hour
 * periods is roughly a fortnight of trading: long enough that a couple of bad
 * days do not dominate, short enough to notice decay while it matters.
 */
const EDGE_WINDOW_PERIODS = 30;

/**
 * A documented release, e.g. { authorizedBy, documentedAt, evidence }. The
 * owner chose full autonomy on 2026-10-02, so the daemon writes it itself,
 * but only when the shadow book's evidence gate passes; the evidence and the
 * release are recorded in the ledger. Risk ceilings are unchanged.
 */
const RISK_RELEASE_KEY = "xsec:riskRelease";

let rebalancing = false;
let marking = false;

/** How long a task waits for another holder (a script, a second process) to release the book lock. */
const LOCK_WAIT_MS = 60_000;
const LOCK_RETRY_MS = 250;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` holding the book lock. Waits up to LOCK_WAIT_MS for another holder
 * instead of skipping at once, and says so when it gives up, so contention is
 * visible rather than a task that silently never runs.
 */
async function withLock<T>(fn: () => Promise<T>, task = "task"): Promise<T | null> {
  const redis = getRedis();
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = await redis.set(LOCK_KEY, token, { ex: 300, nx: true }).catch(() => null);
  while (!acquired && Date.now() < deadline) {
    await sleep(LOCK_RETRY_MS);
    acquired = await redis.set(LOCK_KEY, token, { ex: 300, nx: true }).catch(() => null);
  }
  if (!acquired) {
    await Logger.warn(`[XSEC] ${task} deferred: the book lock stayed held for ${LOCK_WAIT_MS / 1000}s.`);
    return null;
  }
  try {
    return await fn();
  } finally {
    await redis.compareAndDelete(LOCK_KEY, token).catch(() => undefined);
  }
}

/**
 * Decide and record the book's risk state before any action. The breaker
 * (25% lifetime drawdown) and a lost edge stop new risk; neither stops the
 * management of risk already held.
 */
async function decideRiskState(portfolio: BookPortfolio, prices: Map<string, PerpTicker> | null, edgeVerdict: string): Promise<BookRiskDecision> {
  const positions = Object.values(portfolio.positions);
  const equity = prices ? bookEquityUsd(portfolio, prices) : null;
  // A released book measures drawdown from the best equity since its release;
  // the lifetime breaker (deeper than the acknowledged level) still applies.
  const epoch = portfolio.riskState?.releaseEpoch;
  if (epoch && equity !== null) epoch.epochPeakEquityUsd = Math.max(epoch.epochPeakEquityUsd, equity);
  const currentDrawdownPercent = equity === null
    ? 0
    : epoch
      ? epochDrawdownPercent(epoch, equity)
      : portfolio.peakEquityUsd > 0 ? Math.max(0, ((portfolio.peakEquityUsd - equity) / portfolio.peakEquityUsd) * 100) : 0;
  const release = await getRedis().get<{ authorizedBy?: string; documentedAt?: string }>(RISK_RELEASE_KEY).catch(() => null);
  const previous = portfolio.riskState?.state ?? "ACTIVE";
  const decision = evaluateBookRisk({
    previous,
    lifetimeMaxDrawdownPercent: portfolio.maxDrawdownPercent,
    currentDrawdownPercent,
    hasOpenPositions: positions.length > 0,
    entryDataReady: Boolean(prices),
    exitDataReady: Boolean(prices),
    edgeVerdict,
    releaseAuthorized: Boolean(release?.authorizedBy && release?.documentedAt),
    breachAcknowledgedAtPercent: portfolio.riskState?.breachAcknowledgedAtPercent,
  });
  const released = previous === "SHADOW" && decision.state === "ACTIVE";
  const halted = (previous === "ACTIVE" || previous === "ENTRY_HALT") && (decision.state === "REDUCE_ONLY" || decision.state === "SHADOW");
  const now = new Date().toISOString();
  portfolio.riskState = {
    ...portfolio.riskState,
    haltedAt: halted ? now : portfolio.riskState?.haltedAt,
    // A new incident ends the release epoch; the next release starts a new one.
    releaseEpoch: halted
      ? undefined
      : released && equity !== null
        ? { releasedAt: now, releaseEquityUsd: equity, epochPeakEquityUsd: equity }
        : portfolio.riskState?.releaseEpoch,
    state: decision.state,
    reasons: decision.reasons,
    allowEntries: decision.allowEntries,
    allowReductions: decision.allowReductions,
    policyVersion: BOOK_RISK_POLICY_VERSION,
    updatedAt: new Date().toISOString(),
    breachAcknowledgedAtPercent: released ? portfolio.maxDrawdownPercent : portfolio.riskState?.breachAcknowledgedAtPercent,
  };
  await saveBookPortfolio(portfolio);
  if (decision.state !== previous) {
    await Logger.warn(`[XSEC] risk state ${previous} -> ${decision.state}: ${decision.reasons.join(" ")}`);
  }
  return decision;
}

/**
 * One staged reduce-only step, sized by the fill capacity limit. Without
 * valid prices the blocked attempt is recorded and retried next sweep; no
 * fill is invented to make the book look flat.
 */
async function reduceOnlyStep(portfolio: BookPortfolio, prices: Map<string, PerpTicker> | null, decision: BookRiskDecision) {
  const at = new Date().toISOString();
  if (!decision.allowReductions || !prices) {
    portfolio.riskState = { ...portfolio.riskState!, lastUnwind: { at, executed: 0, detail: decision.reasons.join(" ") || "no valid prices" } };
    await saveBookPortfolio(portfolio);
    return;
  }
  const plan = makeReduceOnlyPlan({
    positions: Object.values(portfolio.positions),
    prices,
    maxParticipation: FILL_CAPACITY_POLICY.maxTurnoverShare,
    equityUsd: bookEquityUsd(portfolio, prices),
  });
  const result = applyBookPlan({ portfolio, plan, prices, config: CONFIG, reduceOnly: true });
  portfolio.riskState = { ...portfolio.riskState!, lastUnwind: { at, executed: result.executed, detail: plan.reason } };
  await saveBookPortfolio(portfolio);
  await recordBookTrades(result.trades);
  await recordReconciliation(result.reconciliation);
  if (result.executed > 0) await logRebalance(result, plan);
}

/** Every minute: re-check the risk state and, when reducing, take one staged step. */
async function runRiskSweep(prices: Map<string, PerpTicker>) {
  await withLock(async () => {
    const portfolio = await loadBookPortfolio();
    const edge = await getRedis().get<{ verdict?: string }>(EDGE_VERDICT_KEY).catch(() => null);
    const decision = await decideRiskState(portfolio, prices, edge?.verdict ?? "INSUFFICIENT_DATA");
    if (decision.state !== "REDUCE_ONLY") return;
    await settleBookFunding(portfolio, liveFundingDeps).catch(() => undefined);
    await reduceOnlyStep(portfolio, prices, decision);
    // The last close moves a breached book to SHADOW at once.
    if (Object.keys(portfolio.positions).length === 0) await decideRiskState(portfolio, prices, edge?.verdict ?? "INSUFFICIENT_DATA");
  }, "risk sweep");
}

/**
 * For a halted, flat book: judge the shadow book's evidence since the halt.
 * When it passes, write the release record (once per incident) and return
 * the verdict the risk policy needs; otherwise return null.
 */
async function releaseOnShadowEvidence(portfolio: BookPortfolio): Promise<string | null> {
  const haltedAtMs = Date.parse(portfolio.riskState?.haltedAt ?? "") || 0;
  const curve = (await getCurve(SHADOW_BOOK_EQUITY_CURVE_KEY)).filter((point) => Date.parse(point.at) >= haltedAtMs);
  const evidence = evaluateShadowEvidence(curve);
  if (!evidence.passed) return null;
  const redis = getRedis();
  const existing = await redis.get<{ documentedAt?: string }>(RISK_RELEASE_KEY).catch(() => null);
  const existingAtMs = Date.parse(existing?.documentedAt ?? "") || 0;
  if (existingAtMs < haltedAtMs || !existing) {
    const record = {
      authorizedBy: "AUTONOMOUS_EVIDENCE_GATE",
      documentedAt: new Date().toISOString(),
      note: "Shadow book passed the release gate: >=30 periods, positive 95% lower bound on mean net return, drawdown under 15%.",
      evidence,
    };
    await redis.set(RISK_RELEASE_KEY, record);
    await ExecutionLedger.recordBestEffort({ type: "BOOK_RISK_RELEASED", source: "XSEC", payload: record });
    await Logger.warn(`[XSEC] shadow evidence passed; releasing the halted book. ${JSON.stringify(evidence.metrics)}`);
  }
  return PROMOTION_EVIDENCE_PASSED;
}

/** The same plan on a capital-free book, so halted periods still produce forward evidence. */
async function runShadowRebalance(snapshot: Awaited<ReturnType<typeof buildMomentumSnapshot>>) {
  const shadow = await loadBookPortfolio(10_000, SHADOW_BOOK_PORTFOLIO_KEY);
  await settleBookFunding(shadow, liveFundingDeps).catch(() => undefined);
  await recordEquityPoint(shadow, bookEquityUsd(shadow, snapshot.prices), SHADOW_BOOK_EQUITY_CURVE_KEY);
  const plan = decideBook({ momentumBySymbol: snapshot.momentum, currentWeights: currentWeights(shadow, snapshot.prices), config: CONFIG });
  applyBookPlan({ portfolio: shadow, plan, prices: snapshot.prices, config: CONFIG });
  await saveBookPortfolio(shadow, SHADOW_BOOK_PORTFOLIO_KEY);
}

async function runRebalance() {
  if (rebalancing) return;
  rebalancing = true;
  try {
    await withLock(async () => {
      const portfolio = await loadBookPortfolio();

      // Equity sampling, funding and the edge review run in every risk state,
      // so a halted book keeps an up-to-date verdict.
      const prices = await fetchTickers().catch(() => null);
      if (prices) await recordEquityPoint(portfolio, bookEquityUsd(portfolio, prices));
      await settleBookFunding(portfolio, liveFundingDeps).catch(() => undefined);
      const edge = await reviewEdge();
      const shadowVerdict = portfolio.riskState?.state === "SHADOW" ? await releaseOnShadowEvidence(portfolio) : null;
      const decision = await decideRiskState(portfolio, prices, shadowVerdict ?? edge?.verdict ?? "INSUFFICIENT_DATA");

      if (decision.state === "REDUCE_ONLY") {
        await reduceOnlyStep(portfolio, prices, decision);
        await getRedis().set(LAST_REBALANCE_KEY, Date.now());
        return;
      }

      const snapshot = await buildMomentumSnapshot({ lookbackHours: CONFIG.lookbackHours }).catch(() => null);
      if (!snapshot || snapshot.momentum.size < 3 * CONFIG.bookSize) {
        await Logger.warn(
          `[XSEC] only ${snapshot?.momentum.size ?? 0} rankable symbols, need ${3 * CONFIG.bookSize}. Skipping this rebalance rather than trading a thin cross-section.`
        );
        await getRedis().set(LAST_REBALANCE_KEY, Date.now());
        return;
      }

      const plan = decideBook({ momentumBySymbol: snapshot.momentum, currentWeights: currentWeights(portfolio, snapshot.prices), config: CONFIG });
      if (decision.allowEntries || decision.allowReductions) {
        // ENTRY_HALT keeps managing what it holds: only orders that reduce.
        const result = applyBookPlan({ portfolio, plan, prices: snapshot.prices, config: CONFIG, reduceOnly: !decision.allowEntries });
        await saveBookPortfolio(portfolio);
        await recordBookTrades(result.trades);
        await recordReconciliation(result.reconciliation);
        await logRebalance(result, plan);
      }
      if (decision.state !== "ACTIVE") await runShadowRebalance(snapshot);
      await getRedis().set(LAST_REBALANCE_KEY, Date.now());
    }, "rebalance");
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
    // Rebuild when new fills settled, and also whenever no verdict is stored at
    // all, so a restart or a cleared key recovers on the next mark instead of
    // waiting for the next rebalance twelve hours away.
    const haveVerdict = await getRedis().get(RECONCILIATION_VERDICT_KEY).catch(() => null);
    if (settled > 0 || !haveVerdict) await buildCostVerdict().catch(() => undefined);

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
      riskState: portfolio.riskState?.state ?? "ACTIVE",
    }, { ex: 300 });
    await runRiskSweep(prices).catch((error) =>
      Logger.warn(`[XSEC] risk sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    );
  } catch (error) {
    await Logger.warn(`[XSEC] mark failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    marking = false;
  }
}

async function runFunding() {
  try {
    await withLock(async () => {
      const portfolio = await loadBookPortfolio();
      if (Object.keys(portfolio.positions).length === 0 && !(portfolio.fundingTail?.length)) return;
      const before = portfolio.fundingPaidUsd;
      const outcome = await settleBookFunding(portfolio, liveFundingDeps);
      if (outcome.booked > 0) {
        await saveBookPortfolio(portfolio);
        const paid = portfolio.fundingPaidUsd - before;
        await Logger.info(`[XSEC] ${outcome.booked} funding settlement(s): ${paid >= 0 ? "paid" : "received"} $${Math.abs(paid).toFixed(2)}.`);
      }
      if (outcome.pending > 0 || outcome.errors.length > 0) {
        await Logger.warn(`[XSEC] funding pending reconciliation: ${outcome.pending} boundary(ies). ${outcome.errors.join("; ")}`.trim());
      }
    }, "funding");
  } catch (error) {
    await Logger.warn(`[XSEC] funding settlement failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function maybeRebalance() {
  const last = Number(await getRedis().get<number>(LAST_REBALANCE_KEY).catch(() => 0)) || 0;
  if (Date.now() - last >= REBALANCE_INTERVAL_MS) await runRebalance();
}

let lastFundingCheckAt = 0;

/**
 * One pass of every task, in order. Each awaits the previous, so the daemon
 * never contends with itself for the book lock.
 */
async function runCycle() {
  await runMark().catch(() => undefined);
  await maybeRebalance().catch(() => undefined);
  if (Date.now() - lastFundingCheckAt >= FUNDING_CHECK_INTERVAL_MS) {
    lastFundingCheckAt = Date.now();
    await runFunding().catch(() => undefined);
  }
}

async function main() {
  await Logger.info(
    `[XSEC] starting cross-sectional daemon: ${CONFIG.lookbackHours}h momentum, ` +
    `${CONFIG.holdHours}h rebalance, ${CONFIG.bookSize} names per side, ${CONFIG.rankBuffer}x rank buffer.`
  );
  // Schedule the next cycle only after this one finishes, so a slow
  // rebalance delays the next mark instead of overlapping it.
  const loop = async () => {
    try {
      await runCycle();
    } catch (error) {
      await Logger.error(`[XSEC] cycle failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
    } finally {
      // The next cycle is always scheduled, whatever this one did.
      setTimeout(() => { void loop(); }, MARK_INTERVAL_MS);
    }
  };
  await loop();
}

export { decideRiskState, rebalanceStatus, runCycle, runRebalance, runRiskSweep };

if (require.main === module) main().catch(async (error) => {
  await Logger.error(`[XSEC] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
