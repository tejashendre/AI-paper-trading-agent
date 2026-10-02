import test from "node:test";
import assert from "node:assert/strict";
import { BybitTickerBook, BybitTickerState, mergeBybitTicker } from "@/lib/data/bybitPublic";
import { liveQuoteKey, MarketService, setMarketServiceDeps } from "@/lib/market";
import { forbidNetwork, makeFakeBybit, SERVER_NOW } from "./helpers/fakeBybitMarket";

const T0 = SERVER_NOW - 10_000;

const snapshot = (ts: number, data: Record<string, string> = {}) => ({
  topic: "tickers.XAUUSDT",
  type: "snapshot",
  ts,
  data: {
    symbol: "XAUUSDT",
    lastPrice: "4189.87",
    bid1Price: "4189.80",
    bid1Size: "3",
    ask1Price: "4189.90",
    ask1Size: "1",
    markPrice: "4189.88",
    indexPrice: "4190.10",
    fundingRate: "0.0001",
    nextFundingTime: String(T0 + 3_600_000),
    openInterest: "5000",
    ...data,
  },
});

const delta = (ts: number, data: Record<string, string>) => ({
  topic: "tickers.XAUUSDT",
  type: "delta",
  ts,
  data: { symbol: "XAUUSDT", ...data },
});

test("ticker_snapshot_delta_reconnect_and_quiet_price", async (t) => {
  await t.test("a snapshot initializes every field with its own event time", () => {
    const state = mergeBybitTicker(null, snapshot(T0), T0 + 5)!;
    assert.equal(state.symbol, "XAUUSDT");
    assert.equal(state.lastPrice, 4189.87);
    assert.equal(state.lastPriceEventMs, T0);
    assert.equal(state.bidAskEventMs, T0);
    assert.equal(state.markEventMs, T0);
    assert.equal(state.receivedAtMs, T0 + 5);
  });

  await t.test("a delta before any snapshot is not a quote", () => {
    assert.equal(mergeBybitTicker(null, delta(T0, { lastPrice: "4190" }), T0), null);
  });

  // Bybit pushes only changed fields in a delta, so a delta confirms every
  // field it omits as unchanged at its own time. A quiet but live market (the
  // FX contracts trade rarely) must not look stale; a dead socket still does,
  // because no deltas arrive at all.
  await t.test("a delta confirms the fields it omits as unchanged at its time", () => {
    const base = mergeBybitTicker(null, snapshot(T0), T0)!;
    const next = mergeBybitTicker(base, delta(T0 + 4_000, { fundingRate: "0.0002", openInterest: "5100" }), T0 + 4_001)!;
    assert.equal(next.fundingRate, 0.0002);
    assert.equal(next.sensorEventMs, T0 + 4_000);
    assert.equal(next.lastPrice, base.lastPrice, "values are unchanged");
    assert.equal(next.bid, base.bid);
    assert.equal(next.lastPriceEventMs, T0 + 4_000, "last price confirmed current");
    assert.equal(next.bidAskEventMs, T0 + 4_000, "bid/ask confirmed current");
    assert.equal(next.markEventMs, T0 + 4_000, "mark confirmed current");
  });

  await t.test("a field never seen in this session is not confirmed by a delta", () => {
    const base = mergeBybitTicker(null, snapshot(T0, { bid1Price: "", ask1Price: "", bid1Size: "", ask1Size: "" }), T0)!;
    assert.equal(base.bidAskEventMs, undefined);
    const next = mergeBybitTicker(base, delta(T0 + 2_000, { indexPrice: "4189.5" }), T0 + 2_000)!;
    assert.equal(next.bidAskEventMs, undefined);
    assert.equal(next.lastPriceEventMs, T0 + 2_000);
  });

  await t.test("a quiet but live contract keeps streaming instead of falling back to REST", async () => {
    const fake = makeFakeBybit();
    const restoreDeps = setMarketServiceDeps(fake.deps);
    const network = forbidNetwork();
    try {
      // Last trade a minute ago, but index deltas confirm the book every second.
      let state = mergeBybitTicker(null, snapshot(SERVER_NOW - 60_000), SERVER_NOW - 60_000)!;
      state = mergeBybitTicker(state, delta(SERVER_NOW - 500, { indexPrice: "4189.40" }), SERVER_NOW - 500)!;
      await fake.deps.cache.set(liveQuoteKey("GOLD"), state);
      const quote = await MarketService.getCurrentPriceSnapshot("GOLD");
      assert.equal(quote.transport, "WS");
      assert.equal(quote.quoteTimes.lastPriceMs, SERVER_NOW - 500);
    } finally {
      network.restore();
      restoreDeps();
    }
  });

  await t.test("an older delta is ignored", () => {
    const base = mergeBybitTicker(null, snapshot(T0 + 1_000), T0 + 1_000)!;
    assert.equal(mergeBybitTicker(base, delta(T0, { lastPrice: "1" }), T0 + 1_001), base);
  });

  await t.test("subscription acks and pongs are not quotes", () => {
    const base = mergeBybitTicker(null, snapshot(T0), T0)!;
    assert.equal(mergeBybitTicker(base, { op: "pong", success: true, ret_msg: "pong" }, T0 + 1), null);
    assert.equal(mergeBybitTicker(base, { op: "subscribe", success: true }, T0 + 1), null);
    assert.equal(mergeBybitTicker(base, "not json", T0 + 1), null);
  });

  await t.test("a public trade refreshes last price only", () => {
    const base = mergeBybitTicker(null, snapshot(T0), T0)!;
    const trade = { topic: "publicTrade.XAUUSDT", type: "snapshot", ts: T0 + 3_000, data: [
      { T: T0 + 2_500, s: "XAUUSDT", p: "4191.00", v: "0.1", S: "Buy" },
      { T: T0 + 2_900, s: "XAUUSDT", p: "4191.50", v: "0.2", S: "Buy" },
    ] };
    const next = mergeBybitTicker(base, trade, T0 + 3_001)!;
    assert.equal(next.lastPrice, 4191.5);
    assert.equal(next.lastPriceEventMs, T0 + 2_900);
    assert.equal(next.bidAskEventMs, T0);
  });

  await t.test("a reconnect invalidates prior-session state until a new snapshot", () => {
    const book = new BybitTickerBook();
    assert.ok(book.apply(snapshot(T0), T0));
    assert.ok(book.apply(delta(T0 + 1_000, { lastPrice: "4190" }), T0 + 1_000));
    book.reset();
    assert.equal(book.get("XAUUSDT"), null);
    assert.equal(book.apply(delta(T0 + 2_000, { lastPrice: "4191" }), T0 + 2_000), null);
    assert.equal(book.get("XAUUSDT"), null);
    assert.ok(book.apply(snapshot(T0 + 3_000), T0 + 3_000));
    assert.equal(book.get("XAUUSDT")!.lastPriceEventMs, T0 + 3_000);
  });

  await t.test("a quiet market is refreshed by REST without pretending it came from WS", async () => {
    const fake = makeFakeBybit();
    const restoreDeps = setMarketServiceDeps(fake.deps);
    const network = forbidNetwork();
    try {
      // The socket is connected and funding keeps arriving, but price is quiet.
      const quiet: BybitTickerState = {
        ...mergeBybitTicker(null, snapshot(SERVER_NOW - 60_000), SERVER_NOW - 60_000)!,
        fundingRate: 0.0003,
        sensorEventMs: SERVER_NOW - 500,
        receivedAtMs: SERVER_NOW - 500,
        lastEventMs: SERVER_NOW - 500,
      };
      await fake.deps.cache.set(liveQuoteKey("GOLD"), quiet);
      const viaRest = await MarketService.getCurrentPriceSnapshot("GOLD");
      assert.equal(viaRest.transport, "REST");
      assert.equal(viaRest.source, "HTTP");
      assert.equal(viaRest.eventTimeMs, SERVER_NOW);
      assert.ok(fake.calls.some((call) => call.includes("/v5/market/tickers") && call.includes("symbol=XAUUSDT")));

      const live = mergeBybitTicker(null, snapshot(SERVER_NOW - 1_000), SERVER_NOW - 990)!;
      await fake.deps.cache.set(liveQuoteKey("GOLD"), live);
      const viaWs = await MarketService.getCurrentPriceSnapshot("GOLD");
      assert.equal(viaWs.transport, "WS");
      assert.equal(viaWs.price, 4189.87);
      assert.equal(viaWs.eventTimeMs, SERVER_NOW - 1_000);
      assert.equal(viaWs.receivedAtMs, SERVER_NOW - 990);
      assert.equal(viaWs.quoteTimes.bidAskMs, SERVER_NOW - 1_000);
      assert.equal(viaWs.markPrice, 4189.88);
      assert.deepEqual(network.stray, []);
    } finally {
      network.restore();
      restoreDeps();
    }
  });
});
