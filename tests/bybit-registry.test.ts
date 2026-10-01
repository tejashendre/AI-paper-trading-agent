import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIGURED_ASSETS,
  getConfiguredInstrument,
  isMetadataUsable,
  validateBybitMetadata,
} from "@/lib/trading/instrumentRegistry";
import { SUPPORTED_ASSETS } from "@/lib/market";

const evidence = JSON.parse(
  readFileSync(path.join(__dirname, "..", "docs", "BYBIT_ALL_ASSETS_MARKET_EVIDENCE_2026-10-01.json"), "utf8")
);

// Section 1 of the plan, verified against public metadata on 2026-10-01.
const EXPECTED: Array<[string, "crypto" | "forex" | "commodity", string]> = [
  ["BTC", "crypto", "BTCUSDT"],
  ["ETH", "crypto", "ETHUSDT"],
  ["SOL", "crypto", "SOLUSDT"],
  ["EURUSD", "forex", "EURUSDUSDT"],
  ["GBPUSD", "forex", "GBPUSDUSDT"],
  ["USDJPY", "forex", "USDJPYUSDT"],
  ["GOLD", "commodity", "XAUUSDT"],
  ["OIL", "commodity", "CLUSDT"],
  ["SILVER", "commodity", "XAGUSDT"],
];

function rawFor(symbol: string): Record<string, any> {
  const row = evidence.assets.find((a: any) => a.instrument.symbol === symbol);
  assert.ok(row, `evidence has ${symbol}`);
  // Deep copy so a test mutating one field cannot leak into another.
  return JSON.parse(JSON.stringify(row.instrument));
}

const NOW = evidence.assets[0].instrument.serverTime as number;

test("registry_covers_exactly_nine_symbols", () => {
  assert.deepEqual([...CONFIGURED_ASSETS].sort(), EXPECTED.map(([a]) => a).sort());
  for (const [asset, riskClass, symbol] of EXPECTED) {
    const ref = getConfiguredInstrument(asset);
    assert.equal(ref.asset, asset);
    assert.equal(ref.symbol, symbol);
    assert.equal(ref.venue, "BYBIT");
    assert.equal(ref.economicsModel, "BYBIT_LINEAR_USDT_V1");
    assert.equal(ref.settlementCurrency, "USDT");
    assert.ok(ref.instrumentVersion.includes(symbol));
    // Risk class is preserved through the compatibility view.
    assert.equal(SUPPORTED_ASSETS[asset].category, riskClass);
  }
  assert.equal(getConfiguredInstrument("OIL").symbol, "CLUSDT");
  assert.equal(Object.keys(SUPPORTED_ASSETS).length, 9);
});

test("unknown_asset_throws_instead_of_defaulting_to_btc", () => {
  assert.throws(() => getConfiguredInstrument("UNKNOWN"), /UNKNOWN/);
  assert.throws(() => getConfiguredInstrument(""), /not a configured asset/);
});

test("instrument_version_is_stable_across_metadata_refreshes", () => {
  const first = validateBybitMetadata("EURUSDUSDT", rawFor("EURUSDUSDT"), NOW);
  const later = validateBybitMetadata("EURUSDUSDT", rawFor("EURUSDUSDT"), NOW + 6 * 3_600_000);
  // A refresh alone is not a new cohort: content hash ignores verification time.
  assert.equal(first.metadataVersion, later.metadataVersion);
  assert.notEqual(first.verifiedAtMs, later.verifiedAtMs);
  assert.equal(
    getConfiguredInstrument("EURUSD").instrumentVersion,
    getConfiguredInstrument("EURUSD").instrumentVersion
  );

  const changed = rawFor("EURUSDUSDT");
  changed.lotSizeFilter.qtyStep = "1";
  assert.notEqual(validateBybitMetadata("EURUSDUSDT", changed, NOW).metadataVersion, first.metadataVersion);
});

test("metadata_accepts_all_nine_verified_contracts", () => {
  for (const [, , symbol] of EXPECTED) {
    const meta = validateBybitMetadata(symbol, rawFor(symbol), NOW);
    assert.equal(meta.symbol, symbol);
    assert.equal(meta.status, "Trading");
    assert.equal(meta.settleCoin, "USDT");
    assert.ok(meta.fundingIntervalMinutes > 0);
    // Decimal strings are kept verbatim rather than converted through floats.
    assert.equal(meta.qtyStep, rawFor(symbol).lotSizeFilter.qtyStep);
    assert.ok(isMetadataUsable(meta, NOW));
  }
  assert.equal(validateBybitMetadata("XAUUSDT", rawFor("XAUUSDT"), NOW).fundingIntervalMinutes, 240);
  assert.equal(validateBybitMetadata("EURUSDUSDT", rawFor("EURUSDUSDT"), NOW).symbolType, "forex");
});

test("metadata_rejects_wrong_or_untradeable_contract", () => {
  const cases: Array<[string, (raw: Record<string, any>) => void, RegExp]> = [
    ["wrong symbol", (raw) => { raw.symbol = "BTCUSDT"; }, /symbol/],
    ["not trading", (raw) => { raw.status = "Settling"; }, /status/],
    ["inverse contract", (raw) => { raw.contractType = "InversePerpetual"; }, /contractType/],
    ["missing lot filter", (raw) => { delete raw.lotSizeFilter; }, /lotSizeFilter/],
    ["zero step", (raw) => { raw.lotSizeFilter.qtyStep = "0"; }, /qtyStep/],
    ["negative step", (raw) => { raw.lotSizeFilter.qtyStep = "-0.1"; }, /qtyStep/],
    ["missing min qty", (raw) => { delete raw.lotSizeFilter.minOrderQty; }, /minOrderQty/],
    ["non-numeric tick", (raw) => { raw.priceFilter.tickSize = "abc"; }, /tickSize/],
    ["non-USDT settlement", (raw) => { raw.settleCoin = "USDC"; }, /settleCoin/],
    ["non-USDT quote", (raw) => { raw.quoteCoin = "USDC"; }, /quoteCoin/],
    ["missing funding interval", (raw) => { delete raw.fundingInterval; }, /fundingInterval/],
    ["not an object", () => undefined, /object/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const raw = rawFor("EURUSDUSDT");
    mutate(raw);
    const input = label === "not an object" ? null : raw;
    assert.throws(() => validateBybitMetadata("EURUSDUSDT", input, NOW), pattern, label);
  }
});

test("metadata_older_than_24h_is_unusable_for_new_entries", () => {
  const meta = validateBybitMetadata("CLUSDT", rawFor("CLUSDT"), NOW);
  assert.equal(isMetadataUsable(meta, NOW + 24 * 3_600_000), true);
  assert.equal(isMetadataUsable(meta, NOW + 24 * 3_600_000 + 1), false);
  // A verification stamp from the future is not trusted either.
  assert.equal(isMetadataUsable(meta, NOW - 60_000), false);
});

test("broader_xsec_symbols_validate_without_becoming_configured_assets", () => {
  const raw = rawFor("BTCUSDT");
  raw.symbol = "DOGEUSDT";
  raw.baseCoin = "DOGE";
  const meta = validateBybitMetadata("DOGEUSDT", raw, NOW);
  assert.equal(meta.symbol, "DOGEUSDT");
  assert.throws(() => getConfiguredInstrument("DOGE"));
});
