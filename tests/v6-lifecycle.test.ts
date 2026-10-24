import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRedis } from './helpers/memoryRedis';
import { setRedisClient } from '../src/lib/redis';
import { PortfolioManager } from '../src/lib/portfolio';
import { MarketService } from '../src/lib/market';
import { SwingEngine } from '../src/lib/swingEngine';
import { sweepSwingExits } from '../src/lib/execution/swingLifecycle';
import { getConfiguredInstrument, validateBybitMetadata } from '../src/lib/trading/instrumentRegistry';
import { evidenceInstrument } from './helpers/fakeBybitMarket';
import { buildPositionOutcomes } from '../src/lib/trading/positionOutcomes';
import { freezeBrainCosts } from '../src/lib/strategy/v6/evidence';
import { liveFundingDeps } from '../src/lib/data/bybitPublic';
import { runReplacementWatchdog,runReplacementFunding } from '../src/daemon/replacementSwingDaemon';
import type { OpenPosition,Portfolio } from '../src/lib/types';

async function world(t:test.TestContext,price:number){
  const cwd=process.cwd(),dir=mkdtempSync(path.join(os.tmpdir(),'v6-exits-'));process.chdir(dir);
  const redis=new MemoryRedis();setRedisClient(redis);
  const now=Date.now(),instrument=getConfiguredInstrument('BTC'),market={price,bid:price*.9999,ask:price*1.0001,markPrice:price};
  const quote=mock.method(MarketService,'getCurrentPriceSnapshot',async()=>{const at=Date.now();return {...market,provider:'BYBIT_LINEAR_HTTP',source:'HTTP' as const,transport:'REST' as const,venue:'BYBIT_LINEAR',instrument:instrument.symbol,instrumentVersion:instrument.instrumentVersion,
    updatedAt:new Date(at).toISOString(),eventTimeMs:at,receivedAtMs:at,indexPrice:market.markPrice,quoteTimes:{lastPriceMs:at,bidAskMs:at,markMs:at}};});
  const metadata=mock.method(MarketService,'getInstrumentMetadata',async()=>validateBybitMetadata(instrument.symbol,evidenceInstrument(instrument.symbol),Date.now()));
  const baseInterval=mock.method(liveFundingDeps,'intervalMinutes',async()=>480),baseSettlements=mock.method(liveFundingDeps,'settlements',async()=>[]);
  t.after(()=>{quote.mock.restore();metadata.mock.restore();baseInterval.mock.restore();baseSettlements.mock.restore();setRedisClient(null);process.chdir(cwd);});
  const p=await PortfolioManager.resetPortfolio('ai',10000);
  const pos:OpenPosition={asset:'BTC',entryPrice:100,amount:1,btcAmount:1,usdInvested:100,stopLoss:90,takeProfit:130,entryTime:new Date(now-3600000).toISOString(),signalScore:0,reasoning:'test',direction:'LONG',
    highestPriceReached:100,lowestPriceReached:100,strategyType:'swing',instrument,brainRunId:'exit-run',brainCosts:freezeBrainCosts('BTC'),
    brainPolicy:{version:'v6',strategyId:'fixture',configHash:'fixture',initialAtr:5,priceRDistance:10,targetR:3,trailActivationR:2,trailAtr:2,maxHoldMs:86400000}};
  p.openPositions={BTC:pos};return {p,pos,redis,market};
}
async function transaction(f:Awaited<ReturnType<typeof world>>){
  await f.redis.set('brain:v6:activeRun',{runId:'exit-run'});await f.redis.set('brain:v6:run:exit-run:ledgerAcknowledged',true);
  await f.redis.set('portfolio:write-lock:ai','exit-lease',{ex:30});await PortfolioManager.updatePortfolio(f.p,'ai');
  return {runId:'exit-run',leaseToken:'exit-lease',expected:await f.redis.readRaw(['brain:v6:activeRun','brain:v6:run:exit-run:portfolio'])};
}
test('v6 AI winner keeps its frozen stop before 2R without legacy partials, scale-ins or thesis checks',async t=>{
  const f=await world(t,119);
  const legacy=mock.method(SwingEngine,'analyze',async()=>{throw new Error('v6 called legacy brain');});
  t.after(()=>legacy.mock.restore());
  const result=await sweepSwingExits(f.p,{portfolioType:'ai',checkSignalReversal:true,brainTransaction:await transaction(f)});
  assert.equal(result.errors,0);assert.equal(f.pos.stopLoss,90);assert.equal(f.pos.amount,1);assert.equal(result.partialExits,0);assert.equal(result.scaledIn,0);
  assert.equal(legacy.mock.callCount(),0);
});

test('forced reduce-only stages capacity-limited legs while frozen and completes one whole position with conserved cash and fees',async t=>{
  const f=await world(t,100);f.pos.positionId='staged-proof';f.pos.initialRiskUsdt=10;f.pos.entryFeePaid=.055;
  f.pos.entryExecutionCostUsd=.08;f.pos.brainFundingIntervalMinutes=480;
  f.pos.quantityLegs=[{atMs:Date.parse(f.pos.entryTime),quantityDelta:1}];
  f.p.usd=9899.945;f.p.totalFeesPaid=.055;f.p.balances.BTC=1;f.p.btc=1;f.p.openPosition=f.pos;
  const interval=mock.method(liveFundingDeps,'intervalMinutes',async()=>480),settlements=mock.method(liveFundingDeps,'settlements',async()=>[]);
  let turnover=5000;
  const liquidity=mock.method(MarketService,'getLiquiditySnapshot',async()=>({bestBid:f.market.bid,bestAsk:f.market.ask,
    bids:[[f.market.bid,10000] as [number,number]],asks:[[f.market.ask,10000] as [number,number]],turnover24hUsdt:turnover,observedAtMs:Date.now()}));
  t.after(()=>{interval.mock.restore();settlements.mock.restore();liquidity.mock.restore();});
  const context=await transaction(f);await f.redis.set('swing:entryFreeze',{reason:'DRAWDOWN'});
  const first=await sweepSwingExits(f.p,{portfolioType:'ai',brainTransaction:context,forceReduceOnly:true});
  assert.equal(first.partialExits,1);assert.equal(first.closed,0);assert.equal(f.pos.amount,.5);
  assert.equal(f.pos.positionId,'staged-proof');assert.equal(f.pos.initialRiskUsdt,10);assert.equal(f.pos.brainOriginalMarginUsdt,100);
  assert.equal(f.pos.usdInvested,50);assert.equal(f.pos.entryFeePaid,.0275);assert.equal(f.p.totalTrades,0);
  let trades=(await f.redis.lrange('brain:v6:run:exit-run:trades',0,-1)).map(x=>JSON.parse(x));
  assert.equal(trades.length,1);assert.equal(trades[0].isPartialExit,true);
  assert.equal(buildPositionOutcomes({trades,openPositions:[f.pos]}).completed.length,0);
  turnover=1e9;
  // The pending reduction continues even after the caller's one-time force flag is gone.
  const second=await sweepSwingExits(f.p,{portfolioType:'ai',brainTransaction:context});
  assert.equal(second.closed,1);assert.equal(f.p.openPositions.BTC,undefined);assert.equal(f.p.openPosition,null);assert.equal(f.p.btc,0);assert.equal(f.p.balances.BTC,0);
  trades=(await f.redis.lrange('brain:v6:run:exit-run:trades',0,-1)).map(x=>JSON.parse(x));
  assert.equal(trades.length,2);assert.equal(trades.reduce((s,x)=>s+x.amount,0),1);
  assert.equal(trades.filter(x=>!x.isPartialExit).length,1);assert.equal(f.p.totalTrades,1);
  assert.ok(Math.abs(trades.reduce((s,x)=>s+x.entryFeeUsd,0)-.055)<1e-12);
  const net=trades.reduce((s,x)=>s+x.pnl,0),fees=.055+trades.reduce((s,x)=>s+x.exitFeeUsd,0);
  assert.ok(Math.abs(f.p.usd-(10000+net))<1e-8);assert.ok(Math.abs(f.p.totalPnl-net)<1e-10);
  assert.ok(Math.abs(f.p.totalFeesPaid-fees)<1e-10);assert.ok(Math.abs(f.p.returns[0]-net)<1e-10);
  assert.equal((await f.redis.scanKeys('brain:v6:run:exit-run:outbox:brain-exit:*')).length,2);
  assert.equal((await f.redis.lrange('user:trades',0,-1)).length,0);
  const cash=f.p.usd;await sweepSwingExits(f.p,{portfolioType:'ai',brainTransaction:context,forceReduceOnly:true});assert.equal(f.p.usd,cash);
});

test('forced reduction queues zero capacity and below-minimum dust without inventing a fill or abandoning the position',async t=>{
  const f=await world(t,100);f.pos.positionId='queued-proof';
  let turnover=0;
  const liquidity=mock.method(MarketService,'getLiquiditySnapshot',async()=>({bestBid:f.market.bid,bestAsk:f.market.ask,
    bids:[[f.market.bid,1000] as [number,number]],asks:[[f.market.ask,1000] as [number,number]],turnover24hUsdt:turnover,observedAtMs:Date.now()}));
  t.after(()=>liquidity.mock.restore());const context=await transaction(f),cash=f.p.usd;
  for(const capacity of [0,10]){
    turnover=capacity;await sweepSwingExits(f.p,{portfolioType:'ai',brainTransaction:context,forceReduceOnly:true});
    assert.equal(f.pos.amount,1);assert.equal(f.p.usd,cash);assert.equal((await f.redis.lrange('brain:v6:run:exit-run:trades',0,-1)).length,0);
    assert.equal(f.pos.brainReductionPending,true);assert.match(f.pos.scaleInBlockedReason??'',/QUEUED/);
  }
});

test('executable bid crossing the stop triggers exit even when last trade remains above it and equity uses mark price',async t=>{
  const f=await world(t,100.1);f.market.bid=99.9;f.market.ask=100.3;f.market.markPrice=98;
  f.pos.stopLoss=100;f.pos.positionId='spread-proof';
  const liquidity=mock.method(MarketService,'getLiquiditySnapshot',async()=>({bestBid:f.market.bid,bestAsk:f.market.ask,
    bids:[[f.market.bid,10000] as [number,number]],asks:[[f.market.ask,10000] as [number,number]],turnover24hUsdt:1e9,observedAtMs:Date.now()}));
  t.after(()=>liquidity.mock.restore());const result=await sweepSwingExits(f.p,{portfolioType:'ai',brainTransaction:await transaction(f)});
  assert.equal(result.closed,1);assert.equal(f.pos.lastMarkPrice,98);
  const [close]=(await f.redis.lrange('brain:v6:run:exit-run:trades',0,-1)).map(x=>JSON.parse(x));assert.ok(close.price<=f.market.bid);
});
test('v6 AI trails using immutable entry ATR and R distance after 2R',async t=>{
  const f=await world(t,125);
  const result=await sweepSwingExits(f.p,{portfolioType:'ai',brainTransaction:await transaction(f)});
  assert.equal(result.errors,0);assert.ok(Math.abs(f.pos.stopLoss-114.9875)<1e-8);assert.equal(f.pos.highestPriceReached,124.9875);
  assert.equal(f.pos.amount,1);assert.equal(result.partialExits,0);assert.equal(result.scaledIn,0);
});
test('v6 fields never hijack the human exit policy',async t=>{
  const f=await world(t,119);
  const legacy=mock.method(SwingEngine,'analyze',async()=>{throw new Error('human still calls legacy');});
  t.after(()=>legacy.mock.restore());
  const human=structuredClone(f.p) as Portfolio;
  const result=await sweepSwingExits(human,{portfolioType:'user',checkSignalReversal:true});
  assert.equal(legacy.mock.callCount(),1);assert.equal(result.errors,1);
});

test('v6 protective close conserves one scoped cash credit and retains actual exit/cost evidence',async t=>{
  const f=await world(t,135);f.pos.instrument=getConfiguredInstrument('BTC');f.pos.positionId='closed-proof';f.pos.entryFeePaid=.055;
  f.pos.brainFundingIntervalMinutes=480;
  const interval=mock.method(liveFundingDeps,'intervalMinutes',async()=>480),settlements=mock.method(liveFundingDeps,'settlements',async()=>[]);
  const liquidity=mock.method(MarketService,'getLiquiditySnapshot',async()=>({bestBid:134.99,bestAsk:135.01,bids:[[134.99,10000] as [number,number]],asks:[[135.01,10000] as [number,number]],turnover24hUsdt:1e9,observedAtMs:Date.now()}));
  t.after(()=>{interval.mock.restore();settlements.mock.restore();liquidity.mock.restore();});
  const context=await transaction(f);
  const result=await sweepSwingExits(f.p,{portfolioType:'ai',brainTransaction:context});
  assert.equal(result.closed,1);assert.equal(f.p.openPositions.BTC,undefined);
  const saved=await f.redis.get<Portfolio>('brain:v6:run:exit-run:portfolio');assert.equal(saved?.usd,f.p.usd);
  const trades=await f.redis.lrange('brain:v6:run:exit-run:trades',0,-1);assert.equal(trades.length,1);
  const close=JSON.parse(trades[0]);assert.ok(close.brainExitObservation?.sourceHash);assert.ok(close.brainStressedExit.feeUsdt>close.exitFeeUsd);
  assert.equal((await f.redis.scanKeys('brain:v6:run:exit-run:outbox:*')).length>=1,true);
  assert.equal((await f.redis.lrange('ai:trades',0,-1)).length,0);
  const cash=f.p.usd;await sweepSwingExits(f.p,{portfolioType:'ai',brainTransaction:context});assert.equal(f.p.usd,cash);
});

test('the protective watchdog latches marked drawdown and starts reducing before another entry scan',async t=>{
  const f=await world(t,80);f.pos.positionId='floor-proof';f.pos.amount=100;f.pos.btcAmount=100;f.pos.stopLoss=50;
  f.pos.quantityLegs=[{atMs:Date.now()-86400000,quantityDelta:100}];f.pos.brainFundingIntervalMinutes=480;
  f.pos.brainPolicy!.priceRDistance=50;f.p.usd=9900;f.p.balances.BTC=100;f.p.peakValue=10000;
  const liquidity=mock.method(MarketService,'getLiquiditySnapshot',async()=>({bestBid:f.market.bid,bestAsk:f.market.ask,bids:[[f.market.bid,100000] as [number,number]],asks:[[f.market.ask,100000] as [number,number]],turnover24hUsdt:1e10,observedAtMs:Date.now()}));
  t.after(()=>liquidity.mock.restore());await transaction(f);await f.redis.del('portfolio:write-lock:ai');
  await runReplacementWatchdog();
  assert.equal((liveFundingDeps.intervalMinutes as any).mock.callCount(),0,'funding transport cannot delay the protective loop');
  assert.equal((await f.redis.get<Portfolio>('brain:v6:run:exit-run:portfolio'))?.openPositions.BTC,undefined);
  assert.equal((await f.redis.get<any[]>('brain:v6:run:exit-run:breakers'))?.some(l=>l.kind==='DRAWDOWN'),true);
});

test('funding fetches outside the lease, commits once to fresh state and accepts a full-length position identity',async t=>{
  const f=await world(t,100),at=Math.floor(Date.now()/(8*3600000))*8*3600000;
  f.pos.positionId='v6:'+'x'.repeat(80)+':'+'y'.repeat(64);f.pos.entryTime=new Date(at-3600000).toISOString();
  f.pos.quantityLegs=[{atMs:at-3600000,quantityDelta:1}];f.pos.brainFundingIntervalMinutes=480;
  let requests=0;
  const settlement=mock.method(liveFundingDeps,'settlements',async()=>{requests++;assert.equal(await f.redis.get('portfolio:write-lock:ai'),null);
    return [{symbol:'BTCUSDT',settlementTimeMs:at,rate:.001,markPrice:100}];});
  t.after(()=>settlement.mock.restore());await transaction(f);await f.redis.del('portfolio:write-lock:ai');
  await runReplacementFunding();const saved=(await f.redis.get<Portfolio>('brain:v6:run:exit-run:portfolio'))!;
  assert.equal(saved.usd,9999.9);assert.deepEqual(saved.openPositions.BTC.fundingSettledTimes,[at]);
  assert.equal(saved.brainFundingObservations?.[f.pos.positionId]?.length,1);
  assert.equal((await f.redis.scanKeys('brain:v6:run:exit-run:outbox:*')).length,1);
  await runReplacementFunding();assert.equal(requests,1);assert.equal((await f.redis.get<Portfolio>('brain:v6:run:exit-run:portfolio'))?.usd,saved.usd);
});
