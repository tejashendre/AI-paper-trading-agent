import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordedReplayInput, recordedSnapshotAt } from '@/lib/backtest/replayEngine';
import { MarketService, setMarketServiceDeps } from '@/lib/market';
import { makeFakeBybit, SERVER_NOW } from './helpers/fakeBybitMarket';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVenue, installVenue, minuteBars } from './helpers/fakeBybitVenue';
import { captureBybitEvidence } from '../scripts/capture-bybit-evidence';
import { readResearchEvidence } from '@/lib/research/researchArchive';

const at=Date.parse('2026-01-02T00:00:00Z');
function evidence(overrides: any = {}) {
  return {asset:'BTC',recordedAtMs:at,candles:{},metadata:{},
    quote:{price:100,bid:99,ask:101,eventTimeMs:at,receivedAtMs:at,updatedAt:new Date(at).toISOString(),
      quoteTimes:{lastPriceMs:at,bidAskMs:at,markMs:null}},
    depth:{b:[['99','4']],a:[['101','2']],ts:at},
    funding:{fundingRate:0.0001,openInterest:1234,observedAtMs:at},...overrides};
}
function tape(row:any) { return buildRecordedReplayInput([row]).recordedSnapshots!.BTC; }

test('raw quote and depth clocks cannot be replaced by an earlier archive timestamp', () => {
  const row=evidence(), future=at+60000;
  row.quote={...row.quote,eventTimeMs:future,receivedAtMs:future,updatedAt:new Date(future).toISOString(),
    quoteTimes:{lastPriceMs:future,bidAskMs:future,markMs:null}};
  row.depth={...row.depth,ts:future};row.funding.observedAtMs=future;
  const rows=tape(row);
  assert.equal(recordedSnapshotAt(rows,at),null);
  const selected=recordedSnapshotAt(rows,future)!;
  assert.equal(selected.quote!.eventTimeMs,future);
  assert.equal(selected.quote!.receivedAtMs,future);
  assert.equal(selected.quote!.quoteTimes.bidAskMs,future);
});

test('raw stale quote, depth and sensors remain unavailable even in a newly written envelope', () => {
  const valid=evidence();assert.ok(recordedSnapshotAt(tape(valid),at));
  for(const part of ['quote','depth','funding']) {
    const row=evidence();
    if(part==='quote') row.quote={...row.quote,eventTimeMs:at-20000,updatedAt:new Date(at-20000).toISOString(),
      quoteTimes:{lastPriceMs:at-20000,bidAskMs:at-20000,markMs:null}};
    if(part==='depth') row.depth.ts=at-20000;
    if(part==='funding') row.funding.observedAtMs=at-61000;
    assert.equal(recordedSnapshotAt(tape(row),at),null,part+' must obey its source freshness');
  }
});

test('missing source clocks and late receipts cannot create causal recorded flow', () => {
  assert.equal(tape(evidence({quote:{lastPrice:'100',bid1Price:'99',ask1Price:'101'}}))[0].quote,undefined);
  assert.equal(tape(evidence({depth:{b:[['99','4']],a:[['101','2']]}}))[0].orderbookResult,null);
  assert.equal(tape(evidence({funding:{fundingRate:0.0001,openInterest:1234}}))[0].deepSensors,null);
  const row=evidence();row.quote.receivedAtMs=at+2000;
  assert.equal(recordedSnapshotAt(tape(row),at),null);
  assert.ok(recordedSnapshotAt(tape(row),at+2000));
});

test('live research depth and sensors retain their source observation times', async () => {
  const fake=makeFakeBybit(),restore=setMarketServiceDeps(fake.deps);
  try {
    assert.equal((await MarketService.getOrderbookImbalance('BTC') as any).observedAtMs,SERVER_NOW);
    assert.equal((await MarketService.getDeepSensors('BTC') as any).observedAtMs,SERVER_NOW);
  } finally {restore();}
});

test('public offline captures retain component clocks and raw funding history', async () => {
  const venue=createVenue(Date.now()),restore=installVenue(venue).restore;
  venue.series.set('BTCUSDT',minuteBars(100,0,venue.nowMs,400));
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'source-clock-capture-'));
  try {
    await captureBybitEvidence({assets:['BTC'],intervals:['15m'],output});
    const row=readResearchEvidence(output)[0];
    assert.equal((row.quote as any).eventTimeMs,venue.nowMs);
    assert.ok((row.quote as any).receivedAtMs>0);
    assert.equal((row.depth as any).observedAtMs,venue.nowMs);
    assert.equal((row.funding as any).observedAtMs,venue.nowMs);
    assert.ok((row.metadata as any).fundingHistory);
    assert.ok(row.recordedAtMs>=(row.quote as any).receivedAtMs);
  } finally {restore();}
});
