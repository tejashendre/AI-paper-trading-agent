# Release compatibility fixes, 28 October 2026

The scoped fixes preserve the approved strategy definitions, risk calculations, evidence qualification, original financial event timestamps, existing history and human account behavior. They do not initialize capital, execute a reset, place an order, change authentication or alter network policy. The controller owns publication, production checks and deployment.

## Confirmed faults and changes

1. A delayed financial outbox event or backdated reset acknowledgement selected an earlier ledger day and forked the chronological hash chain. The append segment now advances monotonically from the latest segment. A compressed latest segment remains untouched and the next append starts a later segment. The record retains its original event timestamp. Readers, idempotency lookup and compaction continue to use the existing format. No old ledger file is migrated or rewritten by append.
2. A daemon waiting for its first acknowledged epoch published scan ID zero and no ledger progress. The waiting branch now publishes an advancing counter and durable SCAN_COMPLETED heartbeat with RESET_REQUIRED and zero capital allocated. It acquires the AI write lease, checks migration freeze, and rereads epoch and acknowledgement before changing the counter or ledger/status heads. A held reset lease or freeze produces no heartbeat writes. A failed ledger append cannot publish healthy status. No portfolio or capital is created.
3. XSEC retirement made the old 13-hour rebalance health check fail permanently. The Docker probe now uses a small read-only script. Retirement requires a valid active replacement pointer, explicit HISTORICAL_ONLY mode, durable acknowledgement, fresh matching run and release heartbeat, positive numeric progress, and a flat, valid historical XSEC account without liabilities. Missing, mismatched, stale or malformed state fails closed. A legacy book retains its rebalance requirement. The existing Dockerfile already copies the scripts directory.
4. The scheduled monitor applied retired v5 funnels and queue counters to v6. It now reads the existing public /api/brain projection when status identifies v6 and checks current epoch, release, source freshness, account equity, risk halts, protective sweep, and pending funding or ledger reconciliation. SHADOW inactivity does not require invented fills. XSEC overdue is waived only for a fresh matching replacement projection; remaining historical positions still alert. Closed-weekend TradFi capture unavailability follows the existing weekend exception, while crypto freshness and strategy integrity remain checked. Legacy monitoring is preserved.
5. Batch-level transaction receipts allowed entry [A,B], close A, then entry [A] to reuse an entry through a different batch transaction ID. The atomic Redis mutation now checks durable per-entry trade and position markers before its first financial write and writes those markers in the same transaction. The in-memory adapter implements the same contract. Identical original batch retries retain their receipt behavior. The runtime excludes an already committed setup before allocation. Duplicate positions within a single batch also refuse before writes. Existing run namespace archival covers the markers.

## Verification

The delayed-event, existing backdated reset, zero-progress heartbeat and partial-batch entry regressions were observed failing before their fixes. Additional negative regressions cover reset lease/freeze races, an epoch acknowledged during heartbeat lease acquisition, ledger append failure, closed-position setup reuse, malformed retirement clocks, stale/mismatched releases, unresolved funding, stale protection, missing source telemetry and weekend boundaries.

Observed red commands and counts:

- `node --import tsx --test tests/ledger-delayed-events.test.ts tests/v6-runtime.test.ts tests/v6-reset.test.ts`: 31 tests, 28 passed and 3 failed on delayed ledger linkage, existing reset chain validity and zero heartbeat scan ID.
- `node --import tsx --test tests/v6-entry-transaction.test.ts tests/ledger-delayed-events.test.ts`: 11 tests, 10 passed and 1 failed because partial-batch entry reuse was accepted.
- `node --import tsx --test tests/health-monitor.test.ts`: initially 9 tests, 7 passed and 2 failed because retired v5 queue/funnel/XSEC alerts remained active. The later closed-weekend source regression also failed before the exception was added.
- `node --import tsx --test tests/xsec-healthcheck.test.ts`: initially 2 tests, 1 passed and 1 failed because Docker still invoked the old probe. Later negative retirement cases failed on missing account cash and string progress before strict validation was added.
- `node --import tsx --test tests/v6-runtime.test.ts`: 16 tests, 14 passed and 2 failed before the waiting heartbeat acquired the AI lease and reread the epoch. The failures showed altered reset snapshots and stale RESET_REQUIRED publication.

Final fresh verification:

```text
node --import tsx --test tests/ledger-delayed-events.test.ts tests/ledger-compaction.test.ts tests/ledger-maintenance.test.ts tests/ledger-multiprocess.test.ts tests/v6-entry-transaction.test.ts tests/v6-runtime.test.ts tests/v6-reset.test.ts tests/v6-redis-contract.test.ts tests/health-monitor.test.ts tests/xsec-healthcheck.test.ts
```

All 71 tests passed, with zero failures. This includes byte-identical old-day preservation during append, original timestamp preservation after compaction, archived-tail continuation, compressed reader verification, idempotency lookup after relocation and compaction, prefix verification, and concurrent writers.

`npx tsc --noEmit --incremental false`, scoped ESLint over all edited TypeScript/JavaScript and `git diff --check` passed. ESLint emitted only the existing ancestor configuration deprecation warning. The whole-branch build and broader regression suite remain the controller's checks. The deploy checker remains unchanged: the waiting branch now supplies the positive, advancing scan IDs its existing contract requires.

The local machine has no Redis server or Docker runtime available. Lua argument contracts and in-memory atomic behavior were exercised locally; the new server-side Lua guard was inspected but has not been executed against a local Redis instance. No production network, environment file, key or account payload was read by this work. GitHub's public HTTP 403 is left to the controller's existing origin/network investigation.

## TypeScript verification correction

The controller's fresh TypeScript run found that the newly destructured `brain` argument was inferred as required for legacy callers. An independent rerun reproduced the failure with exit code 2. The argument now defaults to undefined, preserving the intended optional runtime contract and all existing tests. A fresh standalone `npx tsc --noEmit --incremental false` completed with exit code 0, and `node --import tsx --test tests/health-monitor.test.ts` passed all 10 tests with exit code 0.

The earlier combined verification calls retained only output text and discarded command session metadata. They did not establish the final TypeScript exit status. The earlier TypeScript success claim was therefore incorrect; the explicit completed standalone result above replaces it.
