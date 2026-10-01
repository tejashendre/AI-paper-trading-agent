import assert from "node:assert/strict";
import { test } from "node:test";
import * as learning from "@/lib/trading/localLearning";
import { getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";
import { TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import { TradeAdmissionController } from "@/lib/trading/tradeAdmission";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const cohort = { instrumentVersion: getConfiguredInstrument("GOLD").instrumentVersion,
  dataSchemaVersion: "bybit-closed-bars-v1", assetClass: "commodity", family: "TREND_PULLBACK",
  regime: "TREND", direction: "LONG", strategyVersion: TRADING_STRATEGY_VERSION, configHash: "gold-trend-config",
  costModelVersion: "paper-cost-v3", riskPolicyVersion: "risk-v3" };
function rule(overrides: Record<string, unknown> = {}): any {
  return { id: "gold-rule", scope: "asset", key: "GOLD", action: "REDUCE", confidenceAdjustment: -8,
    message: "Less risk", sampleSize: 15, favorableRate: 0.1, avgMove: -100, updatedAt: new Date(NOW).toISOString(),
    sampleUnit: "COMPLETED_POSITION", distinctSampleCount: 15, netReturnFraction: -0.01, netR: -0.5,
    createdAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 10000).toISOString(),
    cohort, units: "FRACTION_AND_R", riskMultiplier: 0.5, ...overrides };
}
function adjustment(rules: any[], context = cohort): any {
  return (learning.calculateLearningAdjustment as any)(rules, "GOLD", ["TREND_PULLBACK"], { cohort: context, nowMs: NOW });
}
test("old_yahoo_gold_does_not_quarantine_new_bybit_gold", () => {
  const old = rule({ action: "WATCH_ONLY", cohort: { ...cohort, instrumentVersion: "LEGACY:YAHOO_GOLD" } });
  assert.equal(adjustment([old]).watchOnly, false);
  assert.equal(adjustment([old]).adjustment, 0);
  const crypto = rule({ scope: "global", action: "WATCH_ONLY", cohort: { ...cohort, assetClass: "crypto" } });
  assert.equal(adjustment([crypto]).watchOnly, false);
});
test("reduce_rule_does_not_secretly_become_watch_only", () => {
  const result = adjustment([rule()]);
  assert.equal(result.watchOnly, false);
  assert.equal(result.adjustment, -4);
  assert.equal(result.riskMultiplier, 0.5);
});
test("sparse, expired, mismatched currency units and shadow evidence cannot adjust live risk", () => {
  for (const candidate of [
    rule({ distinctSampleCount: 2, sampleSize: 200 }),
    rule({ expiresAt: new Date(NOW - 1).toISOString() }),
    rule({ units: "RAW_DOLLARS", netReturnFraction: undefined }),
    rule({ sampleUnit: "SHADOW_SETUP", distinctSampleCount: 200 }),
    rule({ cohort: { ...cohort, configHash: "another-trial" } }),
  ]) {
    const result = adjustment([candidate]);
    assert.equal(result.adjustment, 0);
    assert.equal(result.watchOnly, false);
    assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
  }
});
test("positive learning cannot increase risk above baseline or stack duplicate votes", () => {
  const positive = rule({ action: "BOOST", confidenceAdjustment: 9, netR: 1, netReturnFraction: 0.02, riskMultiplier: 2 });
  const result = adjustment([positive, { ...positive, id: "second-rule" }]);
  assert.equal(result.adjustment, 4);
  assert.equal(result.riskMultiplier, 1);
});
test("complete-position rules require distinct positions and recorded initial risk", () => {
  const fn = (learning as any).deriveLearningRules;
  assert.equal(typeof fn, "function");
  const outcome = { positionId: "position-1", asset: "GOLD", instrument: getConfiguredInstrument("GOLD"),
    direction: "LONG", strategyVersion: cohort.strategyVersion, setupFamily: cohort.family, regime: cohort.regime,
    configHash: cohort.configHash, dataSchemaVersion: cohort.dataSchemaVersion,
    costModelVersion: cohort.costModelVersion, riskPolicyVersion: cohort.riskPolicyVersion,
    openedAtMs: NOW - 30 * 86400000, closedAtMs: NOW - 29 * 86400000,
    initialRiskUsdt: 100, netPnlUsdt: -50, netR: -0.5, returnOnInitialMargin: -0.01 };
  assert.deepEqual(fn(Array(100).fill(outcome), NOW), []);
  const positions = Array.from({ length: 15 }, (_, i) => ({ ...outcome, positionId: "p-" + i,
    openedAtMs: outcome.openedAtMs + i * 86400000, closedAtMs: outcome.closedAtMs + i * 86400000 }));
  const rules = fn(positions, NOW);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].distinctSampleCount, 15);
  assert.equal(rules[0].netR, -0.5);
  assert.deepEqual(fn(positions.map(p => ({ ...p, initialRiskUsdt: null })), NOW), []);
});
test("positive learning does not increase admission leverage, margin or stop risk", () => {
  const input: any = { portfolio: { usd: 10000, peakValue: 10000, openPositions: {}, scalpPositions: {} },
    asset: "BTC", direction: "SHORT", entryPrice: 100, stopLoss: 102, takeProfit: 95,
    signalScore: 20, finalConviction: 74, learningAdjustment: 0, setupTags: ["SELL_SIDE_BREAKDOWN_CONTINUATION"],
    reasoning: "fixture", strategyType: "swing", assetMode: "REALTIME_FAST", dataQuality: 100 };
  const baseline = TradeAdmissionController.evaluate(input);
  const boosted = TradeAdmissionController.evaluate({ ...input, finalConviction: 78, learningAdjustment: 4 });
  assert.equal(baseline.approved, true);
  assert.equal(boosted.approved, true);
  assert.ok(boosted.leverage <= baseline.leverage);
  assert.ok(boosted.requiredMarginUsd <= baseline.requiredMarginUsd + 1e-8);
  assert.ok(boosted.maxLossUsd <= baseline.maxLossUsd + 1e-8);
});
