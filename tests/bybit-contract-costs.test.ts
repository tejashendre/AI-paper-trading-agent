import test from "node:test";
import assert from "node:assert/strict";
import {
  alignStopTowardEntry,
  calculateInstrumentPnl,
  feeScheduleFor,
  floorOrderQty,
  instrumentFee,
  instrumentNotional,
  positionInstrument,
  validateOrderSize,
} from "@/lib/trading/assetSpecs";
import { getConfiguredInstrument, validateBybitMetadata } from "@/lib/trading/instrumentRegistry";
import { estimatePaperFill } from "@/lib/trading/executionCostModel";
import { capacityNotionalCap, evaluateFillCapacity, FILL_CAPACITY_POLICY, LiquiditySnapshot } from "@/lib/execution/liquidityCost";
import { applyBookPlan, emptyBookPortfolio, TAKER_FEE_RATE } from "@/lib/execution/bookRebalancer";
import { evidenceInstrument, SERVER_NOW } from "./helpers/fakeBybitMarket";

const meta = (symbol: string, lot: Record<string, string> = {}, tick?: string) => {
  const raw = evidenceInstrument(symbol) as any;
  Object.assign(raw.lotSizeFilter, lot);
  if (tick) raw.priceFilter.tickSize = tick;
  return validateBybitMetadata(symbol, raw, SERVER_NOW);
};

test("linear_usdjpy_long_short_and_notional", async (t) => {
  await t.test("USDJPY, EURUSD, XAU, CL and XAG settle linearly in USDT", () => {
    const cases: Array<[string, number, number, number, number]> = [
      ["USDJPY", 150, 151, 10, 10],
      ["EURUSD", 1.1325, 1.1335, 1_000, 1],
      ["GOLD", 4_189, 4_199, 0.5, 5],
      ["OIL", 90.43, 89.43, 3, -3],
      ["SILVER", 61.12, 62.12, 2, 2],
    ];
    for (const [asset, entry, exit, qty, expected] of cases) {
      const instrument = getConfiguredInstrument(asset);
      const long = calculateInstrumentPnl({ instrument, entryPrice: entry, exitPrice: exit, quantity: qty, direction: "LONG" });
      assert.ok(Math.abs(long - expected) < 1e-9, `${asset} long ${long}`);
      const short = calculateInstrumentPnl({ instrument, entryPrice: entry, exitPrice: exit, quantity: qty, direction: "SHORT" });
      assert.ok(Math.abs(short + expected) < 1e-9, `${asset} short ${short}`);
    }
    assert.equal(instrumentNotional(getConfiguredInstrument("USDJPY"), 10, 150), 1_500);
    // The legacy example keeps its own formula.
    const legacy = positionInstrument({ asset: "USDJPY", strategyType: "swing" });
    assert.ok(Math.abs(calculateInstrumentPnl({ instrument: legacy, entryPrice: 150, exitPrice: 151, quantity: 10, direction: "LONG" }) - 10 / 151) < 1e-12);
  });

  await t.test("fees come from a versioned public schedule, taker unless a resting fill is simulated", () => {
    const crypto = feeScheduleFor(getConfiguredInstrument("BTC"));
    assert.deepEqual([crypto.makerRate, crypto.takerRate, crypto.status], [0.0002, 0.00055, "PUBLIC_BASELINE"]);
    const metals = feeScheduleFor(getConfiguredInstrument("GOLD"));
    assert.deepEqual([metals.makerRate, metals.takerRate, metals.status], [0, 0.000275, "PUBLIC_BASELINE"]);
    assert.equal(feeScheduleFor(getConfiguredInstrument("OIL")).version, metals.version);
    const fx = feeScheduleFor(getConfiguredInstrument("USDJPY"));
    assert.deepEqual([fx.makerRate, fx.takerRate, fx.status], [0, 0.000275, "PUBLIC_BASELINE"]);
    for (const schedule of [crypto, metals, fx]) {
      assert.match(schedule.sourceUrl, /^https:\/\/(www\.|announcements\.)?bybit\.com\//);
      assert.match(schedule.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
    }
    // Every new fee is notional times the taker rate.
    assert.ok(Math.abs(instrumentFee(getConfiguredInstrument("USDJPY"), 10, 150) - 1_500 * 0.000275) < 1e-12);
    assert.ok(Math.abs(instrumentFee(getConfiguredInstrument("OIL"), 10, 90) - 900 * 0.000275) < 1e-12);
    const fill = estimatePaperFill({
      asset: "GOLD", action: "BUY", requestedPrice: 4_000, amount: 1, context: { reason: "ENTRY" },
    });
    assert.ok(Math.abs(fill.feeUsd - fill.notionalUsd * 0.000275) < 1e-9);
    // A legacy position keeps the fee assumption it was opened with.
    assert.equal(instrumentFee(positionInstrument({ asset: "EURUSD", strategyType: "swing" }), 1_000, 1.1), 0);
  });

  await t.test("a scheduled book rebalance is not assumed to earn maker fees", () => {
    const portfolio = emptyBookPortfolio(10_000);
    const prices = new Map([["DOGEUSDT", { symbol: "DOGEUSDT", lastPrice: 0.2, markPrice: 0.2, bid: 0.19999, ask: 0.20001, turnover24h: 50e6, fundingRate: 0.0001 }]]);
    const result = applyBookPlan({
      portfolio,
      plan: {
        strategyVersion: "test", targets: [], universeSize: 1, skipped: false, turnover: 0.02, reason: "test",
        orders: [{ symbol: "DOGEUSDT", action: "OPEN_LONG", weightDelta: 0.02, fromWeight: 0, toWeight: 0.02 }],
      },
      prices,
    });
    assert.equal(result.executed, 1);
    const trade = result.trades[0];
    assert.ok(Math.abs(trade.feeUsd - trade.notionalUsd * TAKER_FEE_RATE) < 1e-9, `fee ${trade.feeUsd}`);
  });
});

test("venue_rounding_never_expands_risk", async (t) => {
  await t.test("quantities floor to the step exactly", () => {
    assert.equal(floorOrderQty("0.01299", meta("BTCUSDT")), "0.012");
    assert.equal(floorOrderQty("0.01999", meta("ETHUSDT")), "0.01");
    assert.equal(floorOrderQty("12.39", meta("SOLUSDT")), "12.3");
    // 0.1 + 0.2 in floating point is 0.30000000000000004; 0.3 must stay 0.3.
    assert.equal(floorOrderQty(String(0.1 + 0.2), meta("SOLUSDT")), "0.3");
    assert.equal(floorOrderQty("0.29999999999", meta("SOLUSDT")), "0.2");
    assert.equal(floorOrderQty("3", meta("USDJPYUSDT")), "3");
    assert.equal(floorOrderQty("0.0009", meta("BTCUSDT")), "0");
    assert.throws(() => floorOrderQty("1e21", meta("BTCUSDT")), /decimal/);
    assert.throws(() => floorOrderQty("-1", meta("BTCUSDT")), /decimal/);
  });

  await t.test("below venue minimums is rejected, never rounded up", () => {
    const btc = meta("BTCUSDT");
    const tooSmall = validateOrderSize({ quantity: floorOrderQty("0.0009", btc), price: 84_000, metadata: btc, maxNotionalUsdt: 1_000 });
    assert.equal(tooSmall.allowed, false);
    assert.ok(tooSmall.reasons.some((r) => r.startsWith("BELOW_MIN_QTY")));
    const lowNotional = validateOrderSize({ quantity: "0.1", price: 20, metadata: meta("SOLUSDT"), maxNotionalUsdt: 1_000 });
    assert.ok(lowNotional.reasons.some((r) => r.startsWith("BELOW_MIN_NOTIONAL")), lowNotional.reasons.join("; "));
    assert.equal(validateOrderSize({ quantity: "0.012", price: 84_000, metadata: btc, maxNotionalUsdt: 1_100 }).allowed, true);
  });

  await t.test("off-step, oversized and over-budget orders are rejected", () => {
    const btc = meta("BTCUSDT");
    const offStep = validateOrderSize({ quantity: "0.0125", price: 84_000, metadata: btc, maxNotionalUsdt: 10_000 });
    assert.ok(offStep.reasons.some((r) => r.startsWith("QTY_NOT_ON_STEP")));
    const overMarketMax = validateOrderSize({ quantity: "151", price: 1, metadata: btc, maxNotionalUsdt: 1e9 });
    assert.ok(overMarketMax.reasons.some((r) => r.startsWith("ABOVE_MAX_MARKET_QTY")));
    const overBudget = validateOrderSize({ quantity: "0.012", price: 84_000, metadata: btc, maxNotionalUsdt: 1_000 });
    assert.ok(overBudget.reasons.some((r) => r.startsWith("ABOVE_RISK_NOTIONAL")));
    const unsafe = validateOrderSize({ quantity: "123456789012345678901234567890", price: 1, metadata: btc, maxNotionalUsdt: Infinity });
    assert.ok(unsafe.reasons.some((r) => r.startsWith("UNSAFE_MAGNITUDE")));
  });

  await t.test("a venue minimum whose stop risk exceeds the internal budget is rejected", () => {
    const gold = meta("XAUUSDT");
    // Minimum 0.001 oz at 4,000 with a 400-point stop risks 0.4 USDT; budget 0.3.
    const result = validateOrderSize({
      quantity: "0.001", price: 4_000, metadata: gold, maxNotionalUsdt: 100, stopPrice: 3_600, maxLossUsdt: 0.3,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.some((r) => r.startsWith("STOP_RISK_ABOVE_BUDGET")), result.reasons.join("; "));
  });

  await t.test("stops and targets move onto the tick toward entry, never away", () => {
    const fx = meta("EURUSDUSDT"); // tick 0.00001
    assert.equal(alignStopTowardEntry({ price: 1.123456, entryPrice: 1.13, metadata: fx }), 1.12346);
    assert.equal(alignStopTowardEntry({ price: 1.136544, entryPrice: 1.13, metadata: fx }), 1.13654);
    const jpy = meta("USDJPYUSDT"); // tick 0.001
    assert.equal(alignStopTowardEntry({ price: 149.0004, entryPrice: 150, metadata: jpy }), 149.001);
    assert.equal(alignStopTowardEntry({ price: 150.9996, entryPrice: 150, metadata: jpy }), 150.999);
    assert.equal(alignStopTowardEntry({ price: 149.5, entryPrice: 150, metadata: jpy }), 149.5);
  });
});

function book(overrides: Partial<LiquiditySnapshot> = {}): LiquiditySnapshot {
  return {
    bestBid: 99.99,
    bestAsk: 100.01,
    bids: [[99.99, 50], [99.95, 50]],
    asks: [[100.01, 50], [100.05, 50], [100.5, 500]],
    turnover24hUsdt: 10_000_000,
    observedAtMs: SERVER_NOW,
    ...overrides,
  };
}

test("fill_capacity_limits_are_enforced", async (t) => {
  const order = { side: "BUY" as const, quantity: 5, entryPrice: 100.01, stopPrice: 98, impactBps: 0.5 };

  await t.test("a fill inside every limit passes and records what it saw", () => {
    const result = evaluateFillCapacity({ ...order, liquidity: book() });
    assert.equal(result.allowed, true, result.reasons.join("; "));
    assert.equal(result.snapshot.policyVersion, FILL_CAPACITY_POLICY.version);
    // Only asks within 10 bps of the best ask count as available depth.
    assert.ok(Math.abs(result.snapshot.depthWithinBandUsdt! - (100.01 * 50 + 100.05 * 50)) < 1e-9);
  });

  await t.test("turnover, depth and spread-to-stop limits each reject", () => {
    const turnover = evaluateFillCapacity({ ...order, liquidity: book({ turnover24hUsdt: 40_000 }) });
    assert.ok(turnover.reasons.some((r) => r.startsWith("TURNOVER_CAPACITY")));
    const depth = evaluateFillCapacity({ ...order, quantity: 20, liquidity: book() });
    assert.ok(depth.reasons.some((r) => r.startsWith("DEPTH_CAPACITY")), depth.reasons.join("; "));
    const tightStop = evaluateFillCapacity({ ...order, stopPrice: 99.9, liquidity: book() });
    assert.ok(tightStop.reasons.some((r) => r.startsWith("COST_TO_STOP")), tightStop.reasons.join("; "));
  });

  await t.test("an outage or a broken book never becomes a free fill", () => {
    for (const liquidity of [null, book({ bestBid: 100.01, bestAsk: 100.01 }), book({ asks: [] }), book({ bestAsk: Number.NaN })]) {
      const result = evaluateFillCapacity({ ...order, liquidity });
      assert.equal(result.allowed, false);
      assert.ok(result.reasons.some((r) => r.startsWith("LIQUIDITY_UNAVAILABLE")), result.reasons.join("; "));
    }
  });

  await t.test("the capacity cap shrinks size rather than expanding it", () => {
    assert.equal(capacityNotionalCap({ side: "BUY", liquidity: book({ turnover24hUsdt: 100_000 }) }), 1_000);
    assert.ok(Math.abs(capacityNotionalCap({ side: "BUY", liquidity: book() })! - 0.1 * (100.01 * 50 + 100.05 * 50)) < 1e-9);
    assert.equal(capacityNotionalCap({ side: "BUY", liquidity: null }), null);
  });
});
