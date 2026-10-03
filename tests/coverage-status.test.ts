import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCoverageSnapshot,
  describeBookRisk,
  describeShadowEvidence,
  recordFunnelDecision,
  ScanDecision,
  summarizeFunnel,
} from "@/lib/trading/coverageStatus";
import { buildPositionOutcomes } from "@/lib/trading/positionOutcomes";
import { emptyBookPortfolio } from "@/lib/execution/bookRebalancer";
import { CONFIGURED_ASSETS, getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";
import type { Trade } from "@/lib/types";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const ready = { allowed: true, state: "READY" as const, reasons: [] as string[] };

function decision(asset: string, overrides: Partial<ScanDecision> = {}): ScanDecision {
  return { decisionId: `scan-1:${asset}`, asset, at: new Date(NOW - 60_000).toISOString(), action: "HOLD", vetoCode: "NO_SETUP", reason: "No setup", ...overrides };
}

test("healthy_feed_does_not_claim_asset_can_trade", async (t) => {
  await t.test("a valid OIL quote with a learning veto is data-ready but not risk-allowed", () => {
    const [oil] = buildCoverageSnapshot({
      nowMs: NOW,
      assets: { OIL: { dataEligibility: ready, quoteEventTimeMs: NOW - 2_000, lastDecision: decision("OIL", { action: "BLOCKED", vetoCode: "LEARNING", reason: "Recent OIL outcomes put this setup on watch only." }) } },
      outcomes: [], trades: [], funnels: {},
    }).filter((row) => row.asset === "OIL");
    assert.equal(oil.symbol, "CLUSDT");
    assert.equal(oil.dataReady, true);
    assert.equal(oil.strategyReady, true);
    assert.equal(oil.riskAllowed, false);
    assert.match(String(oil.primaryVeto), /^LEARNING: /);
    assert.equal(oil.quoteAgeMs, 2_000);
    assert.ok(oil.notes.some((note) => /WTI/.test(note)));
  });

  await t.test("FX warm-up is separate from its weekly limitation", () => {
    const [eur] = buildCoverageSnapshot({
      nowMs: NOW,
      assets: {
        EURUSD: {
          dataEligibility: {
            allowed: false,
            state: "WARMING_UP",
            reasons: ["WARMING_UP_H4: 80 of 100 completed h4 bars", "WEEKLY_FEATURE_UNAVAILABLE: 3 of 8 completed weeks; the weekly bias contributes nothing"],
          },
          quoteEventTimeMs: NOW - 1_000,
          lastDecision: decision("EURUSD", { action: "BLOCKED", vetoCode: "WARMING_UP", reason: "Waiting for history" }),
        },
      },
      outcomes: [], trades: [], funnels: {},
    }).filter((row) => row.asset === "EURUSD");
    assert.equal(eur.dataReady, false);
    assert.deepEqual(eur.intradayWarmUp, ["WARMING_UP_H4: 80 of 100 completed h4 bars"]);
    assert.ok(eur.limitations.some((note) => note.startsWith("WEEKLY_FEATURE_UNAVAILABLE")));
    assert.ok(eur.notes.some((note) => /fee/i.test(note) && /0\.0275% taker/.test(note) && /older stress-fee cohorts remain unverified/.test(note)));
  });

  await t.test("all nine rows appear even when one asset's inputs failed", () => {
    const rows = buildCoverageSnapshot({
      nowMs: NOW,
      assets: Object.fromEntries(CONFIGURED_ASSETS.filter((a) => a !== "SILVER").map((a) => [a, { dataEligibility: ready, quoteEventTimeMs: NOW, lastDecision: decision(a) }])),
      outcomes: [], trades: [], funnels: {},
    });
    assert.deepEqual(rows.map((row) => row.asset), [...CONFIGURED_ASSETS]);
    const silver = rows.find((row) => row.asset === "SILVER")!;
    assert.equal(silver.dataReady, false);
    assert.match(String(silver.primaryVeto), /^DATA_NOT_ELIGIBLE: /);
    assert.equal(silver.lastEvaluatedAt, null);
  });
});

test("funnels_count_each_decision_once", () => {
  let days = recordFunnelDecision([], decision("BTC", { decisionId: "scan-1:BTC", action: "ENTRY", vetoCode: null }));
  // The same decision recorded again (a retry) is ignored.
  days = recordFunnelDecision(days, decision("BTC", { decisionId: "scan-1:BTC", action: "ENTRY", vetoCode: null }));
  days = recordFunnelDecision(days, decision("BTC", { decisionId: "scan-2:BTC", action: "BLOCKED", vetoCode: "EXECUTION_COST", reason: "costs" }));
  days = recordFunnelDecision(days, decision("BTC", { decisionId: "scan-3:BTC", vetoCode: "NO_SETUP" }));
  const week = summarizeFunnel(days, 7, NOW);
  assert.equal(week.evaluations, 3);
  assert.equal(week.candidates, 2);
  assert.equal(week.provenancePass, 2);
  assert.equal(week.costPass, 1);
  assert.equal(week.fills, 1);
  assert.equal(week["veto:EXECUTION_COST"], 1);
  assert.equal(week["veto:NO_SETUP"], 1);
  // Older than the window is excluded.
  const old = recordFunnelDecision([], decision("BTC", { decisionId: "old", at: new Date(NOW - 10 * 86_400_000).toISOString(), action: "ENTRY", vetoCode: null }));
  assert.equal(summarizeFunnel(old, 7, NOW).fills, 0);
  assert.equal(summarizeFunnel(old, 30, NOW).fills, 1);
});

test("cash_legs_completed_positions_and_shadow_stats_are_distinct", async (t) => {
  const base = { asset: "BTC", direction: "LONG" as const, positionId: "pos-1", instrument: getConfiguredInstrument("BTC"), btcAmount: 0, price: 1, stopLoss: 0, takeProfit: 0, signalScore: 0, reasoning: "x", entryTime: new Date(NOW - 9e6).toISOString() };
  const trades: Trade[] = [
    { ...base, id: "entry", timestamp: new Date(NOW - 9e6).toISOString(), action: "BUY", amount: 1, usdValue: 100 },
    { ...base, id: "partial", timestamp: new Date(NOW - 5e6).toISOString(), action: "SELL", amount: 0.35, usdValue: 50, pnl: 15, isPartialExit: true },
    { ...base, id: "final", timestamp: new Date(NOW - 1e6).toISOString(), action: "SELL", amount: 0.65, usdValue: 60, pnl: -5 },
  ];
  const outcomes = buildPositionOutcomes({ trades, openPositions: [] }).completed;

  await t.test("realized cash and completed positions are reported separately", () => {
    const btc = buildCoverageSnapshot({ nowMs: NOW, assets: {}, outcomes, trades, funnels: {} }).find((row) => row.asset === "BTC")!;
    assert.equal(btc.completedPositions, 1);
    assert.equal(btc.realizedCashFromExitLegs, 10);
    assert.equal(btc.lastFillAt, trades[0].timestamp);
  });

  await t.test("shadow results are labeled hypothetical, with samples and costs", () => {
    const shadow = emptyBookPortfolio(10_000);
    shadow.totalFills = 12;
    shadow.feesPaidUsd = 3.3;
    shadow.fundingPaidUsd = 0.4;
    shadow.realizedPnlUsd = 25;
    const evidence = describeShadowEvidence(shadow, new Map());
    assert.equal(evidence.liveCapital, false);
    assert.equal(evidence.label, "SHADOW_ONLY");
    assert.equal(evidence.fills, 12);
    assert.equal(evidence.feesUsdt, 3.3);
    assert.equal(evidence.hypotheticalRealizedPnlUsdt, 25);
    assert.equal("realizedPnlUsd" in evidence, false, "never presented as live profit");
  });

  await t.test("a REDUCE_ONLY book shows exposure, the last unwind and both drawdowns", () => {
    const book = emptyBookPortfolio(10_000);
    book.peakEquityUsd = 10_000;
    book.maxDrawdownPercent = 28.152;
    book.cashUsd = 8_000;
    book.positions.AAAUSDT = {
      symbol: "AAAUSDT", quantity: 10, entryPrice: 100, notionalUsd: 1_000, weight: 0.1, openedAt: "", lastRebalancedAt: "",
      feesPaidUsd: 0, fundingPaidUsd: 0, realizedPnlUsd: 0,
    };
    book.riskState = {
      state: "REDUCE_ONLY", reasons: ["DRAWDOWN_BREACH: ..."], allowEntries: false, allowReductions: true,
      policyVersion: "book-risk-v1-2026-10-01", updatedAt: new Date(NOW).toISOString(),
      lastUnwind: { at: new Date(NOW - 60_000).toISOString(), executed: 0, detail: "blocked: AAAUSDT: no valid price or turnover" },
    };
    const prices = new Map([["AAAUSDT", { symbol: "AAAUSDT", lastPrice: 90, markPrice: 90, bid: 89.9, ask: 90.1, turnover24h: 1e6, fundingRate: 0 }]]);
    const view = describeBookRisk({ portfolio: book, prices, edgeVerdict: "NO_ESTABLISHED_EDGE", edgeReviewedAt: new Date(NOW - 3_600_000).toISOString() });
    assert.equal(view.state, "REDUCE_ONLY");
    assert.equal(view.grossExposureUsdt, 900);
    assert.equal(view.openPositions, 1);
    assert.equal(view.lifetimeMaxDrawdownPercent, 28.152);
    // Equity is cash plus unrealized P&L: 8,000 - 100 against a 10,000 peak.
    assert.ok(Math.abs(view.currentDrawdownPercent - 21) < 1e-9);
    assert.match(String(view.lastUnwind?.detail), /blocked/);
    assert.equal(view.edgeReviewedAt, new Date(NOW - 3_600_000).toISOString());
  });
});
