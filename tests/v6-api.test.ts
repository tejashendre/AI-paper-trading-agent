import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRedis } from './helpers/memoryRedis';
import { setRedisClient } from '@/lib/redis';
import { ACTIVE_AI_RUN_KEY, REPLACEMENT_BRAIN_VERSION, aiRunKeys } from '@/lib/admin/resetAiRun';
import { GET, POST } from '@/app/api/brain/route';
import { brainDefinition } from '@/lib/strategy/v6/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrainStatusPanel, diagnosticMetric } from '@/components/BrainStatusPanel';

process.env.DASHBOARD_SECRET = 'v6-api-test-only';
process.env.CRON_SECRET = 'v6-api-cron-test-only';
const request = (method = 'GET', body?: unknown, token?: string) => new Request('http://localhost/api/brain?reset=execute', {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function fixture(t: test.TestContext) {
  const redis = new MemoryRedis();
  setRedisClient(redis); t.after(() => setRedisClient(null));
  await redis.set('ai:portfolio', { usd: 8123, totalPnl: -1877, totalTrades: 92 });
  await redis.set('user:portfolio', { usd: 7777, privateMarker: 'human-private-marker' });
  await redis.set('xsec:portfolio', { cashUsd: 5555, privateMarker: 'xsec-private-marker' });
  return redis;
}
const active = { runId: 'api-proof', brainVersion: REPLACEMENT_BRAIN_VERSION, startedAt: '2026-10-24T10:00:00Z',
  initialCapital: 10000, capital: 10000, highWaterEquity: 10000, mode: 'SHADOW', xsecMode: 'HISTORICAL_ONLY',
  archive: { path: 'C:/private/archive.json', sha256: 'a'.repeat(64) }, ledgerEventId: 'private-ledger-id' };

test('public GET with reset query is read-only, missing epoch requires reset and never inherits historical performance', async t => {
  const redis = await fixture(t);
  const keys = ['ai:portfolio', 'user:portfolio', 'xsec:portfolio', ACTIVE_AI_RUN_KEY, 'brain:v6:status'];
  const before = await redis.readRaw(keys);
  const response = await GET(request()); const status = await response.json();
  assert.equal(response.status, 200); assert.equal(status.mode, 'RESET_REQUIRED');
  assert.equal(status.currentRun, null); assert.equal(status.account, null);
  assert.equal(status.assets.length, 9); assert.equal(status.assets[0].evidence.historicalCount, null);
  assert.equal(status.history.xsecMode, 'HISTORICAL_ONLY');
  assert.deepEqual(await redis.readRaw(keys), before);
  assert.doesNotMatch(JSON.stringify(status), /7777|8123|5555|private-marker|private\/archive/);
});

test('current epoch status uses scoped account and allowlists runtime fields without leaking archive or human data', async t => {
  const redis = await fixture(t);
  await redis.set(ACTIVE_AI_RUN_KEY, active);
  await redis.set(aiRunKeys(active.runId).portfolio, { usd: 9950, totalPnl: -50, totalTrades: 2, grossProfit: 0, grossLoss: 50 });
  await redis.set('brain:v6:status', { version: 'v6', runId: active.runId, mode: 'SHADOW', generatedAtMs: Date.now(),
    generatedAt: new Date().toISOString(), equityUsdt: 9980, privateMarker: 'runtime-private-marker', assets: [{ ...brainDefinition('BTC'), mode: 'SHADOW',
      riskTier: 'BASE', evidence: { historicalCount: 4, forwardCount: 2, paperCount: 0, reasons: ['INSUFFICIENT_FORWARD_EVIDENCE'] },
      decision: { status: 'NO_TRADE', code: 'CALENDAR', reason: 'Calendar coverage is unavailable' },
    }] });
  const status = await (await GET(request())).json();
  assert.equal(status.currentRun.runId, active.runId); assert.equal(status.account.cashUsdt, 9950);
  assert.equal(status.account.realizedPnlUsdt, -50); assert.equal(status.account.equityUsdt, 9980);
  assert.equal(status.assets[0].evidence.forwardCount, 2); assert.equal(status.assets[0].mode, 'SHADOW');
  assert.equal(status.assets[1].mode, 'UNAVAILABLE'); assert.equal(status.account.profitFactor, 0);
  assert.equal(status.risk.initialRiskFraction, 0.0025); assert.equal(status.risk.escalatedRiskFraction, 0.005);
  assert.equal(status.risk.drawdownStopFraction, 0.1); assert.equal(status.history.allocatedCapitalUsdt, 0);
  assert.doesNotMatch(JSON.stringify(status), /runtime-private|human-private|private-ledger|private\/archive/);
});

test('an unbound or mismatched definition is unavailable even when its telemetry advertises active trading', async t => {
  const redis = await fixture(t); await redis.set(ACTIVE_AI_RUN_KEY, active);
  await redis.set(aiRunKeys(active.runId).portfolio, { usd: 10000 });
  for (const definition of [{ asset: 'BTC' }, { ...brainDefinition('BTC'), configHash: 'old-definition' }]) {
    await redis.set('brain:v6:status', { version: 'v6', runId: active.runId, mode: 'PAPER_ACTIVE', generatedAtMs: Date.now(),
      assets: [{ ...definition, mode: 'PAPER_ACTIVE', evidence: { paperCount: 50 } }] });
    const body = await (await GET(request())).json();
    assert.equal(body.assets[0].mode, 'UNAVAILABLE'); assert.equal(body.assets[0].evidence.paperCount, null);
  }
});

test('stale or different-run telemetry cannot advertise active permission or current equity', async t => {
  const redis = await fixture(t); await redis.set(ACTIVE_AI_RUN_KEY, active);
  await redis.set(aiRunKeys(active.runId).portfolio, { usd: 10000 });
  for (const telemetry of [{ runId: 'older-run', generatedAtMs: Date.now() }, { runId: active.runId, generatedAtMs: Date.now() - 600000 }]) {
    await redis.set('brain:v6:status', { ...telemetry, version: 'v6', mode: 'PAPER_ACTIVE', equityUsdt: 12345,
      assets: [{ asset: 'BTC', mode: 'PAPER_ACTIVE', evidence: { historicalCount: 300 } }] });
    const status = await (await GET(request())).json();
    assert.equal(status.mode, 'UNAVAILABLE'); assert.equal(status.account.equityUsdt, null);
    assert.equal(status.assets[0].mode, 'UNAVAILABLE'); assert.equal(status.account.profitFactor, null);
  }
});

test('POST preview requires dashboard auth, sanitizes raw snapshots, refuses execute and client archive paths', async t => {
  const redis = await fixture(t);
  for (const token of [undefined, 'SPECTATOR', 'v6-api-cron-test-only']) {
    assert.equal((await POST(request('POST', { action: 'preview', runId: 'next-run' }, token))).status, 403);
  }
  const before = await redis.readRaw(['ai:portfolio', 'user:portfolio', ACTIVE_AI_RUN_KEY]);
  const preview = await POST(request('POST', { action: 'preview', runId: 'next-run' }, 'v6-api-test-only'));
  assert.equal(preview.status, 200); const body = await preview.json();
  assert.equal(body.executionAvailable, false); assert.equal(body.capitalUsdt, 10000);
  assert.ok(body.counts.archivedKeys > 0); assert.match(body.digests.source, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(body), /human-private|xsec-private|sources|"human"|archiveDirectory|7777|8123|5555/);
  for (const input of [{ action: 'execute', runId: 'next-run' }, { action: 'preview', runId: 'next-run', archiveDirectory: 'C:/outside' }]) {
    assert.equal((await POST(request('POST', input, 'v6-api-test-only'))).status, 400);
  }
  assert.deepEqual(await redis.readRaw(Object.keys(before)), before);
});

test('brain panel names current epoch, unavailable counts, shared capital and gated risk without inventing diagnostics', async t => {
  const redis = await fixture(t);
  const missing = await (await GET(request())).json();
  const html = renderToStaticMarkup(createElement(BrainStatusPanel, { status: missing, isDark: true }));
  assert.match(html, /RESET_REQUIRED/); assert.match(html, /Unavailable/);
  assert.match(html, /10,000/); assert.match(html, /25/); assert.match(html, /50/);
  assert.match(html, /Historical/); assert.match(html, /10%/);
  assert.equal(diagnosticMetric(undefined), 'Unavailable'); assert.equal(diagnosticMetric(NaN), 'Unavailable');
  assert.equal(diagnosticMetric(0), '0.00');
  assert.match(renderToStaticMarkup(createElement(BrainStatusPanel, { status: null, isDark: false })), /unavailable/i);
  await redis.set(ACTIVE_AI_RUN_KEY, active);
  const current = renderToStaticMarkup(createElement(BrainStatusPanel, { status: await (await GET(request())).json(), isDark: false }));
  assert.match(current, /api-proof/); assert.doesNotMatch(current, /private\/archive/);
});
