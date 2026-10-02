import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
function run(stopFails = false, compactFails = false) {
  const script = path.resolve('scripts/release-ledger-maintenance.sh').replace(/\\/g, '/');
  const command = `docker() { printf '%s\\n' "$*"; if [ "$2" = stop ] && [ "${stopFails}" = true ]; then return 1; fi; if [ "\${8:-}" = scripts/ledger-compact.ts ] && [ "${compactFails}" = true ]; then return 1; fi; }; export -f docker; bash '${script}';`;
  return spawnSync(bash, ['-c', command], { encoding: 'utf8' });
}
test('release stops the dashboard and both daemons before compacting and verifies the result', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const calls = result.stdout.trim().split(/\r?\n/);
  assert.equal(calls[0], 'compose stop quant-dashboard swing-daemon xsec-daemon');
  assert.match(calls[1], /ledger-compact.ts --apply$/);
  assert.match(calls[2], /verify-execution-ledger.ts$/);
});
test('a failed writer stop never proceeds to compaction', () => {
  const result = run(true);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /ledger-compact/);
});
test('a compaction failure is a failed release, rather than a success claim', () => {
  assert.notEqual(run(false, true).status, 0);
});
