import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { feeScheduleFor } from '@/lib/trading/assetSpecs';
import { getConfiguredInstrument } from '@/lib/trading/instrumentRegistry';
import { estimatePaperFill, EXECUTION_COST_MODEL_VERSION } from '@/lib/trading/executionCostModel';
import { modeledPositionMark } from '@/lib/trading/positionValuation';
import { shadowCostsObserved, simulatedNetOutcome } from '@/lib/trading/opportunityJournal';
import { ensureResearchBaselines, reviewRegisteredCandidates } from '@/lib/research/researchLoop';
import { registerCandidate, getCandidateRegistry } from '@/lib/research/candidateRegistry';
import { setRedisClient } from '@/lib/redis';
import { MemoryRedis } from './helpers/memoryRedis';
import { definition } from './helpers/researchFixtures';
import { markedEquity } from '@/lib/trading/markedEquity';
import { evaluatePortfolioRiskBudget } from '@/lib/trading/portfolioRiskBudget';

const oldVersion = 'bybit-fx-stress-2026-10-01';

test('historical descriptive labels keep their observation fee schedule', () => {
  const record={asset:'EURUSD',direction:'LONG' as const,entryPrice:1.1,dataQuality:100};
  const prior=simulatedNetOutcome({...record,feeScheduleVersion:oldVersion},{firstHit:'NONE',currentPrice:1.1},1.1);
  const fresh=simulatedNetOutcome({...record,feeScheduleVersion:feeScheduleFor(getConfiguredInstrument('EURUSD')).version},
    {firstHit:'NONE',currentPrice:1.1},1.1);
  assert.ok(prior.feeDragUsd>fresh.feeDragUsd+0.5);
  assert.ok(prior.netPnlUsd<fresh.netPnlUsd-0.5);
  assert.deepEqual(simulatedNetOutcome(record,{firstHit:'NONE',currentPrice:1.1},1.1),prior);
});

test('historical fallback execution costs retain old FX fees in the daily risk budget', () => {
  const now=new Date(), instrument=getConfiguredInstrument('EURUSD');
  const result=evaluatePortfolioRiskBudget({portfolio:{usd:10000,openPositions:{},initialCapital:10000,peakValue:10000} as any,
    trades:[{asset:'EURUSD',instrument,amount:1000,price:1.1,action:'BUY',timestamp:now.toISOString(),feeScheduleVersion:oldVersion} as any],
    asset:'BTC',direction:'LONG',candidateNotionalUsd:10,candidateMaxLossUsd:1,candidateEntryCostUsd:0,now});
  assert.ok(Math.abs(result.diagnostics.executionCosts24h-1100*0.00055)<1e-12);
});

test('risk equity charges the frozen exit fee on old FX exposure', () => {
  const portfolio:any = {usd:9000,openPositions:{EURUSD:{asset:'EURUSD',instrument:getConfiguredInstrument('EURUSD'),
    amount:1000,entryPrice:1.1,usdInvested:1000,direction:'LONG',lastMarkPrice:1.09,feeScheduleVersion:oldVersion}}};
  assert.ok(Math.abs(markedEquity(portfolio) - (10000-10-1090*0.00055)) < 1e-9);
});

test('manual FX closes settle frozen fees and new manual fills stamp the published version', async () => {
  process.env.DASHBOARD_SECRET='isolated-fx-test-dashboard-secret';
  const { POST } = await import('@/app/api/trade/manual/route');
  const { PortfolioManager } = await import('@/lib/portfolio');
  const { MarketService } = await import('@/lib/market');
  const { Logger } = await import('@/lib/logger');
  let portfolio:any;
  const trades:any[]=[];
  mock.method(PortfolioManager,'acquireWriteLock',async()=>async()=>{});
  mock.method(PortfolioManager,'getPortfolio',async()=>portfolio);
  mock.method(PortfolioManager,'updatePortfolio',async()=>{});
  mock.method(PortfolioManager,'logTrade',async(trade:any)=>{trades.push(trade);});
  mock.method(MarketService,'getCurrentPrice',async()=>1.09);
  mock.method(Logger,'info',async()=>{});
  try {
    for (const action of ['SELL','COVER','BUY','SHORT']) {
      const closing=action==='SELL'||action==='COVER';
      portfolio={usd:9000,balances:{EURUSD:closing?1000:0},openPositions:closing?{EURUSD:{asset:'EURUSD',
        instrument:getConfiguredInstrument('EURUSD'),amount:1000,entryPrice:1.1,usdInvested:1000,
        entryFeePaid:0.605,direction:action==='COVER'?'SHORT':'LONG',feeScheduleVersion:oldVersion}}:{},
        totalPnl:0,totalTrades:0,returns:[],winningTrades:0,losingTrades:0,grossProfit:0,grossLoss:0,
        consecutiveWins:0,consecutiveLosses:0,maxConsecutiveWins:0,maxConsecutiveLosses:0};
      const response=await POST(new Request('http://localhost/api/trade/manual',{method:'POST',
        headers:{authorization:'Bearer isolated-fx-test-dashboard-secret','content-type':'application/json'},
        body:JSON.stringify({asset:'EURUSD',action,amount:1000})}));
      assert.equal(response.status,200,`${action}: ${await response.text()}`);
      if (closing) {
        const gross=action==='SELL'?-10:10;
        assert.ok(Math.abs(portfolio.usd-(10000+gross-1090*0.00055))<1e-9,action);
        assert.equal(trades.at(-1)?.feeScheduleVersion,oldVersion);
      } else {
        assert.equal(portfolio.openPositions.EURUSD.feeScheduleVersion,feeScheduleFor(getConfiguredInstrument('EURUSD')).version,action);
        assert.equal(trades.at(-1)?.feeScheduleVersion,portfolio.openPositions.EURUSD.feeScheduleVersion);
      }
    }
  } finally {mock.restoreAll();delete process.env.DASHBOARD_SECRET;}
});

test('official TradFi VIP0 baseline applies to all three configured FX contracts', () => {
  for (const asset of ['EURUSD', 'GBPUSD', 'USDJPY']) {
    const instrument = getConfiguredInstrument(asset), schedule = feeScheduleFor(instrument);
    assert.deepEqual([schedule.makerRate, schedule.takerRate, schedule.status], [0, 0.000275, 'PUBLIC_BASELINE']);
    assert.notEqual(schedule.version, oldVersion);
    assert.ok(schedule.verificationSourceUrls?.includes('https://www.bybit.com/en/learn/bybit-tradfi/trade-tradfi-perpetuals-bybit'));
    const fill = estimatePaperFill({asset, instrument, action:'BUY', requestedPrice:asset==='USDJPY'?150:1.1,
      amount:10, context:{reason:'ENTRY'}});
    assert.ok(Math.abs(fill.feeUsd / fill.notionalUsd - 0.000275) < 1e-12);
    assert.notEqual(fill.modelVersion, EXECUTION_COST_MODEL_VERSION, 'changed FX costs need a distinct learning cohort');
  }
});

test('old FX positions keep stress fees in exit marks and their browser cost curve', () => {
  const instrument = getConfiguredInstrument('USDJPY');
  const old = feeScheduleFor(instrument, oldVersion);
  assert.deepEqual([old.takerRate, old.status], [0.00055, 'UNVERIFIED_STRESS_RATE']);
  const mark = modeledPositionMark('USDJPY', {asset:'USDJPY', instrument, amount:10, direction:'LONG',
    entryPrice:150, entryTime:new Date().toISOString(), entryFeePaid:0.825, feeScheduleVersion:oldVersion}, 149);
  assert.ok(Math.abs(mark.valuation.exitFeeRate - 0.00055) < 1e-12);
  const unstamped = modeledPositionMark('USDJPY', {asset:'USDJPY', instrument, amount:10, direction:'LONG',
    entryPrice:150, entryTime:new Date().toISOString(), entryFeePaid:0.825}, 149);
  assert.equal(unstamped.exitFee, mark.exitFee, 'unstamped old linear positions retain the conservative prior fee');
});

test('unstamped FX shadow observations remain unverified; new fee-stamped observations can collect evidence', () => {
  const instrument = getConfiguredInstrument('EURUSD');
  assert.equal(shadowCostsObserved({halfSpreadBps:0.4}, instrument), false);
  assert.equal(shadowCostsObserved({halfSpreadBps:0.4,feeScheduleVersion:oldVersion}, instrument), false);
  assert.equal(shadowCostsObserved({halfSpreadBps:0.4,feeScheduleVersion:feeScheduleFor(instrument).version}, instrument), true);
});

test('new FX research cohorts preserve old definitions and keep old fee evidence blocked', async () => {
  const memory = new MemoryRedis(), original = process.env.EXECUTION_LEDGER_DIR;
  process.env.EXECUTION_LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(),'fx-fee-cohort-'));
  setRedisClient(memory);
  try {
    const old = {...definition,candidateId:'old-fx',instrumentVersions:[getConfiguredInstrument('EURUSD').instrumentVersion],
      costModelVersion:EXECUTION_COST_MODEL_VERSION};
    await registerCandidate(old);
    await ensureResearchBaselines();
    const registry = await getCandidateRegistry();
    assert.equal(registry.find(d=>d.candidateId===old.candidateId)?.costModelVersion, old.costModelVersion);
    const fresh = registry.filter(d=>d.instrumentVersions.includes(old.instrumentVersions[0]) && d.candidateId!==old.candidateId);
    assert.equal(fresh.length,3, 'trend, range and session breakout');
    assert.ok(fresh.every(d=>d.costModelVersion!==old.costModelVersion));
    const status = await reviewRegisteredCandidates();
    assert.ok(status.candidates.find(d=>d.candidateId===old.candidateId)?.reasons.includes('UNVERIFIED_FEES'));
    assert.ok(status.candidates.filter(d=>fresh.some(f=>f.candidateId===d.candidateId)).every(d=>!d.reasons.includes('UNVERIFIED_FEES')));
    assert.ok(status.candidates.every(d=>d.mode==='SHADOW'), 'published fees alone never promote a candidate');
  } finally {
    setRedisClient(null);
    if (original===undefined) delete process.env.EXECUTION_LEDGER_DIR; else process.env.EXECUTION_LEDGER_DIR=original;
  }
});
