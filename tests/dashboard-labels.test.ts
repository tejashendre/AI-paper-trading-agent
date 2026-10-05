import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeLastBookAction, emptyBookMessage, rebalanceScheduleNote, swingWinRateTile } from "@/lib/ui/dashboardLabels";
import * as labels from '@/lib/ui/dashboardLabels';

describe("dashboard labels", () => {
  it("research rows name every family and tell the older fee cohort apart", () => {
    assert.equal(labels.researchCandidateLabel({ asset: "OIL", family: "SESSION_BREAKOUT" }), "OIL Session breakout");
    assert.equal(labels.researchCandidateLabel({ asset: "USDJPY", family: "RANGE_REVERSION", reasons: ["INSUFFICIENT_FORWARD_SHADOW"] }), "USDJPY Range");
    assert.match(labels.researchCandidateLabel({ asset: "USDJPY", family: "RANGE_REVERSION", reasons: ["UNVERIFIED_FEES"] }), /older fee model/);
  });
  it("the collapsed radar line summarises checks, winners, rules and research modes", () => {
    const line = labels.radarSummary({ checked: 2000, favorableRate: 0.388, rules: 0,
      candidates: [{ mode: "SHADOW" }, { mode: "SHADOW" }, { mode: "CONTROLLED_PROBE" }, { mode: "REJECTED" }] });
    assert.equal(line, "2000 setups checked later, 39% net winners, 0 rules learned. 4 research configurations: 1 trading, 2 in shadow, 1 retired.");
  });
  it("benchmarks list the bot's books next to the simple baselines, with unknown kept unknown", () => {
    const rows = labels.benchmarkRows({ bot: { swingReturnPercent: 0.659, crossSectionalReturnPercent: null },
      equalWeightHold: { returnPercent: 2 }, trendDaily: { returnPercent: -0.4 } });
    assert.deepEqual(rows.map((row) => row.value), ["+0.66%", "unknown", "+2.00%", "-0.40%"]);
    assert.match(rows[3].label, /shadow/);
    const withRatio = labels.benchmarkRows({ bot: { swingReturnPercent: 0, crossSectionalReturnPercent: 0 },
      equalWeightHold: { returnPercent: 0 }, trendDaily: { returnPercent: 0 }, btcEthRatio: { returnPercent: -1.25 } });
    assert.equal(withRatio.at(-1)?.value, "-1.25%");
  });
  it('shows approved versus executed initial risk without treating the approval as the fill', () => {
    const usage = (labels as any).entryRiskUsage;
    assert.equal(typeof usage, 'function');
    const result = usage({ riskAmountUsd: 13.74, initialRiskUsdt: 2.42, maxLossUsd: 0.5 });
    assert.equal(result.approvedUsdt, 13.74);
    assert.equal(result.takenUsdt, 2.42, 'a trailed stop must not replace the frozen entry risk');
    assert.ok(Math.abs(result.utilizationPercent - 17.6128093159) < 1e-8);
    assert.equal(usage({}).utilizationPercent, null, 'missing legacy evidence must stay unknown');
  });
  it("a flat halted book is not described as never having opened", () => {
    assert.equal(emptyBookMessage({ totalRebalances: 0, riskState: "ACTIVE" }), "No book yet. The daemon opens one at its first rebalance.");
    const halted = emptyBookMessage({ totalRebalances: 61, riskState: "SHADOW" });
    assert.doesNotMatch(halted, /No book yet/);
    assert.match(halted, /flat/i);
    assert.match(halted, /SHADOW/);
  });

  it("an unwind step is labeled as an unwind, not a ranking rebalance", () => {
    const unwind = describeLastBookAction({ at: "2026-10-01T10:58:50.406Z", executed: 24, turnover: 1.007, universeSize: 24, reason: "REDUCE_ONLY staged unwind (1.00% of 24h turnover per step)" });
    assert.equal(unwind.title, "Last unwind step");
    assert.doesNotMatch(unwind.detail, /ranked/);
    const rebalance = describeLastBookAction({ at: "2026-09-30T10:00:00.000Z", executed: 6, turnover: 0.27, universeSize: 52, reason: "rebalance" });
    assert.equal(rebalance.title, "Last rebalance");
    assert.match(rebalance.detail, /ranked 52 markets/);
  });

  it("the swing tile uses the same completed-position unit as the statistics panel", () => {
    const tile = swingWinRateTile(
      { totalTrades: 36, winningTrades: 13, totalPnl: 65.91, exitLegs: 49 },
      { trades: 49, wins: 25, pnl: 65.91 }
    );
    assert.equal(tile.winRateText, "36.1%");
    assert.equal(tile.countText, "36 positions · 49 exit legs");
  });

  it("an overdue rebalance is announced", () => {
    assert.equal(rebalanceScheduleNote(null), null);
    assert.equal(rebalanceScheduleNote({ lastAtMs: 1, nextDueAtMs: 2, overdue: false }), null);
    const note = rebalanceScheduleNote({ lastAtMs: Date.UTC(2026, 9, 1, 10, 59), nextDueAtMs: Date.UTC(2026, 9, 1, 22, 59), overdue: true }, Date.UTC(2026, 9, 2, 8, 59));
    assert.match(note ?? "", /overdue by 10h/);
  });
});
