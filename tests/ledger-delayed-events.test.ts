import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionLedger, archiveLedgerDays, compactLedger } from '@/lib/trading/executionLedger';
import { setRedisClient } from '@/lib/redis';
import { MemoryRedis } from './helpers/memoryRedis';

test('delayed financial and reset events preserve timestamps and append after the latest day', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-delayed-'));
  const before = process.env.EXECUTION_LEDGER_DIR;
  process.env.EXECUTION_LEDGER_DIR = directory;
  setRedisClient(new MemoryRedis());
  t.after(() => {
    if (before === undefined) delete process.env.EXECUTION_LEDGER_DIR;
    else process.env.EXECUTION_LEDGER_DIR = before;
    setRedisClient(null);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await ExecutionLedger.record({ id: 'old-history', timestamp: '2020-01-01T23:58:00.000Z', type: 'ENTRY_FILLED', source: 'test', payload: {} });
  const history = fs.readFileSync(path.join(directory, '2020-01-01.ndjson'));
  const newer = await ExecutionLedger.record({ id: 'new-day', timestamp: '2020-01-02T00:01:00.000Z', type: 'SCAN_COMPLETED', source: 'test', payload: {} });
  const delayed = { id: 'delayed-exit', timestamp: '2020-01-01T23:59:00.000Z', type: 'EXIT_FILLED' as const, source: 'test', payload: { financialTimestamp: '2020-01-01T23:59:00.000Z' } };
  const exit = await ExecutionLedger.recordOnce(delayed);
  assert.equal(exit.previousHash, newer.hash);
  assert.equal(exit.timestamp, delayed.timestamp);
  assert.deepEqual(fs.readFileSync(path.join(directory, '2020-01-01.ndjson')), history);
  assert.equal(ExecutionLedger.hasEvent(delayed.id, delayed.timestamp), true);
  assert.equal(ExecutionLedger.verify().valid, true);
  assert.equal((await ExecutionLedger.recordOnce(delayed)).hash, exit.hash);
  await archiveLedgerDays({ directory, keepDays: 1 });
  const reset = await ExecutionLedger.recordOnce({ id: 'reset-ack', timestamp: '2020-01-01T12:00:00.000Z', type: 'AI_RUN_STARTED', source: 'test', payload: {} });
  assert.equal(reset.previousHash, exit.hash);
  assert.equal(ExecutionLedger.verify().valid, true, ExecutionLedger.verify().errors.join('; '));
  const compacted = compactLedger({ directory, dropTypes: ['SCAN_COMPLETED'], minDropBytes: 0 });
  assert.equal(compacted.status, 'COMPACTED');
  assert.equal(ExecutionLedger.verify().valid, true);
  assert.equal(ExecutionLedger.hasEvent(delayed.id, delayed.timestamp), true);
  assert.equal((await ExecutionLedger.recordOnce(delayed)).timestamp, delayed.timestamp);
});

test('recordOnce reuses verified days and still rejects altered history', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-repeat-'));
  const before = process.env.EXECUTION_LEDGER_DIR;
  process.env.EXECUTION_LEDGER_DIR = directory;
  setRedisClient(new MemoryRedis());
  t.after(() => {
    if (before === undefined) delete process.env.EXECUTION_LEDGER_DIR;
    else process.env.EXECUTION_LEDGER_DIR = before;
    setRedisClient(null);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const completion = { id: 'completed', timestamp: '2026-01-01T00:01:00.000Z', type: 'POSITION_COMPLETED' as const, source: 'test', payload: {} };
  const recorded = await ExecutionLedger.recordOnce(completion);
  await ExecutionLedger.record({ ...completion, id: 'next-day', timestamp: '2026-01-02T00:01:00.000Z' });
  await archiveLedgerDays({ directory, keepDays: 1 });
  await ExecutionLedger.recordOnce(completion);

  const hash = t.mock.method(crypto, 'createHash');
  assert.equal((await ExecutionLedger.recordOnce(completion)).hash, recorded.hash);
  assert.equal(hash.mock.callCount(), 0, 'unchanged days should not be rehashed on each retry');

  await ExecutionLedger.record({ ...completion, id: 'later', timestamp: '2026-01-03T00:01:00.000Z' });
  hash.mock.resetCalls();
  assert.equal((await ExecutionLedger.recordOnce(completion)).hash, recorded.hash);
  assert.equal(hash.mock.callCount(), 1, 'a new day should not rehash unchanged history');

  const archive = path.join(directory, '2026-01-02.ndjson.gz');
  const row = gunzipSync(fs.readFileSync(archive)).toString();
  fs.writeFileSync(archive, gzipSync(row.replace('"next-day"', '"tampered"')));
  await assert.rejects(ExecutionLedger.recordOnce(completion), /ledger is invalid/);
});
