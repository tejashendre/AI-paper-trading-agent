import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryRedis } from './helpers/memoryRedis';
import { definition, outcomes } from './helpers/researchFixtures';
import { setRedisClient } from '@/lib/redis';
import { evaluateDemotion, evaluatePromotion, registerCandidate } from '@/lib/research/candidateRegistry';
import { reviewRegisteredCandidates, storeResearchOutcome } from '@/lib/research/researchLoop';
import * as display from '@/lib/research/researchDisplay';

test('progress shows independent positions, elapsed days and bootstrap lower bound without implying eligibility', () => {
  const progress = (display as any).promotionProgress;
  assert.equal(typeof progress, 'function');
  const text = progress({ forwardPositions: 12, forwardSpanMs: 5 * 86400000, forwardExpectancy95: { low: -0.001, high: 0.003 } });
  assert.match(text, /12\/30/);
  assert.match(text, /5\.0\/14/);
  assert.match(text, /-0\.100%/);
  assert.match(progress({}), /unavailable/);
});

test('runtime promotion records enough immutable evidence to reproduce its exact gate decision', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-proof-'));
  const previous = process.env.EXECUTION_LEDGER_DIR;
  process.env.EXECUTION_LEDGER_DIR = directory;
  setRedisClient(new MemoryRedis());
  try {
    await registerCandidate(definition);
    for (const row of outcomes(40)) await storeResearchOutcome({ ...row, researchOrigin: 'SHADOW' });
    const status = await reviewRegisteredCandidates();
    const candidate = status.candidates.find(c => c.candidateId === definition.candidateId)!;
    assert.equal(candidate.mode, 'PAPER_ACTIVE');
    const rows = fs.readdirSync(directory).filter(f => f.endsWith('.ndjson')).flatMap(f =>
      fs.readFileSync(path.join(directory, f), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    const promotion = rows.find(r => r.type === 'RESEARCH_PROMOTED');
    assert.ok(promotion);
    assert.ok(promotion.payload.promotionEvidence, 'promotion must preserve its decision inputs');
    const replayed = evaluatePromotion(promotion.payload.promotionEvidence);
    assert.equal(replayed.eligible, true);
    assert.equal(replayed.reportHash, promotion.payload.reportHash);
    assert.equal(candidate.metrics.forwardRequiredPositions, 30);
    for (const row of outcomes(7)) await storeResearchOutcome({ ...row, positionId: 'live-' + row.positionId,
      researchOrigin: 'PAPER', netR: -1.1, netPnlUsdt: -110, returnOnInitialMargin: -0.11 });
    const demoted = await reviewRegisteredCandidates();
    assert.equal(demoted.candidates.find(c => c.candidateId === definition.candidateId)?.mode, 'REJECTED');
    const latest = fs.readdirSync(directory).filter(f => f.endsWith('.ndjson')).flatMap(f =>
      fs.readFileSync(path.join(directory, f), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    const demotion = latest.find(r => r.type === 'RESEARCH_DEMOTED');
    assert.ok(demotion?.payload.paperEvidence);
    assert.deepEqual(evaluateDemotion(demotion.payload.paperEvidence), demotion.payload.demotion);
  } finally {
    setRedisClient(null);
    if (previous === undefined) delete process.env.EXECUTION_LEDGER_DIR; else process.env.EXECUTION_LEDGER_DIR = previous;
  }
});
