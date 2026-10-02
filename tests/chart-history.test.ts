import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketService, setMarketServiceDeps } from '@/lib/market';
import * as history from '@/lib/ui/chartHistory';
import { klineRows, makeFakeBybit, SERVER_NOW } from './helpers/fakeBybitMarket';
import { GET } from '@/app/api/chart/route';
import { PortfolioManager } from '@/lib/portfolio';

test('chart pages go back beyond a single batch without touching live caches', async () => {
  const fake = makeFakeBybit();
  const restore = setMarketServiceDeps({ ...fake.deps, bybitGet: async <T>(requestPath: string) => {
    fake.calls.push(requestPath);
    const url = new URL(requestPath, 'https://api.bybit.com');
    const end = Number(url.searchParams.get('end') || SERVER_NOW);
    return { result: { list: klineRows('BTCUSDT', '60', 1000, end) } as T, serverTimeMs: SERVER_NOW };
  }});
  try {
    let before: number | undefined;
    const times = new Set<number>();
    for (let i = 0; i < 5; i++) {
      const page = await MarketService.getChartCandlePage('1h', 1000, 'BTC', before);
      assert.equal(page.hasMore, true);
      assert.ok(page.candles.every(c => before === undefined || c.time * 1000 < before));
      for (const c of page.candles) { assert.equal(times.has(c.time), false); times.add(c.time); }
      before = page.nextBeforeMs!;
    }
    assert.ok(times.size > 4900);
    assert.equal(fake.calls.length, 5);
    assert.ok(fake.calls[1].includes('&end='));
    await assert.rejects(MarketService.getChartCandlePage('1h', 1001, 'BTC'), /Invalid/);
    await assert.rejects(MarketService.getChartCandlePage('1h', 1000, 'BTC', NaN), /Invalid/);
  } finally { restore(); }
});

test('history merge keeps pages on refresh and rolls toward older bars at its browser bound', () => {
  const candle = (time: number, close = time) => ({ time, open: 1, high: 2, low: 1, close, volume: 1 });
  assert.deepEqual(history.mergeChartCandles([candle(1), candle(2)], [candle(2, 42), candle(3)], 'latest', 3).map(c => [c.time, c.close]), [[1, 1], [2, 42], [3, 3]]);
  assert.deepEqual(history.mergeChartCandles([candle(3), candle(4)], [candle(1), candle(2)], 'older', 3).map(c => c.time), [1, 2, 3]);
});

test('historical timezone labels use each instant including daylight saving and half-hour offsets', () => {
  assert.equal(history.formatChartTime(Date.parse('2026-01-01T12:00:00Z') / 1000, 'Europe/Paris', 'clock'), '13:00');
  assert.equal(history.formatChartTime(Date.parse('2026-07-01T12:00:00Z') / 1000, 'Europe/Paris', 'clock'), '14:00');
  assert.equal(history.formatChartTime(Date.parse('2026-01-01T12:00:00Z') / 1000, 'Asia/Kolkata', 'clock'), '17:30');
});

test('chart HTTP validates cursors and keeps stale historical pages labeled for the requested asset', async () => {
  process.env.DASHBOARD_SECRET ||= 'test-only-chart-auth';
  const request = (query: string) => new Request(`http://localhost/api/chart?asset=GOLD&interval=4h&${query}`, { headers: { authorization: 'Bearer SPECTATOR' } });
  for (const query of ['limit=520garbage', 'limit=50.5', 'before=NaN', 'before=0', 'before=-1', 'before=9999999999999']) {
    assert.equal((await GET(request(query))).status, 400, query);
  }
  const fake = makeFakeBybit({ kline: (symbol, interval, limit) => klineRows(symbol, interval, limit, SERVER_NOW - 100 * 86400000) });
  const restore = setMarketServiceDeps(fake.deps);
  const originalTrades = PortfolioManager.getTrades;
  PortfolioManager.getTrades = async () => [];
  try {
    const response = await GET(request(`limit=1000&before=${SERVER_NOW - 90 * 86400000}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.asset, 'GOLD'); assert.equal(body.interval, '4h');
    assert.equal(body.historical, true); assert.equal(body.stale, true);
    assert.ok(body.candles.length > 900);
  } finally { restore(); PortfolioManager.getTrades = originalTrades; }
});
