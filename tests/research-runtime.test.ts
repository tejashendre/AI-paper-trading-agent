import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectLabelPath } from '@/lib/trading/opportunityJournal';
import { MemoryRedis } from './helpers/memoryRedis';
import { setRedisClient } from '@/lib/redis';
import { ensureResearchBaselines, reviewRegisteredCandidates } from '@/lib/research/researchLoop';
import { getCandidateRegistry } from '@/lib/research/candidateRegistry';
test('label path excludes future bars and gaps without a later live-price substitution', () => {
  const bars=Array.from({length:5},(_,i)=>({time:i*300,open:100,high:101,low:99,close:100+i,volume:1}));
  assert.equal(selectLabelPath(bars,0,1200000,300000)?.at(-1)?.close,103);
  assert.equal(selectLabelPath(bars.filter(b=>b.time!==300),0,1200000,300000),null);
});
test('runtime preregisters exactly two baselines per asset and never activates them without evidence', async () => {
  setRedisClient(new MemoryRedis());
  try {
    await ensureResearchBaselines(); await ensureResearchBaselines();
    assert.equal((await getCandidateRegistry()).length,18);
    const status=await reviewRegisteredCandidates();
    assert.equal(status.trialCount,18);
    assert.ok(status.candidates.every(c=>c.mode==='SHADOW' && c.reasons.includes('INSUFFICIENT_FORWARD_SHADOW')));
    // Owner chose full autonomy (2026-10-02): evidence, not a person, activates.
    assert.equal(status.activationRequiresHumanReview,false);
  } finally {setRedisClient(null);}
});
