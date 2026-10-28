import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MemoryRedis } from './helpers/memoryRedis';
import { setRedisClient } from '../src/lib/redis';
import { runCycle,runRebalance,runRiskSweep } from '../src/daemon/crossSectionalDaemon';
import { runEntryScan,runExitWatchdog } from '../src/daemon/swingDaemon';

test('default swing daemon command starts only the replacement entry path',()=>{
  const pkg=JSON.parse(readFileSync('package.json','utf8'));
  assert.equal(pkg.scripts['daemon:swing'],'tsx src/daemon/replacementSwingDaemon.ts');
});

test('legacy swing entry and watchdog cannot mutate an active replacement epoch',async()=>{
  const redis=new MemoryRedis();setRedisClient(redis);
  try{
    await redis.set('brain:v6:activeRun',{runId:'legacy-disabled'});
    await redis.set('brain:v6:run:legacy-disabled:portfolio',{usd:10000,openPositions:{},balances:{}});
    const before=await redis.readRaw(['brain:v6:run:legacy-disabled:portfolio','ai:portfolio','ai:trades']);
    await runEntryScan();await runExitWatchdog();
    assert.deepEqual(await redis.readRaw(Object.keys(before)),before);
    assert.equal((await redis.scanKeys('research:*')).length,0);
  }finally{setRedisClient(null);}
});
test('an active replacement epoch prevents XSEC cycles, allocation and release from changing historical book state',async()=>{
  const redis=new MemoryRedis();setRedisClient(redis);
  try{
    await redis.set('brain:v6:activeRun',{runId:'historical-proof'});
    await redis.set('xsec:portfolio',{cashUsd:8123,positions:{},riskState:{state:'SHADOW'}});
    const before=await redis.readRaw(['xsec:portfolio','xsec:riskRelease','xsec:trades']);
    await runCycle();await runRebalance();await runRiskSweep(new Map());
    assert.deepEqual(await redis.readRaw(Object.keys(before)),before);
  }finally{setRedisClient(null);}
});
