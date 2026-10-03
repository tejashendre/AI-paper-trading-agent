import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryRedis } from './helpers/memoryRedis';
import { setRedisClient } from '@/lib/redis';
import { MAX_PENDING, OpportunityJournal } from '@/lib/trading/opportunityJournal';
import { TRADING_STRATEGY_VERSION } from '@/lib/trading/executionLedger';
import { storeResearchOutcome, reviewRegisteredCandidates } from '@/lib/research/researchLoop';
import { registerCandidate } from '@/lib/research/candidateRegistry';
import { definition, outcomes } from './helpers/researchFixtures';

test('a full day of all-asset research preserves the oldest unfinished 24-hour labels', async () => {
  const memory = new MemoryRedis(); setRedisClient(memory);
  try {
    const start = Date.now() - 25 * 3600000;
    for (let bar=0; bar<100; bar++) await OpportunityJournal.recordMany(
      ['BTC','ETH','SOL','EURUSD','GBPUSD','USDJPY','GOLD','OIL','SILVER'].map(asset=>({
        asset, candidateId:`${asset}-${bar}`, family:'TREND_PULLBACK', configHash:'config',
        timestamp:new Date(start+bar*900000).toISOString(), action:'WATCH', decisionState:'WATCH_LONG',
        price:100, stopLoss:95, takeProfit:110, finalConviction:50,
      })));
    const pending=memory.listRows(`opportunity:${TRADING_STRATEGY_VERSION}:v3:pending`).map(raw=>JSON.parse(raw));
    assert.equal(pending.length,900);
    assert.ok(pending.some(row=>row.candidateId==='BTC-0'), 'oldest mature label was discarded');
    assert.equal((await OpportunityJournal.getRecent(1000)).length,500,'display history stays bounded');
    // 900 held plus enough new candidates to overflow the cap by 1004.
    await OpportunityJournal.recordMany(Array.from({length:MAX_PENDING-900+1004},(_,i)=>({asset:'BTC',candidateId:`capacity-${i}`,
      timestamp:new Date().toISOString(),action:'WATCH',decisionState:'WATCH_LONG',price:100})));
    const bounded=memory.listRows(`opportunity:${TRADING_STRATEGY_VERSION}:v3:pending`).map(raw=>JSON.parse(raw));
    assert.equal(bounded.length,MAX_PENDING);
    assert.ok(bounded.some(row=>row.candidateId==='BTC-0'));
    const status=await memory.get<any>(`opportunity:${TRADING_STRATEGY_VERSION}:v3:queueStatus`);
    assert.equal(status.status,'CAPACITY_LIMIT');
    assert.equal(status.rejectedNew,1004);
  } finally {setRedisClient(null);}
});

test('dense recent observations cannot evict independent cohort evidence', async () => {
  const memory=new MemoryRedis(); setRedisClient(memory);
  try {
    await registerCandidate(definition);
    const independent=outcomes(15).map(o=>({...o,researchOrigin:'SHADOW'}));
    for (const o of independent) await storeResearchOutcome(o);
    const last=independent.at(-1)!;
    for (let i=0;i<4200;i++) await storeResearchOutcome({...last,positionId:'dense-'+i,
      openedAtMs:last.openedAtMs+(i+1)*1000,closedAtMs:last.closedAtMs+(i+1)*1000,
      labelEndMs:last.labelEndMs+(i+1)*1000,featureStartMs:last.featureStartMs});
    const status=await reviewRegisteredCandidates();
    const candidate=status.candidates.find(c=>c.candidateId===definition.candidateId)!;
    assert.equal(candidate.metrics.forwardPositions,15);
    assert.equal((await reviewRegisteredCandidates()).candidates.find(c=>c.candidateId===definition.candidateId)!
      .metrics.forwardPositions,15,'restart-style reread retains the independent set');
  } finally {setRedisClient(null);}
});
