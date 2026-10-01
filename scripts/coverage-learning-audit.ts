/** Read-only diagnostics. Does not load .env files, connect to Redis, or trade. */
import fs from "fs";
import path from "path";
import assert from "node:assert/strict";
import { SUPPORTED_ASSETS, type MarketPriceSnapshot } from "../src/lib/market";
import { SetupPerformance } from "../src/lib/trading/setupPerformance";
import { evaluateEntryEligibility } from "../src/lib/trading/entryEligibility";
import { getConfiguredInstrument, validateBybitMetadata } from "../src/lib/trading/instrumentRegistry";
import type { Trade } from "../src/lib/types";

const statusFile = process.argv[2];
const outputFile = process.argv[3];

// 1. Entry data gate, offline. Runs the shared eligibility decision the daemon
//    uses: every correct fresh path must pass and every forged or stale path
//    must fail, for all nine assets.
const evidence = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "docs", "BYBIT_ALL_ASSETS_MARKET_EVIDENCE_2026-10-01.json"), "utf8")
);
const nowMs = Date.now();
const coverage = Object.entries(SUPPORTED_ASSETS).map(([asset, config]) => {
  const instrument = getConfiguredInstrument(asset);
  const raw = evidence.assets.find((row: { instrument: { symbol: string } }) => row.instrument.symbol === instrument.symbol)?.instrument;
  const metadata = raw ? validateBybitMetadata(instrument.symbol, raw, nowMs) : null;
  const quote: MarketPriceSnapshot = {
    price: 100, provider: "BYBIT_LINEAR_HTTP", source: "HTTP", transport: "REST", venue: "BYBIT_LINEAR",
    instrument: instrument.symbol, instrumentVersion: instrument.instrumentVersion,
    updatedAt: new Date(nowMs - 500).toISOString(), eventTimeMs: nowMs - 500, receivedAtMs: nowMs - 400,
    bid: 99.99, ask: 100.01, quoteTimes: { lastPriceMs: nowMs - 500, bidAskMs: nowMs - 500, markMs: null },
  };
  const decide = (overrides: Partial<MarketPriceSnapshot> = {}, withMetadata = true) => evaluateEntryEligibility({
    instrument, metadata: withMetadata ? metadata : null, quote: { ...quote, ...overrides },
    closedBarCounts: { m15: 100, h1: 100, h4: 100, w1: 26 }, nowMs, fastExecution: false, depthAvailable: true,
  });
  const forged = {
    wrongSymbol: decide({ instrument: "WRONG_INSTRUMENT" }),
    wrongVenue: decide({ venue: "KRAKEN" }),
    sixtySecondOld: decide({ quoteTimes: { lastPriceMs: nowMs - 60_000, bidAskMs: nowMs - 60_000, markMs: null } }),
    future: decide({ quoteTimes: { lastPriceMs: nowMs + 5_000, bidAskMs: nowMs, markMs: null } }),
    crossedBook: decide({ bid: 100.02, ask: 100.01 }),
    noMetadata: decide({}, false),
  };
  return {
    asset, category: config.category, instrument: instrument.symbol,
    correctFreshPathAccepted: decide().allowed,
    forgedOrStaleAccepted: Object.entries(forged).filter(([, result]) => result.allowed).map(([label]) => label),
  };
});
assert(coverage.every((row) => row.correctFreshPathAccepted), "Every correct fresh path must pass the entry data gate");
assert(coverage.every((row) => row.forgedOrStaleAccepted.length === 0), "Every forged or stale path must fail closed");

if (!statusFile) {
  const report = { auditLabel: "entry data gate (offline)", coverage, blockedByRoutingMismatch: [] as string[] };
  if (outputFile) fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log("Learning diagnostics skipped: pass a raw STATUS_SNAPSHOT.json to include them.");
  process.exit(0);
}

// 2. Learning diagnostics need a raw status snapshot with trade rows.
const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
const trades: Trade[] = status.aiTrades || [];
const exits = trades.filter((trade) => typeof trade.pnl === "number");
const groups = new Map<string, Trade[]>();
for (const trade of exits) {
  assert(trade.entryTime, "Historical position aggregation requires entryTime");
  const key = `${trade.asset}:${trade.direction}:${trade.entryTime}`;
  groups.set(key, [...(groups.get(key) || []), trade]);
}
const completedPositions: Trade[] = [];
let partialLegsWithoutFinalClose = 0;
for (const legs of groups.values()) {
  const finalLegs = legs.filter((trade) => !trade.isPartialExit);
  if (finalLegs.length === 0) { partialLegsWithoutFinalClose += legs.length; continue; }
  assert.equal(finalLegs.length, 1, "Historical grouping must map to exactly one final close");
  completedPositions.push({ ...finalLegs[0], pnl: legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0) });
}
const options = { strategyVersion: status.deployment?.strategyVersion };
const currentLearning = SetupPerformance.build(trades, status.opportunitySummary, options);
const positionLearning = SetupPerformance.build(completedPositions, status.opportunitySummary, options);
const learning = currentLearning.byAsset.map((before) => {
  const after = positionLearning.byAsset.find((row) => row.key === before.key)!;
  return {
    asset: before.key, completedPositions: before.tradeCount,
    pnlUsedByCurrentLearningUsd: before.realizedPnl,
    pnlIncludingPartialExitsUsd: after.realizedPnl,
    currentAdjustment: before.confidenceAdjustment,
    diagnosticPositionAdjustment: after.confidenceAdjustment,
    currentHoldoutAvgPnl: before.outOfSampleAvgPnl,
    diagnosticPositionHoldoutAvgPnl: after.outOfSampleAvgPnl,
  };
});

// Exercise the actual evaluator with a profitable partial and losing final leg.
const seed = exits.find((trade) => !trade.isPartialExit);
assert(seed, "Need a final-close record for the accounting fixture");
const fixture = [
  { ...seed, id: "audit-partial", pnl: 15, isPartialExit: true },
  { ...seed, id: "audit-final", pnl: -5, isPartialExit: false },
];
const fixtureResult = SetupPerformance.build(fixture as Trade[], {}).byAsset[0];
// Corrected economics: the +15 partial and -5 final are one +10 position.
assert.equal(fixtureResult.realizedPnl, 10, "Learning must count partial exits inside their position");

const report = {
  auditLabel: "2026-10-01 strategy coverage and learning audit",
  snapshotCompletedAtUtc: status.swingScan?.completedAt,
  reportedDeployment: status.deployment,
  coverage,
  blockedByRoutingMismatch: coverage.filter((row) => !row.correctFreshPathAccepted).map((row) => row.asset),
  exitRecords: exits.length,
  partialExitRecords: exits.filter((trade) => trade.isPartialExit).length,
  completedPositions: completedPositions.length,
  partialLegsWithoutFinalClose,
  realizedPnlUsd: exits.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0),
  learningPnlUsd: currentLearning.byAsset.reduce((sum, row) => sum + row.realizedPnl, 0),
  learning,
  syntheticAccountingFixture: { actualPositionPnlUsd: 10, pnlUsedByLearningUsd: fixtureResult.realizedPnl },
  limitation: "Historical grouping uses asset, direction, and entryTime. A production repair should use a stable positionId and validate fees, scaling, and open partial positions. Recomputed adjustments are diagnostics, not an authorized strategy change.",
};
if (outputFile) fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
