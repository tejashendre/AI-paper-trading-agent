import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as coverage from '@/lib/trading/coverageStatus';
test('archive failures remain visible with the last successful capture',()=>{
  const describe=(coverage as any).describeResearchCapture;
  assert.equal(typeof describe,'function','capture errors currently appear as healthy archive text');
  assert.match(describe([{asset:'BTC',status:'CAPTURE_ERROR',lastCapturedAt:'2026-10-01T10:00:00Z'}]),
    /BTC.*failed.*2026-10-01T10:00:00Z/);
  assert.match(describe([{asset:'ETH',status:'STORAGE_LIMIT'}]),/Storage limit/);
  assert.match(describe([]),/Waiting for/);
  assert.match(describe([{asset:'BTC',status:'CAPTURED'}]),/Closed bars/);
});
