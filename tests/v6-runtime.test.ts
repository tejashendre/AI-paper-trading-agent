import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRedis } from './helpers/memoryRedis';
import { evidenceInstrument } from './helpers/fakeBybitMarket';
import { getConfiguredInstrument, validateBybitMetadata } from '../src/lib/trading/instrumentRegistry';
import { brainEvidenceIdentity, evaluateBrainEvidence, evidenceHash, saveBrainReview, type BrainRegistration, type BrainEvidenceInput } from '../src/lib/strategy/v6/evidence';
import { brainDefinition } from '../src/lib/strategy/v6/engine';
import { emptyBrainShadow } from '../src/lib/strategy/v6/shadow';
import { collectBrainPaperOutcomes, runReplacementScan, runReplacementShadowSweep, type RuntimeDeps, type RuntimeFrame } from '../src/lib/strategy/v6/runtime';
import type { Portfolio, Trade } from '../src/lib/types';

const DAY=86400000,H4=14400000,NOW=Date.parse('2026-10-20T12:00:00Z');
function frame(nowMs=NOW,price?:number):RuntimeFrame {
  const bars=(n:number,step:number,end:number,daily=false)=>Array.from({length:n},(_,i)=>{
    const close=(daily?80+i*.3:90+i*.06)*600;
    return {time:(end-(n-i)*step)/1000,open:close-12,high:close+480,low:close-480,close,volume:10};
  });
  const h4=bars(160,H4,Math.floor(nowMs/H4)*H4),d1=bars(200,DAY,Math.floor(nowMs/DAY)*DAY,true);
  h4.at(-1)!.close=h4.at(-2)!.high+90;h4.at(-1)!.high=h4.at(-1)!.close+90;
  const p=price??h4.at(-1)!.close,instrument=getConfiguredInstrument('BTC');
  const quote={price:p,bid:p-.6,ask:p+.6,markPrice:p,indexPrice:p,provider:'BYBIT_LINEAR_WS',source:'WEBSOCKET' as const,transport:'WS' as const,
    venue:'BYBIT_LINEAR',instrument:instrument.symbol,instrumentVersion:instrument.instrumentVersion,updatedAt:new Date(nowMs).toISOString(),
    eventTimeMs:nowMs,receivedAtMs:nowMs,quoteTimes:{lastPriceMs:nowMs,bidAskMs:nowMs,markMs:nowMs}};
  return {asset:'BTC',bars:{h4,d1,h4AvailableAtMs:nowMs,d1AvailableAtMs:nowMs,observations:[],sourceHash:evidenceHash({h4,d1})},quote,
    metadata:validateBybitMetadata('BTCUSDT',evidenceInstrument('BTCUSDT'),nowMs),liquidity:{bestBid:p-.6,bestAsk:p+.6,bids:[[p-.6,100]],asks:[[p+.6,100]],turnover24hUsdt:1e9,observedAtMs:nowMs},
    fundingRate:.0001,fundingObservedAtMs:nowMs,availableAtMs:nowMs,sourceHash:evidenceHash({quote,nowMs})};
}
function harness(){
  const redis=new MemoryRedis();let now=NOW,current=frame();const events:unknown[]=[],tapes:any[]=[];
  const deps:RuntimeDeps={redis,clock:()=>now,assets:['BTC'],sourceHash:()=>evidenceHash('tested-source'),
    capture:async()=>structuredClone(current),calendar:async()=>null,funding:async()=>[],ledger:async e=>{events.push(e);},archive:async(_run,_id,tape)=>{tapes.push(structuredClone(tape));}};
  return {redis,deps,events,tapes,setNow:(v:number)=>{now=v;current=frame(v);},setFrame:(v:RuntimeFrame)=>{current=v;}};
}
async function seed(h:ReturnType<typeof harness>,ack=true){
  await h.redis.set('brain:v6:activeRun',{runId:'test-run',brainVersion:'replacement-swing-v6-2026-10-24',initialCapital:10000,startedAt:new Date(NOW).toISOString()});
  await h.redis.set('brain:v6:run:test-run:ledgerAcknowledged',ack);
  await h.redis.set('brain:v6:run:test-run:portfolio',{usd:10000,initialCapital:10000,peakValue:10000,balances:{BTC:0},openPositions:{},openPosition:null,totalPnl:0,totalTrades:0,totalFeesPaid:0});
}
test('replacement has no legacy-entry fallback and does not initialize capital without an acknowledged epoch',async()=>{
  const h=harness();const result=await runReplacementScan(h.deps);
  assert.equal(result.mode,'RESET_REQUIRED');assert.equal(await h.redis.get('ai:portfolio'),null);
  assert.ok(result.scanId>0);
  h.setNow(NOW+60000);
  const waiting=await runReplacementScan(h.deps);
  assert.ok(waiting.scanId>result.scanId);
  assert.equal((h.events.at(-1) as any).type,'SCAN_COMPLETED');
  assert.equal((h.events.at(-1) as any).payload.mode,'RESET_REQUIRED');
  assert.equal((h.events.at(-1) as any).payload.capitalAllocatedUsdt,0);
  assert.equal(await h.redis.get('brain:v6:run:test-run:portfolio'),null);
  await seed(h,false);const before=await h.redis.readRaw(['brain:v6:run:test-run:portfolio']);
  assert.equal((await runReplacementScan(h.deps)).mode,'RESET_REQUIRED');
  assert.deepEqual(await h.redis.readRaw(['brain:v6:run:test-run:portfolio']),before);
});
test('a failed pre-reset ledger heartbeat cannot publish healthy daemon progress',async()=>{
  const h=harness();h.deps.ledger=async()=>{throw new Error('ledger unavailable');};
  await assert.rejects(runReplacementScan(h.deps),/ledger unavailable/);
  assert.equal(await h.redis.get('swing:lastScan:ai'),null);
  assert.equal(await h.redis.get('brain:v6:status'),null);
  assert.equal(await h.redis.get('ai:portfolio'),null);
});
test('pre-reset heartbeat preserves reset snapshots while the migration freeze or AI lease is held',async()=>{
  for(const key of ['brain:v6:migration-freeze','portfolio:write-lock:ai']){
    const h=harness();await h.redis.set(key,'reset-owner',{ex:300});
    await h.redis.set('swing:lastScan:ai',{scanId:41});
    await h.redis.set('execution:ledger:head',{hash:'old-head'});
    const keys=[key,'swing:lastScan:ai','execution:ledger:head','brain:v6:status','brain:v6:resetRequiredScanSequence','ai:portfolio'];
    const before=await h.redis.readRaw(keys);
    await runReplacementScan(h.deps);
    assert.deepEqual(await h.redis.readRaw(keys),before);
    assert.equal(h.events.length,0);
  }
});
test('an epoch acknowledged while the waiting heartbeat obtains its lease cannot publish stale RESET_REQUIRED',async()=>{
  const h=harness(),set=h.redis.set.bind(h.redis);let raced=false;
  h.redis.set=async(key,value,options)=>{
    const result=await set(key,value,options);
    if(key==='portfolio:write-lock:ai'&&result==='OK'&&!raced){raced=true;await seed(h);}
    return result;
  };
  await runReplacementScan(h.deps);
  assert.equal(await h.redis.get('swing:lastScan:ai'),null);
  assert.equal(await h.redis.get('brain:v6:status'),null);
  assert.equal(h.events.length,0);
  assert.equal(await h.redis.get('portfolio:write-lock:ai'),null);
});
test('a causal setup opens only virtual exposure and archives all inputs without a financial write',async()=>{
  const h=harness();await seed(h);const before=await h.redis.readRaw(['brain:v6:run:test-run:portfolio','ai:trades']);
  const result=await runReplacementScan(h.deps);
  assert.equal(result.assets[0].decision.status,'SETUP');assert.equal(result.assets[0].mode,'SHADOW');
  assert.equal(result.virtualShadow.openPositions,1);assert.equal(result.virtualShadow.capitalAllocatedUsdt,0);
  assert.deepEqual(await h.redis.readRaw(['brain:v6:run:test-run:portfolio','ai:trades']),before);
  const files=await h.redis.scanKeys('brain:v6:run:test-run:decision:*');assert.equal(files.length,1);
  const reference=await h.redis.get<any>(files[0]),tape=h.tapes[0];assert.equal(reference.decisionId,evidenceHash(tape));
  assert.equal(reference.frames,undefined);assert.equal(tape.frames[0].bars.h4.length,160);
  assert.equal(tape.frames[0].liquidity.bids[0][1],100);assert.equal(tape.frames[0].fundingObservedAtMs,NOW);
  assert.equal(tape.decidedAtMs,NOW);assert.equal(result.assets[0].evidence.forwardCount,0);
});
test('actual receipt clocks determine the common decision boundary and future capture data is refused',async()=>{
  const h=harness();await seed(h);h.deps.capture=async()=>{h.setNow(NOW+800);return frame(NOW+800);};
  const result=await runReplacementScan(h.deps);assert.equal(result.generatedAtMs,NOW+800);
  const tape=h.tapes[0];
  assert.equal(tape.decidedAtMs,NOW+800);assert.equal(tape.frames[0].bars.h4AvailableAtMs,NOW+800);
  h.setNow(NOW+1000);h.deps.capture=async()=>({...frame(NOW+1000),availableAtMs:NOW+2000});
  const bad=await runReplacementScan(h.deps);assert.equal(bad.assets[0].decision.code,'INVALID_CAPTURE');
});
test('repeated scans do not duplicate virtual positions and restart retains immutable registration',async()=>{
  const h=harness();await seed(h);await runReplacementScan(h.deps);
  const first=await h.redis.get('brain:v6:run:test-run:runtimeRegistration:BTC');
  h.setNow(NOW+60000);const again=await runReplacementScan(h.deps);
  assert.equal(again.virtualShadow.openPositions,1);
  assert.deepEqual(await h.redis.get('brain:v6:run:test-run:runtimeRegistration:BTC'),first);
  h.deps.sourceHash=()=>evidenceHash('changed-source');
  assert.equal((await runReplacementScan(h.deps)).assets[0].decision.code,'REGISTRATION_MISMATCH');
});
test('shared shadow exits use the frozen stop and retain actual execution and funding coverage',async()=>{
  const h=harness();await seed(h);await runReplacementScan(h.deps);
  const state=await h.redis.get<any>('brain:v6:run:test-run:shadow');const held=state.open.BTC;
  h.setNow(NOW+5000);h.setFrame(frame(NOW+5000,held.plan.stopLoss-20));
  await runReplacementShadowSweep(h.deps);
  const after=await h.redis.get<any>('brain:v6:run:test-run:shadow');
  assert.equal(Object.keys(after.open).length,0);assert.equal(after.outcomes.length,1);
  assert.equal(after.outcomes[0].executions.length,2);assert.ok(after.outcomes[0].executions[1].depthNotionalUsdt>0);
  assert.equal(after.outcomes[0].funding.length,0);assert.ok(after.outcomes[0].netR<0);
  assert.equal((await h.redis.get<any>('brain:v6:run:test-run:portfolio')).usd,10000);
});
test('an entry freeze still allows shadow stops, and missing due funding cannot become a qualified result',async()=>{
  const h=harness();await seed(h);await runReplacementScan(h.deps);
  const held=(await h.redis.get<any>('brain:v6:run:test-run:shadow')).open.BTC;
  await h.redis.set('swing:entryFreeze',true);h.setNow(NOW+5*3600000);
  h.setFrame(frame(NOW+5*3600000,held.plan.stopLoss-20));await runReplacementShadowSweep(h.deps);
  const after=await h.redis.get<any>('brain:v6:run:test-run:shadow');
  assert.equal(Object.keys(after.open).length,0);assert.equal(after.outcomes.length,0);
  assert.equal(after.pending.length,1);assert.ok(after.pending[0].missingFundingTimes.length>0);
});
async function qualified(){
  const h=harness();await seed(h);
  for(let i=0;i<30;i++)await h.redis.lpush('research:swing-v5.0.0-2026-10-01:candidates',JSON.stringify({candidateId:`fixture-${i}`,registeredAtMs:NOW-DAY}));
  await runReplacementScan(h.deps);
  const registration=(await h.redis.get<BrainRegistration>('brain:v6:run:test-run:runtimeRegistration:BTC'))!,definition=brainDefinition('BTC');
  const identityHash=brainEvidenceIdentity(definition,registration),sourceHash=evidenceHash('fixture'),nowMs=NOW+82*DAY;
  const outcomes=Array.from({length:40},(_,i)=>{const openedAtMs=NOW+(2*i+1)*DAY,closedAtMs=openedAtMs+DAY/4;return {
    positionId:`fixture-shadow-${i}`,identityHash,runId:'test-run',sourceHash,origin:'SHADOW' as const,openedAtMs,closedAtMs,availableAtMs:closedAtMs,
    netR:i%3===0?.8:1.2,stressedNetR:.5,initialRiskUsdt:25,costHash:registration.costHash,
    executions:[openedAtMs,closedAtMs].map(atMs=>({atMs,availableAtMs:atMs,sourceHash,halfSpreadBps:1,depthNotionalUsdt:50000})),
    fundingIntervalMs:8*3600000,funding:[],criticalViolation:false};});
  // The fixture opens at noon and closes at 18:00, crossing the observed 16:00 settlement.
  for(const row of outcomes)row.funding=[{atMs:Math.floor(row.openedAtMs/(8*3600000))*(8*3600000)+8*3600000,actualRate:.0001,mark:60000,
    intervalMinutes:480,availableAtMs:row.closedAtMs,sourceHash}] as never[];
  const input:BrainEvidenceInput={definition,registration,outcomes,nowMs,expiresAtMs:nowMs+DAY,
    trials:(await h.redis.get<BrainEvidenceInput['trials']>('brain:v6:run:test-run:trials'))!,
    dailyReturns:Array.from({length:82},(_,i)=>({dayStartMs:Math.floor(NOW/DAY)*DAY+i*DAY,availableAtMs:Math.floor(NOW/DAY)*DAY+(i+1)*DAY,
      identityHash,runId:'test-run',sourceHash,costHash:registration.costHash,baseRiskFraction:.0025,netReturn:i%2?.003:.001})),
    portfolio:{identityHash,runId:'test-run',sourceHash,riskFraction:.0025,alignedBlockMs:10*DAY,factorClusters:['crypto'],equity:[{atMs:NOW,equityUsdt:10000},{atMs:nowMs,equityUsdt:10500}],
      unresolvedBreaker:false,integrityRestored:true}};
  const proof=evaluateBrainEvidence(input);assert.equal(proof.mode,'PAPER_ACTIVE',proof.reasons.join('; '));await saveBrainReview(h.redis,proof);
  await h.redis.set('brain:v6:run:test-run:shadow',emptyBrainShadow('test-run'));h.setNow(nowMs);return {...h,proof,registration,nowMs};
}
test('only an exact qualified identity commits one durable paper fill and a retry cannot debit cash twice',async()=>{
  const h=await qualified();const result=await runReplacementScan(h.deps);
  assert.equal(result.assets[0].decision.status,'ENTRY');
  const first=await h.redis.get<any>('brain:v6:run:test-run:portfolio');assert.ok(first.usd<10000);
  assert.ok(first.openPositions.BTC.initialRiskUsdt<=25);assert.equal(first.openPositions.BTC.brainRunId,'test-run');
  assert.equal(first.openPositions.BTC.brainIdentityHash,h.proof.identityHash);
  assert.equal((await h.redis.lrange('brain:v6:run:test-run:trades',0,-1)).length,1);
  await runReplacementScan(h.deps);
  assert.equal((await h.redis.get<any>('brain:v6:run:test-run:portfolio')).usd,first.usd);
  assert.equal((await h.redis.lrange('brain:v6:run:test-run:trades',0,-1)).length,1);
});
test('an already committed setup is excluded before allocating another entry after the position closes',async()=>{
  const h=await qualified();await runReplacementScan(h.deps);
  const p='brain:v6:run:test-run:',portfolio=await h.redis.get<any>(p+'portfolio');
  const positionId=portfolio.openPositions.BTC.positionId;
  assert.ok(await h.redis.get(p+'entryPosition:'+positionId));
  // Simulate the completed protective close without creating a new setup.
  portfolio.openPositions={};portfolio.openPosition=null;portfolio.balances={BTC:0};portfolio.btc=0;
  await h.redis.set(p+'portfolio',portfolio);
  let commits=0;const commit=h.redis.commitBrainEntry.bind(h.redis);
  h.redis.commitBrainEntry=async input=>{commits++;return commit(input);};
  await runReplacementScan(h.deps);
  assert.equal(commits,0);
  assert.equal((await h.redis.get<any>(p+'portfolio')).usd,portfolio.usd);
  assert.equal((await h.redis.lrange(p+'trades',0,-1)).length,1);
});
test('an ambiguous financial commit preserves its outbox and recovers without another fill',async()=>{
  const h=await qualified(),original=h.redis.commitBrainEntry.bind(h.redis);let crashed=false;
  h.redis.commitBrainEntry=async input=>{const receipt=await original(input);if(!crashed){crashed=true;throw new Error('fixture crash after atomic commit');}return receipt;};
  await assert.rejects(runReplacementScan(h.deps),/fixture crash/);
  assert.equal((await h.redis.scanKeys('brain:v6:run:test-run:outbox:*')).length,1);
  const cash=(await h.redis.get<any>('brain:v6:run:test-run:portfolio')).usd;
  await runReplacementScan(h.deps);
  assert.equal((await h.redis.scanKeys('brain:v6:run:test-run:outbox:*')).length,0);
  assert.equal((await h.redis.get<any>('brain:v6:run:test-run:portfolio')).usd,cash);
  assert.equal((await h.redis.lrange('brain:v6:run:test-run:trades',0,-1)).length,1);
});
test('an expired financial lease refuses the entire batch without a trade or cash write',async()=>{
  const h=await qualified(),original=h.redis.commitBrainEntry.bind(h.redis);
  h.redis.commitBrainEntry=async input=>{await h.redis.del('portfolio:write-lock:ai');return original(input);};
  await assert.rejects(runReplacementScan(h.deps),/Stale entry lease/);
  assert.equal((await h.redis.get<any>('brain:v6:run:test-run:portfolio')).usd,10000);
  assert.equal((await h.redis.lrange('brain:v6:run:test-run:trades',0,-1)).length,0);
});
test('paper completions are recoverable and idempotent while missing execution proof never becomes activation evidence',async()=>{
  const h=await qualified();await runReplacementScan(h.deps);
  const entry=JSON.parse((await h.redis.lrange('brain:v6:run:test-run:trades',0,-1))[0]) as Trade;
  const at=h.nowMs+1000,close:Trade={...entry,id:'fixture-exit',action:'SELL',timestamp:new Date(at).toISOString(),amount:entry.amount,price:entry.price-100,
    pnl:-2,exitReason:'STOP_LOSS',exitFeeUsd:.1,brainExitObservation:{...entry.brainEntryObservation!,atMs:at,availableAtMs:at},brainStressedExit:{fillPrice:entry.price-101,feeUsdt:.2}};
  await h.redis.lpush('brain:v6:run:test-run:trades',JSON.stringify(close));
  const portfolio=(await h.redis.get<Portfolio>('brain:v6:run:test-run:portfolio'))!;portfolio.openPositions={};
  const first=await collectBrainPaperOutcomes(h.deps,'test-run',portfolio,at);
  assert.equal(first.outcomes.length,1);assert.equal(first.riskOutcomes.length,1);assert.ok(first.riskOutcomes[0].netPnlUsdt<0);
  assert.equal((await collectBrainPaperOutcomes(h.deps,'test-run',portfolio,at+1000)).outcomes.length,1);
  assert.equal((await h.redis.scanKeys('brain:v6:run:test-run:brainOutcome:*')).length,1);
  const malformed={...close,id:'fixture-exit-2',positionId:'unproved',brainEntryObservation:undefined,brainExitObservation:undefined};
  await h.redis.lpush('brain:v6:run:test-run:trades',JSON.stringify({...entry,id:'fixture-entry-2',positionId:'unproved'}));
  await h.redis.lpush('brain:v6:run:test-run:trades',JSON.stringify(malformed));
  const bad=await collectBrainPaperOutcomes(h.deps,'test-run',portfolio,at+2000);
  assert.equal(bad.outcomes.length,1);assert.equal(bad.riskOutcomes.length,2);
  assert.ok((await h.redis.scanKeys('brain:v6:run:test-run:paperCoverage:*')).length>0);
});
test('shadow protection refuses a quote with a fresh receipt and stale executable components',async()=>{
  const h=harness();await seed(h);await runReplacementScan(h.deps);
  const before=await h.redis.get<any>('brain:v6:run:test-run:shadow'),held=before.open.BTC;
  h.setNow(NOW+5000);const bad=frame(NOW+5000,held.plan.stopLoss-20);bad.quote!.quoteTimes.bidAskMs=NOW-60000;h.setFrame(bad);
  await runReplacementShadowSweep(h.deps);
  assert.equal(Object.keys((await h.redis.get<any>('brain:v6:run:test-run:shadow')).open).length,1);
});

test('a lease lost after the shadow commit cannot publish a later evidence permission',async()=>{
  const h=harness();await seed(h);
  const original=h.redis.commitBrainObservation.bind(h.redis);let first=true;
  h.redis.commitBrainObservation=async input=>{await original(input);if(first){first=false;await h.redis.del('portfolio:write-lock:ai');}};
  await assert.rejects(runReplacementScan(h.deps),/lease/i);
  assert.equal((await h.redis.scanKeys('brain:v6:run:test-run:latest:*')).length,0);
  assert.equal((await h.redis.lrange('brain:v6:run:test-run:trades',0,-1)).length,0);
});
