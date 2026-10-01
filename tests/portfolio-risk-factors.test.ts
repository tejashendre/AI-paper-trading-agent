import test from "node:test";
import assert from "node:assert/strict";
import { classifyRiskFactor, evaluatePortfolioRiskBudget, portfolioFactorExposure } from "@/lib/trading/portfolioRiskBudget";
import { autonomousPositionIdentity } from "@/lib/trading/assetSpecs";
import { getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";
import { DEFAULT_UNIVERSE, screenUniverseDetailed } from "@/lib/strategy/crossSectionalMomentum";
import type { OpenPosition, Portfolio } from "@/lib/types";

function pos(asset: string, direction: "LONG" | "SHORT", amount: number, entryPrice: number, maxLossUsd = 50): OpenPosition {
  return {
    asset, direction, amount, btcAmount: amount, entryPrice, usdInvested: 100, stopLoss: 0, takeProfit: 0,
    entryTime: new Date().toISOString(), signalScore: 70, reasoning: "fixture", strategyType: "swing", maxLossUsd,
    ...autonomousPositionIdentity({ instrument: getConfiguredInstrument(asset), initialRiskUsdt: maxLossUsd, costModelVersion: "c" }),
  };
}

function portfolio(positions: OpenPosition[]): Portfolio {
  return {
    usd: 9_000, btc: 0, balances: {}, openPositions: Object.fromEntries(positions.map((p) => [p.asset, p])), openPosition: null,
    peakValue: 10_000, initialCapital: 10_000, totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0,
    grossProfit: 0, grossLoss: 0, consecutiveWins: 0, consecutiveLosses: 0, maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0, maxDrawdown: 0, maxDrawdownPercent: 0, returns: [], lastUpdated: new Date().toISOString(),
  };
}

test("all_asset_risk_factors_are_counted", async (t) => {
  await t.test("every asset maps to a named class, factor and currency exposure", () => {
    assert.deepEqual(classifyRiskFactor("EURUSD", "LONG"), { riskClass: "forex", factor: "USD", factorDirection: "SHORT" });
    assert.deepEqual(classifyRiskFactor("GBPUSD", "LONG"), { riskClass: "forex", factor: "USD", factorDirection: "SHORT" });
    assert.deepEqual(classifyRiskFactor("USDJPY", "SHORT"), { riskClass: "forex", factor: "USD", factorDirection: "SHORT" });
    assert.equal(classifyRiskFactor("GOLD", "LONG").factor, "METALS");
    assert.equal(classifyRiskFactor("SILVER", "LONG").factor, "METALS");
    assert.equal(classifyRiskFactor("OIL", "SHORT").factor, "ENERGY");
    for (const asset of ["BTC", "ETH", "SOL"]) assert.equal(classifyRiskFactor(asset, "LONG").factor, "CRYPTO");
  });

  await t.test("exposure is measured in true USDT notional", () => {
    const exposure = portfolioFactorExposure([pos("EURUSD", "LONG", 1_000, 1.13), pos("USDJPY", "SHORT", 10, 150), pos("GOLD", "LONG", 0.1, 4_000)]);
    assert.equal(exposure["USD:SHORT"].positions, 2);
    // USDJPYUSDT is a linear contract: 10 contracts at 150 is 1,500 USDT, not 10.
    assert.ok(Math.abs(exposure["USD:SHORT"].notionalUsdt - (1_130 + 1_500)) < 1e-9);
    assert.ok(Math.abs(exposure["METALS:LONG"].notionalUsdt - 400) < 1e-9);
  });

  const candidate = { trades: [], candidateEntryCostUsd: 0.5 };

  await t.test("a USDJPY short counts against euro and sterling longs", () => {
    const book = portfolio([pos("EURUSD", "LONG", 1_000, 1.13, 20), pos("GBPUSD", "LONG", 1_000, 1.33, 20)]);
    const decision = evaluatePortfolioRiskBudget({ ...candidate, portfolio: book, asset: "USDJPY", direction: "SHORT", candidateNotionalUsd: 1_500, candidateMaxLossUsd: 20 });
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /USD:SHORT/);
    assert.equal(decision.diagnostics.factorExposure["USD:SHORT"].positions, 2);
  });

  await t.test("a factor's planned stop risk is capped like the whole book's", () => {
    const book = portfolio([pos("GOLD", "LONG", 0.1, 4_000, 250)]);
    const decision = evaluatePortfolioRiskBudget({ ...candidate, portfolio: book, asset: "SILVER", direction: "LONG", candidateNotionalUsd: 600, candidateMaxLossUsd: 60 });
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /FACTOR_RISK: METALS:LONG/);
  });

  await t.test("total gross notional cannot exceed the existing ceiling", () => {
    const book = portfolio([pos("BTC", "LONG", 0.2, 100_000, 10)]);
    const decision = evaluatePortfolioRiskBudget({ ...candidate, portfolio: book, asset: "OIL", direction: "LONG", candidateNotionalUsd: 9_000, candidateMaxLossUsd: 10 });
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /GROSS_NOTIONAL/);
  });
});

test("xsec_universe_rejects_every_non_crypto_group", () => {
  const candidate = (symbol: string, symbolType?: string) => ({
    symbol, symbolType, turnover24h: 500_000_000, historyHours: 2_000, barCoverage: 1,
  });
  const screen = screenUniverseDetailed([
    candidate("DOGEUSDT", ""),
    candidate("EURUSDUSDT", "forex"),
    candidate("GBPUSDUSDT", "forex"),
    candidate("USDJPYUSDT", "forex"),
    candidate("XAUUSDT", "commodity"),
    candidate("CLUSDT", "commodity"),
    candidate("BZUSDT", "commodity"),
    candidate("NVDAUSDT", "stock"),
    // Instrument metadata unavailable: the deny-list still catches known names.
    candidate("XAGUSDT"),
    candidate("AUDUSDUSDT"),
  ], { ...DEFAULT_UNIVERSE, minTurnover24hUsd: 1 });
  assert.deepEqual(screen.eligible, ["DOGEUSDT"]);
  for (const symbol of ["EURUSDUSDT", "GBPUSDUSDT", "USDJPYUSDT", "XAUUSDT", "CLUSDT", "BZUSDT", "NVDAUSDT", "XAGUSDT", "AUDUSDUSDT"]) {
    assert.ok(screen.rejectedNonCrypto.includes(symbol), symbol);
  }
});
