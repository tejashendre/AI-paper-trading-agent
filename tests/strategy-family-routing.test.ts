import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candle } from "@/lib/types";
import type { MarketPriceSnapshot } from "@/lib/market";
import * as engine from "@/lib/swingEngine";
import { CONFIGURED_ASSETS, getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";
import { getMarketSessionState } from "@/lib/trading/marketSession";
import { OpportunityJournal } from "@/lib/trading/opportunityJournal";
import { MemoryRedis } from "./helpers/memoryRedis";
import { setRedisClient } from "@/lib/redis";

const NOW = Date.UTC(2026, 9, 1, 12);
const bases = [84000, 2700, 119, 1.13, 1.32, 158, 4190, 90, 61];
function series(base: number, seconds: number, kind: "trend" | "range" | "flat"): Candle[] {
  return Array.from({ length: 100 }, (_, i) => {
    const close = kind === "trend" ? base * (0.65 + i * 0.0035) : kind === "range" ? base * (1 + 0.02 * Math.sin(i / 3)) : base;
    const open = kind === "trend" ? close - base * 0.002 : close;
    return { time: NOW / 1000 - (100 - i) * seconds, open, close,
      high: Math.max(open, close) + base * 0.0002, low: Math.min(open, close) - base * 0.0002, volume: 1000 };
  });
}
function fixture(asset: typeof CONFIGURED_ASSETS[number], base: number, kind: "trend" | "range" | "flat") {
  const instrument = getConfiguredInstrument(asset);
  const h1 = series(base, 3600, kind);
  const h4 = series(base, 14400, kind === "range" ? "flat" : kind);
  const m15 = series(base, 900, kind);
  if (kind === "range") {
    h1[99] = { ...h1[99], open: base * 0.973, low: base * 0.963, high: base * 0.974, close: base * 0.964 };
    m15[99] = { ...m15[99], open: base * 0.964, low: base * 0.964, high: base * 0.971, close: base * 0.970 };
  }
  const price = m15[99].close;
  const quote: MarketPriceSnapshot = {
    price, provider: "BYBIT_LINEAR_WS", source: "WEBSOCKET", transport: "WS", venue: "BYBIT_LINEAR",
    instrument: instrument.symbol, instrumentVersion: instrument.instrumentVersion,
    updatedAt: new Date(NOW).toISOString(), eventTimeMs: NOW, receivedAtMs: NOW,
    bid: price * 0.99999, ask: price * 1.00001,
    quoteTimes: { lastPriceMs: NOW, bidAskMs: NOW, markMs: null },
  };
  return { instrument, candles15m: m15, candles1h: h1, candles4h: h4, weeklyCandles: [], quote, nowMs: NOW };
}
function evaluate(input: ReturnType<typeof fixture>): any[] {
  const fn = (engine as any).evaluateStrategyFamilies;
  assert.equal(typeof fn, "function", "strategy-family evaluator is not implemented");
  return fn(input);
}
for (const [i, asset] of CONFIGURED_ASSETS.entries()) {
  test(`families_evaluate_every_instrument_without_crypto_assumptions: ${asset}`, () => {
    const trend = evaluate(fixture(asset, bases[i], "trend"));
    assert.ok(trend.some(c => c.family === "TREND_PULLBACK" && c.direction === "LONG"));
    const range = evaluate(fixture(asset, bases[i], "range"));
    assert.ok(range.some(c => c.family === "RANGE_REVERSION" && c.direction === "LONG" && c.mode === "SHADOW"));
    assert.deepEqual(evaluate(fixture(asset, bases[i], "flat")), []);
    for (const candidate of [...trend, ...range]) {
      assert.equal(candidate.asset, asset);
      assert.ok(candidate.featureCutoffMs <= NOW);
      assert.ok(candidate.initialRiskUsdt > 0);
      assert.ok(candidate.stopPrice < candidate.entryPrice && candidate.targetPrice > candidate.entryPrice);
    }
  });
}
test("forming bars, stale quotes and wrong symbols cannot create a candidate", () => {
  const input = fixture("BTC", bases[0], "trend");
  const expected = evaluate(input);
  const unfinished = { ...input.candles4h[99], time: NOW / 1000, close: 1 };
  assert.deepEqual(evaluate({ ...input, candles4h: [...input.candles4h, unfinished] }), expected);
  assert.deepEqual(evaluate({ ...input, quote: { ...input.quote, eventTimeMs: NOW - 20000,
    updatedAt: new Date(NOW - 20000).toISOString(), quoteTimes: { ...input.quote.quoteTimes, lastPriceMs: NOW - 20000 } } }), []);
  assert.deepEqual(evaluate({ ...input, quote: { ...input.quote, instrument: "ETHUSDT" } }), []);
  assert.deepEqual(evaluate({ ...input, candles1h: input.candles1h.slice(-20) }), []);
});
test("candidate identity is stable for a closed setup bar, not a scan timestamp", () => {
  const input = fixture("GOLD", bases[6], "range");
  const first = evaluate(input)[0];
  const second = evaluate({ ...input, nowMs: NOW + 1000 })[0];
  assert.equal(first.candidateId, second.candidateId);
  assert.equal(first.configHash, second.configHash);
});
test("replay uses the same family evaluator with explicit historical quote provenance", () => {
  const input = fixture("GOLD", bases[6], "range");
  const quote = { ...input.quote, provider: "REPLAY", venue: "REPLAY", source: "HTTP" as const, transport: "REST" as const };
  assert.deepEqual(evaluate({ ...input, quote }), []);
  const fn = (engine as any).evaluateStrategyFamilies;
  const replay = fn({ ...input, quote, dataMode: "REPLAY" });
  assert.equal(replay[0]?.family, "RANGE_REVERSION");
  assert.equal(replay[0]?.candidateId, evaluate(input)[0].candidateId);
});
test("missing_flow_and_high_cost_do_not_create_false_opportunities", () => {
  const input = fixture("EURUSD", bases[3], "range");
  assert.ok(evaluate(input).length);
  assert.deepEqual(evaluate({ ...input, quote: { ...input.quote, bid: input.quote.price * 0.9, ask: input.quote.price * 1.1 } }), []);
  const weekend = getMarketSessionState("EURUSD", new Date("2026-10-03T12:00:00Z"));
  assert.equal(weekend.isOpen, true);
  assert.equal(weekend.underlyingOpen, false);
  assert.ok(weekend.warnings.length);
});
test("family journal retains setup identity, shadow mode and the binding veto", () => {
  const record = OpportunityJournal.buildFromScanResult({
    asset: "GOLD", action: "WATCH", decisionState: "WATCH_LONG", price: 4100, direction: "LONG",
    timestamp: new Date(NOW).toISOString(), candidateId: "range-gold-bar-1", family: "RANGE_REVERSION",
    configHash: "range-v1", featureCutoffMs: NOW - 900000, mode: "SHADOW", vetoCode: "LIQUIDITY",
  }) as any;
  assert.equal(record.candidateId, "range-gold-bar-1");
  assert.equal(record.family, "RANGE_REVERSION");
  assert.equal(record.mode, "SHADOW");
  assert.equal(record.vetoCode, "LIQUIDITY");
});
test("repeat scans count a setup once and a later bar remains a new observation", async () => {
  const memory = new MemoryRedis();
  setRedisClient(memory);
  try {
    const input = { asset: "GOLD", action: "WATCH", decisionState: "WATCH_LONG", price: 4100,
      timestamp: new Date(NOW).toISOString(), family: "RANGE_REVERSION", candidateId: "gold-bar-1",
      mode: "SHADOW", direction: "LONG", finalConviction: 30 };
    await OpportunityJournal.recordMany([input, input, { ...input, candidateId: "gold-bar-2" }]);
    assert.equal((await OpportunityJournal.getRecent(20)).length, 2);
  } finally { setRedisClient(null); }
});
