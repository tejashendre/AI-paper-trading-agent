import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalRedisProxy, brainEntryReceipt, type BrainEntryCommit } from '@/lib/redis';
import { previewAiRunReset, resetAiRun, aiRunKeys, REQUIRED_AI_RESET_LEASE_KEYS } from '@/lib/admin/resetAiRun';

const target = process.env.BRAIN_REDIS_TEST_URL;
test('production Redis Lua transactions and archive-first reset on disposable loopback DB15', { skip: !target, timeout: 120000 }, async (t) => {
  let url: URL;
  try { url = new URL(target!); } catch { throw new Error('Invalid integration test Redis URL'); }
  assert.ok(url.protocol === 'redis:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/15' &&
    !url.username && !url.password && !url.search && !url.hash, 'Integration tests require unauthenticated numeric-loopback Redis DB15');
  const redis = new LocalRedisProxy(target);
  t.after(async () => { await redis.quit(); });
  assert.equal((await redis.scanKeys('*', 1)).length, 0, 'Refuse to modify a nonempty database; use a fresh disposable Redis service');
  const lease = 'integration-lease';
  async function fixture(label: string) {
    const runId = `real-${label}-${randomUUID()}`, prefix = `brain:v6:run:${runId}:`;
    await redis.set('brain:v6:activeRun', { runId });
    await redis.set(prefix + 'ledgerAcknowledged', true);
    await redis.set(prefix + 'portfolio', { usd: 10000, openPositions: {} });
    await redis.set('portfolio:write-lock:ai', lease, { ex: 60 });
    const trade = (id: string, asset = 'BTC', action = 'BUY', positionId = id) => ({ id, positionId, asset, action, brainRunId: runId });
    async function input(transactionId: string, trades = [trade('one')], usd = 9900, kind: 'ENTRY' | 'EXIT' = 'ENTRY'): Promise<BrainEntryCommit> {
      const held = (await redis.get<{ openPositions: Record<string, { positionId: string }> }>(prefix + 'portfolio'))!.openPositions;
      for (const row of trades) { if (kind === 'ENTRY') held[row.asset] = { positionId: row.positionId }; else delete held[row.asset]; }
      const financial = { kind, portfolio: JSON.stringify({ usd, openPositions: held }),
        trades: trades.map(row => JSON.stringify(row)), events: trades.map(row => ({ id: 'event:' + row.id,
          event: JSON.stringify({ id: 'event:' + row.id, type: kind === 'ENTRY' ? 'ENTRY_FILLED' : 'EXIT_FILLED' }) })) };
      return { runId, transactionId, leaseToken: lease, expected: await redis.readRaw(['brain:v6:activeRun', prefix + 'portfolio']),
        ...financial, expiresAtMs: Date.now() + 30000, receipt: brainEntryReceipt(financial) };
    }
    const stateKeys = (transactionId: string) => [prefix + 'portfolio', 'ai:portfolio', prefix + 'trades', prefix + 'outbox:event:one',
      prefix + 'entryTrade:one', prefix + 'entryPosition:one', prefix + 'transaction:' + transactionId];
    return { runId, prefix, trade, input, stateKeys };
  }
  await t.test('atomic entry, durable per-entry markers and original receipt retry survive partial-batch closure', async () => {
    const f = await fixture('entry');
    const input = await f.input('batch-one-two', [f.trade('one'), f.trade('two', 'ETH')], 9800);
    assert.equal(await redis.commitBrainEntry(input), input.receipt);
    assert.equal((await redis.get<{ usd: number }>(f.prefix + 'portfolio'))?.usd, 9800);
    assert.equal((await redis.get<{ usd: number }>('ai:portfolio'))?.usd, 9800);
    assert.equal((await redis.lrange(f.prefix + 'trades', 0, -1)).length, 2);
    for (const id of ['one', 'two']) {
      assert.notEqual(await redis.get(f.prefix + 'outbox:event:' + id), null);
      assert.equal(await redis.get(f.prefix + 'entryTrade:' + id), input.receipt);
      assert.equal(await redis.get(f.prefix + 'entryPosition:' + id), input.receipt);
    }
    const committed = await redis.readRaw(f.stateKeys(input.transactionId));
    assert.equal(await redis.commitBrainEntry(input), input.receipt);
    assert.deepEqual(await redis.readRaw(Object.keys(committed)), committed);
    await redis.commitBrainEntry(await f.input('close-one', [f.trade('close-one', 'BTC', 'SELL', 'one')], 9900, 'EXIT'));
    assert.deepEqual((await redis.get<{ openPositions: unknown }>(f.prefix + 'portfolio'))?.openPositions, { ETH: { positionId: 'two' } });
    await redis.del(f.prefix + 'outbox:event:one');
    const before = await redis.readRaw(f.stateKeys('partial-reentry'));
    await assert.rejects(redis.commitBrainEntry(await f.input('partial-reentry')), /already committed/i);
    await assert.rejects(redis.commitBrainEntry(await f.input('renamed-entry', [f.trade('renamed-one', 'BTC', 'BUY', 'one')])), /already committed/i);
    assert.deepEqual(await redis.readRaw(Object.keys(before)), before);
    assert.equal(await redis.commitBrainEntry(input), input.receipt);
    assert.equal((await redis.get<{ usd: number }>(f.prefix + 'portfolio'))?.usd, 9900);
  });
  for (const fault of ['lease', 'source', 'trade-type', 'outbox-type']) await t.test(`financial ${fault} failure leaves all cash, trades, events and markers unchanged`, async () => {
    const f = await fixture(fault), input = await f.input('refused');
    if (fault === 'lease') await redis.set('portfolio:write-lock:ai', 'other-owner', { ex: 60 });
    if (fault === 'source') await redis.set(f.prefix + 'portfolio', { usd: 9876, openPositions: {} });
    if (fault === 'trade-type') await redis.set(f.prefix + 'trades', 'wrong-type');
    if (fault === 'outbox-type') await redis.lpush(f.prefix + 'outbox:event:one', 'wrong-type');
    const before = await redis.readRaw(f.stateKeys('refused'));
    await assert.rejects(redis.commitBrainEntry(input), /lease|source changed|trade history type|WRONGTYPE/i);
    assert.deepEqual(await redis.readRaw(Object.keys(before)), before);
  });
  await t.test('an immutable observation conflict refuses every preceding mutable write', async () => {
    const f = await fixture('observation'), shadow = f.prefix + 'shadow', proof = f.prefix + 'proof:' + 'a'.repeat(64);
    const keys = ['brain:v6:activeRun', shadow, proof];
    await redis.commitBrainObservation({ runId: f.runId, leaseToken: lease, expected: await redis.readRaw(keys),
      writes: { [shadow]: '{"sequence":1}', [proof]: '{"proof":1}' } });
    const before = await redis.readRaw(keys);
    await assert.rejects(redis.commitBrainObservation({ runId: f.runId, leaseToken: lease, expected: before,
      writes: { [shadow]: '{"sequence":2}', [proof]: '{"proof":2}' } }), /immutable evidence changed/i);
    assert.deepEqual(await redis.readRaw(keys), before);
  });
  await t.test('reset archives before acknowledgement, preserves raw human/history bytes and cannot reinject capital', async () => {
    const archiveDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-real-redis-'));
    t.after(() => { assert.equal(path.dirname(path.resolve(archiveDirectory)), path.resolve(os.tmpdir())); fs.rmSync(archiveDirectory, { recursive: true, force: true }); });
    await redis.del('brain:v6:activeRun');
    await redis.set('ai:portfolio', { usd: 8123, openPositions: {}, balances: {} });
    await redis.set('xsec:portfolio', { cashUsd: 6543, positions: {}, fundingTail: [] });
    await redis.set('user:portfolio', '{ "usd": 9999, "openPositions": {} }');
    await redis.lpush('user:trades', '{ "id": "fixture-human" }');
    await redis.lpush('ai:trades', '{"id":"fixture-legacy-ai"}');
    await redis.lpush('xsec:trades', '{"id":"fixture-legacy-xsec"}');
    const preservedKeys = ['user:portfolio', 'user:trades', 'ai:trades', 'xsec:trades', 'xsec:portfolio'];
    const preserved = await redis.readRaw(preservedKeys), runId = `real-reset-${randomUUID()}`;
    const leases = Object.fromEntries(REQUIRED_AI_RESET_LEASE_KEYS.map(key => [key, 'reset:' + randomUUID()]));
    for (const [key, value] of Object.entries(leases)) await redis.set(key, value, { ex: 60 });
    const preview = await previewAiRunReset({ runId, archiveDirectory, redis });
    assert.equal(preview.canReset, true, preview.blockers.join('; '));
    assert.deepEqual(fs.readdirSync(archiveDirectory), []);
    let acknowledgements = 0;
    const acknowledge = async (run: { archive: { path: string }; runId: string }) => {
      acknowledgements++;
      assert.equal(JSON.parse(fs.readFileSync(run.archive.path, 'utf8')).preview.sourceDigest, preview.sourceDigest);
      assert.equal((await redis.get<{ runId: string }>('brain:v6:activeRun'))?.runId, runId);
      assert.equal(await redis.get(aiRunKeys(runId).ledgerAcknowledged), null);
      assert.deepEqual(await redis.readRaw(preservedKeys), preserved);
    };
    const active = await resetAiRun({ preview, leases, redis, acknowledge });
    assert.equal(active.initialCapital, 10000);
    assert.equal((await redis.get<{ usd: number }>(aiRunKeys(runId).portfolio))?.usd, 10000);
    assert.equal(await redis.get(aiRunKeys(runId).ledgerAcknowledged), true);
    await redis.set(aiRunKeys(runId).portfolio, { usd: 9950, openPositions: {}, balances: {} });
    await redis.set('ai:portfolio', { usd: 9950, openPositions: {}, balances: {} });
    assert.deepEqual(await resetAiRun({ preview, leases, redis, acknowledge }), active);
    assert.equal(acknowledgements, 1);
    assert.equal((await redis.get<{ usd: number }>(aiRunKeys(runId).portfolio))?.usd, 9950);
    assert.equal((await redis.get<{ usd: number }>('ai:portfolio'))?.usd, 9950);
    assert.deepEqual(await redis.readRaw(preservedKeys), preserved);
  });
});
