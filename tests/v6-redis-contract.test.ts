import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRedisProxy, brainEntryReceipt, type BrainEntryCommit, type BrainObservationCommit } from '@/lib/redis';
import { MemoryRedis } from './helpers/memoryRedis';

test('production Redis wrapper forwards NX without requiring an expiry', async () => {
  const commands: unknown[][] = [];
  const values = new Map<string, unknown>();
  const proxy = Object.create(LocalRedisProxy.prototype) as LocalRedisProxy;
  Object.defineProperty(proxy, 'client', { value: {
    set: async (...args: unknown[]) => {
      commands.push(args);
      const [key, value] = args as [string, string];
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
  } });

  assert.equal(await proxy.set('immutable-definition', { version: 1 }, { nx: true }), 'OK');
  assert.equal(await proxy.set('immutable-definition', { version: 2 }, { nx: true }), null);
  assert.equal(values.get('immutable-definition'), '{"version":1}');
  assert.deepEqual(commands, [
    ['immutable-definition', '{"version":1}', 'NX'],
    ['immutable-definition', '{"version":2}', 'NX'],
  ]);
});

test('production observation proxy rejects every non-string write before eval and memory rejects without partial writes', async () => {
  let evaluations = 0;
  const proxy = Object.create(LocalRedisProxy.prototype) as LocalRedisProxy;
  Object.defineProperty(proxy, 'client', { value: { eval: async () => { evaluations++; return 1; } } });
  const redis = new MemoryRedis(), prefix = 'brain:v6:run:observation-review:';
  await redis.set('brain:v6:activeRun', { runId: 'observation-review' });
  await redis.set('portfolio:write-lock:ai', 'review-lease', { ex: 30 });
  const keys = ['brain:v6:activeRun', prefix + 'shadow', prefix + 'breakers'];
  const before = await redis.readRaw(keys);
  for (const malformed of [{ invalid: 'not a Redis argument' }, null, 5, false, []]) {
    const input = { runId: 'observation-review', leaseToken: 'review-lease', expected: before,
      writes: { [prefix + 'shadow']: '{"sequence":1}', [prefix + 'breakers']: malformed } } as unknown as BrainObservationCommit;
    await assert.rejects(() => proxy.commitBrainObservation(input), /write.*string|invalid.*write/i);
    assert.equal(evaluations, 0, 'malformed payload never reaches the production Lua backend');
    await assert.rejects(() => redis.commitBrainObservation(input), /write.*string|invalid.*write/i);
    assert.deepEqual(await redis.readRaw(keys), before, 'no preceding observation write can survive validation failure');
  }
});

test('production financial proxy rejects nested serialized payloads before eval and memory preserves the complete old state', async () => {
  let evaluations = 0;
  const proxy = Object.create(LocalRedisProxy.prototype) as LocalRedisProxy;
  Object.defineProperty(proxy, 'client', { value: { eval: async () => { evaluations++; return 'unexpected'; } } });
  const redis = new MemoryRedis(), prefix = 'brain:v6:run:financial-review:';
  await redis.set('brain:v6:activeRun', { runId: 'financial-review' });
  await redis.set('portfolio:write-lock:ai', 'review-lease', { ex: 30 });
  await redis.set(prefix + 'ledgerAcknowledged', true);
  await redis.set(prefix + 'portfolio', { usd: 10000, openPositions: {} });
  const keys = ['brain:v6:activeRun', prefix + 'portfolio', 'ai:portfolio', prefix + 'trades', prefix + 'outbox:event:one'];
  const before = await redis.readRaw(keys);
  const portfolio = JSON.stringify({ usd: 9990, openPositions: { BTC: { positionId: 'one' } } });
  const trade = JSON.stringify({ id: 'one', brainRunId: 'financial-review', action: 'BUY' });
  const event = { id: 'event:one', event: JSON.stringify({ id: 'event:one' }) };
  for (const financial of [
    { portfolio: [portfolio], trades: [trade], events: [event] },
    { portfolio, trades: [[trade]], events: [event] },
    { portfolio, trades: [trade], events: [{ ...event, event: [event.event] }] },
  ]) {
    const input = { runId: 'financial-review', transactionId: 'review', leaseToken: 'review-lease',
      expected: before, ...financial, expiresAtMs: Date.now() + 10000 } as unknown as BrainEntryCommit;
    input.receipt = brainEntryReceipt(input);
    await assert.rejects(() => proxy.commitBrainEntry(input), /string|financial.*payload/i);
    assert.equal(evaluations, 0, 'malformed financial fields never reach Lua');
    await assert.rejects(() => redis.commitBrainEntry(input), /string|financial.*payload/i);
    assert.deepEqual(await redis.readRaw(keys), before, 'portfolio, mirror, trades and outbox remain untouched');
  }
});
