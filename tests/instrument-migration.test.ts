import test from "node:test";
import assert from "node:assert/strict";
import { OpenPosition, Portfolio, Trade } from "@/lib/types";
import { getConfiguredInstrument, legacyInstrument } from "@/lib/trading/instrumentRegistry";
import {
  autonomousPositionIdentity,
  calculateInstrumentPnl,
  instrumentNotional,
  instrumentQuantityFromNotional,
  migrationEntryBlock,
  positionInstrument,
  positionLegIdentity,
} from "@/lib/trading/assetSpecs";
import { entryInstrumentFor } from "@/lib/market";
import { INSTRUMENT_MIGRATION_VERSION, planInstrumentMigration } from "../scripts/migrate-bybit-instruments";

const NOW = Date.parse("2026-10-01T08:00:00.000Z");

function position(overrides: Partial<OpenPosition>): OpenPosition {
  return {
    asset: "BTC",
    entryPrice: 100,
    amount: 1,
    btcAmount: 1,
    usdInvested: 100,
    stopLoss: 90,
    takeProfit: 120,
    entryTime: "2026-09-20T10:00:00.000Z",
    signalScore: 70,
    reasoning: "fixture",
    direction: "LONG",
    strategyType: "swing",
    ...overrides,
  };
}

function portfolio(openPositions: Record<string, OpenPosition>): Portfolio {
  return {
    usd: 9_876.54,
    btc: 0,
    balances: {},
    openPositions,
    openPosition: null,
    peakValue: 10_120,
    initialCapital: 10_000,
    totalTrades: 3,
    winningTrades: 2,
    losingTrades: 1,
    totalPnl: 10,
    grossProfit: 15,
    grossLoss: 5,
    consecutiveWins: 0,
    consecutiveLosses: 1,
    maxConsecutiveWins: 2,
    maxConsecutiveLosses: 1,
    maxDrawdown: 50,
    maxDrawdownPercent: 0.5,
    returns: [1.5, -0.5],
    lastUpdated: "2026-09-30T00:00:00.000Z",
  };
}

function trade(overrides: Partial<Trade>): Trade {
  return {
    id: "t",
    timestamp: "2026-09-20T10:00:00.000Z",
    asset: "BTC",
    action: "BUY",
    direction: "LONG",
    amount: 1,
    btcAmount: 1,
    price: 100,
    usdValue: 100,
    stopLoss: 90,
    takeProfit: 120,
    signalScore: 70,
    reasoning: "fixture",
    ...overrides,
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("legacy_usdjpy_model_survives_new_registry", async (t) => {
  const legacy = position({ asset: "USDJPY", entryPrice: 150, amount: 10, btcAmount: 10 });

  await t.test("unlabeled autonomous position reads as the legacy synthetic model", () => {
    const instrument = positionInstrument(legacy);
    assert.equal(instrument.economicsModel, "LEGACY_SYNTHETIC_V1");
    assert.equal(instrument.venue, "LEGACY");
    assert.equal(instrument.settlementCurrency, "USD_PROXY");
    const pnl = calculateInstrumentPnl({ instrument, entryPrice: 150, exitPrice: 151, quantity: 10, direction: "LONG" });
    assert.ok(Math.abs(pnl - 10 / 151) < 1e-12, `legacy pnl ${pnl}`);
    // Quantity was USD exposure in the legacy model.
    assert.equal(instrumentNotional(instrument, 10, 150), 10);
  });

  await t.test("the new Bybit contract uses linear USDT economics", () => {
    const linear = getConfiguredInstrument("USDJPY");
    assert.equal(calculateInstrumentPnl({ instrument: linear, entryPrice: 150, exitPrice: 151, quantity: 10, direction: "LONG" }), 10);
    assert.equal(calculateInstrumentPnl({ instrument: linear, entryPrice: 150, exitPrice: 151, quantity: 10, direction: "SHORT" }), -10);
    assert.equal(instrumentNotional(linear, 10, 150), 1_500);
    assert.equal(instrumentQuantityFromNotional(linear, 1_500, 150), 10);
  });

  await t.test("migration labels the legacy model and never writes the Bybit reference onto it", () => {
    const input = { portfolios: [portfolio({ USDJPY: legacy })], trades: [], nowMs: NOW };
    const out = planInstrumentMigration(clone(input));
    const migrated = out.migratedPortfolios[0].openPositions.USDJPY;
    assert.deepEqual(migrated.instrument, legacyInstrument("USDJPY", "LEGACY_SYNTHETIC_V1"));
    assert.equal(migrated.economicsModel, "LEGACY_SYNTHETIC_V1");
    assert.notEqual(migrated.instrument!.instrumentVersion, getConfiguredInstrument("USDJPY").instrumentVersion);
    const pnl = calculateInstrumentPnl({
      instrument: positionInstrument(migrated), entryPrice: 150, exitPrice: 151, quantity: 10, direction: "LONG",
    });
    assert.ok(Math.abs(pnl - 10 / 151) < 1e-12);
    // Every original field is untouched.
    for (const [key, value] of Object.entries(legacy)) {
      assert.deepEqual((migrated as any)[key], value, key);
    }
    assert.deepEqual(out.conflicts, []);
  });

  await t.test("manual paper positions keep their own execution model", () => {
    const manual = position({ asset: "GOLD", strategyType: undefined, reasoning: "Manual BUY order" });
    assert.equal(positionInstrument(manual).economicsModel, "LEGACY_PAPER_V1");
    const out = planInstrumentMigration({ portfolios: [portfolio({ GOLD: manual })], trades: [], nowMs: NOW });
    assert.equal(out.migratedPortfolios[0].openPositions.GOLD.economicsModel, "LEGACY_PAPER_V1");
  });

  await t.test("a position already on the Bybit model is left as it is", () => {
    const identity = autonomousPositionIdentity({
      instrument: getConfiguredInstrument("OIL"),
      initialRiskUsdt: 40,
      costModelVersion: "cost-test",
    });
    const current = position({ asset: "OIL", ...identity });
    const out = planInstrumentMigration({ portfolios: [portfolio({ OIL: current })], trades: [], nowMs: NOW });
    assert.deepEqual(out.migratedPortfolios[0].openPositions.OIL, current);
  });

  await t.test("unknown legacy provenance is a conflict that blocks only that asset", () => {
    const forged = position({
      asset: "USDJPY",
      instrument: { ...getConfiguredInstrument("USDJPY"), symbol: "USDJPY=X" },
      economicsModel: "BYBIT_LINEAR_USDT_V1",
    });
    const mislabeled = position({ asset: "XRP" });
    const out = planInstrumentMigration({
      portfolios: [portfolio({ USDJPY: forged, SILVER: mislabeled, BTC: position({}) })],
      trades: [],
      nowMs: NOW,
    });
    const migrated = out.migratedPortfolios[0];
    assert.ok(out.conflicts.some((c) => c.startsWith("USDJPY:")), out.conflicts.join("\n"));
    assert.ok(out.conflicts.some((c) => c.startsWith("SILVER:")), out.conflicts.join("\n"));
    // Conflicting records are reported, not relabeled.
    assert.deepEqual(migrated.openPositions.USDJPY, forged);
    assert.match(String(migrationEntryBlock(migrated, "USDJPY")), /USDJPY/);
    assert.match(String(migrationEntryBlock(migrated, "SILVER")), /SILVER/);
    assert.equal(migrationEntryBlock(migrated, "BTC"), null);
  });
});

test("new_autonomous_positions_carry_complete_identity", () => {
  assert.throws(
    () => autonomousPositionIdentity({ instrument: getConfiguredInstrument("BTC"), initialRiskUsdt: 0, costModelVersion: "c" }),
    /initialRiskUsdt/
  );
  const identity = autonomousPositionIdentity({
    instrument: getConfiguredInstrument("SOL"),
    initialRiskUsdt: 25,
    costModelVersion: "cost-test",
  });
  assert.match(identity.positionId, /^[0-9a-f-]{36}$/);
  assert.equal(identity.economicsModel, "BYBIT_LINEAR_USDT_V1");
  assert.equal(identity.initialRiskUsdt, 25);
  assert.equal(identity.costModelVersion, "cost-test");
  assert.ok(identity.riskPolicyVersion.length > 0);
  const pos = position({ asset: "SOL", ...identity });
  assert.deepEqual(positionLegIdentity(pos), {
    positionId: identity.positionId,
    instrument: identity.instrument,
    economicsModel: identity.economicsModel,
  });
});

test("new_entries_freeze_the_instrument_of_todays_route", () => {
  for (const asset of ["BTC", "ETH", "SOL", "GOLD", "OIL", "SILVER"]) {
    assert.deepEqual(entryInstrumentFor(asset), getConfiguredInstrument(asset), asset);
  }
  // FX is still priced off Kraken/Yahoo until the market-path task; its
  // entries must not claim a Bybit contract they do not trade.
  for (const asset of ["EURUSD", "GBPUSD", "USDJPY"]) {
    assert.deepEqual(entryInstrumentFor(asset), legacyInstrument(asset, "LEGACY_SYNTHETIC_V1"), asset);
  }
  assert.throws(() => entryInstrumentFor("XRP"), /XRP/);
});

test("migration_is_idempotent_and_preserves_history", async (t) => {
  const btcEntryTime = "2026-09-20T10:00:00.000Z";
  const ethEntryTime = "2026-09-22T12:00:00.000Z";
  const solEntryTime = "2026-09-24T09:00:00.000Z";
  // Redis keeps trades newest first.
  const trades: Trade[] = [
    trade({ id: "sol-final-b", timestamp: "2026-09-25T12:00:00.000Z", asset: "SOL", action: "SELL", entryTime: solEntryTime, entryPrice: 20, pnl: 4 }),
    trade({ id: "sol-final-a", timestamp: "2026-09-25T11:00:00.000Z", asset: "SOL", action: "SELL", entryTime: solEntryTime, entryPrice: 20, pnl: 3 }),
    trade({ id: "eth-final", timestamp: "2026-09-23T15:00:00.000Z", asset: "ETH", action: "SELL", entryTime: ethEntryTime, entryPrice: 2_010, pnl: -7 }),
    trade({ id: "eth-scale", timestamp: "2026-09-23T09:00:00.000Z", asset: "ETH", action: "BUY", reasoning: "Scaled into profitable swing winner." }),
    trade({ id: "eth-partial", timestamp: "2026-09-22T20:00:00.000Z", asset: "ETH", action: "SELL", entryTime: ethEntryTime, entryPrice: 2_000, pnl: 9, isPartialExit: true }),
    trade({ id: "eth-entry", timestamp: "2026-09-22T12:00:00.012Z", asset: "ETH", action: "BUY" }),
    trade({ id: "btc-final", timestamp: "2026-09-21T15:00:00.000Z", asset: "BTC", action: "SELL", entryTime: btcEntryTime, entryPrice: 100, pnl: -5 }),
    trade({ id: "btc-partial", timestamp: "2026-09-20T18:00:00.000Z", asset: "BTC", action: "SELL", entryTime: btcEntryTime, entryPrice: 100, pnl: 15, isPartialExit: true }),
    trade({ id: "btc-entry", timestamp: "2026-09-20T10:00:00.004Z", asset: "BTC", action: "BUY" }),
    trade({ id: "orphan", timestamp: "2026-09-19T10:00:00.000Z", asset: "GOLD", action: "SELL", pnl: 2 }),
  ];
  const openRunner = position({ asset: "EURUSD", entryTime: "2026-09-29T08:00:00.000Z", entryPrice: 1.1, partialExitCount: 1 });
  const runnerPartial = trade({
    id: "eurusd-partial", timestamp: "2026-09-30T08:00:00.000Z", asset: "EURUSD", action: "SELL",
    entryTime: openRunner.entryTime, entryPrice: 1.1, pnl: 3, isPartialExit: true,
  });
  const input = { portfolios: [portfolio({ EURUSD: openRunner })], trades: [runnerPartial, ...trades], nowMs: NOW };
  const pristine = clone(input);

  const first = planInstrumentMigration(clone(input));
  const byId = new Map(first.migratedTrades.map((row) => [row.id, row]));

  await t.test("a +15 partial and -5 final with clean lineage share one inferred position", () => {
    const id = byId.get("btc-partial")!.positionId;
    assert.ok(id && id.startsWith("legacy:"), String(id));
    assert.equal(byId.get("btc-final")!.positionId, id);
    assert.equal(byId.get("btc-entry")!.positionId, id);
    assert.equal(byId.get("btc-partial")!.pnl, 15);
    assert.equal(byId.get("btc-final")!.pnl, -5);
  });

  await t.test("an open runner and its earlier partial share one inferred position", () => {
    const id = byId.get("eurusd-partial")!.positionId;
    assert.ok(id);
    assert.equal(first.migratedPortfolios[0].openPositions.EURUSD.positionId, id);
  });

  await t.test("scale-in ambiguity and conflicting finals are reported, not guessed", () => {
    for (const ambiguous of ["eth-entry", "eth-partial", "eth-scale", "eth-final", "sol-final-a", "sol-final-b"]) {
      assert.equal(byId.get(ambiguous)!.positionId, undefined, ambiguous);
    }
    assert.ok(first.conflicts.some((c) => c.startsWith("ETH:") && /scale-in/i.test(c)), first.conflicts.join("\n"));
    assert.ok(first.conflicts.some((c) => c.startsWith("SOL:") && /final/i.test(c)), first.conflicts.join("\n"));
    // History conflicts affect lineage only; they do not block trading.
    assert.equal(migrationEntryBlock(first.migratedPortfolios[0], "ETH"), null);
    assert.equal(byId.get("orphan")!.positionId, undefined);
  });

  await t.test("every original field, balance and the trade order are preserved", () => {
    assert.deepEqual(input, pristine, "input is not mutated");
    assert.deepEqual(first.migratedTrades.map((row) => row.id), input.trades.map((row) => row.id));
    input.trades.forEach((original, index) => {
      for (const [key, value] of Object.entries(original)) {
        assert.deepEqual((first.migratedTrades[index] as any)[key], value, `${original.id}.${key}`);
      }
    });
    const [account] = first.migratedPortfolios;
    for (const key of ["usd", "peakValue", "initialCapital", "totalPnl", "returns", "maxDrawdownPercent"] as const) {
      assert.deepEqual(account[key], input.portfolios[0][key], key);
    }
  });

  await t.test("account units are relabeled as an explicit assumption", () => {
    const [account] = first.migratedPortfolios;
    assert.equal(account.accountingCurrency, "USDT");
    assert.equal(account.instrumentMigration?.version, INSTRUMENT_MIGRATION_VERSION);
    assert.equal(account.instrumentMigration?.previousAccountingCurrency, "USD_PROXY");
    assert.match(String(account.instrumentMigration?.accountingAssumption), /1 USD_PROXY = 1 USDT/);
    assert.equal(account.instrumentMigration?.originalHash, first.originalHash);
  });

  await t.test("applying twice is identical", () => {
    const second = planInstrumentMigration({
      portfolios: clone(first.migratedPortfolios),
      trades: clone(first.migratedTrades),
      nowMs: NOW + 3_600_000,
    });
    assert.deepEqual(second.migratedPortfolios, first.migratedPortfolios);
    assert.deepEqual(second.migratedTrades, first.migratedTrades);
    assert.equal(second.originalHash, first.originalHash);
    assert.equal(second.migrationVersion, first.migrationVersion);
    assert.deepEqual(second.conflicts, first.conflicts);
  });

  await t.test("an account marked by an unknown migration version is rejected", () => {
    const foreign = clone(first.migratedPortfolios);
    foreign[0].instrumentMigration!.version = "instrument-migration-v999";
    assert.throws(
      () => planInstrumentMigration({ portfolios: foreign, trades: [], nowMs: NOW }),
      /v999/
    );
  });
});
