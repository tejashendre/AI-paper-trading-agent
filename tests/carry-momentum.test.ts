import test from "node:test";
import assert from "node:assert/strict";
import { buildCarryMomentumBook, DEFAULT_STRATEGY, planCarryRebalance } from "@/lib/strategy/crossSectionalMomentum";

// 30 names: funding rises with the index; momentum alternates sign.
const names = Array.from({ length: 30 }, (_, i) => `C${i}USDT`);
const funding = new Map(names.map((s, i) => [s, (i - 15) * 0.0001]));
const momentum = new Map(names.map((s, i) => [s, i % 2 === 0 ? 0.05 : -0.05]));

test("carry with momentum agreement holds only names where both agree", async (t) => {
  await t.test("long low funding with positive momentum, short high funding with negative momentum, equal counts", () => {
    const book = buildCarryMomentumBook(momentum, funding, DEFAULT_STRATEGY);
    const longs = book.filter((p) => p.side === "LONG"), shorts = book.filter((p) => p.side === "SHORT");
    assert.equal(longs.length, shorts.length);
    assert.ok(longs.length > 0);
    for (const p of longs) assert.ok(funding.get(p.symbol)! < 0 && momentum.get(p.symbol)! > 0, p.symbol);
    for (const p of shorts) assert.ok(funding.get(p.symbol)! > 0 && momentum.get(p.symbol)! < 0, p.symbol);
    const gross = book.reduce((sum, p) => sum + Math.abs(p.weight), 0);
    assert.ok(gross <= DEFAULT_STRATEGY.grossExposure + 1e-12);
    assert.ok(Math.abs(book.reduce((sum, p) => sum + p.weight, 0)) < 1e-12, "dollar-neutral");
  });

  await t.test("when high-funding names are trending up there is no short, so the variant stays flat", () => {
    const allUp = new Map(names.map((s) => [s, 0.05]));
    assert.deepEqual(buildCarryMomentumBook(allUp, funding, DEFAULT_STRATEGY), []);
  });

  await t.test("no agreement closes what the variant held", () => {
    const plan = planCarryRebalance(new Map([["C0USDT", 0.05], ["C29USDT", -0.05]]), [], DEFAULT_STRATEGY, 30);
    assert.equal(plan.skipped, false);
    assert.deepEqual(plan.orders.map((o) => [o.symbol, o.toWeight, o.action]), [["C0USDT", 0, "CLOSE"], ["C29USDT", 0, "CLOSE"]]);
    assert.equal(planCarryRebalance(new Map(), [], DEFAULT_STRATEGY, 30).skipped, true);
  });
});
