import test from 'node:test';
import assert from 'node:assert/strict';
import * as marks from '@/lib/trading/positionValuation';
import { livePortfolioGain } from '@/lib/ui/livePortfolioGain';
import { getConfiguredInstrument } from '@/lib/trading/instrumentRegistry';

const position={asset:'BTC',instrument:getConfiguredInstrument('BTC'),direction:'LONG',amount:2,
  usdInvested:200,entryPrice:100,entryTime:new Date().toISOString(),entryFeePaid:5,
  lastMarkPrice:80,lastMarkAt:new Date().toISOString()};
const portfolio={usd:9795,openPositions:{BTC:position},scalpPositions:{}};
const outage=async()=>{throw new Error('fixture unavailable');};

test('status retains a real marked loss when live price synchronization fails',async()=>{
  const calculate=(marks as any).calculateAccountValue;
  assert.equal(typeof calculate,'function');
  const result=await calculate(portfolio,outage);
  const mark=marks.modeledPositionMark('BTC',position,80);
  assert.equal(result.totalValue,9795+(200+mark.grossPnl-mark.exitFee-mark.carryCost));
  assert.ok(result.totalValue<9955,'an outage cannot reset the losing position to cost');
  assert.equal(result.valuations,null);
  assert.equal(livePortfolioGain(result.totalValue,10000,result.valuations,{}).live,false);
});

test('a held position without any usable mark has unknown total gain',async()=>{
  const calculate=(marks as any).calculateAccountValue;
  assert.equal(typeof calculate,'function');
  const result=await calculate({...portfolio,openPositions:{BTC:{...position,lastMarkPrice:undefined}}},outage);
  assert.equal(result.totalValue,null);
  assert.equal(livePortfolioGain(result.totalValue,10000,result.valuations,{}).gain,null);
});

test('fresh status marks both position types exactly once and exposes live coefficients',async()=>{
  const calculate=(marks as any).calculateAccountValue;
  assert.equal(typeof calculate,'function');
  let calls=0;
  const result=await calculate({...portfolio,scalpPositions:{BTC:{...position,amount:1,usdInvested:100}}},async()=>{calls++;return 110;});
  const a=marks.modeledPositionMark('BTC',position,110),b=marks.modeledPositionMark('BTC',{...position,amount:1},110);
  assert.equal(result.totalValue,9795+(200+a.grossPnl-a.exitFee-a.carryCost)+(100+b.grossPnl-b.exitFee-b.carryCost));
  assert.equal(calls,1);assert.equal(result.valuations.length,2);
});
