import test from "node:test";
import assert from "node:assert/strict";
import { clearCrowdingCache, evaluateCrowding, loadCrowdingInputs } from "@/lib/strategy/crowding";
import { stagesReached } from "@/lib/trading/coverageStatus";

const ramp = (n: number, from: number, to: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

test("crowding filter skips only the crowded side", async (t) => {
  await t.test("top-decile long share and positive top-decile funding block longs, not shorts", () => {
    const inputs = { buyRatios: ramp(100, 0.5, 0.78), fundingRates: ramp(60, -0.0001, 0.0005) };
    const long = evaluateCrowding("LONG", inputs);
    assert.equal(long.crowded, true);
    assert.match(long.reason, /CROWDED_LONG: 78% of accounts long/);
    assert.equal(evaluateCrowding("SHORT", inputs).crowded, false);
  });

  await t.test("one extreme alone is not crowding", () => {
    const ratioOnly = { buyRatios: ramp(100, 0.5, 0.78), fundingRates: [...ramp(59, 0.0001, 0.0005), 0.0002] };
    assert.equal(evaluateCrowding("LONG", ratioOnly).crowded, false);
  });

  await t.test("bottom-decile long share with negative bottom-decile funding blocks shorts", () => {
    const inputs = { buyRatios: ramp(100, 0.7, 0.3), fundingRates: ramp(60, 0.0001, -0.0006) };
    assert.equal(evaluateCrowding("SHORT", inputs).crowded, true);
    assert.equal(evaluateCrowding("LONG", inputs).crowded, false);
  });

  await t.test("too little history never blocks", () => {
    const decision = evaluateCrowding("LONG", { buyRatios: ramp(10, 0.5, 0.9), fundingRates: ramp(10, 0, 0.001) });
    assert.equal(decision.crowded, false);
    assert.equal(decision.ratioRank, null);
  });

  await t.test("inputs come from Bybit newest-first lists, are cached, and add the current rate", async () => {
    clearCrowdingCache();
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      const list = String(url).includes("account-ratio")
        ? [{ buyRatio: "0.7" }, { buyRatio: "0.6" }]
        : [{ fundingRate: "0.0003" }, { fundingRate: "0.0001" }];
      return new Response(JSON.stringify({ retCode: 0, result: { list }, time: 1 }), { status: 200 });
    }) as typeof fetch;
    const first = await loadCrowdingInputs("XAUUSDT", 0.0004, { fetchImpl, nowMs: () => 1_000 });
    assert.deepEqual(first, { buyRatios: [0.6, 0.7], fundingRates: [0.0001, 0.0003, 0.0004] });
    await loadCrowdingInputs("XAUUSDT", undefined, { fetchImpl, nowMs: () => 2_000 });
    assert.equal(calls, 2, "second call within 15 minutes is served from cache");
  });

  await t.test("CROWDING is a risk veto that passed provenance", () => {
    const stages = stagesReached({ decisionId: "d", asset: "GOLD", at: "2026-10-03T00:00:00Z", action: "BLOCKED", vetoCode: "CROWDING", reason: "" });
    assert.deepEqual(stages, ["closedBars", "evaluations", "candidates", "provenancePass"]);
  });
});
