import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfiguredInstrument } from '@/lib/trading/instrumentRegistry';

const at = Date.parse('2026-01-02T00:00:00Z');
const candidate: any = { candidateId: 'signal', asset: 'USDJPY', instrument: getConfiguredInstrument('USDJPY'),
  family: 'TREND_PULLBACK', configHash: 'cfg', regime: 'TREND', direction: 'LONG', entryPrice: 150,
  stopPrice: 149, targetPrice: 153, featureCutoffMs: at, initialRiskUsdt: 1, mode: 'SHADOW', reasons: [] };
const bars = Array.from({length: 288}, (_, i) => ({ time: at / 1000 + i * 300,
  open: 150 + i / 200, high: 150.1 + i / 200, low: 149.9 + i / 200, close: 150 + i / 200, volume: 10 }));
test('candidate replay is causal, deterministic, linear and includes stress and signed actual funding', async () => {
  const r: any = await import('../src/lib/research/familyReplay').catch(() => ({}));
  assert.equal(typeof r.replayStrategyCandidate, 'function');
  const input = { candidate, bars, barIntervalMs: 300000, featureStartMs: at - 1000,
    labelEndMs: at + 86400000, fundingIntervalMinutes: 480, funding: [8,16,24].map(h => ({symbol:'USDJPYUSDT',
      settlementTimeMs: at + h * 3600000, rate: 0.0001, markPrice:150})), historicalCostsAvailable:false };
  const result = r.replayStrategyCandidate(input);
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result, r.replayStrategyCandidate(input));
  assert.deepEqual(result, r.replayStrategyCandidate({...input, bars: [...bars, {...bars[0], time: at / 1000 + 86400, close: 999}]}));
  const o = result.outcome;
  assert.ok(o.fundingCashflowUsdt < 0);
  assert.ok(o.feesUsdt > 0);
  assert.ok(o.grossPnlUsdt > 0);
  assert.equal(o.netPnlUsdt, o.grossPnlUsdt - o.feesUsdt + o.fundingCashflowUsdt);
  assert.ok(o.netPnlUsdt < o.grossPnlUsdt);
  assert.ok(o.stressedNetPnlUsdt <= o.netPnlUsdt);
  assert.equal(o.historicalCostsAvailable, false);
  assert.ok(result.assumptions.includes('BAR_RESOLUTION_LIMITATION'));
  const missing = r.replayStrategyCandidate({...input, funding:[]});
  assert.equal(missing.outcome.historicalCostsAvailable, false);
  assert.ok(missing.assumptions.includes('MISSING_FUNDING_SETTLEMENTS'));
  assert.equal(r.replayStrategyCandidate({...input, bars: bars.slice(0, 100)}).status, 'INSUFFICIENT_PATH');
});
