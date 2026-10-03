import test from "node:test";
import assert from "node:assert/strict";
import { BOOK_TARGET_ANNUAL_VOL, volatilityScale } from "@/lib/execution/bookRiskPolicy";
import { buildTargetBook, DEFAULT_STRATEGY, rankByMomentum } from "@/lib/strategy/crossSectionalMomentum";

const T0 = Date.parse("2026-09-01T00:00:00Z");
const HALF_DAY = 12 * 3_600_000;
function curve(periodMove: number, n = 61) {
  let equity = 10_000;
  return Array.from({ length: n }, (_, i) => {
    if (i > 0) equity *= 1 + (i % 2 === 0 ? periodMove : -periodMove);
    return { at: new Date(T0 + i * HALF_DAY).toISOString(), equityUsd: equity };
  });
}

test("volatility scaling only ever shrinks the book", async (t) => {
  await t.test("a book running hotter than target is scaled down in proportion", () => {
    // +/-3% every 12h is about 81% annualized.
    const result = volatilityScale(curve(0.03));
    assert.ok(result.realizedAnnualVol! > 0.7 && result.realizedAnnualVol! < 0.9, String(result.realizedAnnualVol));
    assert.ok(Math.abs(result.scale - BOOK_TARGET_ANNUAL_VOL / result.realizedAnnualVol!) < 1e-12);
  });

  await t.test("a calm book is never levered up", () => {
    assert.equal(volatilityScale(curve(0.001)).scale, 1);
  });

  await t.test("too little history leaves the size unchanged", () => {
    const result = volatilityScale(curve(0.03, 10));
    assert.equal(result.scale, 1);
    assert.equal(result.realizedAnnualVol, null);
  });

  await t.test("a scaled gross exposure shrinks every target weight", () => {
    const momentum = new Map(Array.from({ length: 30 }, (_, i) => [`C${i}USDT`, i - 15]));
    const ranked = rankByMomentum(momentum);
    const full = buildTargetBook(ranked, new Map(), DEFAULT_STRATEGY);
    const half = buildTargetBook(ranked, new Map(), { ...DEFAULT_STRATEGY, grossExposure: DEFAULT_STRATEGY.grossExposure * 0.5 });
    const gross = (book: typeof full) => book.reduce((sum, target) => sum + Math.abs(target.weight), 0);
    assert.ok(Math.abs(gross(half) - gross(full) / 2) < 1e-12);
  });
});
