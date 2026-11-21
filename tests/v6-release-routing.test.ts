import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MemoryRedis } from './helpers/memoryRedis';
import { setRedisClient } from '../src/lib/redis';
import { runCycle,runRebalance,runRiskSweep } from '../src/daemon/crossSectionalDaemon';

test('default swing daemon command starts only the replacement entry path',()=>{
  const pkg=JSON.parse(readFileSync('package.json','utf8'));
  assert.equal(pkg.scripts['daemon:swing'],'tsx src/daemon/replacementSwingDaemon.ts');
  const compose = readFileSync('docker-compose.yml', 'utf8');
  assert.match(compose, /command: \[\"node\", \"--import\"[^\r\n]*replacementSwingDaemon\.ts/);
  assert.match(compose, /stop_grace_period: 90s/);
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

test('shutdown stops scheduling and waits for an in-flight writer to release its own lease', async () => {
  const { createSwingDrain } = await import('../src/daemon/replacementSwingDaemon');
  const redis = new MemoryRedis();
  const key = 'portfolio:write-lock:ai';
  let finish!: () => void;
  const inflight = new Promise<void>(resolve => { finish = resolve; });
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const drain = createSwingDrain();
  drain.run(async () => {
    await redis.set(key, 'old-daemon', { nx: true, ex: 300 });
    acquired();
    try { await inflight; } finally { await redis.compareAndDelete(key, 'old-daemon'); }
  });
  await ready;
  const stopped = drain.stop();
  assert.equal(await redis.set(key, 'replacement', { nx: true, ex: 60 }), null);
  let scheduledAfterStop = false;
  drain.run(async () => { scheduledAfterStop = true; });
  finish();
  await stopped;
  assert.equal(scheduledAfterStop, false);
  assert.equal(await redis.set(key, 'replacement', { nx: true, ex: 60 }), 'OK');
});
