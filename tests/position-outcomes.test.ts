import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ExecutionLedger } from "@/lib/trading/executionLedger";
import {
  buildPositionOutcomes,
  positionOutcomeCohortKey,
  summarizeCompletedPositions,
} from "@/lib/trading/positionOutcomes";
import { SetupPerformance } from "@/lib/trading/setupPerformance";
import { buildTradeReview } from "@/lib/trading/tradeReviewJournal";
import { buildWalkForwardResearchReport } from "@/lib/research/walkForward";
import { getConfiguredInstrument, legacyInstrument } from "@/lib/trading/instrumentRegistry";
import type { OpenPosition, Trade } from "@/lib/types";

const BTC = getConfiguredInstrument("BTC");
const T0 = Date.parse("2026-09-20T10:00:00.000Z");
const iso = (offsetHours: number) => new Date(T0 + offsetHours * 3_600_000).toISOString();

function leg(overrides: Partial<Trade>): Trade {
  return {
    id: "leg",
    timestamp: iso(0),
    asset: "BTC",
    action: "BUY",
    direction: "LONG",
    amount: 0.01,
    btcAmount: 0.01,
    price: 100_000,
    usdValue: 200,
    stopLoss: 99_000,
    takeProfit: 102_000,
    signalScore: 70,
    reasoning: "fixture",
    positionId: "pos-1",
    instrument: BTC,
    economicsModel: "BYBIT_LINEAR_USDT_V1",
    initialRiskUsdt: 10,
    strategyVersion: "swing-test",
    executionCostModelVersion: "paper-cost-v3-2026-10-01",
    riskPolicyVersion: "risk-policy-v2-2026-10-01",
    setupTags: ["TREND_PULLBACK"],
    marketRegime: "TRENDING",
    entryTime: iso(0),
    ...overrides,
  };
}

const entry = leg({ id: "entry", action: "BUY", entryFeeUsd: 0.55 });
const partial = leg({
  id: "partial", timestamp: iso(5), action: "SELL", amount: 0.0035, isPartialExit: true, pnl: 15,
  usdValue: 70 + 0.1925 + 15, entryFeeUsd: 0.1925, exitFeeUsd: 0.2, grossPnlUsd: 15.39, exitTime: iso(5), exitReason: "TAKE_PROFIT", exitPrice: 104_400,
});
const final = leg({
  id: "final", timestamp: iso(9), action: "SELL", amount: 0.0065, pnl: -5, isPartialExit: false,
  usdValue: 130 + 0.3575 - 5, entryFeeUsd: 0.3575, exitFeeUsd: 0.35, grossPnlUsd: -4.29, fundingCashflowUsdt: -0.0025,
  exitTime: iso(9), exitReason: "STOP_LOSS", exitPrice: 99_340,
});
test("new entries retain explicit family, config and regime through complete outcomes", () => {
  const provenance = { strategyFamily: "RANGE_REVERSION", strategyConfigHash: "registered-range",
    strategyDataSchemaVersion: "bybit-closed-bars-v1", strategyRegime: "RANGE" };
  const result = buildPositionOutcomes({ trades: [
    { ...entry, ...provenance }, { ...partial, ...provenance }, { ...final, ...provenance },
  ], openPositions: [] }).completed[0];
  assert.equal(result.setupFamily, "RANGE_REVERSION");
  assert.equal(result.configHash, "registered-range");
  assert.equal(result.regime, "RANGE");
  assert.equal(result.dataSchemaVersion, "bybit-closed-bars-v1");
});

test("partial_profit_then_final_loss_is_one_winning_position", async (t) => {
  const trades = [final, partial, entry];
  const { completed, incompletePositionIds, conflicts } = buildPositionOutcomes({ trades, openPositions: [] });

  await t.test("one completed outcome, net +10 and 1R", () => {
    assert.deepEqual(conflicts, []);
    assert.deepEqual(incompletePositionIds, []);
    assert.equal(completed.length, 1);
    const [outcome] = completed;
    assert.equal(outcome.positionId, "pos-1");
    assert.ok(Math.abs(outcome.netPnlUsdt - 10) < 1e-12);
    assert.equal(outcome.netR, 1);
    assert.deepEqual(outcome.legIds.sort(), ["entry", "final", "partial"]);
    // Trade.pnl is already net; fees come from exit legs once and are not subtracted again.
    assert.ok(Math.abs(outcome.feesUsdt - (0.1925 + 0.2 + 0.3575 + 0.35)) < 1e-12);
    assert.ok(Math.abs(outcome.fundingCashflowUsdt + 0.0025) < 1e-12);
    assert.ok(Math.abs(outcome.returnOnInitialMargin - 10 / 200) < 1e-12);
    assert.equal(outcome.openedAtMs, T0);
    assert.equal(outcome.closedAtMs, Date.parse(iso(9)));
    assert.match(positionOutcomeCohortKey(outcome), /BTC.*BYBIT_LINEAR_USDT_V1:BTCUSDT.*swing-test/);
  });

  await t.test("setup learning sees one +10 position", () => {
    const summary = SetupPerformance.build(trades, {});
    const btc = summary.byAsset.find((bucket) => bucket.key === "BTC")!;
    assert.equal(btc.tradeCount, 1);
    assert.ok(Math.abs(btc.realizedPnl - 10) < 1e-12);
    assert.equal(btc.wins, 1);
  });

  await t.test("trade review classifies the whole position", () => {
    const position = { direction: "LONG", entryTime: iso(0), entryPrice: 100_000, maxLossUsd: 10 } as OpenPosition;
    const review = buildTradeReview(final, position, completed[0])!;
    assert.ok(Math.abs(review.pnl - 10) < 1e-12);
    assert.equal(review.riskMultiple, 1);
    assert.equal(review.positionId, "pos-1");
  });

  await t.test("walk-forward research samples one position", () => {
    const report = buildWalkForwardResearchReport({ trades });
    assert.equal(report.aggregateSample.count, 1);
    assert.ok(Math.abs(report.aggregateSample.netPnlUsd - 10) < 1e-12);
  });

  await t.test("dashboard statistics count positions, with realized cash shown separately", () => {
    const stats = summarizeCompletedPositions({ outcomes: completed, trades });
    assert.equal(stats.completedPositions, 1);
    assert.equal(stats.winRate, 1);
    assert.ok(Math.abs(stats.totalPnl - 10) < 1e-12);
    assert.ok(Math.abs(stats.realizedCashFromExitLegs - 10) < 1e-12);
    assert.equal(stats.exitLegs, 2);
  });

  await t.test("an open remainder is incomplete and excluded, its cash still visible", () => {
    const open = { asset: "BTC", positionId: "pos-1", amount: 0.0065 } as OpenPosition;
    const result = buildPositionOutcomes({ trades: [partial, entry], openPositions: [open] });
    assert.deepEqual(result.completed, []);
    assert.deepEqual(result.incompletePositionIds, ["pos-1"]);
    const stats = summarizeCompletedPositions({ outcomes: result.completed, trades: [partial, entry] });
    assert.equal(stats.completedPositions, 0);
    assert.equal(stats.realizedCashFromExitLegs, 15);
  });
});

test("scale_ins_duplicate_events_and_cost_allocation", async (t) => {
  const scale = leg({ id: "scale", timestamp: iso(2), action: "BUY", amount: 0.005, reasoning: "Scaled into profitable swing winner.", entryFeeUsd: 0.27 });
  const p1 = leg({ id: "p1", timestamp: iso(4), action: "SELL", amount: 0.005, isPartialExit: true, pnl: 6, entryFeeUsd: 0.2, exitFeeUsd: 0.2, usdValue: 106.2 });
  const p2 = leg({ id: "p2", timestamp: iso(5), action: "SELL", amount: 0.004, isPartialExit: true, pnl: 4, entryFeeUsd: 0.16, exitFeeUsd: 0.16, usdValue: 84.16 });
  const fin = leg({ id: "fin", timestamp: iso(8), action: "SELL", amount: 0.006, pnl: -1, entryFeeUsd: 0.46, exitFeeUsd: 0.24, usdValue: 119.46 });

  await t.test("two entry fills, several partials, a final and a replayed leg give one outcome", () => {
    const { completed, conflicts } = buildPositionOutcomes({ trades: [fin, p2, p1, p1, scale, entry], openPositions: [] });
    assert.deepEqual(conflicts, []);
    assert.equal(completed.length, 1);
    assert.deepEqual([...completed[0].legIds].sort(), ["entry", "fin", "p1", "p2", "scale"]);
    assert.ok(Math.abs(completed[0].netPnlUsdt - 9) < 1e-12, "the replayed leg is counted once");
    assert.ok(Math.abs(completed[0].feesUsdt - (0.2 + 0.2 + 0.16 + 0.16 + 0.46 + 0.24)) < 1e-12);
  });

  const cases: Array<[string, Trade[], RegExp]> = [
    ["two finals", [fin, leg({ ...fin, id: "fin-2" }), p1, entry], /final/i],
    ["negative remaining quantity", [leg({ ...fin, amount: 0.02 }), entry], /quantity/i],
    ["inconsistent instrument versions", [leg({ ...fin, instrument: getConfiguredInstrument("ETH") }), entry], /instrument/i],
    ["missing lineage", [leg({ ...fin, positionId: undefined, entryTime: undefined })], /lineage/i],
  ];
  for (const [label, trades, pattern] of cases) {
    await t.test(`${label} is rejected, not guessed`, () => {
      const result = buildPositionOutcomes({ trades, openPositions: [] });
      assert.deepEqual(result.completed, [], label);
      assert.ok(result.conflicts.some((c) => pattern.test(c)), `${label}: ${result.conflicts.join("; ")}`);
    });
  }

  await t.test("unavailable initial risk gives netR null, not a fabricated R", () => {
    const noRisk = [leg({ ...final, initialRiskUsdt: undefined }), leg({ ...partial, initialRiskUsdt: undefined }), leg({ ...entry, initialRiskUsdt: undefined })];
    const [outcome] = buildPositionOutcomes({ trades: noRisk, openPositions: [] }).completed;
    assert.equal(outcome.netR, null);
    assert.equal(outcome.initialRiskUsdt, null);
    assert.ok(Math.abs(outcome.netPnlUsdt - 10) < 1e-12);
  });

  await t.test("pre-upgrade legs group by their recorded entry time", () => {
    const legacy = (t: Trade): Trade => ({ ...t, positionId: undefined, instrument: undefined, economicsModel: undefined, initialRiskUsdt: undefined });
    const { completed, conflicts } = buildPositionOutcomes({ trades: [legacy(final), legacy(partial), legacy(entry)], openPositions: [] });
    assert.deepEqual(conflicts, []);
    assert.equal(completed.length, 1);
    assert.match(completed[0].positionId, /^legacy:/);
    assert.ok(Math.abs(completed[0].netPnlUsdt - 10) < 1e-12);
    assert.deepEqual(completed[0].instrument, legacyInstrument("BTC", "LEGACY_SYNTHETIC_V1"));
  });
});

test("upgrade_fixture_reconciles_one_sample_per_completed_position", () => {
  const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "upgrade", "trades.json"), "utf8"));
  assert.equal(fixture.schemaVersion, 1);
  const { completed, incompletePositionIds, conflicts } = buildPositionOutcomes({ trades: fixture.trades, openPositions: fixture.openPositions });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(completed.map((outcome) => outcome.positionId).sort(), ["fixture-btc-1", completed.find((o) => o.asset === "ETH")!.positionId].sort());
  assert.deepEqual(incompletePositionIds, ["fixture-gold-1"], "the open gold remainder is not a completed sample");
  const byAsset = Object.fromEntries(completed.map((outcome) => [outcome.asset, outcome.netPnlUsdt]));
  assert.ok(Math.abs(byAsset.BTC - 10) < 1e-12);
  assert.ok(Math.abs(byAsset.ETH - 12) < 1e-12);
  const stats = summarizeCompletedPositions({ outcomes: completed, trades: fixture.trades });
  assert.equal(stats.completedPositions, 2);
  // Cash includes the open position's realized partial; position results do not.
  assert.ok(Math.abs(stats.realizedCashFromExitLegs - (10 + 12 + 0.9)) < 1e-9);
  assert.ok(Math.abs(stats.totalPnl - 22) < 1e-9);

  const ledger = ExecutionLedger.verify(path.join(__dirname, "fixtures", "upgrade", "ledger"));
  assert.equal(ledger.valid, true, ledger.errors.join("; "));
  assert.equal(ledger.events, 8);
  assert.equal(ExecutionLedger.hasEvent("position-completed:fixture-btc-1", "2026-10-01", path.join(__dirname, "fixtures", "upgrade", "ledger")), true);
});
