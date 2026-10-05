/**
 * Release A end to end, offline: the real swing daemon scan and exit
 * watchdog, the real market service, metadata cache, funding fetchers,
 * portfolio store and hash-chained ledger, run against a fake Bybit behind
 * the global fetch and an in-memory Redis. Every world gets its own working
 * directory, ledger directory and store, so nothing touches live data.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { CONFIGURED_ASSETS, CONFIGURED_INSTRUMENTS, ConfiguredAsset, getConfiguredInstrument, validateBybitMetadata } from "@/lib/trading/instrumentRegistry";
import { MemoryRedis } from "./helpers/memoryRedis";
import { createVenue, installVenue, minuteBars, VenueState } from "./helpers/fakeBybitVenue";
import { evidenceInstrument } from "./helpers/fakeBybitMarket";

// Tuesday 14:00 UTC: inside every liquidity window, no scheduled event.
const T = Date.UTC(2026, 8, 29, 14, 0, 0);
const FUNDING_AT = Date.UTC(2026, 8, 29, 16, 0, 0);
const EXIT_AT = FUNDING_AT + 10 * 60_000;
const HOUR = 3_600_000;
// Only the asset under test trends; the rest stay flat and produce no setup.
const TREND_DRIFT = -0.0009;
const TREND_BARS = 1_701;
const FLAT_BARS = 900;
const START_PRICE: Record<ConfiguredAsset, number> = {
  BTC: 84_000, ETH: 2_700, SOL: 119, EURUSD: 1.1325, GBPUSD: 1.3275, USDJPY: 158, GOLD: 4_190, OIL: 90.4, SILVER: 61.1,
};

// Mock the clock before any module that reads it is loaded.
mock.timers.enable({ apis: ["Date"], now: T });
const originalCwd = process.cwd();
const originalLedgerDir = process.env.EXECUTION_LEDGER_DIR;

let m: {
  daemon: typeof import("@/daemon/swingDaemon");
  xsec: typeof import("@/daemon/crossSectionalDaemon");
  redis: typeof import("@/lib/redis");
  market: typeof import("@/lib/market");
  bybit: typeof import("@/lib/data/bybitPublic");
  portfolio: typeof import("@/lib/portfolio");
  ledger: typeof import("@/lib/trading/executionLedger");
  specs: typeof import("@/lib/trading/assetSpecs");
  coverage: typeof import("@/lib/trading/coverageStatus");
  setups: typeof import("@/lib/trading/setupPerformance");
  book: typeof import("@/lib/execution/bookRebalancer");
  migration: typeof import("../scripts/migrate-bybit-instruments");
};

before(async () => {
  m = {
    daemon: await import("@/daemon/swingDaemon"),
    xsec: await import("@/daemon/crossSectionalDaemon"),
    redis: await import("@/lib/redis"),
    market: await import("@/lib/market"),
    bybit: await import("@/lib/data/bybitPublic"),
    portfolio: await import("@/lib/portfolio"),
    ledger: await import("@/lib/trading/executionLedger"),
    specs: await import("@/lib/trading/assetSpecs"),
    coverage: await import("@/lib/trading/coverageStatus"),
    setups: await import("@/lib/trading/setupPerformance"),
    book: await import("@/lib/execution/bookRebalancer"),
    migration: await import("../scripts/migrate-bybit-instruments"),
  };
});

after(() => {
  process.chdir(originalCwd);
  if (originalLedgerDir === undefined) delete process.env.EXECUTION_LEDGER_DIR;
  else process.env.EXECUTION_LEDGER_DIR = originalLedgerDir;
  m.redis.setRedisClient(null);
  mock.timers.reset();
});

interface World {
  memory: MemoryRedis;
  venue: VenueState;
  net: ReturnType<typeof installVenue>;
  ledgerDir: string;
  advanceTo(ms: number): void;
  close(): void;
}

async function openWorld(trending: ConfiguredAsset | null, configure?: (venue: VenueState) => void): Promise<World> {
  mock.timers.setTime(T);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bybit-upgrade-"));
  process.chdir(root);
  const ledgerDir = path.join(root, "ledger");
  process.env.EXECUTION_LEDGER_DIR = ledgerDir;
  const memory = new MemoryRedis();
  m.redis.setRedisClient(memory);

  const venue = createVenue(T);
  for (const asset of CONFIGURED_ASSETS) {
    // Bars run three hours past T; the venue only serves those already open.
    const bars = (asset === trending ? TREND_BARS : FLAT_BARS) + 12;
    venue.series.set(CONFIGURED_INSTRUMENTS[asset].symbol, minuteBars(START_PRICE[asset], asset === trending ? TREND_DRIFT : 0, T + 3 * HOUR, bars));
  }
  configure?.(venue);
  const net = installVenue(venue);
  const metadataCache = m.bybit.createBybitMetadataCache();
  const restoreDeps = m.market.setMarketServiceDeps({ metadata: (symbol) => metadataCache.get(symbol) });

  return {
    memory,
    venue,
    net,
    ledgerDir,
    advanceTo(ms) {
      venue.nowMs = ms;
      mock.timers.setTime(ms);
    },
    close() {
      restoreDeps();
      net.restore();
      process.chdir(originalCwd);
    },
  };
}

interface LedgerLine { id: string; type: string; asset?: string; positionId?: string; payload?: any }

function ledgerEvents(directory: string): LedgerLine[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith(".ndjson"))
    .sort()
    .flatMap((file) => fs.readFileSync(path.join(directory, file), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as LedgerLine));
}

function ledgerDigest(directory: string): string {
  const hash = createHash("sha256");
  for (const file of fs.readdirSync(directory).sort()) hash.update(file).update(fs.readFileSync(path.join(directory, file)));
  return hash.digest("hex");
}

async function lastScan(memory: MemoryRedis): Promise<Array<{ asset: string; action: string; vetoCode?: string; reason: string }>> {
  const scan = await memory.get<{ results: Array<{ asset: string; action: string; vetoCode?: string; reason: string }> }>("swing:lastScan:ai");
  assert.ok(scan, "the scan stored no snapshot");
  return scan.results;
}

async function scanRow(memory: MemoryRedis, asset: ConfiguredAsset) {
  const row = (await lastScan(memory)).find((result) => result.asset === asset);
  assert.ok(row, `${asset} was not evaluated`);
  return row;
}

function outcomes(memory: MemoryRedis) {
  return memory.listRows("ai:positionOutcomes").map((raw) => JSON.parse(raw).outcome);
}

describe("Bybit all-assets upgrade, offline end to end", () => {
  it('new FX signals use only the published-fee learning cohort', async () => {
    const world=await openWorld('EURUSD');
    try {
      const engine=await import('@/lib/swingEngine');
      const costs=await import('@/lib/trading/executionCostModel');
      const instrument=getConfiguredInstrument('EURUSD');
      const rules=['TREND','RANGE','NEUTRAL'].flatMap(regime=>[false,true].map(current=>({
        id:`fee-${regime}-${current}`,scope:'asset',key:'EURUSD',action:current?'BOOST':'WATCH_ONLY',
        confidenceAdjustment:current?2:-4,message:current?'verified-fee-cohort':'old-stress-cohort',
        netReturnFraction:current?0.01:-0.02,netR:current?0.1:-0.2,
        sampleSize:30,distinctSampleCount:30,sampleUnit:'COMPLETED_POSITION',units:'FRACTION_AND_R',
        createdAt:new Date(T-86400000).toISOString(),expiresAt:new Date(T+86400000).toISOString(),
        cohort:{instrumentVersion:instrument.instrumentVersion,dataSchemaVersion:engine.STRATEGY_DATA_SCHEMA_VERSION,
          assetClass:'forex',family:'TREND_PULLBACK',regime,direction:'SHORT',strategyVersion:m.ledger.TRADING_STRATEGY_VERSION,
          configHash:engine.strategyFamilyConfigHash('TREND_PULLBACK','EURUSD'),
          costModelVersion:current?`${costs.EXECUTION_COST_MODEL_VERSION}:${m.specs.feeScheduleFor(instrument).version}`:costs.EXECUTION_COST_MODEL_VERSION,
          riskPolicyVersion:m.specs.RISK_POLICY_VERSION}})));
      await world.memory.set(`learning:${m.ledger.TRADING_STRATEGY_VERSION}:localRules`,rules);
      const signal=await engine.SwingEngine.analyze('EURUSD');
      assert.ok(signal.learningRules.includes('verified-fee-cohort'),JSON.stringify(signal.learningRules));
      assert.ok(!signal.learningRules.includes('old-stress-cohort'));
    } finally {world.close();}
  });
  for (const restriction of ['COOLDOWN','ACTIVE_POSITION','EVENT_BLACKOUT','OPERATOR_FREEZE'] as const) {
    it(`shadow research continues under ${restriction} without adding an order`, async () => {
      const asset=restriction==='EVENT_BLACKOUT'?'OIL':'BTC';
      const world=await openWorld(asset);
      try {
        if (restriction==='COOLDOWN') await world.memory.set(`swing:cooldown:${asset}`,true,{ex:3600});
        if (restriction==='OPERATOR_FREEZE') await world.memory.set('swing:entryFreeze',{reason:'test'});
        if (restriction==='ACTIVE_POSITION') {await m.daemon.runEntryScan();world.advanceTo(T+15*60000);}
        if (restriction==='EVENT_BLACKOUT') {
          const at=Date.UTC(2026,8,30,14,30);
          world.venue.series.set(CONFIGURED_INSTRUMENTS[asset].symbol,minuteBars(START_PRICE[asset],TREND_DRIFT,at,TREND_BARS));
          world.advanceTo(at);
        }
        const fillsBefore=ledgerEvents(world.ledgerDir).filter(e=>e.type==='ENTRY_FILLED').length;
        await m.daemon.runEntryScan();
        assert.equal((await scanRow(world.memory,asset)).vetoCode,restriction);
        const history=world.memory.listRows(`opportunity:${m.ledger.TRADING_STRATEGY_VERSION}:v3:history`).map(raw=>JSON.parse(raw));
        assert.ok(history.some(row=>row.asset===asset && row.candidateId && row.mode==='SHADOW' &&
          Date.parse(row.timestamp)===Date.now()),'entry veto suppressed the shadow observation');
        assert.equal(ledgerEvents(world.ledgerDir).filter(e=>e.type==='ENTRY_FILLED').length,fillsBefore);
      } finally {world.close();}
    });
  }
  it("covers exactly the nine configured assets", () => {
    assert.deepEqual([...CONFIGURED_ASSETS].sort(), Object.keys(START_PRICE).sort());
  });

  it('the watchdog persists a losing mark and updates drawdown without closing the position', async () => {
    const world = await openWorld('BTC');
    try {
      await m.daemon.runEntryScan();
      const before = await m.portfolio.PortfolioManager.getPortfolio('ai');
      const pos = before.openPositions.BTC;
      assert.ok(pos);
      const price = pos.entryPrice + (pos.stopLoss - pos.entryPrice) * 0.4;
      world.advanceTo(T + 6000); // Expire the market service's five-second quote cache.
      world.venue.priceOverride.set('BTCUSDT', price);
      await m.daemon.runExitWatchdog();
      const marked = await m.portfolio.PortfolioManager.getPortfolio('ai');
      assert.ok(marked.openPositions.BTC, 'a within-stop loss must remain open');
      assert.equal((marked.openPositions.BTC as any).lastMarkPrice, price);
      assert.equal(marked.openPositions.BTC.lastMarkAt, new Date(T + 6000).toISOString());
      assert.ok(marked.maxDrawdownPercent > before.maxDrawdownPercent);
      assert.equal(marked.usd, before.usd, 'marking must not realize P&L');
    } finally { world.close(); }
  });

  it('a winning probe cannot scale while another held asset has no usable mark', async () => {
    const world = await openWorld(null);
    try {
      world.venue.priceOverride.set('BTCUSDT', 84200);
      const goldSeries = world.venue.series.get('XAUUSDT')!;
      world.venue.series.delete('XAUUSDT');
      const portfolio = await m.portfolio.PortfolioManager.getPortfolio('ai');
      const base = { direction: 'LONG' as const, entryTime: new Date(T).toISOString(), signalScore: 20,
        reasoning: 'scale-in mark fixture', strategyType: 'swing' as const, finalConviction: 85,
        dataQuality: 100, entryMode: 'CONTROLLED_PROBE' as const, leverageUsed: 1 };
      portfolio.usd = 8500;
      portfolio.openPositions = {
        BTC: { ...base, asset:'BTC', instrument:getConfiguredInstrument('BTC'), positionId:'fixture-btc',
          amount:1000/83000, btcAmount:1000/83000, entryPrice:83000, usdInvested:1000,
          stopLoss:82000, initialStopLoss:82000, initialRiskUsdt:1000/83, maxLossUsd:13, takeProfit:90000 },
        GOLD: { ...base, asset:'GOLD', instrument:getConfiguredInstrument('GOLD'), positionId:'fixture-gold',
          amount:500/4190, btcAmount:500/4190, entryPrice:4190, usdInvested:500,
          stopLoss:4000, takeProfit:4500 },
      };
      await m.portfolio.PortfolioManager.updatePortfolio(portfolio, 'ai');
      await m.daemon.runExitWatchdog();
      assert.equal(ledgerEvents(world.ledgerDir).filter(event => event.type === 'SCALE_IN_FILLED').length, 0);
      assert.equal((await m.portfolio.PortfolioManager.getPortfolio('ai')).openPositions.BTC.amount, 1000/83000);
      // The transient refusal must clear once every held mark is available.
      world.venue.series.set('XAUUSDT', goldSeries);
      world.advanceTo(T + 6000);
      await m.daemon.runExitWatchdog();
      world.advanceTo(T + 12000);
      await m.daemon.runExitWatchdog();
      assert.equal(ledgerEvents(world.ledgerDir).filter(event => event.type === 'SCALE_IN_FILLED').length, 1);
    } finally { world.close(); }
  });

  for (const asset of Object.keys(START_PRICE) as ConfiguredAsset[]) {
    it(`${asset}: a valid fixture enters, settles funding, exits at target and completes once`, async () => {
      const world = await openWorld(asset);
      try {
        const instrument = getConfiguredInstrument(asset);
        await m.daemon.runEntryScan();
        const row = await scanRow(world.memory, asset);
        assert.equal(row.action, "ENTRY", `${asset} did not enter: ${row.vetoCode} ${row.reason}`);
        assert.deepEqual((await lastScan(world.memory)).filter((r) => r.action === "ENTRY").map((r) => r.asset), [asset]);

        const portfolio = await m.portfolio.PortfolioManager.getPortfolio("ai");
        const pos = portfolio.openPositions[asset];
        assert.ok(pos, "no position was opened");
        assert.equal(pos.instrument?.instrumentVersion, `BYBIT_LINEAR_USDT_V1:${instrument.symbol}`);
        assert.equal(pos.economicsModel, "BYBIT_LINEAR_USDT_V1");
        assert.ok(pos.positionId);
        assert.ok((pos.initialRiskUsdt ?? 0) > 0);
        assert.equal(pos.riskPolicyVersion, m.specs.RISK_POLICY_VERSION);

        // The size is on the venue's lot step, and fees follow the class schedule.
        const metadata = validateBybitMetadata(instrument.symbol, evidenceInstrument(instrument.symbol), T);
        const quantity = m.specs.decimalString(pos.amount);
        assert.equal(m.specs.floorOrderQty(quantity, metadata), quantity);
        const schedule = m.specs.feeScheduleFor(instrument);
        assert.equal(pos.feeScheduleVersion, schedule.version);
        assert.equal(schedule.status, "PUBLIC_BASELINE");
        assert.equal(pos.fillLiquidity?.policyVersion, "fill-capacity-v1-2026-10-01");

        // Two hours later price trades through the target; one funding boundary passed.
        world.advanceTo(EXIT_AT);
        const target = pos.direction === "SHORT" ? pos.takeProfit * 0.999 : pos.takeProfit * 1.001;
        world.venue.priceOverride.set(instrument.symbol, target);
        await m.daemon.runExitWatchdog();

        const afterExit = await m.portfolio.PortfolioManager.getPortfolio("ai");
        assert.equal(afterExit.openPositions[asset], undefined, "the target did not close the position");
        assert.equal(afterExit.pendingLedgerEvents?.length ?? 0, 0);

        const trades = await m.portfolio.PortfolioManager.getTrades("ai");
        const legs = trades.filter((trade) => trade.positionId === pos.positionId);
        const close = legs.find((trade) => trade.fundingStatus !== undefined);
        assert.ok(close, "the closing leg carries no funding status");
        assert.equal(close.fundingStatus, "SETTLED");
        // A positive rate pays shorts.
        assert.ok((close.fundingCashflowUsdt ?? 0) > 0, `funding ${close.fundingCashflowUsdt}`);

        const completed = outcomes(world.memory);
        assert.equal(completed.length, 1);
        assert.equal(completed[0].positionId, pos.positionId);
        assert.ok(completed[0].netPnlUsdt > 0);

        const verification = m.ledger.ExecutionLedger.verify(world.ledgerDir);
        assert.equal(verification.valid, true, verification.errors.join("; "));
        const events = ledgerEvents(world.ledgerDir).filter((event) => event.positionId === pos.positionId);
        assert.deepEqual(events.map((event) => event.type), ["ENTRY_APPROVED", "ENTRY_FILLED", "FUNDING_SETTLED", "EXIT_FILLED", "POSITION_COMPLETED"]);
        assert.equal(events[2].id, `funding:${pos.positionId}:${instrument.symbol}:${FUNDING_AT}`);

        // Coverage and learning count the same single completed position.
        const funnel = (await world.memory.get<any[]>(`coverage:funnel:v1:${asset}`)) ?? [];
        const coverage = m.coverage.buildCoverageSnapshot({ nowMs: Date.now(), assets: {}, outcomes: completed, trades, funnels: { [asset]: funnel } });
        const status = coverage.find((entry) => entry.asset === asset);
        assert.ok(status);
        assert.equal(status.completedPositions, 1);
        assert.ok(status.lastFillAt);
        assert.equal(status.funnel7d.fills, 1);
        assert.ok(!status.notes.some((note) => note.includes("not confirmed the fee schedule")));
        const learning = m.setups.SetupPerformance.build(trades, null);
        assert.equal(learning.closedTradeCount, 1);
        assert.deepEqual(learning.positionConflicts, []);

        assert.deepEqual(world.net.stray, []);
      } finally {
        world.close();
      }
    });
  }

  const negatives: Array<{ name: string; vetoCodes: string[]; configure: (venue: VenueState, symbol: string) => void }> = [
    {
      name: "metadata for another contract",
      vetoCodes: ["DATA_NOT_ELIGIBLE"],
      configure: (venue, symbol) => venue.metadataSwap.set(symbol, symbol === "BTCUSDT" ? "ETHUSDT" : "BTCUSDT"),
    },
    {
      name: "a stale quote",
      vetoCodes: ["DATA_NOT_ELIGIBLE"],
      configure: (venue) => { venue.serverTimeOffsetMs = -60_000; },
    },
    {
      name: "a book too thin to fill",
      vetoCodes: ["LIQUIDITY"],
      configure: (venue) => { venue.depthScale = 0.0005; },
    },
    {
      name: "too few closed bars",
      vetoCodes: ["WARMING_UP"],
      configure: (venue) => { venue.klineCap = 60; },
    },
  ];

  for (const negative of negatives) {
    it(`no asset enters with ${negative.name}`, async () => {
      for (const asset of Object.keys(START_PRICE) as ConfiguredAsset[]) {
        const symbol = CONFIGURED_INSTRUMENTS[asset].symbol;
        const world = await openWorld(asset, (venue) => negative.configure(venue, symbol));
        try {
          await m.daemon.runEntryScan();
          const row = await scanRow(world.memory, asset);
          assert.notEqual(row.action, "ENTRY", `${asset} entered with ${negative.name}`);
          assert.ok(negative.vetoCodes.includes(row.vetoCode ?? ""), `${asset}: ${row.vetoCode} ${row.reason}`);
          const portfolio = await m.portfolio.PortfolioManager.getPortfolio("ai");
          assert.deepEqual(Object.keys(portfolio.openPositions), []);
          assert.equal(ledgerEvents(world.ledgerDir).filter((event) => event.type === "ENTRY_FILLED").length, 0);
        } finally {
          world.close();
        }
      }
    });
  }

  it("restarts, migration reruns and an outage conserve positions, fills and the ledger", async () => {
    const asset: ConfiguredAsset = "GOLD";
    const symbol = CONFIGURED_INSTRUMENTS[asset].symbol;
    const world = await openWorld(asset);
    try {
      await m.daemon.runEntryScan();
      const opened = (await m.portfolio.PortfolioManager.getPortfolio("ai")).openPositions[asset];
      assert.ok(opened);

      // A restarted daemon rescans the same state: no second entry or fill.
      world.advanceTo(T + 60_000);
      await m.daemon.runEntryScan();
      world.advanceTo(T + 120_000);
      await m.daemon.runEntryScan();
      assert.equal((await scanRow(world.memory, asset)).vetoCode, "ACTIVE_POSITION");
      assert.equal(ledgerEvents(world.ledgerDir).filter((event) => event.type === "ENTRY_FILLED").length, 1);
      const rescanned = await m.portfolio.PortfolioManager.getPortfolio("ai");
      assert.equal(rescanned.openPositions[asset].positionId, opened.positionId);
      assert.equal(rescanned.usd, (await m.portfolio.PortfolioManager.getPortfolio("ai")).usd);

      // Past a funding boundary the winner reaches 1.5R: funding books and a
      // partial exit fills. A restarted watchdog repeating the same sweep adds
      // no second partial, funding event or cash movement.
      world.advanceTo(EXIT_AT);
      const risk = Math.abs((opened.initialStopLoss ?? opened.stopLoss) - opened.entryPrice);
      world.venue.priceOverride.set(symbol, opened.direction === "SHORT" ? opened.entryPrice - 1.5 * risk : opened.entryPrice + 1.5 * risk);
      await m.daemon.runExitWatchdog();
      const afterPartial = await m.portfolio.PortfolioManager.getPortfolio("ai");
      const tradesAfterPartial = (await m.portfolio.PortfolioManager.getTrades("ai")).length;
      await m.daemon.runExitWatchdog();
      const held = (await m.portfolio.PortfolioManager.getPortfolio("ai")).openPositions[asset];
      assert.ok(held, "the partial exit closed the whole position");
      assert.equal(held.partialExitCount, 1);
      assert.ok(held.amount < opened.amount);
      assert.equal(held.positionId, opened.positionId);
      assert.equal(held.economicsModel, opened.economicsModel);
      assert.deepEqual(held.fundingSettledTimes, [FUNDING_AT]);
      assert.equal((await m.portfolio.PortfolioManager.getPortfolio("ai")).usd, afterPartial.usd);
      assert.equal((await m.portfolio.PortfolioManager.getTrades("ai")).length, tradesAfterPartial);
      const countOf = (type: string) => ledgerEvents(world.ledgerDir).filter((event) => event.type === type).length;
      assert.equal(countOf("PARTIAL_EXIT_FILLED"), 1);
      assert.equal(countOf("FUNDING_SETTLED"), 1);

      // The migration is offline and idempotent: a second pass labels nothing
      // and neither pass touches the ledger.
      const ledgerBefore = ledgerDigest(world.ledgerDir);
      const portfolio = await m.portfolio.PortfolioManager.getPortfolio("ai");
      const trades = await m.portfolio.PortfolioManager.getTrades("ai");
      const first = m.migration.planInstrumentMigration({ portfolios: [portfolio], trades, nowMs: Date.now() });
      assert.deepEqual(first.conflicts, []);
      const second = m.migration.planInstrumentMigration({ portfolios: first.migratedPortfolios, trades: first.migratedTrades, nowMs: Date.now() });
      assert.deepEqual(second.migratedPortfolios, first.migratedPortfolios);
      assert.deepEqual(second.migratedTrades, first.migratedTrades);
      assert.equal(first.migratedPortfolios[0].openPositions[asset].amount, held.amount);
      assert.equal(ledgerDigest(world.ledgerDir), ledgerBefore);

      // During a venue outage the position is kept as it is and nothing enters,
      // even though the venue's price has crossed the runner's protective stop
      // (a trailing runner exits on its stop, not on the fixed target).
      world.venue.priceOverride.set(symbol, opened.direction === "SHORT" ? held.stopLoss * 1.002 : held.stopLoss * 0.998);
      world.venue.outage = true;
      world.advanceTo(EXIT_AT + 60_000);
      await m.daemon.runExitWatchdog();
      await m.daemon.runEntryScan();
      const duringOutage = (await m.portfolio.PortfolioManager.getPortfolio("ai")).openPositions[asset];
      assert.ok(duringOutage, "the outage closed the position");
      assert.equal(duringOutage.amount, held.amount);
      assert.equal(duringOutage.stopLoss, held.stopLoss);
      assert.deepEqual((await lastScan(world.memory)).filter((row) => row.action === "ENTRY"), []);
      assert.equal(countOf("ENTRY_FILLED"), 1);
      assert.equal(countOf("EXIT_FILLED"), 0);

      // Once fresh data returns, the exit is priced and the position completes
      // once, with the entry, partial and final legs in one outcome.
      world.venue.outage = false;
      world.advanceTo(EXIT_AT + 120_000);
      await m.daemon.runExitWatchdog();
      assert.equal((await m.portfolio.PortfolioManager.getPortfolio("ai")).openPositions[asset], undefined);
      const completed = outcomes(world.memory);
      assert.equal(completed.length, 1);
      assert.equal(completed[0].positionId, opened.positionId);
      assert.equal(completed[0].legIds.length, 3);
      assert.equal(countOf("EXIT_FILLED"), 1);
      assert.equal(countOf("POSITION_COMPLETED"), 1);
      assert.equal(countOf("FUNDING_SETTLED"), 1);
      assert.equal(m.ledger.ExecutionLedger.verify(world.ledgerDir).valid, true);
    } finally {
      world.close();
    }
  });

  it("a scan's ledger record stays a compact heartbeat; full diagnostics live in the scan snapshot", async () => {
    // Per-minute scans with every asset's full diagnostics grew the ledger by
    // about 30 MB a day on the VPS while nothing ever read them back.
    const world = await openWorld("GOLD");
    try {
      await m.daemon.runEntryScan();
      const files = fs.readdirSync(world.ledgerDir).filter((file) => file.endsWith(".ndjson"));
      const line = files.flatMap((file) => fs.readFileSync(path.join(world.ledgerDir, file), "utf8").split(/\r?\n/))
        .find((row) => row.includes('"SCAN_COMPLETED"'));
      assert.ok(line, "the scan was not recorded");
      assert.ok(Buffer.byteLength(line) < 2048, `scan record is ${Buffer.byteLength(line)} bytes`);
      const event = JSON.parse(line);
      assert.equal(event.payload.results.length, 9);
      assert.deepEqual(Object.keys(event.payload.results[0]).sort(), ["action", "asset", "vetoCode"]);
      const snapshot = await world.memory.get<{ results: unknown[] }>("swing:lastScan:ai");
      assert.equal(snapshot?.results.length, 9, "full diagnostics remain available in the scan snapshot");
    } finally {
      world.close();
    }
  });

  it("an entry freeze stops new entries while exits keep running", async () => {
    const asset: ConfiguredAsset = "GOLD";
    const symbol = CONFIGURED_INSTRUMENTS[asset].symbol;
    const world = await openWorld(asset);
    try {
      await world.memory.set("swing:entryFreeze", { reason: "migration window", setBy: "operator" });
      await world.memory.set("swing:lastScan:ai", { scanId: 33338, completedAt: new Date(T - 60_000).toISOString() });
      await m.daemon.runEntryScan();
      assert.deepEqual(Object.keys((await m.portfolio.PortfolioManager.getPortfolio("ai")).openPositions), []);
      assert.equal(ledgerEvents(world.ledgerDir).filter((event) => event.type === "ENTRY_FILLED").length, 0);
      const frozenScan = await world.memory.get<{ scanId: number; runtimeCommit: string | null; results: Array<{ action: string }> }>("swing:lastScan:ai");
      assert.ok(frozenScan && frozenScan.scanId > 33338, "restart must advance the persisted scan sequence");
      assert.equal(frozenScan.runtimeCommit, process.env.APP_COMMIT_SHA || null);
      assert.equal(frozenScan.results.length, 9);
      assert.ok(frozenScan.results.every((row) => row.action !== "ENTRY"));

      await world.memory.del("swing:entryFreeze");
      // Rescan the same full-quality setup; a minute later the fixture is only
      // a near-miss, which is research-only and would not test the freeze.
      world.advanceTo(T + 1_000);
      await m.daemon.runEntryScan();
      const opened = (await m.portfolio.PortfolioManager.getPortfolio("ai")).openPositions[asset];
      const resumed = await scanRow(world.memory, asset);
      assert.ok(opened, `entries did not resume after the freeze was lifted: ${resumed.action} ${resumed.vetoCode} ${resumed.reason}`);

      await world.memory.set("swing:entryFreeze", { reason: "rollback window", setBy: "operator" });
      world.advanceTo(EXIT_AT);
      world.venue.priceOverride.set(symbol, opened.direction === "SHORT" ? opened.takeProfit * 0.999 : opened.takeProfit * 1.001);
      await m.daemon.runExitWatchdog();
      assert.equal((await m.portfolio.PortfolioManager.getPortfolio("ai")).openPositions[asset], undefined, "a freeze blocked an exit");
      assert.equal(outcomes(world.memory).length, 1);
    } finally {
      world.close();
    }
  });

  it("a breached cross-sectional book can only reduce", async () => {
    const world = await openWorld(null);
    try {
      const book = await m.book.loadBookPortfolio();
      const now = new Date(T).toISOString();
      book.positions.BTCUSDT = {
        symbol: "BTCUSDT", quantity: 0.01, entryPrice: 84_000, notionalUsd: 840, weight: 0.084, openedAt: now, lastRebalancedAt: now,
        feesPaidUsd: 0, fundingPaidUsd: 0, realizedPnlUsd: 0, quantityHistory: [{ atMs: T, quantity: 0.01 }], fundingFromMs: T,
      };
      book.cashUsd = 6_400;
      book.peakEquityUsd = 10_000;
      book.maxDrawdownPercent = 28.15;
      await m.book.saveBookPortfolio(book);

      const prices = new Map([["BTCUSDT", { symbol: "BTCUSDT", lastPrice: 84_000, markPrice: 84_000, bid: 83_999, ask: 84_001, turnover24h: 5e9, fundingRate: 0.0001 }]]);
      await m.xsec.runRiskSweep(prices);

      const after = await m.book.loadBookPortfolio();
      assert.ok(after.riskState, "no risk state was recorded");
      assert.ok(["REDUCE_ONLY", "SHADOW"].includes(after.riskState.state), after.riskState.state);
      assert.equal(after.riskState.allowEntries, false);
      assert.deepEqual(Object.keys(after.positions).filter((symbol) => symbol !== "BTCUSDT"), []);
      assert.ok(Math.abs(after.positions.BTCUSDT?.quantity ?? 0) < 0.01, "the breached book did not reduce");
    } finally {
      world.close();
    }
  });
});
