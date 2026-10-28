import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRedis } from './helpers/memoryRedis';
import * as store from '../src/lib/redis';

async function fixture(){
  const redis=new MemoryRedis(),prefix='brain:v6:run:entry-test:';
  await redis.set('brain:v6:activeRun',{runId:'entry-test'});
  await redis.set(prefix+'ledgerAcknowledged',true);
  await redis.set(prefix+'portfolio',{usd:10000,openPositions:{}});
  await redis.set('portfolio:write-lock:ai','lease',{ex:30});
  const financial={portfolio:JSON.stringify({usd:9990,openPositions:{BTC:{positionId:'one'}}}),
    trades:[JSON.stringify({id:'one',positionId:'one',asset:'BTC',action:'BUY',brainRunId:'entry-test'})],events:[{id:'entry:one',event:JSON.stringify({id:'entry:one',type:'ENTRY_FILLED'})}]};
  return {redis,prefix,input:{runId:'entry-test',transactionId:'one',leaseToken:'lease',expected:await redis.readRaw(['brain:v6:activeRun',prefix+'portfolio']),
    ...financial,expiresAtMs:Date.now()+10000,receipt:(store as any).brainEntryReceipt?.(financial)??'missing'}};
}
test('atomic entry commits financial state, trade and outbox once across a lost reply',async()=>{
  const f=await fixture();assert.equal(typeof (f.redis as any).commitBrainEntry,'function','fenced entry commit exists');
  const result=await f.redis.commitBrainEntry(f.input);
  assert.equal(result,f.input.receipt);
  await f.redis.commitBrainEntry(f.input);
  assert.equal((await f.redis.get<{usd:number}>(f.prefix+'portfolio'))?.usd,9990);
  assert.equal((await f.redis.get<{usd:number}>('ai:portfolio'))?.usd,9990);
  assert.equal((await f.redis.lrange(f.prefix+'trades',0,-1)).length,1);
  assert.equal(await f.redis.get(f.prefix+'outbox:entry:one')!==null,true);
  await assert.rejects(()=>f.redis.commitBrainEntry({...f.input,portfolio:JSON.stringify({usd:123})}),/receipt|payload/i);
});
test('a closed entry cannot be reused by a different partial batch after its outbox is drained',async()=>{
  const f=await fixture();
  const second={id:'two',positionId:'two',asset:'ETH',action:'BUY',brainRunId:'entry-test'};
  const financial={portfolio:JSON.stringify({usd:9980,openPositions:{BTC:{positionId:'one'},ETH:{positionId:'two'}}}),
    trades:[...f.input.trades,JSON.stringify(second)],events:f.input.events};
  const batch={...f.input,...financial,transactionId:'one-and-two',receipt:store.brainEntryReceipt(financial)};
  await f.redis.commitBrainEntry(batch);
  await f.redis.del(f.prefix+'outbox:entry:one');
  const close={kind:'EXIT' as const,portfolio:JSON.stringify({usd:9990,openPositions:{ETH:{positionId:'two'}}}),
    trades:[JSON.stringify({id:'exit-one',positionId:'one',asset:'BTC',action:'SELL',brainRunId:'entry-test'})],
    events:[{id:'exit:one',event:JSON.stringify({id:'exit:one',type:'EXIT_FILLED'})}]};
  await f.redis.commitBrainEntry({...f.input,...close,transactionId:'close-one',expected:await f.redis.readRaw(Object.keys(f.input.expected)),receipt:store.brainEntryReceipt(close)});
  const before=await f.redis.readRaw([f.prefix+'portfolio','ai:portfolio',f.prefix+'trades']);
  const retry={...f.input,expected:await f.redis.readRaw(Object.keys(f.input.expected))};
  await assert.rejects(f.redis.commitBrainEntry(retry),/already committed/i);
  // A changed trade id still cannot reopen the same setup/position.
  const renamed={...retry,trades:[JSON.stringify({...JSON.parse(f.input.trades[0]),id:'renamed-one'})]};
  renamed.receipt=store.brainEntryReceipt(renamed);
  await assert.rejects(f.redis.commitBrainEntry(renamed),/already committed/i);
  assert.deepEqual(await f.redis.readRaw(Object.keys(before)),before);
  assert.equal(await f.redis.get(f.prefix+'outbox:entry:one'),null);
  assert.equal(await f.redis.commitBrainEntry(batch),batch.receipt);
});
test('two differently named trades cannot enter the same position in one atomic batch',async()=>{
  const f=await fixture(),before=await f.redis.readRaw([f.prefix+'portfolio','ai:portfolio',f.prefix+'trades']);
  const second={...JSON.parse(f.input.trades[0]),id:'different-trade-id'};
  const input={...f.input,trades:[...f.input.trades,JSON.stringify(second)]};
  input.receipt=store.brainEntryReceipt(input);
  await assert.rejects(f.redis.commitBrainEntry(input),/duplicate financial trade/i);
  assert.deepEqual(await f.redis.readRaw(Object.keys(before)),before);
});
for(const fault of ['lease','freeze','ack','epoch','portfolio','deadline'] as const)test(`entry ${fault} race cannot write partial financial state`,async()=>{
  const f=await fixture();assert.equal(typeof (f.redis as any).commitBrainEntry,'function');
  if(fault==='lease')await f.redis.set('portfolio:write-lock:ai','other',{ex:30});
  if(fault==='freeze')await f.redis.set('brain:v6:migration-freeze','reset',{ex:30});
  if(fault==='ack')await f.redis.del(f.prefix+'ledgerAcknowledged');
  if(fault==='epoch')await f.redis.set('brain:v6:activeRun',{runId:'other'});
  if(fault==='portfolio')await f.redis.set(f.prefix+'portfolio',{usd:9876,openPositions:{}});
  if(fault==='deadline')f.input.expiresAtMs=Date.now()-1;
  await assert.rejects(()=>f.redis.commitBrainEntry(f.input));
  assert.equal((await f.redis.lrange(f.prefix+'trades',0,-1)).length,0);
  assert.equal(await f.redis.get(f.prefix+'outbox:entry:one'),null);
});

test('virtual shadow evidence cannot overwrite a newer head after lease loss',async()=>{
  const f=await fixture();assert.equal(typeof (f.redis as any).commitBrainObservation,'function');
  const expected=await f.redis.readRaw(['brain:v6:activeRun',f.prefix+'shadow']);
  const input={runId:'entry-test',leaseToken:'lease',expected,writes:{[f.prefix+'shadow']:JSON.stringify({sequence:1})}};
  await f.redis.commitBrainObservation(input);
  await assert.rejects(()=>f.redis.commitBrainObservation(input),/changed/i);
  await assert.rejects(async()=>f.redis.commitBrainObservation({...input,expected:await f.redis.readRaw(Object.keys(expected)),writes:{'user:portfolio':'{}'}}),/forbidden|write/i);
  await f.redis.set('portfolio:write-lock:ai','new-lease',{ex:30});
  await assert.rejects(async()=>f.redis.commitBrainObservation({...input,expected:await f.redis.readRaw(Object.keys(expected))}),/lease/i);
});

test('protective exits remain atomic during an entry freeze and cannot duplicate their cash credit',async()=>{
  const f=await fixture();await f.redis.set('brain:v6:migration-freeze','reset',{ex:30});
  const financial={kind:'EXIT' as const,portfolio:JSON.stringify({usd:9989,openPositions:{}}),trades:[JSON.stringify({id:'exit-one',asset:'BTC',action:'SELL',brainRunId:'entry-test'})],events:[{id:'exit:one',event:JSON.stringify({id:'exit:one',type:'EXIT_FILLED'})}]};
  const input={...f.input,...financial,receipt:store.brainEntryReceipt(financial)};
  await f.redis.commitBrainEntry(input);await f.redis.commitBrainEntry(input);
  assert.equal((await f.redis.get<{usd:number}>(f.prefix+'portfolio'))?.usd,9989);
  assert.equal((await f.redis.lrange(f.prefix+'trades',0,-1)).length,1);
});
