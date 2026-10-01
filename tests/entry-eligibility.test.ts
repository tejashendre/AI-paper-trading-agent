import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateEntryEligibility,
  REQUIRED_CLOSED_BARS,
  validateExitQuote,
  WEEKLY_FEATURE_MIN_BARS,
} from "@/lib/trading/entryEligibility";
import { CONFIGURED_ASSETS, getConfiguredInstrument, validateBybitMetadata } from "@/lib/trading/instrumentRegistry";
import type { MarketPriceSnapshot } from "@/lib/market";
import { TradeAdmissionController } from "@/lib/trading/tradeAdmission";
import type { Portfolio } from "@/lib/types";
import { evidenceInstrument, SERVER_NOW } from "./helpers/fakeBybitMarket";

const NOW = SERVER_NOW;
const READY_BARS = { m15: 100, h1: 100, h4: 100, w1: 26 };

function freshQuote(asset: string, overrides: Partial<MarketPriceSnapshot> = {}): MarketPriceSnapshot {
  const instrument = getConfiguredInstrument(asset);
  return {
    price: 100,
    provider: "BYBIT_LINEAR_HTTP",
    source: "HTTP",
    transport: "REST",
    venue: "BYBIT_LINEAR",
    instrument: instrument.symbol,
    instrumentVersion: instrument.instrumentVersion,
    updatedAt: new Date(NOW - 1_000).toISOString(),
    eventTimeMs: NOW - 1_000,
    receivedAtMs: NOW - 900,
    bid: 99.99,
    ask: 100.01,
    quoteTimes: { lastPriceMs: NOW - 1_000, bidAskMs: NOW - 1_000, markMs: NOW - 1_000 },
    ...overrides,
  };
}

function input(asset: string, overrides: Record<string, unknown> = {}) {
  const instrument = getConfiguredInstrument(asset);
  return {
    instrument,
    metadata: validateBybitMetadata(instrument.symbol, evidenceInstrument(instrument.symbol), NOW - 60_000),
    quote: freshQuote(asset),
    closedBarCounts: READY_BARS,
    nowMs: NOW,
    fastExecution: false,
    depthAvailable: true,
    ...overrides,
  };
}

const hasReason = (reasons: string[], code: string) => reasons.some((reason) => reason.startsWith(`${code}:`));

test("nine_correct_symbols_pass_data_gate", async (t) => {
  for (const asset of CONFIGURED_ASSETS) {
    await t.test(asset, () => {
      const result = evaluateEntryEligibility(input(asset));
      assert.equal(result.allowed, true, result.reasons.join("; "));
      assert.equal(result.state, "READY");
      assert.equal(result.instrumentVersion, getConfiguredInstrument(asset).instrumentVersion);
    });
  }

  await t.test("a young FX contract trades with its weekly feature marked unavailable", () => {
    for (const asset of ["EURUSD", "GBPUSD", "USDJPY"]) {
      const result = evaluateEntryEligibility(input(asset, { closedBarCounts: { ...READY_BARS, w1: 3 } }));
      assert.equal(result.allowed, true, asset);
      assert.ok(hasReason(result.reasons, "WEEKLY_FEATURE_UNAVAILABLE"), result.reasons.join("; "));
    }
    assert.ok(WEEKLY_FEATURE_MIN_BARS > 3);
  });

  await t.test("intraday history below the requirement is warming up, not ready", () => {
    for (const key of ["m15", "h1", "h4"] as const) {
      const result = evaluateEntryEligibility(input("OIL", {
        closedBarCounts: { ...READY_BARS, [key]: REQUIRED_CLOSED_BARS - 1 },
      }));
      assert.equal(result.allowed, false);
      assert.equal(result.state, "WARMING_UP");
      assert.ok(hasReason(result.reasons, `WARMING_UP_${key.toUpperCase()}`), result.reasons.join("; "));
    }
  });
});

test("forged_stale_and_future_inputs_block_every_asset", async (t) => {
  const cases: Array<[string, (asset: string) => Record<string, unknown>, string]> = [
    ["wrong venue", (a) => ({ quote: freshQuote(a, { venue: "KRAKEN" }) }), "WRONG_VENUE"],
    ["wrong provider", (a) => ({ quote: freshQuote(a, { provider: "YAHOO" }) }), "WRONG_PROVIDER"],
    ["candle-close price fallback", (a) => ({ quote: freshQuote(a, { provider: "CANDLE_CLOSE" }) }), "WRONG_PROVIDER"],
    ["wrong symbol", (a) => ({ quote: freshQuote(a, { instrument: a === "BTC" ? "ETHUSDT" : "BTCUSDT" }) }), "WRONG_SYMBOL"],
    ["wrong instrument version", (a) => ({ quote: freshQuote(a, { instrumentVersion: `LEGACY_SYNTHETIC_V1:${a}` }) }), "WRONG_INSTRUMENT_VERSION"],
    ["NaN price", (a) => ({ quote: freshQuote(a, { price: Number.NaN }) }), "INVALID_PRICE"],
    ["nonpositive price", (a) => ({ quote: freshQuote(a, { price: 0 }) }), "INVALID_PRICE"],
    ["crossed book", (a) => ({ quote: freshQuote(a, { bid: 100.02, ask: 100.01 }) }), "CROSSED_BOOK"],
    ["missing bid/ask", (a) => ({ quote: freshQuote(a, { bid: undefined, ask: undefined, quoteTimes: { lastPriceMs: NOW - 1_000, bidAskMs: null, markMs: null } }) }), "MISSING_BID_ASK"],
    ["missing quote time", (a) => ({ quote: freshQuote(a, { quoteTimes: { lastPriceMs: Number.NaN, bidAskMs: NOW, markMs: null } }) }), "MISSING_QUOTE_TIME"],
    ["stale quote", (a) => ({ quote: freshQuote(a, { quoteTimes: { lastPriceMs: NOW - 10_001, bidAskMs: NOW - 1_000, markMs: null } }) }), "STALE_QUOTE"],
    ["future quote", (a) => ({ quote: freshQuote(a, { quoteTimes: { lastPriceMs: NOW + 2_001, bidAskMs: NOW, markMs: null } }) }), "FUTURE_QUOTE"],
    // A funding-only stream update refreshes the frame's time, never the price's.
    ["funding-only refresh", (a) => ({ quote: freshQuote(a, { transport: "WS", provider: "BYBIT_LINEAR_WS", source: "WEBSOCKET", eventTimeMs: NOW, quoteTimes: { lastPriceMs: NOW - 60_000, bidAskMs: NOW - 60_000, markMs: NOW } }) }), "STALE_QUOTE"],
    ["stale bid/ask", (a) => ({ quote: freshQuote(a, { quoteTimes: { lastPriceMs: NOW - 1_000, bidAskMs: NOW - 30_000, markMs: null } }) }), "STALE_BID_ASK"],
    ["REST clock uncertainty", (a) => ({ quote: freshQuote(a, { receivedAtMs: NOW - 1_000 + 2_500 }) }), "CLOCK_UNCERTAIN"],
    ["missing quote", () => ({ quote: null }), "QUOTE_MISSING"],
    ["missing metadata", () => ({ metadata: null }), "METADATA_UNUSABLE"],
    ["expired metadata", (a) => ({ metadata: validateBybitMetadata(getConfiguredInstrument(a).symbol, evidenceInstrument(getConfiguredInstrument(a).symbol), NOW - 25 * 3_600_000) }), "METADATA_UNUSABLE"],
    ["metadata for another symbol", (a) => ({ metadata: validateBybitMetadata(a === "BTC" ? "ETHUSDT" : "BTCUSDT", evidenceInstrument(a === "BTC" ? "ETHUSDT" : "BTCUSDT"), NOW) }), "METADATA_UNUSABLE"],
    ["legacy instrument", (a) => ({ instrument: { ...getConfiguredInstrument(a), venue: "LEGACY", economicsModel: "LEGACY_SYNTHETIC_V1", instrumentVersion: `LEGACY_SYNTHETIC_V1:${a}` } }), "WRONG_INSTRUMENT"],
  ];
  for (const [label, build, code] of cases) {
    await t.test(label, () => {
      for (const asset of CONFIGURED_ASSETS) {
        const result = evaluateEntryEligibility(input(asset, build(asset)));
        assert.equal(result.allowed, false, `${asset} ${label}`);
        assert.equal(result.state, "BLOCKED_DATA", `${asset} ${label}`);
        assert.ok(hasReason(result.reasons, code), `${asset} ${label}: ${result.reasons.join("; ")}`);
      }
    });
  }

  await t.test("a fresh REST quote serves swing entries but not a branch that needs the stream", () => {
    const swing = evaluateEntryEligibility(input("ETH"));
    assert.equal(swing.allowed, true);
    const fast = evaluateEntryEligibility(input("ETH", { fastExecution: true }));
    assert.equal(fast.allowed, false);
    assert.ok(hasReason(fast.reasons, "FAST_REQUIRES_STREAM_QUOTE"), fast.reasons.join("; "));
    const streamed = freshQuote("ETH", { transport: "WS", provider: "BYBIT_LINEAR_WS", source: "WEBSOCKET" });
    assert.equal(evaluateEntryEligibility(input("ETH", { fastExecution: true, quote: streamed })).allowed, true);
    const noDepth = evaluateEntryEligibility(input("ETH", { fastExecution: true, quote: streamed, depthAvailable: false }));
    assert.equal(noDepth.state, "BLOCKED_LIQUIDITY");
  });
});

test("exit_quotes_ignore_entry_warmup_but_not_provenance", () => {
  const instrument = getConfiguredInstrument("GOLD");
  assert.equal(validateExitQuote({ instrument, quote: freshQuote("GOLD"), nowMs: NOW }).valid, true);
  const stale = validateExitQuote({
    instrument,
    quote: freshQuote("GOLD", { quoteTimes: { lastPriceMs: NOW - 60_000, bidAskMs: null, markMs: null } }),
    nowMs: NOW,
  });
  assert.equal(stale.valid, false);
  assert.ok(hasReason(stale.reasons, "STALE_QUOTE"));
  assert.equal(validateExitQuote({ instrument, quote: freshQuote("GOLD", { instrument: "XAGUSDT" }), nowMs: NOW }).valid, false);
});

test("admission_refuses_a_blocked_data_eligibility", () => {
  const portfolio = {
    usd: 10_000, btc: 0, balances: {}, openPositions: {}, openPosition: null, peakValue: 10_000, initialCapital: 10_000,
    totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, grossProfit: 0, grossLoss: 0, consecutiveWins: 0,
    consecutiveLosses: 0, maxConsecutiveWins: 0, maxConsecutiveLosses: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
    returns: [], lastUpdated: new Date(NOW).toISOString(),
  } as Portfolio;
  const blocked = evaluateEntryEligibility(input("SILVER", { quote: null }));
  const result = TradeAdmissionController.evaluate({
    portfolio, asset: "SILVER", direction: "LONG", entryPrice: 60, stopLoss: 58, takeProfit: 66,
    signalScore: 80, finalConviction: 80, reasoning: "test", strategyType: "swing", dataEligibility: blocked,
  });
  assert.equal(result.approved, false);
  assert.match(result.reason, /QUOTE_MISSING/);
});
