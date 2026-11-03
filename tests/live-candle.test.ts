import test from 'node:test';
import assert from 'node:assert/strict';
import { foldLiveCandle, formatCountdown } from '../src/components/TradingChart';

test('the forming candle follows ticks and rolls over at the period boundary', () => {
  const bar = { time: 3600, open: 100, high: 101, low: 99, close: 100 };
  assert.deepEqual(foldLiveCandle(bar, 102, 3600_000 + 1_000, 3600), { time: 3600, open: 100, high: 102, low: 99, close: 102 });
  assert.deepEqual(foldLiveCandle(bar, 98, 7200_000, 3600), { time: 7200, open: 100, high: 100, low: 98, close: 98 });
  assert.equal(foldLiveCandle(bar, 102, 1_000, 3600), null, 'a tick older than the last candle is ignored');
  assert.equal(foldLiveCandle(null, 102, 3600_000, 3600), null);
  assert.equal(foldLiveCandle(bar, NaN, 3600_000, 3600), null);
});
test('the countdown shows time left until the candle closes', () => {
  assert.equal(formatCountdown(0, 60), '01:00');
  assert.equal(formatCountdown(59_000, 60), '00:01');
  assert.equal(formatCountdown(1_000, 14400), '3:59:59');
});
