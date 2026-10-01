import test from "node:test";
import assert from "node:assert/strict";
import { BOOK_HARD_DRAWDOWN_PERCENT, evaluateBookRisk, makeReduceOnlyPlan } from "@/lib/execution/bookRiskPolicy";
import { applyBookPlan, BookPosition, bookEquityUsd, emptyBookPortfolio } from "@/lib/execution/bookRebalancer";
import type { PerpTicker } from "@/lib/data/perpUniverse";

const base = {
  previous: "ACTIVE" as const,
  lifetimeMaxDrawdownPercent: 5,
  currentDrawdownPercent: 2,
  hasOpenPositions: true,
  entryDataReady: true,
  exitDataReady: true,
  edgeVerdict: "NO_ESTABLISHED_EDGE",
  releaseAuthorized: false,
};

test("drawdown_breach_does_not_freeze_existing_risk", async (t) => {
  await t.test("a breached book with open positions reduces, it does not hold", () => {
    assert.equal(BOOK_HARD_DRAWDOWN_PERCENT, 25);
    const decision = evaluateBookRisk({ ...base, lifetimeMaxDrawdownPercent: 28.152, currentDrawdownPercent: 26 });
    assert.equal(decision.state, "REDUCE_ONLY");
    assert.equal(decision.allowEntries, false);
    assert.equal(decision.allowReductions, true);
    assert.ok(decision.reasons.some((r) => r.startsWith("DRAWDOWN_BREACH")), decision.reasons.join("; "));
  });

  await t.test("recovered equity does not erase the breach or restore ACTIVE", () => {
    const decision = evaluateBookRisk({ ...base, previous: "REDUCE_ONLY", lifetimeMaxDrawdownPercent: 28.152, currentDrawdownPercent: 0 });
    assert.equal(decision.state, "REDUCE_ONLY");
    assert.equal(decision.allowEntries, false);
  });

  await t.test("without valid exit data, reductions wait with a reason", () => {
    const decision = evaluateBookRisk({ ...base, lifetimeMaxDrawdownPercent: 28.152, exitDataReady: false });
    assert.equal(decision.state, "REDUCE_ONLY");
    assert.equal(decision.allowReductions, false);
    assert.ok(decision.reasons.some((r) => r.startsWith("EXIT_DATA_UNAVAILABLE")));
  });

  await t.test("the final close moves a breached book to SHADOW", () => {
    const decision = evaluateBookRisk({ ...base, previous: "REDUCE_ONLY", lifetimeMaxDrawdownPercent: 28.152, hasOpenPositions: false });
    assert.equal(decision.state, "SHADOW");
    assert.equal(decision.allowEntries, false);
  });

  await t.test("SHADOW needs both release authorization and promotion evidence", () => {
    const shadow = { ...base, previous: "SHADOW" as const, lifetimeMaxDrawdownPercent: 28.152, hasOpenPositions: false };
    assert.equal(evaluateBookRisk({ ...shadow, releaseAuthorized: true }).state, "SHADOW");
    const evidenceOnly = evaluateBookRisk({ ...shadow, edgeVerdict: "PROMOTION_EVIDENCE_PASSED" });
    assert.equal(evidenceOnly.state, "SHADOW");
    assert.ok(evidenceOnly.reasons.some((r) => r.startsWith("ELIGIBLE_FOR_REVIEW")), evidenceOnly.reasons.join("; "));
    const released = evaluateBookRisk({ ...shadow, releaseAuthorized: true, edgeVerdict: "PROMOTION_EVIDENCE_PASSED" });
    assert.equal(released.state, "ACTIVE");
    assert.equal(released.allowEntries, true);
    // After release the reviewed level is acknowledged; only a deeper breach reopens it.
    const after = { ...base, previous: "ACTIVE" as const, lifetimeMaxDrawdownPercent: 28.152, breachAcknowledgedAtPercent: 28.152, currentDrawdownPercent: 3 };
    assert.equal(evaluateBookRisk(after).state, "ACTIVE");
    assert.equal(evaluateBookRisk({ ...after, lifetimeMaxDrawdownPercent: 30 }).state, "REDUCE_ONLY");
    assert.equal(evaluateBookRisk({ ...after, currentDrawdownPercent: 25 }).state, "REDUCE_ONLY");
  });

  await t.test("a lost edge without a breach halts entries and keeps managing risk", () => {
    const decision = evaluateBookRisk({ ...base, edgeVerdict: "EDGE_GONE" });
    assert.equal(decision.state, "ENTRY_HALT");
    assert.equal(decision.allowEntries, false);
    assert.equal(decision.allowReductions, true);
    assert.equal(evaluateBookRisk({ ...base, previous: "ENTRY_HALT", edgeVerdict: "EDGE_STABLE" }).state, "ACTIVE");
  });
});

function ticker(symbol: string, markPrice: number, turnover24h: number): PerpTicker {
  return { symbol, lastPrice: markPrice, markPrice, bid: markPrice * 0.9999, ask: markPrice * 1.0001, turnover24h, fundingRate: 0.0001 };
}

function position(symbol: string, quantity: number, entryPrice: number): BookPosition {
  const now = new Date().toISOString();
  return {
    symbol, quantity, entryPrice, notionalUsd: Math.abs(quantity * entryPrice), weight: 0, openedAt: now,
    lastRebalancedAt: now, feesPaidUsd: 0, fundingPaidUsd: 0, realizedPnlUsd: 0,
  };
}

test("reduce_only_cannot_increase_or_flip_a_position", async (t) => {
  const portfolio = emptyBookPortfolio(10_000);
  portfolio.positions = {
    AAAUSDT: position("AAAUSDT", 10, 100),
    BBBUSDT: position("BBBUSDT", -20, 50),
    CCCUSDT: position("CCCUSDT", 1_000, 1),
    DDDUSDT: position("DDDUSDT", 5, 10),
  };
  const prices = new Map([
    // 1% of 20,000 turnover is 200 USDT per step: AAA (1,000) reduces in stages.
    ["AAAUSDT", ticker("AAAUSDT", 100, 20_000)],
    ["BBBUSDT", ticker("BBBUSDT", 50, 100_000_000)],
    ["CCCUSDT", ticker("CCCUSDT", 1, 50_000_000)],
    // DDD has no price: its unwind is blocked, not guessed.
  ]);
  const equity = bookEquityUsd(portfolio, prices);
  const plan = makeReduceOnlyPlan({ positions: Object.values(portfolio.positions), prices, maxParticipation: 0.01, equityUsd: equity });

  await t.test("every order moves toward zero without crossing it", () => {
    const bySymbol = new Map(plan.orders.map((order) => [order.symbol, order]));
    assert.deepEqual([...bySymbol.keys()].sort(), ["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
    for (const order of plan.orders) {
      assert.ok(Math.abs(order.toWeight) < Math.abs(order.fromWeight), order.symbol);
      assert.ok(order.toWeight === 0 || Math.sign(order.toWeight) === Math.sign(order.fromWeight), order.symbol);
      assert.ok(["REDUCE", "CLOSE"].includes(order.action), order.action);
    }
    assert.equal(bySymbol.get("BBBUSDT")!.action, "CLOSE");
    assert.equal(bySymbol.get("AAAUSDT")!.action, "REDUCE", "a thin market unwinds in stages");
    assert.match(plan.reason, /DDDUSDT/, "the blocked unwind is recorded");
  });

  await t.test("applying it reduces quantities and opens nothing", () => {
    const before = JSON.parse(JSON.stringify(portfolio.positions));
    applyBookPlan({ portfolio, plan, prices, reduceOnly: true });
    assert.ok(Math.abs(portfolio.positions.AAAUSDT.quantity - 8) < 1e-6, `AAA ${portfolio.positions.AAAUSDT.quantity}`);
    assert.equal(portfolio.positions.BBBUSDT, undefined);
    assert.equal(portfolio.positions.DDDUSDT.quantity, before.DDDUSDT.quantity);
  });

  await t.test("a reduce-only apply refuses increases, flips and new symbols", () => {
    const hostile = {
      ...plan,
      orders: [
        { symbol: "AAAUSDT", action: "INCREASE" as const, weightDelta: 0.5, fromWeight: 0.08, toWeight: 0.5 },
        { symbol: "CCCUSDT", action: "FLIP" as const, weightDelta: -0.2, fromWeight: 0.1, toWeight: -0.1 },
        { symbol: "EEEUSDT", action: "OPEN_LONG" as const, weightDelta: 0.1, fromWeight: 0, toWeight: 0.1 },
      ],
    };
    const before = JSON.parse(JSON.stringify(portfolio.positions));
    prices.set("EEEUSDT", ticker("EEEUSDT", 2, 50_000_000));
    const result = applyBookPlan({ portfolio, plan: hostile, prices, reduceOnly: true });
    assert.equal(result.executed, 0);
    assert.deepEqual(portfolio.positions, before);
  });
});
