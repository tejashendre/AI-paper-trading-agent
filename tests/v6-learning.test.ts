import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLearningBook, learnedRisk, samplesFromTrades, LEARNING_HALF_LIFE_MS } from '../src/lib/strategy/v6/learning';
import type { Trade } from '../src/lib/types';

const NOW = Date.parse('2026-11-03T00:00:00Z');
const exit = (asset: string, pnl: number, risk: number, daysAgo: number, action: Trade['action'] = 'SELL'): Trade =>
  ({ id: `${asset}-${pnl}-${daysAgo}-${Math.random()}`, asset, action, pnl, initialRiskUsdt: risk, timestamp: new Date(NOW - daysAgo * 86400000).toISOString() } as Trade);

test('only closed legs with a real risk basis become R samples', () => {
  const s = samplesFromTrades([exit('BTC', 50, 25, 1), { ...exit('BTC', 10, 0, 1) }, { ...exit('BTC', 10, 25, 1), action: 'BUY' } as Trade, exit('ETH', -25, 25, 1, 'COVER')], 'V6');
  assert.equal(s.length, 2);
  assert.equal(s[0].r, 2); assert.equal(s[1].direction, 'SHORT'); assert.equal(s[1].r, -1);
});
test('winners scale risk up, losers scale down, and a clear losing record pauses the pair', () => {
  const winners = Array.from({ length: 10 }, (_, i) => exit('BTC', 50, 25, i));
  const losers = Array.from({ length: 12 }, (_, i) => exit('SOL', -25, 25, i));
  const book = buildLearningBook(samplesFromTrades([...winners, ...losers], 'V6'), NOW);
  const btc = learnedRisk(book, 'BTC', 'LONG'), sol = learnedRisk(book, 'SOL', 'LONG');
  assert.ok(btc.multiplier > 1 && btc.multiplier <= 1.5 && !btc.paused);
  assert.ok(sol.paused); assert.equal(sol.multiplier, 0);
  assert.deepEqual(learnedRisk(book, 'GOLD', 'SHORT'), { multiplier: 1, paused: false, reason: 'No history yet: base risk' });
});
test('shrinkage keeps a few trades from swinging allocation, and old or legacy results weigh less', () => {
  const few = buildLearningBook(samplesFromTrades([exit('BTC', -25, 25, 1), exit('BTC', -25, 25, 1)], 'V6'), NOW);
  assert.ok(!learnedRisk(few, 'BTC', 'LONG').paused);
  const old = buildLearningBook(samplesFromTrades(Array.from({ length: 12 }, () => exit('BTC', -25, 25, 4 * LEARNING_HALF_LIFE_MS / 86400000)), 'V6'), NOW);
  assert.ok(!learnedRisk(old, 'BTC', 'LONG').paused);
  const legacy = buildLearningBook(samplesFromTrades(Array.from({ length: 6 }, () => exit('BTC', -25, 25, 1)), 'LEGACY'), NOW);
  assert.ok(!learnedRisk(legacy, 'BTC', 'LONG').paused);
});
