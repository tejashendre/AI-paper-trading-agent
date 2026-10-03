import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

/**
 * Runs the real release script in a temporary project folder with `docker`
 * stubbed: every call is printed, the dry run reports `plan`, and individual
 * steps can be made to fail.
 */
function run(options: { stopFails?: boolean; compactFails?: boolean; copyVerifyFails?: boolean; plan?: string } = {}) {
  const { stopFails = false, compactFails = false, copyVerifyFails = false, plan = 'WOULD_COMPACT' } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ledger-'));
  fs.mkdirSync(path.join(root, 'data', 'execution-ledger'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'execution-ledger', '2026-10-01.ndjson'), '{"type":"ENTRY_FILLED"}\n');
  fs.mkdirSync(path.join(root, 'backup'));
  const script = path.resolve('scripts/release-ledger-maintenance.sh').replace(/\\/g, '/');
  const cwd = root.replace(/\\/g, '/');
  const command = [
    `docker() {`,
    `  printf '%s\\n' "$*";`,
    `  if [ "$2" = stop ] && [ "${stopFails}" = true ]; then return 1; fi;`,
    `  if [ "\${8:-}" = scripts/ledger-compact.ts ] && [ -z "\${9:-}" ]; then printf '  "status": "%s",\\n' "${plan}"; fi;`,
    `  if [ "\${9:-}" = --apply ] && [ "${compactFails}" = true ]; then return 1; fi;`,
    `  if [ "\${9:-}" = --directory ] && [ "${copyVerifyFails}" = true ]; then return 1; fi;`,
    `  return 0;`,
    `};`,
    `export -f docker; cd '${cwd}' && bash '${script}' backup;`,
  ].join(' ');
  const result = spawnSync(bash, ['-c', command], { encoding: 'utf8' });
  const calls = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('compose'));
  const copied = fs.existsSync(path.join(root, 'backup', 'execution-ledger', '2026-10-01.ndjson'));
  fs.rmSync(root, { recursive: true, force: true });
  return { ...result, calls, copied };
}

test('release stops writers, copies and verifies the ledger, then compacts and verifies the result', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls[0], 'compose stop quant-dashboard swing-daemon xsec-daemon');
  assert.match(result.calls[1], /ledger-compact\.ts$/, 'dry run first');
  assert.match(result.calls[2], /verify-execution-ledger\.ts --directory backup\/execution-ledger$/, 'the copy is verified');
  assert.match(result.calls[3], /ledger-compact\.ts --apply$/);
  assert.match(result.calls[4], /verify-execution-ledger\.ts$/);
  assert.equal(result.copied, true, 'the full ledger was not copied into the backup');
});
test('nothing is copied or compacted when the dry run finds too little to reclaim', () => {
  const result = run({ plan: 'SKIPPED_BELOW_THRESHOLD' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.calls.some((call) => call.includes('--apply')));
  assert.equal(result.copied, false);
  assert.match(result.calls.at(-1)!, /verify-execution-ledger\.ts$/);
});
test('a failed writer stop never proceeds to compaction', () => {
  const result = run({ stopFails: true });
  assert.notEqual(result.status, 0);
  assert.ok(!result.calls.some((call) => call.includes('ledger-compact')));
});
test('a copy that fails verification stops before anything is deleted', () => {
  const result = run({ copyVerifyFails: true });
  assert.notEqual(result.status, 0);
  assert.ok(!result.calls.some((call) => call.includes('--apply')));
});
test('a compaction failure is a failed release, rather than a success claim', () => {
  assert.notEqual(run({ compactFails: true }).status, 0);
});
