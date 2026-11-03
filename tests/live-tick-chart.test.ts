import test from 'node:test';
import assert from 'node:assert/strict';
import { foldTick } from '../src/components/LiveTickChart';

test('ticks fold into 1-second OHLC bars and the window keeps only the last hour', () => {
  let bars = foldTick([], 100, 1_000_000);
  bars = foldTick(bars, 103, 1_000_400);
  bars = foldTick(bars, 99, 1_000_900);
  assert.deepEqual(bars, [{ time: 1000, open: 100, high: 103, low: 99, close: 99 }]);
  bars = foldTick(bars, 101, 1_001_100);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[1], { time: 1001, open: 99, high: 101, low: 99, close: 101 });
  assert.equal(foldTick(bars, 105, 999_000), bars, 'an out-of-order tick is ignored');
  assert.equal(foldTick(bars, NaN, 1_002_000), bars, 'an invalid price is ignored');
  const later = foldTick(bars, 102, 1_000_000 + 3601 * 1000);
  assert.deepEqual(later.map(b => b.time), [4601], 'bars older than 3600s are trimmed');
});
