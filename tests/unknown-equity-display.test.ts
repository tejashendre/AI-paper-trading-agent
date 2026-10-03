import test from 'node:test';
import assert from 'node:assert/strict';
import * as ui from '@/lib/ui/livePortfolioGain';

test('unknown equity never coerces to a total loss or zero margin utilization',()=>{
  const calculate=(ui as any).portfolioEquityMetrics;
  assert.equal(typeof calculate,'function');
  for(const total of [null,undefined,NaN]) assert.deepEqual(calculate(total,10000,200),
    {gain:null,returnPercent:null,marginPercent:null});
  assert.deepEqual(calculate(0,10000,200),{gain:-10000,returnPercent:-100,marginPercent:null});
  assert.deepEqual(calculate(10500,10000,210),{gain:500,returnPercent:5,marginPercent:2});
});
