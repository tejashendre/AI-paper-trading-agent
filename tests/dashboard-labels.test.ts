import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeLastBookAction, emptyBookMessage, rebalanceScheduleNote, swingWinRateTile } from "@/lib/ui/dashboardLabels";

describe("dashboard labels", () => {
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
