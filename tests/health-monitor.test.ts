import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain ESM script without type declarations
import { evaluateHealth, tradfiWeekend } from "../scripts/health-monitor.mjs";

const NOW = Date.parse("2026-10-06T12:00:00Z"); // a Tuesday
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const feed = (asset: string, category: string, minutesAgo: number) => ({ asset, category, dataEligibility: { quoteEventTimeMs: NOW - minutesAgo * 60_000 } });

function healthy() {
  return {
    status: {
      swingScan: { completedAt: iso(1), summary: { ERROR: 0 } },
      executionLedger: { lastEventAt: iso(1) },
      researchQueue: { rejectedNew: 0 },
      feedHealthMatrix: { assets: [feed("BTC", "crypto", 0.5), feed("EURUSD", "forex", 1)] },
    },
    book: { rebalanceSchedule: { overdue: false } },
  };
}

test("health monitor reports each silent failure in plain English", async (t) => {
  await t.test("a healthy system raises nothing", () => {
    assert.deepEqual(evaluateHealth({ ...healthy(), nowMs: NOW }), []);
  });

  await t.test("stale scan, quiet ledger, scan errors, full queue, stale feed and overdue rebalance all alert", () => {
    const { status, book } = healthy();
    status.swingScan = { completedAt: iso(6), summary: { ERROR: 2 } };
    status.executionLedger.lastEventAt = iso(11);
    status.researchQueue.rejectedNew = 3;
    status.feedHealthMatrix.assets[0] = feed("BTC", "crypto", 11);
    book.rebalanceSchedule.overdue = true;
    const problems: string[] = evaluateHealth({ status, book, nowMs: NOW });
    assert.equal(problems.length, 6, problems.join("\n"));
    for (const word of [/scan is stale/, /asset error/, /ledger/, /dropped 3/, /BTC quote/, /rebalance is overdue/]) {
      assert.ok(problems.some((p) => word.test(p)), `missing ${word}`);
    }
  });

  await t.test("an asset whose cost-passing candidates are all blocked by risk gates alerts", () => {
    const { status, book } = healthy();
    const coverage: Array<Record<string, unknown>> = [
      { asset: "BTC", funnel7d: { costPass: 171, riskPass: 0, "veto:NO_SETUP": 2743, "veto:PORTFOLIO_RISK_BUDGET": 171 } },
      { asset: "GOLD", funnel7d: { costPass: 5, riskPass: 1 } },
    ];
    (status as Record<string, unknown>).assetCoverage = coverage;
    assert.deepEqual(evaluateHealth({ status, book, nowMs: NOW }).length, 1);
    // Once any asset fills again the alert clears, although the 7-day funnel still remembers.
    coverage[1].lastFillAt = iso(60);
    assert.deepEqual(evaluateHealth({ status, book, nowMs: NOW }), []);
    coverage[1].lastFillAt = iso(73 * 60);
    const problems: string[] = evaluateHealth({ status, book, nowMs: NOW });
    assert.deepEqual(problems, ["BTC: 171 candidates passed cost checks in 7 days and risk gates blocked all of them (top veto PORTFOLIO_RISK_BUDGET)."]);
  });

  await t.test("FX and commodity quotes may pause over the weekend; crypto may not", () => {
    const saturday = Date.parse("2026-10-10T12:00:00Z");
    assert.equal(tradfiWeekend(saturday), true);
    assert.equal(tradfiWeekend(NOW), false);
    const status = { ...healthy().status, swingScan: { completedAt: new Date(saturday).toISOString() }, executionLedger: { lastEventAt: new Date(saturday).toISOString() } };
    status.feedHealthMatrix = { assets: [{ asset: "EURUSD", category: "forex", dataEligibility: { quoteEventTimeMs: saturday - 3_600_000 } }, { asset: "BTC", category: "crypto", dataEligibility: { quoteEventTimeMs: saturday - 3_600_000 } }] };
    const problems: string[] = evaluateHealth({ status, book: {}, nowMs: saturday });
    assert.deepEqual(problems, ["BTC quote is older than 10 minutes."]);
  });

  await t.test("an older deployment without the rebalance schedule field is not an alert by itself", () => {
    assert.deepEqual(evaluateHealth({ status: healthy().status, book: {}, nowMs: NOW }), []);
  });
});
