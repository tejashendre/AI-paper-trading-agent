import test from 'node:test';
import assert from 'node:assert/strict';
import * as live from '@/lib/ui/livePortfolioGain';
import { modeledPositionMark } from '@/lib/trading/positionValuation';
import { getConfiguredInstrument, legacyInstrument, CONFIGURED_ASSETS } from '@/lib/trading/instrumentRegistry';

test('headline shows signed total gain, including zero account value and no fabricated loading balance', () => {
  assert.equal(live.livePortfolioGain(10065.91, 10000, [], {}).gain!.toFixed(2), '65.91');
  assert.equal(live.livePortfolioGain(0, 10000, [], {}).gain, -10000);
  assert.equal(live.livePortfolioGain(undefined, 10000, [], {}).gain, null);
  assert.equal(live.formatSignedGain(-1046.66), '-$1,046.66');
  assert.equal(live.formatSignedGain(1046.66), '+$1,046.66');
});

test('live gain reconciles to the server exit model across all assets, sides and frozen legacy JPY units', () => {
  for (const asset of CONFIGURED_ASSETS) for (const direction of ['LONG', 'SHORT']) {
    for (const instrument of [getConfiguredInstrument(asset), legacyInstrument(asset, 'LEGACY_PAPER_V1')]) {
      const pos = { asset, instrument, direction, amount: 2, entryPrice: 100, entryTime: new Date().toISOString(),
        entryFeePaid: 7, usdInvested: 200, dataQuality: 80 };
      const atSync = modeledPositionMark(asset, pos, 105);
      const atLive = modeledPositionMark(asset, pos, 95);
      const accountAtSync = 9993 + 200 + atSync.grossPnl - atSync.exitFee - atSync.carryCost;
      const expected = 9993 + 200 + atLive.grossPnl - atLive.exitFee - atLive.carryCost;
      const result = live.livePortfolioGain(accountAtSync, 10000, [atSync.valuation],
        { [asset]: { price: 95, fresh: true, updatedAt: new Date().toISOString() } });
      assert.ok(Math.abs(result.totalValue! - expected) < 1e-7, `${asset} ${direction} ${instrument.economicsModel}`);
      assert.ok(Math.abs(result.gain! - (expected - 10000)) < 1e-7);
      assert.equal(result.live, true);
    }
  }
});

test('stale, missing, future and invalid quotes keep the last synchronized gain explicitly', () => {
  const pos = { asset: 'BTC', direction: 'LONG', amount: 1, entryPrice: 100, entryTime: new Date().toISOString(), usdInvested: 100 };
  const mark = modeledPositionMark('BTC', pos, 100).valuation;
  for (const quote of [undefined, {price:110,fresh:false}, {price:Infinity,fresh:true},
    {price:110,fresh:true,updatedAt:'2020-01-01T00:00:00Z'}, {price:110,fresh:true,updatedAt:'2099-01-01T00:00:00Z'}]) {
    const result = live.livePortfolioGain(10065.91, 10000, [mark], { BTC: quote });
    assert.equal(result.gain!.toFixed(2), '65.91'); assert.equal(result.live, false);
  }
});
