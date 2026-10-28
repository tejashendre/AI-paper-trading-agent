import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle } from '../src/lib/types';
import type { PublicMarketRequest } from '../src/lib/strategy/v6/data';
import type { BrainDataset } from '../src/lib/strategy/v6/data';
import { evidenceInstrument } from './helpers/fakeBybitMarket';
import { validateBybitMetadata, getConfiguredInstrument } from '../src/lib/trading/instrumentRegistry';
import { evidenceHash, freezeBrainCosts } from '../src/lib/strategy/v6/evidence';
const H4 = 14_400_000, DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const moduleData = import('../src/lib/strategy/v6/data').catch(() => null);
const moduleReplay = import('../src/lib/strategy/v6/replay').catch(() => null);
const row = (at: number, close = 100) => [String(at), String(close), String(close+2), String(close-2), String(close), '10', '1000'];
test('runtime loader excludes forming/future bars and records actual receipt rather than bar close', async () => {
  const data = await moduleData;
  assert.ok(data, 'native loader is implemented');
  const request: PublicMarketRequest = async <T>(path: string) => ({ result: { list: path.includes('interval=D') ? [row(Math.floor(NOW/DAY)*DAY), row(Math.floor(NOW/DAY)*DAY-DAY)] : [row(NOW), row(NOW-H4), row(NOW-2*H4)] } as T, serverTimeMs: NOW+1 });
  const out = await data.loadBrainBars('BTC', NOW, {request, clock: () => NOW+20});
  assert.equal(out.h4.length, 2); assert.equal(out.d1.length, 1);
  assert.equal(out.h4AvailableAtMs, NOW+20); assert.equal(out.d1AvailableAtMs, NOW+20);
  assert.match(out.sourceHash, /^[a-f0-9]{64}$/);
});
test('native capture bounds pagination, rejects conflicting duplicate bars and does not invent old quote observations', async () => {
  const data = await moduleData; assert.ok(data);
  let calls = 0;
  const request: PublicMarketRequest = async <T>(path: string) => { calls++; return {result: {list: path.includes('funding/history') ? [] : [row(path.includes('interval=D')?Math.floor(NOW/DAY)*DAY-DAY:NOW-H4)]} as T, serverTimeMs: NOW}; };
  const captured = await data.captureBrainDataset({asset:'BTC',startMs:NOW-10*DAY,endMs:NOW,request,clock:()=>NOW,maxPages:2});
  assert.ok(calls <= 11); assert.deepEqual(captured.observations, []);
  assert.ok(captured.missing.includes('HISTORICAL_BID_ASK_DEPTH'));
  const tampered = structuredClone(captured); tampered.h4.push({...tampered.h4[0],close:123});
  assert.throws(() => data.verifyBrainDataset(tampered), /hash|duplicate|bar/i);
});

function scenarioDataset(asset:'BTC'|'ETH'|'SOL'='BTC'):BrainDataset {
 const h4=Array.from({length:160},(_,i)=>{const close=90+i*.06;return {time:(NOW-(160-i)*H4)/1000,open:close-.02,high:close+.8,low:close-.8,close,volume:10};});
 const signal=h4.at(-1)!;signal.close=h4.at(-2)!.high+.15;signal.high=signal.close+.15;
 const d1=Array.from({length:200},(_,i)=>{const close=80+i*.3;return {time:(Math.floor(NOW/DAY)*DAY-(200-i)*DAY)/1000,open:close-.02,high:close+.8,low:close-.8,close,volume:10};});
 const h1=Array.from({length:4},(_,i)=>({time:(NOW+i*3600000)/1000,open:100.5,high:i===3?120:101,low:100,close:i===3?115:100.5,volume:10}));
 const capturedAtMs=NOW+10*DAY,metadata=validateBybitMetadata(getConfiguredInstrument(asset).symbol,evidenceInstrument(getConfiguredInstrument(asset).symbol),capturedAtMs);
 const funding=[NOW-4*3600000,NOW+4*3600000].map(atMs=>({atMs,rate:.0001,mark:100.5,availableAtMs:capturedAtMs,sourceHash:'a'.repeat(64)}));
 const body={version:'v6-dataset-1' as const,asset,symbol:metadata.symbol,startMs:d1[0].time*1000,endMs:NOW+4*3600000,capturedAtMs,h4,d1,h1,receipts:[],observations:[] as never[],
  missing:['HISTORICAL_BID_ASK_DEPTH','HISTORICAL_CALENDAR_SNAPSHOTS','HISTORICAL_METADATA_INTERVAL_SCHEDULE'],metadata,costs:freezeBrainCosts(asset),funding};
 return {...body,sourceHash:evidenceHash(body)};
}

test('descriptive replay sizes a shared book, models later entries and closes with costs and actual funding',async()=>{
 const replay=await moduleReplay;assert.ok(replay);
 const report=replay.replaySwingV6({datasets:[scenarioDataset()],startMs:NOW,endMs:NOW+4*3600000}) as any;
 assert.equal(report.verdict,'NOT_TESTABLE');assert.deepEqual(report.trades,[]);assert.equal(report.ordersSubmitted,0);
 assert.ok(report.decisions.some((x:any)=>x.modeledStatus==='SETUP'));
 assert.equal(report.scenario.trades.length,1);
 const trade=report.scenario.trades[0];
 assert.ok(trade.openedAtMs>NOW);assert.ok(trade.entryPrice>100.5);assert.ok(trade.initialRiskUsdt<=25);
 assert.equal(trade.exitReason,'TARGET');assert.ok(trade.fundingCashflowUsdt<0);
 assert.ok(trade.stressedNetPnlUsdt<trade.netPnlUsdt);assert.ok(trade.entryFeeUsdt>0&&trade.exitFeeUsdt>0);
 assert.equal(report.scenario.metadataPolicy,'CURRENT_METADATA_FROZEN_FOR_SCENARIO');
 assert.equal(report.scenario.promotionEvidence,false);
});

test('scenario allocation and outcomes are invariant to asset input order and obey the account caps',async()=>{
 const replay=await moduleReplay;assert.ok(replay);
 const datasets=[scenarioDataset('BTC'),scenarioDataset('ETH'),scenarioDataset('SOL')];
 const a=replay.replaySwingV6({datasets,startMs:NOW,endMs:NOW+4*3600000}) as any;
 const b=replay.replaySwingV6({datasets:[...datasets].reverse(),startMs:NOW,endMs:NOW+4*3600000}) as any;
 assert.deepEqual(a.scenario.trades,b.scenario.trades);
 assert.ok(a.scenario.maxOpenRiskUsdt<=200);assert.ok(a.scenario.maxGrossNotionalUsdt<=25000);assert.ok(a.scenario.maxMarginUsdt<=4000);
});

test('native capture retains current metadata, real funding rates and exact settlement opening marks',async()=>{
 const data=await moduleData;assert.ok(data);
 const request:PublicMarketRequest=async<T>(p:string)=>({serverTimeMs:NOW+DAY,result:{list:p.includes('instruments-info')?[evidenceInstrument('BTCUSDT')]:p.includes('funding/history')?
  [{fundingRateTimestamp:String(NOW-4*3600000),fundingRate:'.0002'}]:p.includes('mark-price-kline')?[[String(NOW-4*3600000),'101','103','99','102']]:[]} as T});
 const captured=await data.captureBrainDataset({asset:'BTC',startMs:NOW-DAY,endMs:NOW,includeH1:true,request,clock:()=>NOW+DAY,maxPages:2});
 assert.equal(captured.metadata?.verifiedAtMs,NOW+DAY);assert.equal(captured.metadata?.symbol,'BTCUSDT');
 assert.equal(captured.funding?.[0].rate,.0002);assert.equal(captured.funding?.[0].mark,101);
 assert.ok(captured.missing.includes('HISTORICAL_METADATA_INTERVAL_SCHEDULE'));
 assert.equal(data.verifyBrainDataset(captured).sourceHash,captured.sourceHash);
});

test('funding at the capture end retains its boundary mark without substituting a later close',async()=>{
 const data=await moduleData;assert.ok(data);
 const request:PublicMarketRequest=async<T>(p:string)=>({serverTimeMs:NOW+DAY,result:{list:p.includes('instruments-info')?[evidenceInstrument('BTCUSDT')]:p.includes('funding/history')?
  [{fundingRateTimestamp:String(NOW),fundingRate:'.0002'}]:p.includes('mark-price-kline')?[[String(NOW),'101','103','99','102']]:[]} as T});
 const captured=await data.captureBrainDataset({asset:'BTC',startMs:NOW-DAY,endMs:NOW,request,clock:()=>NOW+DAY,maxPages:2});
 assert.equal(captured.funding?.[0].mark,101);
 assert.equal(data.verifyBrainDataset(captured).sourceHash,captured.sourceHash);
});

test('a bounded settlement-mark refresh retains source receipts and never invents a missing quote',async()=>{
 const data=await moduleData;assert.ok(data);
 const dataset=scenarioDataset();dataset.funding![1].mark=null;
 const {sourceHash,...body}=dataset;dataset.sourceHash=evidenceHash(body);
 const refreshed=await data.completeBrainFundingMarks(dataset,{clock:()=>dataset.capturedAtMs+1,
  request:async<T>(p:string)=>({serverTimeMs:dataset.capturedAtMs+1,result:{list:p.includes(`start=${dataset.funding![1].atMs}`)?[[String(dataset.funding![1].atMs),'102','103','99','101']]:[]} as T})});
 assert.equal(refreshed.funding![1].mark,102);assert.notEqual(refreshed.sourceHash,sourceHash);
 assert.ok(refreshed.receipts.some(r=>r.path.includes('mark-price-kline')));
 assert.equal(data.verifyBrainDataset(refreshed).sourceHash,refreshed.sourceHash);
});
test('same-bar target and stop ambiguity resolves adversely, including short gaps', async () => {
  const replay = await moduleReplay; assert.ok(replay, 'offline replay is implemented');
  const policy = {version:'v6' as const,strategyId:'test',configHash:'test',initialAtr:5,priceRDistance:10,targetR:3,trailActivationR:2,trailAtr:2,maxHoldMs:10*DAY};
  const bar:Candle={time:NOW/1000,open:100,high:135,low:85,close:120,volume:1};
  const out=replay.replayExitBar({policy,direction:'LONG',entryPrice:100,stopLoss:90,openedAtMs:NOW,nowMs:NOW+H4,watermark:100},bar);
  assert.equal(out.reason,'STOP'); assert.equal(out.exitPrice,90);
  const short=replay.replayExitBar({policy,direction:'SHORT',entryPrice:100,stopLoss:110,openedAtMs:NOW,nowMs:NOW+H4,watermark:100},{...bar,open:115,high:120,low:65});
  assert.equal(short.reason,'STOP'); assert.equal(short.exitPrice,115);
});
test('trail activated inside an ambiguous bar cannot pretend its later adverse extreme happened first',async()=>{
 const replay=await moduleReplay;assert.ok(replay);
 const input={policy:{version:'v6' as const,strategyId:'t',configHash:'t',initialAtr:5,priceRDistance:10,targetR:3,trailActivationR:2,trailAtr:2,maxHoldMs:DAY},direction:'LONG' as const,entryPrice:100,stopLoss:90,openedAtMs:NOW,nowMs:NOW+H4,watermark:100};
 const out=replay.replayExitBar(input,{time:NOW/1000,open:100,high:125,low:95,close:120,volume:1});
 assert.equal(out.reason,'TRAILING'); assert.equal(out.exitPrice,115);
});

test('time exit inside an hourly bar uses a conservative price bound rather than its earlier open',async()=>{
 const replay=await moduleReplay;assert.ok(replay);
 const policy={version:'v6' as const,strategyId:'t',configHash:'t',initialAtr:5,priceRDistance:10,targetR:3,trailActivationR:2,trailAtr:2,maxHoldMs:1800000};
 const result=replay.replayExitBar({policy,direction:'LONG',entryPrice:100,stopLoss:90,openedAtMs:NOW,nowMs:NOW+3600000,watermark:100},
  {time:NOW/1000,open:100,high:105,low:95,close:101,volume:1});
 assert.equal(result.reason,'TIME');assert.equal(result.exitPrice,95);
});
test('funding includes settlement at exit, excludes entry boundary and refuses missing actual mark',async()=>{
 const replay=await moduleReplay;assert.ok(replay);
 const openedAtMs=NOW-4*3600000,closedAtMs=NOW+4*3600000;
 const rates=[{atMs:openedAtMs,rate:.01,mark:100,availableAtMs:openedAtMs,sourceHash:'a'.repeat(64)},{atMs:closedAtMs,rate:.01,mark:100,availableAtMs:closedAtMs,sourceHash:'b'.repeat(64)}];
 const out=replay.replayFunding({openedAtMs,closedAtMs,intervalMinutes:480,direction:'LONG',quantity:2,settlements:rates});
 assert.equal(out.cashflowUsdt,-2);assert.deepEqual(out.missingTimes,[]);
 assert.deepEqual(replay.replayFunding({openedAtMs,closedAtMs,intervalMinutes:480,direction:'LONG',quantity:2,settlements:[{...rates[1],mark:null}]}).missingTimes,[closedAtMs]);
});
test('backfilled candles alone produce NOT_TESTABLE and zero shadow capital or fabricated fills',async()=>{
 const data=await moduleData;const replay=await moduleReplay;assert.ok(data);assert.ok(replay);
 const request:PublicMarketRequest=async<T>()=>({result:{list:[]} as T,serverTimeMs:NOW});
 const dataset=await data.captureBrainDataset({asset:'BTC',startMs:NOW-DAY,endMs:NOW,request,clock:()=>NOW,maxPages:1});
 const out=replay.replaySwingV6({datasets:[dataset],startMs:NOW-DAY,endMs:NOW});
 assert.equal(out.verdict,'NOT_TESTABLE');assert.equal(out.eligible,false);assert.equal(out.capitalAllocatedUsdt,0);assert.equal(out.ordersSubmitted,0);assert.deepEqual(out.trades,[]);
 assert.ok(out.reasons.includes('HISTORICAL_BID_ASK_DEPTH'));
});
