import assert from "node:assert/strict";
import { test } from "node:test";
import { definition, outcomes } from "./helpers/researchFixtures";

import { deflatedSharpeRatio } from "@/lib/research/deflatedSharpe";
import { MemoryRedis } from "./helpers/memoryRedis";
import { setRedisClient } from "@/lib/redis";

async function registry(): Promise<any> {
  const module = await import("../src/lib/research/candidateRegistry").catch(() => ({}));
  assert.equal(typeof (module as any).evaluatePromotion, "function", "promotion evaluator is not implemented");
  return module;
}
test("no_edge_no_fee_proof_no_promotion", async () => {
  const r = await registry();
  const input = { definition, outcomes: outcomes(), trials: [definition], holdoutConsumed: false, feesVerified: true };
  const good = r.evaluatePromotion(input);
  assert.equal(good.eligible, true, JSON.stringify(good.reasons));
  for (const variant of [
    { ...input, feesVerified: false },
    { ...input, holdoutConsumed: true },
    { ...input, outcomes: outcomes(51) },
    { ...input, outcomes: outcomes().map(o => ({ ...o, netPnlUsdt: -5, netR: -0.05, returnOnInitialMargin: -0.005 })) },
    { ...input, outcomes: outcomes().map(o => ({ ...o, stressedNetPnlUsdt: -5 })) },
    { ...input, outcomes: outcomes().map(o => ({ ...o, historicalCostsAvailable: false })) },
    { ...input, outcomes: outcomes().map(o => ({ ...o, researchOrigin: "REPLAY" })) },
    { ...input, outcomes: outcomes().map(o => ({ ...o, riskLimitBreached: true })) },
  ]) {
    const report = r.evaluatePromotion(variant);
    assert.equal(report.eligible, false);
    assert.ok(report.reasons.length);
  }
  assert.deepEqual(r.evaluatePromotion(input), good, "seeded research must be reproducible");
});
test("candidate_search_is_counted_and_holdout_is_one_use", async () => {
  const r = await registry();
  const memory = new MemoryRedis(); setRedisClient(memory);
  try {
    await r.registerCandidate(definition);
    await r.registerCandidate(definition);
    const alternate = { ...definition, candidateId: "alternate", configHash: "config-2" };
    await r.registerCandidate(alternate);
    const trials = await r.getCandidateRegistry();
    assert.equal(trials.length, 2);
    assert.ok(trials.some((t: any) => t.holdoutConsumed === true), "reused holdout must be recorded as consumed");
    await assert.rejects(r.registerCandidate({ ...definition, configHash: "mutated-in-place" }), /immutable|identity/i);
    const five = Array.from({ length: 5 }, (_, i) => ({ ...definition, candidateId: "variant-" + i, configHash: "config-" + i }));
    const report = r.evaluatePromotion({ definition: five[0], outcomes: outcomes(), trials: five, holdoutConsumed: false, feesVerified: true });
    assert.equal(report.metrics.trialCount, 5);
    await assert.rejects(r.registerCandidate({ ...definition, candidateId: "third", configHash: "config-3", holdoutId: "fresh-3" }), /bounded|alternate/i);
  } finally { setRedisClient(null); }
});
test("all attempted trials count by default in Sharpe correction", () => {
  const result = deflatedSharpeRatio({ observedSharpePerPeriod: 0.4, periods: 100, skew: 0, kurtosis: 3, trials: 5 });
  assert.equal(result.effectiveTrials, 5);
});

test('renaming a consumed holdout cannot recycle the same evidence or interval', async () => {
  const r=await registry();
  const bound={...definition,evidenceManifestHash:'a'.repeat(64),
    holdoutStartMs:definition.registeredAtMs,holdoutEndMs:definition.registeredAtMs+300*86400000};
  const consumed={...bound,holdoutConsumed:true};
  const renamed={...bound,candidateId:'renamed',holdoutId:'new-name'};
  const rows=outcomes().map(o=>({...o,evidenceManifestHash:bound.evidenceManifestHash}));
  const input={definition:renamed,outcomes:rows,trials:[consumed,renamed],holdoutConsumed:false,feesVerified:true};
  assert.ok(r.evaluatePromotion(input).reasons.includes('HOLDOUT_CONSUMED'));
  const changedManifest={...renamed,evidenceManifestHash:'b'.repeat(64)};
  assert.ok(r.evaluatePromotion({...input,definition:changedManifest,trials:[consumed,changedManifest],
    outcomes:rows.map(o=>({...o,evidenceManifestHash:changedManifest.evidenceManifestHash}))}).reasons.includes('HOLDOUT_CONSUMED'));
  const shift=365*86400000;
  const fresh={...changedManifest,candidateId:'fresh',holdoutId:'fresh',registeredAtMs:bound.registeredAtMs-shift,
    holdoutStartMs:bound.holdoutStartMs-shift,holdoutEndMs:bound.holdoutEndMs-shift};
  const report=r.evaluatePromotion({...input,definition:fresh,trials:[consumed,fresh],outcomes:rows.map(o=>({...o,
    evidenceManifestHash:fresh.evidenceManifestHash,openedAtMs:o.openedAtMs-shift,closedAtMs:o.closedAtMs-shift,
    featureStartMs:o.featureStartMs-shift,labelEndMs:o.labelEndMs-shift}))});
  assert.equal(report.eligible,true,JSON.stringify(report.reasons));
  assert.equal(r.evaluatePromotion({...input,outcomes:rows.map(o=>({...o,evidenceManifestHash:'wrong'}))}).eligible,false);
});
