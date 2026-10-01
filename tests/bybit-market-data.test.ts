import test from "node:test";
import assert from "node:assert/strict";
import { Candle, Timeframe } from "@/lib/types";
import {
  closedCandles,
  entryInstrumentFor,
  MarketService,
  setMarketServiceDeps,
  SUPPORTED_ASSETS,
} from "@/lib/market";
import { getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";
import {
  amountFromNotionalUsd,
  calculateInstrumentPnl,
  calculatePnlUsd,
  estimateNotionalUsd,
  getUsdMovePerUnit,
  positionInstrument,
  tradeInstrument,
} from "@/lib/trading/assetSpecs";
import { buildPaperExecutionPlan } from "@/lib/trading/executionCostModel";
import { getMarketSessionState } from "@/lib/trading/marketSession";
import { checkSourceAgreement } from "@/lib/data/sourceAgreement";
import {
  barOpen,
  forbidNetwork,
  INTERVAL_MS,
  klineRows,
  makeFakeBybit,
  SERVER_NOW,
} from "./helpers/fakeBybitMarket";

const EXPECTED_SYMBOLS: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT",
  EURUSD: "EURUSDUSDT", GBPUSD: "GBPUSDUSDT", USDJPY: "USDJPYUSDT",
  GOLD: "XAUUSDT", OIL: "CLUSDT", SILVER: "XAGUSDT",
};
const TIMEFRAMES: Array<[Timeframe, string]> = [
  ["1m", "1"], ["5m", "5"], ["15m", "15"], ["30m", "30"], ["1h", "60"], ["4h", "240"],
];

function withFakeMarket(options: Parameters<typeof makeFakeBybit>[0] = {}) {
  const fake = makeFakeBybit(options);
  const restoreDeps = setMarketServiceDeps(fake.deps);
  const network = forbidNetwork();
  return {
    fake,
    network,
    restore: () => { network.restore(); restoreDeps(); },
  };
}

test("all_assets_use_bybit_for_all_market_paths", async (t) => {
  for (const [asset, symbol] of Object.entries(EXPECTED_SYMBOLS)) {
    await t.test(asset, async () => {
      const { fake, network, restore } = withFakeMarket();
      try {
        assert.equal(SUPPORTED_ASSETS[asset].bybitLinearSymbol, symbol);
        for (const [timeframe, interval] of TIMEFRAMES) {
          const candles = await MarketService.getCandles(timeframe, 50, asset);
          assert.ok(candles.length > 0, `${asset} ${timeframe}`);
          assert.ok(
            fake.calls.some((call) => call.includes("/v5/market/kline") && call.includes(`symbol=${symbol}`) && call.includes(`interval=${interval}&`)),
            `${asset} ${timeframe} kline request`
          );
        }
        // Weekly no longer branches on category: every asset reads Bybit W bars.
        const weekly = await MarketService.getWeeklyCandles(20, asset);
        assert.ok(weekly.length > 0);
        assert.ok(fake.calls.some((call) => call.includes(`symbol=${symbol}`) && call.includes("interval=W&")));

        const quote = await MarketService.getCurrentPriceSnapshot(asset);
        assert.equal(quote.instrument, symbol);
        assert.equal(quote.instrumentVersion, getConfiguredInstrument(asset).instrumentVersion);
        assert.equal(quote.transport, "REST");
        assert.ok(quote.bid! > 0 && quote.ask! > quote.bid!);

        const depth = await MarketService.getOrderbookImbalance(asset);
        assert.ok(depth.bidVolume > 0 && depth.askVolume > 0);
        const sensors = await MarketService.getDeepSensors(asset);
        assert.equal(sensors.fundingRate, 0.0001);
        assert.equal(sensors.openInterest, 123456);
        const metadata = await MarketService.getInstrumentMetadata(asset);
        assert.equal(metadata.symbol, symbol);

        const touched = new Set(
          fake.calls.map((call) => call.startsWith("metadata:")
            ? call.slice("metadata:".length)
            : new URL(call, "https://api.bybit.com").searchParams.get("symbol"))
        );
        assert.deepEqual([...touched], [symbol], "only the mapped instrument is requested");
        assert.ok(fake.calls.some((call) => call.includes("/v5/market/orderbook")));
        assert.deepEqual(network.stray, [], "no request bypassed the Bybit transport");
      } finally {
        restore();
      }
    });
  }

  await t.test("unknown assets fail explicitly instead of defaulting to BTC", async () => {
    const { fake, restore } = withFakeMarket();
    try {
      await assert.rejects(MarketService.getCandles("1h", 10, "XRP"), /not a configured asset/);
      await assert.rejects(MarketService.getWeeklyCandles(20, "XRP"), /not a configured asset/);
      await assert.rejects(MarketService.getCurrentPriceSnapshot("XRP"), /not a configured asset/);
      await assert.rejects(MarketService.getDeepSensors("XRP"), /not a configured asset/);
      await assert.rejects(MarketService.getOrderbookImbalance("XRP"), /not a configured asset/);
      await assert.rejects(MarketService.getInstrumentMetadata("XRP"), /not a configured asset/);
      assert.deepEqual(fake.calls, []);
    } finally {
      restore();
    }
  });

  await t.test("a missing sensor is unavailable, not zero or neutral", async () => {
    const { restore } = withFakeMarket({
      ticker: (symbol) => ({ symbol, lastPrice: "100", bid1Price: "99.9", ask1Price: "100.1" }),
    });
    try {
      const sensors = await MarketService.getDeepSensors("GOLD");
      assert.equal("fundingRate" in sensors, false);
      assert.equal("openInterest" in sensors, false);
    } finally {
      restore();
    }
  });
});

test("new_entries_trade_the_bybit_contract_for_every_asset", () => {
  for (const asset of Object.keys(EXPECTED_SYMBOLS)) {
    assert.deepEqual(entryInstrumentFor(asset), getConfiguredInstrument(asset), asset);
  }
});

function toCandles(rows: string[][]): Candle[] {
  return rows
    .map((row) => ({
      time: Number(row[0]) / 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .sort((a, b) => a.time - b.time);
}

test("higher_timeframe_features_are_causal", async (t) => {
  await t.test("the forming 4h and weekly bars are excluded by exchange time", () => {
    const fourHour = toCandles(klineRows("XAUUSDT", "240", 10, SERVER_NOW));
    const closed4h = closedCandles(fourHour, "4h", SERVER_NOW);
    assert.equal(closed4h.length, 9);
    assert.equal(closed4h[closed4h.length - 1].time * 1000 + INTERVAL_MS["240"], barOpen("240", SERVER_NOW));

    const weekly = toCandles(klineRows("EURUSDUSDT", "W", 4, SERVER_NOW));
    const closedWeekly = closedCandles(weekly, "1w", SERVER_NOW);
    assert.equal(closedWeekly.length, 3, "a new FX contract has three completed weeks");
    // At the exact close the bar counts as closed.
    assert.equal(closedCandles(fourHour, "4h", barOpen("240", SERVER_NOW) + INTERVAL_MS["240"]).length, 10);
  });

  await t.test("getCandles and getWeeklyCandles return only closed higher-timeframe bars", async () => {
    const { restore } = withFakeMarket();
    try {
      const fourHour = await MarketService.getCandles("4h", 100, "OIL");
      assert.ok(fourHour[fourHour.length - 1].time * 1000 < barOpen("240", SERVER_NOW));
      const weekly = await MarketService.getWeeklyCandles(20, "USDJPY");
      assert.ok(weekly[weekly.length - 1].time * 1000 < barOpen("W", SERVER_NOW));
    } finally {
      restore();
    }
  });

  await t.test("appending later bars never changes earlier bars", async () => {
    const wickTime = barOpen("240", SERVER_NOW) - 3 * INTERVAL_MS["240"];
    const withWick = (rows: string[][]) => rows.map((row) =>
      Number(row[0]) === wickTime ? [row[0], "100", "131", "99", "100.5", row[5], row[6]] : row
    );
    const early = makeFakeBybit({ kline: (s, i, l, now) => withWick(klineRows(s, i, l, now)) });
    let restoreDeps = setMarketServiceDeps(early.deps);
    let before: Candle[];
    try {
      before = await MarketService.getCandles("4h", 50, "SOL");
    } finally {
      restoreDeps();
    }

    const later = SERVER_NOW + 2 * INTERVAL_MS["240"];
    const appended = makeFakeBybit({
      nowMs: later,
      kline: (s, i, l, now) => {
        const rows = withWick(klineRows(s, i, l, now));
        // The bar after the wick opens far away; it must not reshape the wick.
        return rows.map((row) => Number(row[0]) === wickTime + INTERVAL_MS["240"]
          ? [row[0], "160", "161", "159", "160.5", row[5], row[6]]
          : row);
      },
    });
    restoreDeps = setMarketServiceDeps(appended.deps);
    try {
      const after = await MarketService.getCandles("4h", 50, "SOL");
      const shared = after.filter((bar) => before.some((old) => old.time === bar.time) && bar.time * 1000 !== wickTime + INTERVAL_MS["240"]);
      for (const bar of shared) {
        assert.deepEqual(bar, before.find((old) => old.time === bar.time), `bar ${bar.time}`);
      }
      const wick = after.find((bar) => bar.time * 1000 === wickTime)!;
      assert.equal(wick.high, 131, "a genuine wick is kept, not clipped");
    } finally {
      restoreDeps();
    }
  });

  await t.test("missing and invalid bars are flagged, never manufactured", async () => {
    const hole = barOpen("60", SERVER_NOW) - 5 * INTERVAL_MS["60"];
    const broken = barOpen("60", SERVER_NOW) - 8 * INTERVAL_MS["60"];
    const { restore } = withFakeMarket({
      kline: (s, i, l, now) => i !== "60" ? undefined : klineRows(s, i, l, now)
        .filter((row) => Number(row[0]) !== hole)
        .map((row) => Number(row[0]) === broken ? [row[0], "100", "99", "98", "101", row[5], row[6]] : row),
    });
    try {
      const hourly = await MarketService.getCandles("1h", 100, "ETH");
      assert.equal(hourly.some((bar) => bar.time * 1000 === hole), false, "no bar is invented for the gap");
      assert.equal(hourly.some((bar) => bar.time * 1000 === broken), false, "a bar with high below close is dropped");
      const status = MarketService.getCandleSeriesStatus("ETH", "1h", hourly);
      assert.equal(status.missingBars, 2);
    } finally {
      restore();
    }
  });
});

test("contract_sessions_are_24_7_with_underlying_liquidity_windows", () => {
  const saturday = new Date("2026-10-03T15:00:00.000Z");
  const tuesdayPeak = new Date("2026-09-29T14:00:00.000Z");
  for (const asset of Object.keys(EXPECTED_SYMBOLS)) {
    const session = getMarketSessionState(asset, saturday);
    assert.equal(session.isOpen, true, `${asset} perpetual trades through the weekend`);
    if (SUPPORTED_ASSETS[asset].category === "crypto") {
      assert.equal(session.isPeakLiquidity, true);
    } else {
      assert.doesNotMatch(session.reason, /crypto/i, asset);
      assert.equal(session.isPeakLiquidity, false, `${asset} weekend liquidity is thin`);
      assert.ok(session.warnings.some((w) => /weekend/i.test(w)), asset);
    }
  }
  assert.equal(getMarketSessionState("GOLD", tuesdayPeak).isPeakLiquidity, true);
  assert.equal(getMarketSessionState("GOLD", new Date("2026-09-29T03:00:00.000Z")).isPeakLiquidity, false);
  assert.equal(getMarketSessionState("XRP", tuesdayPeak).isOpen, false);
});

test("single_venue_policy_reports_transport_consistency_only", async () => {
  const { network, restore } = withFakeMarket();
  try {
    const restOnly = await checkSourceAgreement("BTC");
    assert.equal(restOnly.independentVenues, 1);
    assert.equal(restOnly.policy, "SINGLE_VENUE_TRANSPORT_CONSISTENCY");
    assert.deepEqual(restOnly.sourcesChecked, ["BYBIT_LINEAR_REST"]);
    assert.ok(restOnly.warnings.some((w) => /stream/i.test(w)), "an unchecked stream is reported");
    assert.deepEqual(network.stray, [], "no Kraken or CoinGecko comparison request");
  } finally {
    restore();
  }
});

test("new_entry_sizing_uses_the_linear_contract_for_usdjpy", () => {
  // A new USDJPYUSDT position is sized and valued as a linear USDT contract.
  assert.equal(amountFromNotionalUsd("USDJPY", 1_500, 150), 10);
  assert.equal(estimateNotionalUsd("USDJPY", 10, 150), 1_500);
  assert.equal(calculatePnlUsd("USDJPY", 150, 151, 10, "LONG"), 10);
  assert.equal(getUsdMovePerUnit("USDJPY", 150, 149), 1);
  const plan = buildPaperExecutionPlan({
    asset: "USDJPY", direction: "LONG", entryPrice: 150, stopLoss: 149, takeProfit: 153, amount: 10,
  });
  assert.ok(Math.abs(plan.entry.notionalUsd - 10 * plan.entry.fillPrice) < 1e-9);
  // A one-yen stop on 10 contracts risks about 10 USDT plus fees and slippage
  // (the FX stress fee alone is about 1.65 USDT round trip), not 10/149.
  assert.ok(plan.netLossUsd > 9 && plan.netLossUsd < 15, `netLossUsd ${plan.netLossUsd}`);

  // The legacy formula survives only for positions that were opened under it.
  const legacy = positionInstrument({ asset: "USDJPY", strategyType: "swing" });
  const legacyPnl = calculateInstrumentPnl({ instrument: legacy, entryPrice: 150, exitPrice: 151, quantity: 10, direction: "LONG" });
  assert.ok(Math.abs(legacyPnl - 10 / 151) < 1e-12);
  // Trade rows written before the upgrade are costed under the legacy model.
  assert.equal(tradeInstrument({ asset: "USDJPY" }).economicsModel, "LEGACY_SYNTHETIC_V1");
});
