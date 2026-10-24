import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateBrainRisk, sizeBrainOrder, evaluateBrainBreakers, RiskRequest } from '../src/lib/strategy/v6/risk';
import { getConfiguredInstrument, validateBybitMetadata } from '../src/lib/trading/instrumentRegistry';
import { evidenceInstrument } from './helpers/fakeBybitMarket';
import type { SwingSetup } from '../src/lib/strategy/v6/engine';

const request = (asset: RiskRequest['asset'], id = asset): RiskRequest => ({ id, asset, riskUsdt: 25, notionalUsdt: 500, marginUsdt: 500 });
const input = (candidates: RiskRequest[]) => ({ equity: 10000, initialCapital: 10000, peakEquity: 10000, open: [], candidates });
test('v6 allocator preserves valid quarter-percent risk without a score', () => {
  const [a] = allocateBrainRisk(input([request('BTC')])); assert.equal(a.riskUsdt,25); assert.equal(a.scale,1);
});
test('simultaneous margin shortage shrinks every candidate proportionally and is input-order invariant', () => {
  const rows = ['BTC','ETH','SOL','EURUSD','GBPUSD','USDJPY','GOLD','SILVER','OIL'].map(a=>request(a as RiskRequest['asset']));
  const a=allocateBrainRisk(input(rows)),b=allocateBrainRisk(input([...rows].reverse()));
  assert.ok(Math.abs(a.reduce((s,x)=>s+x.marginUsdt,0)-4000)<1e-8);
  assert.ok(a.every(x=>Math.abs(x.scale-8/9)<1e-8));
  assert.deepEqual(a.map(x=>[x.id,x.riskUsdt]).sort(),b.map(x=>[x.id,x.riskUsdt]).sort());
});
test('a caller cannot request more than the initial tier and opposing FX sides do not bypass the gross cap', () => {
  const rows=[request('EURUSD'),request('GBPUSD'),request('USDJPY')].map(x=>({...x,riskUsdt:1000,notionalUsdt:1000,marginUsdt:100,riskTier:'ESCALATED' as const}));
  const a=allocateBrainRisk(input(rows)); assert.ok(Math.abs(a.reduce((s,x)=>s+x.riskUsdt,0)-100)<1e-8);
  assert.equal(allocateBrainRisk(input([{...request('BTC'),riskUsdt:1000}]))[0].riskUsdt,25);
});
test('existing risk, gross notional and remaining drawdown floor bind before another entry', () => {
  const a=allocateBrainRisk({...input([request('BTC')]),equity:9005,open:[{asset:'ETH',riskUsdt:4,notionalUsdt:100,marginUsdt:50}]});
  assert.ok(a[0].riskUsdt>0 && a[0].riskUsdt<=1+1e-8);
  assert.equal(allocateBrainRisk({...input([request('BTC')]),equity:9000})[0].riskUsdt,0);
  assert.equal(allocateBrainRisk({...input([request('BTC')]),peakEquity:12000})[0].riskUsdt,0);
  assert.equal(allocateBrainRisk({...input([request('BTC')]),halted:true})[0].riskUsdt,0);
});
test('nonfinite or negative balances/exposures fail closed', () => {
  assert.equal(allocateBrainRisk({...input([request('BTC')]),equity:NaN})[0].riskUsdt,0);
  assert.equal(allocateBrainRisk({...input([request('BTC')]),open:[{asset:'ETH',riskUsdt:-1,notionalUsdt:0,marginUsdt:0}]})[0].riskUsdt,0);
});
test('drawdown and loss-streak latches survive a clock timeout and a tiny intervening non-stop loss',()=>{
  const nowMs=Date.parse('2026-10-24T12:00:00Z');
  const outcomes=Array.from({length:4},(_,i)=>({asset:'BTC' as const,closedAtMs:nowMs-i*3600000,netPnlUsdt:-25,netR:-1,exitReason:'STOP'}));
  outcomes.splice(1,0,{...outcomes[0],closedAtMs:nowMs-1000,netPnlUsdt:-1,netR:-.04,exitReason:'TIME'});
  const a=evaluateBrainBreakers({equity:9500,initialCapital:10000,peakEquity:10000,nowMs,outcomes});
  assert.ok(a.latches.some(x=>x.scope==='account'&&x.kind==='STREAK'));
  const b=evaluateBrainBreakers({equity:10000,initialCapital:10000,peakEquity:10000,nowMs:nowMs+4*86400000,outcomes:[],previous:a.latches});
  assert.deepEqual(b.latches,a.latches);
  assert.ok(evaluateBrainBreakers({equity:9000,initialCapital:10000,peakEquity:10000,nowMs,outcomes:[]}).latches.some(x=>x.kind==='DRAWDOWN'));
});
test('replayed duplicate completion rows cannot manufacture a loss-streak halt',()=>{
  const nowMs=Date.parse('2026-10-24T12:00:00Z');
  const row={positionId:'one-position',asset:'BTC' as const,closedAtMs:nowMs-1000,netPnlUsdt:-25,netR:-1,exitReason:'STOP'};
  const result=evaluateBrainBreakers({equity:10000,initialCapital:10000,peakEquity:10000,nowMs,outcomes:[row,row,row,row]});
  assert.equal(result.latches.some(x=>x.kind==='STREAK'),false);
});
function order() {
  const nowMs=Date.parse('2026-10-24T12:00:00Z');
  const setup={id:'test',asset:'BTC',strategyId:'CRYPTO_TREND_BREAKOUT_V1',configHash:'fixed',direction:'LONG',entryPrice:60000,
    referencePrice:60000,stopLoss:58800,takeProfit:63600,atr:600,priceRDistance:1200,featureStartMs:nowMs-1e9,
    featureCutoffMs:nowMs,setupBarMs:nowMs-14400000,expiresAtMs:nowMs+300000,channel:null,
    policy:{version:'v6',strategyId:'CRYPTO_TREND_BREAKOUT_V1',configHash:'fixed',initialAtr:600,priceRDistance:1200,
      targetR:3,trailActivationR:2,trailAtr:2,maxHoldMs:10*86400000}} as SwingSetup;
  const metadata=validateBybitMetadata(getConfiguredInstrument('BTC').symbol,evidenceInstrument('BTCUSDT'),nowMs);
  return {setup,metadata,nowMs,riskBudgetUsdt:25,equity:10000,availableCash:10000,capacityNotionalUsdt:100000,halfSpreadBps:1,fundingRate:0.0001};
}
test('sizing includes maximum-hold payer funding, fees, adverse fills and lot rounding', () => {
  const a=sizeBrainOrder(order());assert.equal(a.approved,true,a.reason);assert.ok(a.quantity>0);
  assert.ok(a.initialRiskUsdt<=25+1e-8);assert.ok(a.fundingReserveUsdt>0);assert.ok(a.entryFeeUsdt>0);
  assert.ok(a.netRewardRisk>=1.5);assert.ok(a.marginUsdt<=1000);assert.ok(a.leverage<=5);assert.ok(a.costHash.length>=32);
});
test('stressed costs shrink quantity or refuse, while funding receivers never increase admitted size', () => {
  const a=sizeBrainOrder(order()),b=sizeBrainOrder({...order(),stressed:true});
  assert.ok(!b.approved||b.quantity<=a.quantity);assert.ok(sizeBrainOrder({...order(),fundingRate:-0.0001}).quantity<=a.quantity);
});
test('stale setup, wrong contract, missing spread, insufficient liquidity and subminimum sizes cannot trade', () => {
  assert.equal(sizeBrainOrder({...order(),nowMs:order().nowMs+300001}).approved,false);
  assert.equal(sizeBrainOrder({...order(),metadata:{...order().metadata,symbol:'ETHUSDT'}}).approved,false);
  assert.equal(sizeBrainOrder({...order(),halfSpreadBps:NaN}).approved,false);
  assert.equal(sizeBrainOrder({...order(),capacityNotionalUsdt:0}).approved,false);
  assert.equal(sizeBrainOrder({...order(),riskBudgetUsdt:0.001}).approved,false);
});
