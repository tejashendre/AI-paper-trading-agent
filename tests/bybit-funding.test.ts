import test from "node:test";
import assert from "node:assert/strict";
import {
  expectedFundingTimes,
  FundingSettlement,
  fundingCashflow,
  planFundingCashflows,
  quantityHeldAt,
} from "@/lib/trading/executionCostModel";
import {
  drainPendingLedgerEvents,
  exitCashSettlement,
  settleOpenPositionFunding,
} from "@/lib/execution/swingLifecycle";
import { emptyBookPortfolio, settleBookFunding } from "@/lib/execution/bookRebalancer";
import { autonomousPositionIdentity } from "@/lib/trading/assetSpecs";
import { getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";
import type { OpenPosition, Portfolio } from "@/lib/types";

const H = 3_600_000;
const DAY0 = Date.parse("2026-09-30T00:00:00.000Z");
const settlement = (atMs: number, rate = 0.0001, markPrice = 100, symbol = "XAUUSDT"): FundingSettlement => ({
  symbol, settlementTimeMs: atMs, rate, markPrice,
});

test("funding_is_signed_boundary_based_and_once_only", async (t) => {
  await t.test("two four-hour settlements on 1,000 notional", () => {
    const one = settlement(DAY0 + 4 * H);
    assert.ok(Math.abs(fundingCashflow({ direction: "LONG", quantity: 10, settlement: one }) + 0.1) < 1e-12);
    assert.ok(Math.abs(fundingCashflow({ direction: "SHORT", quantity: 10, settlement: one }) - 0.1) < 1e-12);
    const plan = planFundingCashflows({
      positionId: "p1", symbol: "XAUUSDT",
      positionAt: (atMs) => ({ direction: "LONG", quantity: quantityHeldAt([{ atMs: DAY0 + H, quantityDelta: 10 }], atMs) }),
      settlements: [settlement(DAY0 + 4 * H), settlement(DAY0 + 8 * H)],
      settledTimes: [], fromMs: DAY0 + H, toMs: DAY0 + 9 * H, intervalMinutes: 240, nowMs: DAY0 + 9 * H, fetchSucceeded: true,
    });
    assert.equal(plan.events.length, 2);
    assert.ok(Math.abs(plan.events.reduce((sum, e) => sum + e.amountUsdt, 0) + 0.2) < 1e-12);
  });

  await t.test("a negative rate reverses the signs", () => {
    const negative = settlement(DAY0 + 4 * H, -0.0001);
    assert.ok(fundingCashflow({ direction: "LONG", quantity: 10, settlement: negative }) > 0);
    assert.ok(fundingCashflow({ direction: "SHORT", quantity: 10, settlement: negative }) < 0);
  });

  await t.test("boundaries are UTC aligned to each symbol's own interval", () => {
    assert.deepEqual(expectedFundingTimes(DAY0, DAY0 + 9 * H, 240), [DAY0 + 4 * H, DAY0 + 8 * H]);
    assert.deepEqual(expectedFundingTimes(DAY0, DAY0 + 17 * H, 480), [DAY0 + 8 * H, DAY0 + 16 * H]);
    // The start is exclusive, the end inclusive.
    assert.deepEqual(expectedFundingTimes(DAY0 + 8 * H, DAY0 + 16 * H, 480), [DAY0 + 16 * H]);
  });

  await t.test("entry after a boundary owes nothing for it; exit before the next owes nothing for that", () => {
    const legs = [{ atMs: DAY0 + H, quantityDelta: 10 }, { atMs: DAY0 + 7 * H, quantityDelta: -10 }];
    const plan = planFundingCashflows({
      positionId: "p2", symbol: "XAUUSDT",
      positionAt: (atMs) => ({ direction: "LONG", quantity: quantityHeldAt(legs, atMs) }),
      settlements: [settlement(DAY0), settlement(DAY0 + 4 * H), settlement(DAY0 + 8 * H)],
      settledTimes: [], fromMs: DAY0 - H, toMs: DAY0 + 9 * H, intervalMinutes: 240, nowMs: DAY0 + 9 * H, fetchSucceeded: true,
    });
    assert.deepEqual(plan.events.map((e) => e.settlementTimeMs), [DAY0 + 4 * H]);
  });

  await t.test("at a shared timestamp the settlement precedes the fills", () => {
    const enteredAtBoundary = [{ atMs: DAY0 + 4 * H, quantityDelta: 10 }];
    assert.equal(quantityHeldAt(enteredAtBoundary, DAY0 + 4 * H), 0, "an entry at the boundary owes nothing");
    const closedAtBoundary = [{ atMs: DAY0 + H, quantityDelta: 10 }, { atMs: DAY0 + 4 * H, quantityDelta: -10 }];
    assert.equal(quantityHeldAt(closedAtBoundary, DAY0 + 4 * H), 10, "a close at the boundary still pays");
  });

  await t.test("a partial exit changes only the quantity held at later boundaries", () => {
    const legs = [{ atMs: DAY0 + H, quantityDelta: 10 }, { atMs: DAY0 + 5 * H, quantityDelta: -3.5 }];
    const plan = planFundingCashflows({
      positionId: "p3", symbol: "XAUUSDT",
      positionAt: (atMs) => ({ direction: "LONG", quantity: quantityHeldAt(legs, atMs) }),
      settlements: [settlement(DAY0 + 4 * H), settlement(DAY0 + 8 * H)],
      settledTimes: [], fromMs: DAY0 + H, toMs: DAY0 + 9 * H, intervalMinutes: 240, nowMs: DAY0 + 9 * H, fetchSucceeded: true,
    });
    assert.deepEqual(plan.events.map((e) => e.quantity), [10, 6.5]);
  });

  await t.test("restart and replay never charge the same boundary twice", () => {
    const input = {
      positionId: "p4", symbol: "XAUUSDT",
      positionAt: () => ({ direction: "LONG" as const, quantity: 10 }),
      // The same settlement arrives twice, as on a replayed history page.
      settlements: [settlement(DAY0 + 4 * H), settlement(DAY0 + 4 * H), settlement(DAY0 + 8 * H)],
      fromMs: DAY0 + H, toMs: DAY0 + 9 * H, intervalMinutes: 240, nowMs: DAY0 + 9 * H, fetchSucceeded: true,
    };
    const first = planFundingCashflows({ ...input, settledTimes: [] });
    assert.equal(first.events.length, 2);
    assert.equal(new Set(first.events.map((e) => e.id)).size, 2);
    const second = planFundingCashflows({ ...input, settledTimes: first.events.map((e) => e.settlementTimeMs) });
    assert.deepEqual(second.events, []);
  });

  await t.test("missing settlement data is pending, never a zero charge", () => {
    const base = {
      positionId: "p5", symbol: "XAUUSDT",
      positionAt: () => ({ direction: "LONG" as const, quantity: 10 }),
      settledTimes: [], fromMs: DAY0 + H, toMs: DAY0 + 9 * H, intervalMinutes: 240, nowMs: DAY0 + 9 * H,
    };
    const failed = planFundingCashflows({ ...base, settlements: [], fetchSucceeded: false });
    assert.deepEqual(failed.events, []);
    assert.deepEqual(failed.pendingTimes, [DAY0 + 4 * H, DAY0 + 8 * H]);
    const gap = planFundingCashflows({ ...base, settlements: [settlement(DAY0 + 4 * H)], fetchSucceeded: true });
    assert.deepEqual(gap.events.map((e) => e.settlementTimeMs), [DAY0 + 4 * H]);
    assert.deepEqual(gap.pendingTimes, [DAY0 + 8 * H]);
    const noMark = planFundingCashflows({ ...base, settlements: [settlement(DAY0 + 4 * H, 0.0001, Number.NaN)], fetchSucceeded: true });
    assert.deepEqual(noMark.events, []);
    assert.ok(noMark.pendingTimes.includes(DAY0 + 4 * H));
  });
});

function portfolioWith(positions: Record<string, OpenPosition>): Portfolio {
  return {
    usd: 9_000, btc: 0, balances: {}, openPositions: positions, openPosition: null, peakValue: 10_000, initialCapital: 10_000,
    totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, grossProfit: 0, grossLoss: 0, consecutiveWins: 0,
    consecutiveLosses: 0, maxConsecutiveWins: 0, maxConsecutiveLosses: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
    returns: [], totalCarryPaid: 0, lastUpdated: new Date(DAY0).toISOString(),
  };
}

function goldPosition(): OpenPosition {
  return {
    asset: "GOLD", entryPrice: 100, amount: 10, btcAmount: 10, usdInvested: 333.33, stopLoss: 95, takeProfit: 110,
    entryTime: new Date(DAY0 + H).toISOString(), signalScore: 70, reasoning: "fixture", direction: "LONG",
    strategyType: "swing", entryFeePaid: 0.275,
    ...autonomousPositionIdentity({ instrument: getConfiguredInstrument("GOLD"), initialRiskUsdt: 50, costModelVersion: "c", positionId: "gold-1" }),
    quantityLegs: [{ atMs: DAY0 + H, quantityDelta: 10 }],
  };
}

const fakeFunding = (available: FundingSettlement[], fail = false) => ({
  settlements: async (symbol: string, fromMs: number, toMs: number) => {
    if (fail) throw new Error("Bybit funding history unavailable");
    return available.filter((s) => s.symbol === symbol && s.settlementTimeMs > fromMs && s.settlementTimeMs <= toMs);
  },
  intervalMinutes: async () => 240,
});

test("settlement_application_is_atomic_and_idempotent", async () => {
  const portfolio = portfolioWith({ GOLD: goldPosition() });
  const deps = { nowMs: () => DAY0 + 9 * H, ...fakeFunding([settlement(DAY0 + 4 * H), settlement(DAY0 + 8 * H)]) };
  const first = await settleOpenPositionFunding(portfolio, deps);
  assert.equal(first.booked, 2);
  const pos = portfolio.openPositions.GOLD;
  assert.ok(Math.abs(portfolio.usd - (9_000 - 0.2)) < 1e-9, "cash moves with the settlement");
  assert.ok(Math.abs(pos.fundingBookedUsdt! + 0.2) < 1e-12);
  assert.deepEqual(pos.fundingSettledTimes, [DAY0 + 4 * H, DAY0 + 8 * H]);
  // Cash, processed boundaries and the ledger events live in one object, so one write persists all three.
  assert.deepEqual(portfolio.pendingLedgerEvents!.map((e) => e.id), ["funding:gold-1:XAUUSDT:" + (DAY0 + 4 * H), "funding:gold-1:XAUUSDT:" + (DAY0 + 8 * H)]);

  const again = await settleOpenPositionFunding(portfolio, deps);
  assert.equal(again.booked, 0);
  assert.ok(Math.abs(portfolio.usd - (9_000 - 0.2)) < 1e-9, "a restart does not charge again");
  assert.equal(portfolio.pendingLedgerEvents!.length, 2);

  const outage = portfolioWith({ GOLD: goldPosition() });
  const pending = await settleOpenPositionFunding(outage, { nowMs: () => DAY0 + 9 * H, ...fakeFunding([], true) });
  assert.equal(pending.booked, 0);
  assert.equal(outage.usd, 9_000, "no invented zero-cost settlement");
  assert.deepEqual(outage.openPositions.GOLD.fundingPendingTimes, [DAY0 + 4 * H, DAY0 + 8 * H]);

  const legacy = portfolioWith({ EURUSD: { ...goldPosition(), asset: "EURUSD", instrument: undefined, economicsModel: undefined, quantityLegs: undefined } });
  await settleOpenPositionFunding(legacy, deps);
  assert.equal(legacy.usd, 9_000, "legacy positions keep the synthetic carry path");
});

test("pending_ledger_events_drain_once_across_a_crash", async () => {
  const portfolio = portfolioWith({ GOLD: goldPosition() });
  await settleOpenPositionFunding(portfolio, { nowMs: () => DAY0 + 9 * H, ...fakeFunding([settlement(DAY0 + 4 * H), settlement(DAY0 + 8 * H)]) });
  const recorded: string[] = [];
  const ledger = {
    hasEvent: async (id: string) => recorded.includes(id),
    record: async (event: { id?: string }) => { recorded.push(event.id!); },
  };
  let persistCalls = 0;
  // The process dies after the first ledger append, before persisting the drain.
  await assert.rejects(drainPendingLedgerEvents(portfolio, ledger, async () => {
    persistCalls += 1;
    throw new Error("crash");
  }));
  assert.equal(recorded.length, 1);
  assert.equal(portfolio.pendingLedgerEvents!.length, 2, "the in-memory drain is lost with the process");
  const drained = await drainPendingLedgerEvents(portfolio, ledger, async () => { persistCalls += 1; });
  assert.equal(drained, 1);
  assert.deepEqual(recorded.sort(), portfolio.openPositions.GOLD.fundingSettledTimes!.map((t) => `funding:gold-1:XAUUSDT:${t}`).sort());
  assert.equal(portfolio.pendingLedgerEvents!.length, 0);
  assert.ok(persistCalls >= 2);
});

test("lifecycle_cash_is_conserved_with_fees_and_funding_counted_once", async () => {
  const startUsd = 10_000;
  const pos = goldPosition();
  const portfolio = portfolioWith({});
  portfolio.usd = startUsd - pos.usdInvested - pos.entryFeePaid!; // entry debit
  portfolio.openPositions.GOLD = pos;
  const deps = (now: number) => ({ nowMs: () => now, ...fakeFunding([settlement(DAY0 + 4 * H), settlement(DAY0 + 8 * H, -0.0003), settlement(DAY0 + 12 * H)]) });

  await settleOpenPositionFunding(portfolio, deps(DAY0 + 6 * H));
  const partial = exitCashSettlement({ pos, fraction: 0.35, grossPnl: 0.35 * 10 * 5, exitFeeUsd: 0.05, legacyCarryUsd: 0 });
  portfolio.usd += partial.cashDelta;
  pos.amount *= 0.65;
  pos.usdInvested *= 0.65;
  pos.entryFeePaid = pos.entryFeePaid! - partial.entryFeeShare;
  pos.fundingAllocatedUsdt = (pos.fundingAllocatedUsdt ?? 0) + partial.fundingAllocatedUsdt;
  pos.quantityLegs!.push({ atMs: DAY0 + 6 * H, quantityDelta: -3.5 });

  await settleOpenPositionFunding(portfolio, deps(DAY0 + 13 * H));
  const final = exitCashSettlement({ pos, fraction: 1, grossPnl: 6.5 * 2, exitFeeUsd: 0.04, legacyCarryUsd: 0 });
  portfolio.usd += final.cashDelta;

  const fundingTotal = pos.fundingBookedUsdt!;
  // 10 held at +4h (-0.1), 6.5 at +8h (+0.195 received), 6.5 at +12h (-0.065).
  assert.ok(Math.abs(fundingTotal - (-0.1 + 0.195 - 0.065)) < 1e-12, `funding ${fundingTotal}`);
  assert.ok(Math.abs(partial.fundingAllocatedUsdt + final.fundingAllocatedUsdt - fundingTotal) < 1e-12, "funding is allocated exactly once");
  assert.ok(Math.abs(portfolio.usd - startUsd - (partial.netPnl + final.netPnl)) < 1e-9, "cash change equals the sum of leg results");
  const fees = 0.275 + 0.05 + 0.04;
  assert.ok(Math.abs(partial.netPnl + final.netPnl - (17.5 + 13 - fees + fundingTotal)) < 1e-9, "fees are counted once");
});

test("book_funding_uses_actual_boundaries_and_variable_intervals", async () => {
  const portfolio = emptyBookPortfolio(10_000);
  portfolio.positions.DOGEUSDT = {
    symbol: "DOGEUSDT", quantity: -1_000, entryPrice: 0.2, notionalUsd: 200, weight: -0.02,
    openedAt: new Date(DAY0 + H).toISOString(), lastRebalancedAt: new Date(DAY0 + H).toISOString(),
    feesPaidUsd: 0, fundingPaidUsd: 0, realizedPnlUsd: 0,
    quantityHistory: [{ atMs: DAY0 + H, quantity: -1_000 }],
  };
  portfolio.positions.PEPEUSDT = {
    symbol: "PEPEUSDT", quantity: 100_000, entryPrice: 0.001, notionalUsd: 100, weight: 0.01,
    openedAt: new Date(DAY0 + H).toISOString(), lastRebalancedAt: new Date(DAY0 + H).toISOString(),
    feesPaidUsd: 0, fundingPaidUsd: 0, realizedPnlUsd: 0,
    quantityHistory: [{ atMs: DAY0 + H, quantity: 100_000 }],
  };
  const settlements = [
    settlement(DAY0 + 8 * H, 0.0001, 0.2, "DOGEUSDT"),
    settlement(DAY0 + 4 * H, 0.0002, 0.001, "PEPEUSDT"),
    settlement(DAY0 + 8 * H, 0.0002, 0.001, "PEPEUSDT"),
  ];
  const deps = {
    nowMs: () => DAY0 + 9 * H,
    settlements: async (symbol: string, fromMs: number, toMs: number) =>
      settlements.filter((s) => s.symbol === symbol && s.settlementTimeMs > fromMs && s.settlementTimeMs <= toMs),
    intervalMinutes: async (symbol: string) => (symbol === "PEPEUSDT" ? 240 : 480),
  };
  const cashBefore = portfolio.cashUsd;
  const first = await settleBookFunding(portfolio, deps);
  assert.equal(first.booked, 3);
  // Short DOGE receives 0.02; long PEPE pays 0.02 twice.
  assert.ok(Math.abs(portfolio.cashUsd - cashBefore - (0.02 - 0.04)) < 1e-12, `cash ${portfolio.cashUsd - cashBefore}`);
  await settleBookFunding(portfolio, deps);
  assert.ok(Math.abs(portfolio.cashUsd - cashBefore - (0.02 - 0.04)) < 1e-12, "idempotent across runs");
});
