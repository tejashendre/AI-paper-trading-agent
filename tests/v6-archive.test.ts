import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceHash } from '../src/lib/strategy/v6/evidence';
const archiveModule=import('../src/lib/strategy/v6/archive').catch(()=>null);
test('decision archives deduplicate feature bars and reconstruct exact clocks and source hashes',async()=>{
  const archive=await archiveModule;assert.ok(archive);
  const directory=mkdtempSync(path.join(os.tmpdir(),'brain-archive-'));
  const bars={h4:[{time:0,open:1,high:2,low:.5,close:1.5,volume:1}],d1:[],h4AvailableAtMs:100,d1AvailableAtMs:101,sourceHash:'source'};
  const tape={frames:[{bars,availableAtMs:102}],captures:[{value:{bars}}]};
  const decisionId=evidenceHash(tape);
  archive.persistBrainDecisionArchive({directory,runId:'archive-proof',decisionId,tape,maxBytes:100000});
  assert.deepEqual(archive.readBrainDecisionArchive({directory,runId:'archive-proof',decisionId}),tape);
  archive.persistBrainDecisionArchive({directory,runId:'archive-proof',decisionId,tape,maxBytes:100000});
  const next={...tape,atMs:200};archive.persistBrainDecisionArchive({directory,runId:'archive-proof',decisionId:evidenceHash(next),tape:next,maxBytes:100000});
  assert.equal(readdirSync(path.join(directory,'features')).length,1);
});
test('archive budget exhaustion refuses new evidence before writes and preserves all earlier files',async()=>{
  const archive=await archiveModule;assert.ok(archive);
  const directory=mkdtempSync(path.join(os.tmpdir(),'brain-archive-cap-')),tape={now:1};
  const decisionId=evidenceHash(tape);archive.persistBrainDecisionArchive({directory,runId:'cap-proof',decisionId,tape,maxBytes:100000});
  assert.throws(()=>archive.persistBrainDecisionArchive({directory,runId:'cap-proof',decisionId:evidenceHash({now:2}),tape:{now:2},maxBytes:1}),/budget|limit/i);
  assert.deepEqual(archive.readBrainDecisionArchive({directory,runId:'cap-proof',decisionId}),tape);
});
