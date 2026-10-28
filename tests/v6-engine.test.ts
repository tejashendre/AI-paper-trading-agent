import assert from 'node:assert/strict';
import test from 'node:test';
import { brainDefinition, decideBrainExit, evaluateBrain, type BrainSnapshot, type CalendarManifest, type CalendarRelease, type SwingSetup } from '../src/lib/strategy/v6/engine';
import { strategySessionAllowed, validateCalendar } from '../src/lib/strategy/v6/calendar';
import { getConfiguredInstrument, type ConfiguredAsset } from '../src/lib/trading/instrumentRegistry';
import type { Candle } from '../src/lib/types';

const H4 = 14_400_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const URLS: Record<CalendarRelease, string> = {
  FED: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  US_CPI: 'https://www.bls.gov/schedule/2026/home.htm',
  US_PAYROLLS: 'https://www.bls.gov/schedule/2026/home.htm',
  ECB: 'https://www.ecb.europa.eu/press/govcdec/mopo/html/index.en.html',
  BOE: 'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates',
  BOJ: 'https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm',
  EIA_WPSR: 'https://www.eia.gov/reports/upcoming.php',
};

function calendar(nowMs = NOW): CalendarManifest {
  return {
    version: 'v6-calendar-1', retrievedAtMs: nowMs, expiresAtMs: nowMs + DAY,
    coverageStartMs: nowMs - DAY, coverageEndMs: nowMs + 8 * DAY,
    sources: (Object.keys(URLS) as CalendarRelease[]).map(release => ({
      release, source: URLS[release], timezone: 'America/New_York', retrievedAtMs: nowMs,
      coverageStartMs: nowMs - DAY, coverageEndMs: nowMs + 8 * DAY,
    })), events: [],
  };
}

function candles(count: number, stepMs: number, endMs: number, daily = false): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = daily ? 80 + i * .3 : 90 + i * .06;
    return { time: (endMs - (count - i) * stepMs) / 1000, open: close - .02, high: close + .8, low: close - .8, close, volume: 10 };
  });
}

function snapshot(asset: ConfiguredAsset = 'BTC', short = false): BrainSnapshot {
  const h4 = candles(160, H4, NOW);
  const last = h4.at(-1)!;
  const prev = h4.at(-2)!;
  if (asset === 'GOLD' || asset === 'SILVER') {
    prev.close = 97;
    prev.low = 96.5;
    prev.open = 98;
    last.close = 100.5;
    last.high = 100.8;
  } else {
    last.close = prev.high + .15;
    last.high = last.close + .15;
  }
  const d1 = candles(200, DAY, Math.floor(NOW / DAY) * DAY, true);
  if (short) for (const series of [h4, d1]) for (const bar of series) {
    const oldHigh = bar.high;
    bar.open = 200 - bar.open;
    bar.close = 200 - bar.close;
    bar.high = 200 - bar.low;
    bar.low = 200 - oldHigh;
  }
  const price = h4.at(-1)!.close;
  const instrument = getConfiguredInstrument(asset);
  return {
    asset, nowMs: NOW, h4, d1, h4AvailableAtMs: NOW, d1AvailableAtMs: NOW,
    calendar: calendar(), quote: {
      price, provider: 'BYBIT_LINEAR_WS', source: 'WEBSOCKET', transport: 'WS', venue: 'BYBIT_LINEAR',
      instrument: instrument.symbol, instrumentVersion: instrument.instrumentVersion,
      updatedAt: new Date(NOW).toISOString(), eventTimeMs: NOW, receivedAtMs: NOW,
      bid: price - .001, ask: price + .001, markPrice: price, indexPrice: price,
      quoteTimes: { lastPriceMs: NOW, bidAskMs: NOW, markMs: NOW },
    },
  };
}

function setup(input: BrainSnapshot): SwingSetup {
  const result = evaluateBrain(input);
  assert.equal(result.status, 'SETUP', JSON.stringify(result));
  if (result.status !== 'SETUP') throw new Error('expected setup');
  return result.setup;
}

for (const asset of ['BTC', 'EURUSD', 'GOLD', 'OIL'] as const) {
  test(`${asset}: long and short causal signals produce mirrored frozen geometry`, () => {
    const long = setup(snapshot(asset));
    const short = setup(snapshot(asset, true));
    assert.equal(long.direction, 'LONG');
    assert.equal(short.direction, 'SHORT');
    assert.ok(Math.abs(long.priceRDistance - short.priceRDistance) < 1e-10);
    assert.ok(Math.abs(long.takeProfit + short.takeProfit - 200) < 1e-10);
    assert.equal(long.policy.initialAtr, long.atr);
    assert.equal(long.policy.priceRDistance, long.priceRDistance);
    assert.equal(long.takeProfit, long.entryPrice + long.priceRDistance * (asset === 'EURUSD' ? 2.5 : 3));
    assert.equal(long.featureCutoffMs, NOW);
    assert.equal(long.expiresAtMs, NOW + 300_000);
  });
  test(`${asset}: missing required native history is warmup, not a setup`, () => {
    const input = snapshot(asset);
    if (asset === 'EURUSD') input.h4 = input.h4.slice(-150);
    else input.d1 = input.d1.slice(-(asset === 'GOLD' ? 180 : 150));
    assert.equal(evaluateBrain(input).status, 'NO_TRADE');
    assert.equal((evaluateBrain(input) as { code: string }).code, 'WARMING_UP');
  });
  test(`${asset}: an unconfirmed breakout or reclaim stays in cash`, () => {
    const input = snapshot(asset);
    input.h4 = input.h4.map((b, i) => i === input.h4.length - 1 ? { ...b, close: input.h4.at(-2)!.close, high: Math.max(b.high, input.h4.at(-2)!.close), low: Math.min(b.low, input.h4.at(-2)!.close) } : b);
    assert.equal((evaluateBrain(input) as { code: string }).code, 'NO_SIGNAL');
  });
}

test('fresh channels exclude signal bar and compare the preceding close with its own channel', () => {
  const input = snapshot();
  const result = setup(input);
  assert.equal(result.channel!.current, input.h4.at(-2)!.high);
  assert.equal(result.channel!.previous, input.h4.at(-3)!.high);
  input.h4 = input.h4.map((b, i) => i === input.h4.length - 2 ? { ...b, close: b.high, high: b.high } : b);
  assert.equal((evaluateBrain(input) as { code: string }).code, 'NO_SIGNAL');
});

for (const kind of ['future', 'forming', 'duplicate', 'gap', 'unaligned', 'badOHLC', 'futureCapture'] as const) {
  test(`${kind} feature evidence fails closed`, () => {
    const input = snapshot();
    const h4 = input.h4.map(b => ({ ...b }));
    if (kind === 'future') h4.push({ ...h4.at(-1)!, time: (NOW + H4) / 1000 });
    if (kind === 'forming') h4.push({ ...h4.at(-1)!, time: NOW / 1000 });
    if (kind === 'duplicate') h4[20] = { ...h4[19] };
    if (kind === 'gap') h4.splice(20, 1);
    if (kind === 'unaligned') h4[20].time += 1;
    if (kind === 'badOHLC') h4[20].high = h4[20].low - 1;
    if (kind === 'futureCapture') input.h4AvailableAtMs = NOW + 1;
    input.h4 = h4;
    assert.equal((evaluateBrain(input) as { code: string }).code, 'INVALID_DATA');
  });
}

test('daily features reject future/forming, duplicate and gapped data', () => {
  for (const kind of ['forming', 'duplicate', 'gap']) {
    const input = snapshot();
    const d1 = input.d1.map(b => ({ ...b }));
    if (kind === 'forming') d1.push({ ...d1.at(-1)!, time: Math.floor(NOW / DAY) * DAY / 1000 });
    if (kind === 'duplicate') d1[20] = { ...d1[19] };
    if (kind === 'gap') d1.splice(20, 1);
    input.d1 = d1;
    assert.equal((evaluateBrain(input) as { code: string }).code, 'INVALID_DATA');
  }
});

test('stale signal and stale/future component quotes cannot admit a setup', () => {
  const expired = snapshot();
  expired.nowMs += 300_001;
  assert.equal((evaluateBrain(expired) as { code: string }).code, 'STALE_SETUP');
  for (const stamp of [NOW - 10_001, NOW + 1]) for (const field of ['lastPriceMs', 'bidAskMs', 'markMs'] as const) {
    const input = snapshot();
    input.quote!.quoteTimes[field] = stamp;
    assert.equal((evaluateBrain(input) as { code: string }).code, 'QUOTE');
  }
  const input = snapshot();
  input.quote!.receivedAtMs = NOW + 1;
  assert.equal((evaluateBrain(input) as { code: string }).code, 'QUOTE');
});

test('drift, stop distance and oil shocks cannot be rescued by target geometry', () => {
  const drift = snapshot();
  drift.quote!.price += 1;
  drift.quote!.bid! += 1;
  drift.quote!.ask! += 1;
  assert.equal((evaluateBrain(drift) as { code: string }).code, 'PRICE_DRIFT');
  const wideStop = snapshot();
  wideStop.h4 = wideStop.h4.map((b, i) => i === wideStop.h4.length - 2 ? { ...b, low: 1 } : b);
  assert.equal((evaluateBrain(wideStop) as { code: string }).code, 'STOP_GEOMETRY');
  const shock = snapshot('OIL');
  shock.h4 = shock.h4.map((b, i) => i === shock.h4.length - 1 ? { ...b, high: b.high + 10 } : b);
  assert.equal((evaluateBrain(shock) as { code: string }).code, 'SHOCK');
});

test('setup identity survives later quote observations but changes with asset, side or setup bar', () => {
  const input = snapshot();
  const first = setup(input);
  input.nowMs += 1000;
  input.quote!.receivedAtMs += 1000;
  input.quote!.price += .01;
  assert.equal(setup(input).id, first.id);
  assert.notEqual(setup(snapshot('ETH')).id, first.id);
  assert.notEqual(setup(snapshot('BTC', true)).id, first.id);
  const later = snapshot();
  later.h4 = later.h4.map(b => ({ ...b, time: b.time + H4 / 1000 }));
  later.nowMs += H4;
  later.quote!.quoteTimes = { lastPriceMs: later.nowMs, bidAskMs: later.nowMs, markMs: later.nowMs };
  later.quote!.eventTimeMs = later.nowMs;
  later.quote!.receivedAtMs = later.nowMs;
  later.h4AvailableAtMs = later.nowMs;
  assert.notEqual(setup(later).id, first.id);
  assert.notEqual(brainDefinition('BTC').configHash, brainDefinition('ETH').configHash);
});

test('FX/metals liquid windows honor actual DST, Friday cutoff and weekends', () => {
  const cases: [ConfiguredAsset, string, boolean][] = [
    ['EURUSD', '2026-03-23T07:30:00Z', false], ['EURUSD', '2026-03-30T07:30:00Z', true],
    ['EURUSD', '2026-03-05T21:30:00Z', true], ['EURUSD', '2026-03-09T21:30:00Z', false],
    ['EURUSD', '2026-10-23T16:00:00Z', false], ['EURUSD', '2026-10-24T12:00:00Z', false],
    ['GOLD', '2026-10-23T16:00:00Z', true], ['SILVER', '2026-10-25T12:00:00Z', false],
    ['OIL', '2026-10-22T12:00:00Z', true], ['OIL', '2026-10-23T12:00:00Z', false],
    ['BTC', '2026-10-24T02:00:00Z', true],
  ];
  for (const [asset, at, want] of cases) assert.equal(strategySessionAllowed(asset, Date.parse(at)), want, `${asset} ${at}`);
});

test('calendar coverage, source provenance and refresh expiry fail closed', () => {
  assert.equal(validateCalendar({ asset: 'OIL', manifest: calendar(), nowMs: NOW }).allowed, true);
  for (const kind of ['missing', 'expiry', 'future', 'short', 'sourceShort', 'sourceFuture', 'wrongSource', 'timezone', 'tooLongExpiry']) {
    const manifest = calendar();
    if (kind === 'missing') manifest.sources = manifest.sources.filter(s => s.release !== 'EIA_WPSR');
    if (kind === 'expiry') manifest.expiresAtMs = NOW - 1;
    if (kind === 'future') manifest.retrievedAtMs = NOW + 1;
    if (kind === 'short') manifest.coverageEndMs = NOW + 7 * DAY - 1;
    if (kind === 'sourceShort') manifest.sources.at(-1)!.coverageEndMs = NOW + DAY;
    if (kind === 'sourceFuture') manifest.sources.at(-1)!.retrievedAtMs = NOW + 1;
    if (kind === 'wrongSource') manifest.sources.at(-1)!.source = 'https://eia.gov.example.com/schedule';
    if (kind === 'timezone') manifest.sources.at(-1)!.timezone = 'Unknown/Zone';
    if (kind === 'tooLongExpiry') manifest.expiresAtMs = NOW + DAY + 1;
    assert.equal(validateCalendar({ asset: 'OIL', manifest, nowMs: NOW }).allowed, false, kind);
  }
  assert.equal(validateCalendar({ asset: 'OIL', manifest: null, nowMs: NOW }).allowed, false);
  assert.equal(validateCalendar({ asset: 'BTC', manifest: null, nowMs: NOW }).allowed, true);
});

test('official holiday-shifted EIA event blocks only the actual release window', () => {
  const manifest = calendar();
  manifest.events.push({ id: 'shifted-eia', release: 'EIA_WPSR', source: URLS.EIA_WPSR, timezone: 'America/New_York', date: '2026-10-20', timeMs: NOW + 3_600_000, timeUncertain: false });
  assert.equal(validateCalendar({ asset: 'OIL', manifest, nowMs: NOW }).allowed, false);
  assert.equal(validateCalendar({ asset: 'OIL', manifest, nowMs: NOW - 1 }).allowed, false); // manifest would be from the future
  manifest.retrievedAtMs -= 1;
  manifest.expiresAtMs -= 1;
  for (const s of manifest.sources) s.retrievedAtMs -= 1;
  assert.equal(validateCalendar({ asset: 'OIL', manifest, nowMs: NOW - 1 }).allowed, true);
  assert.equal(validateCalendar({ asset: 'EURUSD', manifest, nowMs: NOW }).allowed, true);
});

test('unknown BoJ time blocks the source-local date until confirmed past', () => {
  const manifest = calendar();
  const time = Date.parse('2026-10-20T00:00:00Z');
  manifest.retrievedAtMs = time;
  manifest.expiresAtMs = time + DAY;
  for (const s of manifest.sources) s.retrievedAtMs = time;
  manifest.events.push({ id: 'boj', release: 'BOJ', source: URLS.BOJ, timezone: 'Asia/Tokyo', date: '2026-10-20', timeMs: null, timeUncertain: true });
  assert.equal(validateCalendar({ asset: 'USDJPY', manifest, nowMs: NOW }).allowed, false);
  assert.equal(validateCalendar({ asset: 'EURUSD', manifest, nowMs: NOW }).allowed, true);
  manifest.events[0].confirmedPastAtMs = NOW;
  manifest.retrievedAtMs = NOW;
  manifest.expiresAtMs = NOW + DAY;
  for (const s of manifest.sources) s.retrievedAtMs = NOW;
  assert.equal(validateCalendar({ asset: 'USDJPY', manifest, nowMs: NOW }).allowed, true);
});

test('calendar refusal propagates to a valid impacted class setup', () => {
  const input = snapshot('EURUSD');
  input.calendar = null;
  assert.equal((evaluateBrain(input) as { code: string }).code, 'CALENDAR');
});

test('full-position exits apply frozen initial ATR, monotone stops, targets and calendar time', () => {
  const policy = setup(snapshot()).policy;
  const base = { policy: { ...policy, initialAtr: 2, priceRDistance: 4 }, direction: 'LONG' as const, entryPrice: 100, stopLoss: 96, currentPrice: 107.99, openedAtMs: NOW, nowMs: NOW + 1, watermark: 100 };
  assert.equal(decideBrainExit(base).stopLoss, 96);
  const trail = decideBrainExit({ ...base, currentPrice: 108 });
  assert.equal(trail.action, 'HOLD');
  assert.equal(trail.watermark, 108);
  assert.equal(trail.stopLoss, 104);
  assert.equal(decideBrainExit({ ...base, currentPrice: 107, watermark: 110, stopLoss: 106 }).stopLoss, 106);
  assert.equal(decideBrainExit({ ...base, currentPrice: 105, watermark: 110, stopLoss: 106 }).reason, 'TRAILING');
  assert.equal(decideBrainExit({ ...base, currentPrice: 112 }).reason, 'TARGET');
  assert.equal(decideBrainExit({ ...base, currentPrice: 95 }).reason, 'STOP');
  assert.equal(decideBrainExit({ ...base, nowMs: NOW + 10 * DAY }).reason, 'TIME');
  const short = decideBrainExit({ ...base, direction: 'SHORT', stopLoss: 104, currentPrice: 92, watermark: 100 });
  assert.equal(short.stopLoss, 96);
  assert.equal(short.watermark, 92);
  assert.equal(decideBrainExit({ ...base, direction: 'SHORT', stopLoss: 104, currentPrice: 88 }).reason, 'TARGET');
  assert.equal(decideBrainExit({ ...base, currentPrice: NaN }).reason, 'INVALID_INPUT');
});

test('executed ask/bid and Wilder seed produce the approved minimum stop distance', () => {
  const long = setup(snapshot());
  assert.ok(Math.abs(long.entryPrice - 100.431) < 1e-10);
  // Every prior TR is 1.6; signal TR is 1.84, so Wilder ATR is (13 * 1.6 + 1.84) / 14.
  assert.ok(Math.abs(long.atr - 1.6171428571428572) < 1e-10);
  assert.ok(Math.abs(long.stopLoss - 97.1967142857143) < 1e-10);
  const oil = setup(snapshot('OIL'));
  assert.ok(Math.abs(oil.stopLoss - 96.38814285714287) < 1e-10);
});

test('every configured asset routes to its own immutable class definition', () => {
  const expected = {
    BTC: 'CRYPTO_TREND_BREAKOUT_V1', ETH: 'CRYPTO_TREND_BREAKOUT_V1', SOL: 'CRYPTO_TREND_BREAKOUT_V1',
    EURUSD: 'FX_SESSION_BREAKOUT_V1', GBPUSD: 'FX_SESSION_BREAKOUT_V1', USDJPY: 'FX_SESSION_BREAKOUT_V1',
    GOLD: 'METALS_TREND_RECLAIM_V1', SILVER: 'METALS_TREND_RECLAIM_V1', OIL: 'OIL_TREND_EXPANSION_V1',
  };
  for (const [asset, strategyId] of Object.entries(expected)) {
    assert.equal(setup(snapshot(asset as ConfiguredAsset)).strategyId, strategyId);
    const def = brainDefinition(asset as ConfiguredAsset);
    def.parameters.targetR = 999;
    assert.notEqual(brainDefinition(asset as ConfiguredAsset).parameters.targetR, 999);
  }
});

test('an opposing or absent regime never turns a breakout into an entry', () => {
  for (const asset of ['BTC', 'EURUSD', 'GOLD', 'OIL'] as const) {
    const input = snapshot(asset);
    if (asset === 'EURUSD') {
      input.h4 = input.h4.map((b, i) => i < 120 ? { ...b, open: 105, high: 106, low: 104, close: 105 } : b);
    } else {
      input.d1 = input.d1.map(b => ({ ...b, open: 100, high: 101, low: 99, close: 100 }));
    }
    assert.equal((evaluateBrain(input) as { code: string }).code, 'NO_SIGNAL', asset);
  }
});

test('malformed calendar rows and untyped JSON fail closed without throwing', () => {
  const variants = [
    { sources: [null] }, { events: [null] },
    { sources: 'not-an-array' }, { events: [ { release: 'EIA_WPSR', id: 3 } ] },
  ];
  for (const patch of variants) {
    const m = { ...calendar(), ...patch } as unknown as CalendarManifest;
    assert.equal(validateCalendar({ asset: 'OIL', manifest: m, nowMs: NOW }).allowed, false);
  }
  const m = calendar();
  m.sources.at(-1)!.timezone = undefined as unknown as string;
  assert.equal(validateCalendar({ asset: 'OIL', manifest: m, nowMs: NOW }).allowed, false);
});

test('uncertain releases cannot be confirmed before their local release date', () => {
  const m = calendar();
  m.events.push({ id: 'bad-confirmation', release: 'BOJ', source: URLS.BOJ, timezone: 'Asia/Tokyo', date: '2026-10-20', timeMs: null, timeUncertain: true, confirmedPastAtMs: NOW - DAY });
  assert.equal(validateCalendar({ asset: 'USDJPY', manifest: m, nowMs: NOW }).allowed, false);
});

test('source quote events cannot be available before they were received', () => {
  const input = snapshot();
  input.quote!.receivedAtMs = NOW - 1;
  assert.equal((evaluateBrain(input) as { code: string }).code, 'QUOTE');
});

test('Fed macro exclusion affects every USD pair and both metals at exact boundaries', () => {
  const m = calendar();
  m.events.push({ id: 'fed-release', release: 'FED', source: URLS.FED, timezone: 'America/New_York', date: '2026-10-20', timeMs: NOW + 3_600_000, timeUncertain: false });
  for (const asset of ['EURUSD', 'GBPUSD', 'USDJPY', 'GOLD', 'SILVER'] as const) {
    assert.equal(validateCalendar({ asset, manifest: m, nowMs: NOW }).allowed, false, asset);
    assert.equal(validateCalendar({ asset, manifest: m, nowMs: NOW + 7_200_000 }).allowed, false, asset);
    assert.equal(validateCalendar({ asset, manifest: m, nowMs: NOW + 7_200_001 }).allowed, true, asset);
  }
  assert.equal(validateCalendar({ asset: 'OIL', manifest: m, nowMs: NOW }).allowed, true);
});

test('omitted capture clocks support modeled-at-close research and do not certify actual availability', () => {
  const input = snapshot();
  delete input.h4AvailableAtMs;
  delete input.d1AvailableAtMs;
  // Runtime/replay evidence gates must distinguish this fixture from actual captured data.
  assert.equal(evaluateBrain(input).status, 'SETUP');
  input.h4AvailableAtMs = NOW + 1;
  assert.equal((evaluateBrain(input) as { code: string }).code, 'INVALID_DATA');
});
