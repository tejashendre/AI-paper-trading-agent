import test from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioManager } from '../src/lib/portfolio';
import { setRedisClient } from '../src/lib/redis';
import { MemoryRedis } from './helpers/memoryRedis';
import { ACTIVE_AI_RUN_KEY, aiRunKeys } from '../src/lib/admin/resetAiRun';
import type { Trade, Portfolio } from '../src/lib/types';
import { resetArena } from '../src/lib/admin/resetArena';

test('active AI epoch reads/writes only its own history while retaining old AI and human rows',async()=>{
  const redis=new MemoryRedis();setRedisClient(redis);
  try{
    const keys=aiRunKeys('routing-proof');
    await redis.set(ACTIVE_AI_RUN_KEY,{runId:'routing-proof'});
    await redis.lpush('ai:trades',JSON.stringify({id:'old-ai'}));
    await redis.lpush('user:trades',JSON.stringify({id:'human'}));
    assert.deepEqual(await PortfolioManager.getTrades('ai'),[]);
    await PortfolioManager.logTrade({id:'new-ai',asset:'BTC',timestamp:'2026-10-24T12:00:00Z',action:'BUY'} as Trade,'ai');
    assert.deepEqual((await PortfolioManager.getTrades('ai')).map(x=>x.id),['new-ai']);
    assert.equal(JSON.parse((await redis.lrange('ai:trades',0,-1))[0]).id,'old-ai');
    assert.equal(JSON.parse((await redis.lrange(keys.trades,0,-1))[0]).id,'new-ai');
    assert.deepEqual((await PortfolioManager.getTrades('user')).map(x=>x.id),['human']);
  }finally{setRedisClient(null);}
});

test('legacy arena reset refuses before mutating either account when a replacement epoch exists',async()=>{
  const redis=new MemoryRedis();setRedisClient(redis);
  try{
    await redis.set(ACTIVE_AI_RUN_KEY,{runId:'guard-proof'});
    await redis.set('user:portfolio',{usd:7777});
    await redis.set('ai:portfolio',{usd:9001});
    await assert.rejects(()=>resetArena({capital:10000,source:'TEST'}),/AI.only|replacement|epoch/i);
    assert.deepEqual(await redis.get('user:portfolio'),{usd:7777});
    assert.deepEqual(await redis.get('ai:portfolio'),{usd:9001});
    await assert.rejects(()=>PortfolioManager.resetPortfolio('ai',10000),/AI.only|replacement|epoch/i);
  }finally{setRedisClient(null);}
});
test('a missing active-run portfolio fails closed rather than creating fresh capital or restoring a legacy backup',async()=>{
  const redis=new MemoryRedis();setRedisClient(redis);
  try{
    await redis.set(ACTIVE_AI_RUN_KEY,{runId:'missing-proof'});
    await redis.set('ai:portfolio',{usd:12000});
    await assert.rejects(()=>PortfolioManager.getPortfolio('ai'),/active|run|epoch/i);
    assert.equal((await redis.get<{usd:number}>('ai:portfolio'))?.usd,12000);
  }finally{setRedisClient(null);}
});
test('AI portfolio updates keep the compatibility mirror and current-run record aligned',async()=>{
  const redis=new MemoryRedis();setRedisClient(redis);
  try{
    await redis.set(ACTIVE_AI_RUN_KEY,{runId:'update-proof'});
    await redis.set('user:portfolio',{usd:7777});
    const p={usd:9990,initialCapital:10000,balances:{},openPositions:{},scalpPositions:{}} as Portfolio;
    await PortfolioManager.updatePortfolio(p,'ai');
    assert.equal((await redis.get<Portfolio>(aiRunKeys('update-proof').portfolio))?.usd,9990);
    assert.equal((await redis.get<Portfolio>('ai:portfolio'))?.usd,9990);
    assert.deepEqual(await redis.get('user:portfolio'),{usd:7777});
  }finally{setRedisClient(null);}
});
