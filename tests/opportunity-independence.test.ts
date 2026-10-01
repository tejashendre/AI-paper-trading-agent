import assert from "node:assert/strict";
import { test } from "node:test";
import * as journal from "@/lib/trading/opportunityJournal";
import { getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";

const start = Date.parse("2026-09-01T12:00:00Z");
const record: any = { id: "setup-1", asset: "GOLD", family: "TREND_PULLBACK", configHash: "config",
  instrumentVersion: getConfiguredInstrument("GOLD").instrumentVersion, featureCutoffMs: start,
  featureStartMs: start - 86400000, timestamp: new Date(start).toISOString(), direction: "LONG" };
test("overlapping_opportunities_count_once", () => {
  const fn = (journal as any).selectIndependentSetups;
  assert.equal(typeof fn, "function");
  const overlapping = Array.from({ length: 10 }, (_, i) => ({ ...record, id: "overlap-" + i, featureCutoffMs: start + i * 900000 }));
  assert.equal(fn({ opportunities: overlapping, horizonMs: 86400000 }).length, 1);
  assert.equal(fn({ opportunities: [...overlapping, { ...record, id: "later", featureStartMs: start + 3 * 86400000,
    featureCutoffMs: start + 4 * 86400000 }], horizonMs: 86400000 }).length, 2);
  assert.equal(fn({ opportunities: [record, { ...record, asset: "SILVER", instrumentVersion: "BYBIT:SILVER" }], horizonMs: 86400000 }).length, 2);
});
test("one preregistered 24h label, never the fastest matured horizon", () => {
  const base: any = { id: "e1", opportunityId: "setup-1", asset: "GOLD", horizon: "4h",
    evaluatedAt: new Date(start + 4 * 3600000).toISOString() };
  assert.deepEqual(journal.selectIndependentOpportunityEvaluations([base]), []);
  const daily = { ...base, id: "e2", horizon: "24h", evaluatedAt: new Date(start + 86400000).toISOString() };
  assert.deepEqual(journal.selectIndependentOpportunityEvaluations([base, daily]), [daily]);
});
