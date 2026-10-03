import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionLedger } from '@/lib/trading/executionLedger';
import { evaluatePromotion, recordPromotionReview, evaluateDemotion } from '@/lib/research/candidateRegistry';
import { setRedisClient } from '@/lib/redis';
import { definition, outcomes } from './helpers/researchFixtures';
import { MemoryRedis } from './helpers/memoryRedis';

async function isolated(run: (directory: string, redis: MemoryRedis) => Promise<void>) {
  const old = process.env.EXECUTION_LEDGER_DIR;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-ledger-'));
  const redis = new MemoryRedis(); setRedisClient(redis); process.env.EXECUTION_LEDGER_DIR = directory;
  try { await run(directory, redis); }
  finally { setRedisClient(null); if (old === undefined) delete process.env.EXECUTION_LEDGER_DIR; else process.env.EXECUTION_LEDGER_DIR = old; }
}
function records(directory: string) {
  return fs.readdirSync(directory).filter(f => f.endsWith('.ndjson')).flatMap(f =>
    fs.readFileSync(path.join(directory, f), 'utf8').trim().split('\n').map(row => JSON.parse(row)));
}

test('rare transition proof retains more than 250 inputs and its exact decision hash', async () => isolated(async directory => {
  const base = outcomes(40).map(row => ({...row, researchOrigin:'SHADOW' as const}));
  const input = { definition, trials:[definition], holdoutConsumed:false, feesVerified:true,
    outcomes:[...base, ...Array.from({length:216}, (_,i) => ({...base[i%40], positionId:'other-'+i, configHash:'another-cohort'}))] };
  const report = evaluatePromotion(input); assert.equal(report.eligible, true);
  await recordPromotionReview(definition, report, [], input);
  const event = records(directory).find(row => row.type === 'RESEARCH_PROMOTED');
  assert.equal(event.payload.promotionEvidence.outcomes.length, 256);
  assert.equal(evaluatePromotion(event.payload.promotionEvidence).reportHash, report.reportHash);
}));

test('large final records permit subsequent financial appends and head recovery without a chain fork', async () => isolated(async directory => {
  await ExecutionLedger.record({type:'RESEARCH_PROMOTED',source:'TEST',payload:{note:'x'.repeat(200000),apiKey:'test-only-redaction'}});
  const rows = records(directory); assert.equal(rows[0].payload.apiKey, '[REDACTED]');
  await ExecutionLedger.record({type:'ENTRY_FILLED',source:'TEST',payload:{accounting:'preserved'}});
  assert.equal(ExecutionLedger.verify(directory).valid, true);
  // Recovery cannot assume the large preceding event fits inside 128 KiB.
  fs.unlinkSync(path.join(directory, 'head.json'));
  await ExecutionLedger.record({type:'FUNDING_SETTLED',source:'TEST',payload:{cashflow:1}});
  assert.equal(ExecutionLedger.verify(directory).valid, true);
}));

test('demotion and book-release proof arrays are lossless while telemetry stays bounded', async () => isolated(async directory => {
  const rows = Array.from({length:300}, (_,i) => ({sample:i}));
  await ExecutionLedger.record({type:'RESEARCH_DEMOTED',source:'TEST',payload:{paperEvidence:rows}});
  await ExecutionLedger.record({type:'BOOK_RISK_RELEASED',source:'TEST',payload:{evidenceCurve:rows}});
  await ExecutionLedger.record({type:'SCAN_COMPLETED',source:'TEST',payload:{rows}});
  const events=records(directory);
  assert.equal(events[0].payload.paperEvidence.length,300);
  assert.equal(events[1].payload.evidenceCurve.length,300);
  assert.equal(events[2].payload.rows.length,250);
}));

test('failed durable promotion proof cannot publish activation and retries once storage recovers', async () => isolated(async (directory, redis) => {
  const input = { definition, outcomes:outcomes(40).map(row => ({...row,researchOrigin:'SHADOW' as const})), trials:[definition], holdoutConsumed:false,feesVerified:true };
  const report=evaluatePromotion(input); assert.equal(report.eligible,true);
  const unavailable=path.join(directory,'not-a-directory'); fs.writeFileSync(unavailable,'fixture');
  process.env.EXECUTION_LEDGER_DIR=unavailable;
  await assert.rejects(recordPromotionReview(definition,report,[],input));
  const mode = await redis.get<{mode:string}>(`research:${definition.strategyVersion}:candidates:review:${definition.candidateId}`);
  assert.notEqual(mode?.mode,'PAPER_ACTIVE');
  process.env.EXECUTION_LEDGER_DIR=directory;
  assert.equal(await recordPromotionReview(definition,report,[],input),'PAPER_ACTIVE');
  assert.equal(records(directory).filter(row => row.type==='RESEARCH_PROMOTED').length,1);
}));

test('demotion still halts risk on a ledger outage and preserves its proof for retry', async () => isolated(async (directory, redis) => {
  const input={definition,outcomes:outcomes(40).map(row=>({...row,researchOrigin:'SHADOW' as const})),trials:[definition],holdoutConsumed:false,feesVerified:true};
  const report=evaluatePromotion(input);
  await recordPromotionReview(definition,report,[],input);
  const paper=outcomes(7).map(row=>({...row,researchOrigin:'PAPER',netR:-1.1,netPnlUsdt:-110}));
  const unavailable=path.join(directory,'not-a-directory');fs.writeFileSync(unavailable,'fixture');process.env.EXECUTION_LEDGER_DIR=unavailable;
  assert.equal(await recordPromotionReview(definition,report,paper,input),'REJECTED');
  const key=`research:${definition.strategyVersion}:candidates:review:${definition.candidateId}`;
  const state=await redis.get<any>(key);
  assert.equal(state.mode,'REJECTED');assert.ok(state.pendingTransition,'risk reduction needs a recoverable proof');
  process.env.EXECUTION_LEDGER_DIR=directory;
  await recordPromotionReview(definition,report,[],input);
  const event=records(directory).find(row=>row.type==='RESEARCH_DEMOTED');
  assert.deepEqual(evaluateDemotion(event.payload.paperEvidence),event.payload.demotion);
  assert.equal((await redis.get<any>(key)).pendingTransition,undefined);
}));

test('activation requires the exact evidence that produced the eligible report', async () => isolated(async (_directory, redis) => {
  const input={definition,outcomes:outcomes(40).map(row=>({...row,researchOrigin:'SHADOW' as const})),trials:[definition],holdoutConsumed:false,feesVerified:true};
  const report=evaluatePromotion(input);
  await assert.rejects(recordPromotionReview(definition,report));
  await assert.rejects(recordPromotionReview(definition,report,[],{...input,outcomes:[]}));
  assert.equal(await redis.get(`research:${definition.strategyVersion}:candidates:review:${definition.candidateId}`),null);
}));

test('a durable proof is not duplicated after a failed activation acknowledgement', async () => isolated(async (directory, redis) => {
  const input={definition,outcomes:outcomes(40).map(row=>({...row,researchOrigin:'SHADOW' as const})),trials:[definition],holdoutConsumed:false,feesVerified:true};
  const report=evaluatePromotion(input), original=redis.set.bind(redis);
  redis.set=async (key,value,options) => {
    if ((value as any)?.mode==='PAPER_ACTIVE') throw new Error('fixture acknowledgement unavailable');
    return original(key,value,options);
  };
  await assert.rejects(recordPromotionReview(definition,report,[],input));
  redis.set=original;
  assert.equal(await recordPromotionReview(definition,report,[],input),'PAPER_ACTIVE');
  assert.equal(records(directory).filter(row=>row.type==='RESEARCH_PROMOTED').length,1);
}));
