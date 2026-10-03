import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runReplay } from '@/lib/backtest/replayEngine';
import type { Candle } from '@/lib/types';

const candles: Candle[] = Array.from({ length: 200 }, (_, i) => ({ time: 1700000100 + i * 900,
  open: 100, high: 101, low: 99, close: 100, volume: 100 }));
test('recorded crypto replay reports unavailable flow and trigger evidence instead of a measured zero-fill result', () => {
  const report = runReplay({ assets: { BTC: candles }, recordedSnapshots: { BTC: [] } } as any);
  assert.equal((report as any).assetCoverage.BTC.status, 'NOT_TESTABLE');
  assert.ok((report as any).assetCoverage.BTC.reasons.includes('MISSING_1M_5M_TRIGGER_HISTORY'));
  assert.ok((report as any).assetCoverage.BTC.reasons.includes('MISSING_HISTORICAL_FLOW'));
  assert.equal(report.acceptance.passed, false);
});
test('recorded snapshots never borrow future depth or stale orderbook evidence', async () => {
  const replay = await import('@/lib/backtest/replayEngine');
  const select = (replay as any).recordedSnapshotAt;
  assert.equal(typeof select, 'function');
  const tape = [{ observedAtMs: 100000, sourceTimes:{quoteMs:100000,depthMs:100000,sensorsMs:100000},orderbookResult: { imbalanceRatio: 1.5 } },
    { observedAtMs: 130000, sourceTimes:{quoteMs:130000,depthMs:130000,sensorsMs:130000},orderbookResult: { imbalanceRatio: 0.5 } }];
  assert.equal(select(tape, 104000).orderbookResult.imbalanceRatio, 1.5);
  assert.equal(select(tape, 106000), null, 'the quote obeys its stricter 5-second freshness');
  assert.equal(select(tape, 120000), null, 'a book older than 15 seconds is unavailable');
  assert.equal(select(tape, 90000), null, 'a future observation is unavailable');
});
test('archive input keeps actual closed bars and normalizes recorded depth without inventing fast bars', async () => {
  const replay = await import('@/lib/backtest/replayEngine');
  const prepare = (replay as any).buildRecordedReplayInput;
  assert.equal(typeof prepare, 'function');
  const at = (candles.at(-1)!.time + 900) * 1000;
  const input = prepare([{ asset: 'BTC', recordedAtMs: at, candles: { '15m': [...candles,
    { ...candles[0], time: at / 1000 + 900 }], '4h': [{ ...candles[0], time: at / 1000 - 14400 }] },
    quote: { lastPrice: '100', bid1Price: '99', ask1Price: '101', eventTimeMs:at,receivedAtMs:at }, metadata: {},
    depth: { b: [['99', '4']], a: [['101', '2']],ts:at } }]);
  assert.equal(input.assets.BTC.length, 200);
  assert.equal(input.fastCandles.BTC.m1.length, 0);
  assert.equal(input.fastCandles.BTC.m5.length, 0);
  assert.equal(input.recordedSnapshots.BTC[0].orderbookResult.imbalanceRatio, 2);
  assert.equal(input.recordedSnapshots.BTC[0].quote.price, 100);
  assert.equal(input.higherTimeframeCandles.BTC.h4.length, 1);
  assert.equal(input.higherTimeframeCandles.BTC.h4[0].time, at / 1000 - 14400);
});
