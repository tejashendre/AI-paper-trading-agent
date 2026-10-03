import test from "node:test";
import assert from "node:assert/strict";
import { DAY_MS, ratioPosition, simulateBaselines, trendForwardEvidence, trendWeight, TREND_REGISTERED_AT_MS, type DailySeries } from "@/lib/research/baselines";

const START = Date.parse("2026-01-01T00:00:00Z");

function series(asset: string, dailyReturn: number, days: number, funding: DailySeries["funding"] = [], wiggle = 0.01): DailySeries {
  const closes = new Map<number, number>();
  let price = 100;
  for (let d = 0; d < days; d++) {
    closes.set(START + d * DAY_MS, price);
    price *= 1 + dailyReturn + (d % 2 === 0 ? wiggle : -wiggle);
  }
  return { asset, closes, funding, takerFeeRate: 0.00055 };
}

test("daily baselines are simulated net of fees and real funding", async (t) => {
  await t.test("trend weight blends three lookbacks and scales down volatile assets", () => {
    const up = [...series("A", 0.002, 200).closes.values()];
    const w = trendWeight(up)!;
    assert.ok(w > 0 && w <= 1);
    const down = [...series("B", -0.002, 200).closes.values()];
    assert.ok(trendWeight(down)! < 0);
    assert.equal(trendWeight(up.slice(0, 100)), null, "needs 121 closes");
    const wild = [...series("C", 0.002, 200, [], 0.08).closes.values()];
    assert.ok(Math.abs(trendWeight(wild)!) < Math.abs(w), "higher volatility means a smaller weight");
  });

  await t.test("equal-weight hold tracks the market; trend goes short a falling asset", () => {
    const up = series("UP", 0.003, 220), down = series("DOWN", -0.003, 220);
    const [hold, trend] = simulateBaselines({ series: [up, down], startMs: START + 150 * DAY_MS, endMs: START + 219 * DAY_MS, capitalUsd: 10_000 });
    assert.equal(hold.name, "EQUAL_WEIGHT_HOLD");
    assert.equal(trend.name, "TREND_DAILY");
    assert.ok(trend.returnPercent > 0, `trend ${trend.returnPercent}`);
    assert.ok(trend.returnPercent > hold.returnPercent);
    assert.ok(hold.feesUsd > 0 && trend.feesUsd > 0, "turnover costs are charged");
    assert.equal(hold.curve.length, 70);
  });

  await t.test("longs pay positive funding and shorts receive it", () => {
    const at = START + 160 * DAY_MS + 8 * 3_600_000;
    const up = series("UP", 0.003, 220, [{ atMs: at, rate: 0.01 }]);
    const [hold, trend] = simulateBaselines({ series: [up], startMs: START + 150 * DAY_MS, endMs: START + 219 * DAY_MS, capitalUsd: 10_000 });
    assert.ok(hold.fundingUsd > 0, "a long paid");
    assert.ok(trend.fundingUsd > 0, "trend was long the rising asset and paid");
    const down = series("DOWN", -0.003, 220, [{ atMs: at, rate: 0.01 }]);
    const [, short] = simulateBaselines({ series: [down], startMs: START + 150 * DAY_MS, endMs: START + 219 * DAY_MS, capitalUsd: 10_000 });
    assert.ok(short.fundingUsd < 0, "a short received");
  });

  await t.test("trend evidence counts only days after registration", () => {
    const [, trend] = simulateBaselines({ series: [series("UP", 0.003, 220)], startMs: START + 150 * DAY_MS, endMs: START + 219 * DAY_MS, capitalUsd: 10_000 });
    assert.ok(Date.parse(trend.curve.at(-1)!.at) < TREND_REGISTERED_AT_MS);
    const evidence = trendForwardEvidence(trend);
    assert.equal(evidence.passed, false);
    assert.equal(evidence.metrics.periods, 0);
  });

  await t.test("the BTC/ETH ratio book fades a 2-sigma divergence and exits near the mean", () => {
    const btc = new Map<number, number>(), eth = new Map<number, number>();
    for (let d = 0; d < 40; d++) { btc.set(START + d * DAY_MS, 100 * (1 + (d % 2) * 0.001)); eth.set(START + d * DAY_MS, 10); }
    const last = START + 39 * DAY_MS;
    assert.equal(ratioPosition(btc, eth, last, 0), 0, "inside the band nothing happens");
    btc.set(last, 110);
    assert.equal(ratioPosition(btc, eth, last, 0), -1, "BTC rich: short BTC, long ETH");
    btc.set(last, 100.05);
    assert.equal(ratioPosition(btc, eth, last, -1), 0, "back near the mean: flat");
    btc.set(last, 90);
    assert.equal(ratioPosition(btc, eth, last, 0), 1, "BTC cheap: long BTC, short ETH");
    eth.delete(last - DAY_MS);
    assert.equal(ratioPosition(btc, eth, last, 1), 0, "a missing day means no position");
  });

  await t.test("the ratio book trades only BTC and ETH, dollar-neutral", () => {
    const btc = series("BTC", 0.002, 220), eth = series("ETH", 0, 220), gold = series("GOLD", 0.001, 220);
    const ratio = simulateBaselines({ series: [btc, eth, gold], startMs: START + 150 * DAY_MS, endMs: START + 219 * DAY_MS, capitalUsd: 10_000 })[2];
    assert.equal(ratio.name, "BTC_ETH_RATIO");
    assert.equal(ratio.curve.length, 70);
  });
});
