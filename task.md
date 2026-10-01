# Active work

- [x] Audit asset coverage, decision gates, execution, and learning with current runtime evidence.
- [x] Produce an evidence-linked strategy improvement plan prioritizing all configured asset classes and no mandatory LLM cost.
## 2026-10-01 audit checkpoint
- [x] Verified current routing, entry provenance, whole-position learning discrepancy, and live book restriction.
- [x] Saved docs/STRATEGY_COVERAGE_AUDIT_2026-10-01.md plus sanitized runtime and diagnostic evidence.
- [x] Ran existing strategy audit (179 pass, 1 warning, 0 fail), actual-code diagnostics, and TypeScript check.
- [ ] Proposed first repair slice: centralize instrument provenance and test all nine correct instrument paths plus forged/stale negatives.

Trading changes and deployment remain pending. User priority is broader coverage across all configured asset classes. Next planning evidence: audit Sections 1, 2, and the acceptance sequence. Preserve historical learning and account records.

## 2026-10-01 Bybit implementation handoff

- [x] Verify Trading metadata, REST candles, and actual WS ticker snapshots/deltas for all nine configured Bybit instruments.
- [x] Write and self-review the complete [implementation plan](docs/superpowers/plans/2026-10-01-bybit-all-assets-upgrade.md), with tests, migration, research, and rollout gates.
- [x] Link the current plan from documentation and project state, preserving the prior audit and research evidence.
- [ ] Implement Release A, beginning with Task 1's shared registry and public client, then immutable position economics. Do not deploy a routing-only change before settlement and migration checks pass.

Latest user direction: Bybit for every configured asset. Plan includes EURUSDUSDT, GBPUSDUSDT, and USDJPYUSDT instead of the earlier Kraken/Yahoo alternatives. Implementing trading changes is a later action; this completed slice writes the implementation handoff only.

## 2026-10-01 Release A implementation (branch claude/bybit-all-assets-release-a)

Scope: plan Tasks 1-7, 11, Release A checks of 12, in order, test-first. Out of scope: account resets, rewriting fills, risk-limit increases, mandatory LLM, push to main, deployment, live migration apply.

- [x] Task 1: registry + public Bybit client (commit 16e240c; 21/21 tests, tsc clean, audit 160/1 warn/0 fail = baseline)
- [x] Task 2: immutable position economics + offline migration preview (commit 12e5877; 38/38 tests, tsc + lint clean, audit 160/1/0)
- [x] Task 3: Bybit-only market paths, closed bars, single-venue health (commit b56849d; 69/69 tests, tsc + lint clean, audit 155/1/0 after superseded routing checks merged). Task 2 sizing gate closed.
  - Deferred to Task 5: depth fetch for slow tier at admission (capacity limits); perpUniverse shared all-linear ticker cache not done.
- [x] Task 4: shared entry eligibility gate (commit 9e43266; 105/105 tests, tsc + lint clean, audit 155/1/0; offline diagnostic: 9/9 correct paths pass, 0 forged accepted). Interim gate removed.
- [x] Task 5: linear settlement, lot rules, fees, funding
  - [x] 5a lot rules, fee schedules, fill capacity (commit 784ae93; 120/120 tests, tsc + lint clean, audit 155/1/0)
  - [x] 5b boundary-based idempotent funding for swing + XSEC, pending ledger drain, cash conservation (commit f49a599; 133/133 tests, tsc + lint clean, audit 155/1/0)
- [x] Task 6: full-position outcomes (commit 0e23b9d; 149/149 tests, tsc + lint clean, audit 155/1/0, fixture ledger valid 8 events, research:audit --input = 2 positions / 22 USDT)
- [x] Task 7: book risk policy (commit 0ed9ede; 167/167 tests, tsc + lint clean, audit 155/1/0). DEPLOY NOTE: live XSEC (28.15% lifetime DD, 24 positions) enters REDUCE_ONLY and unwinds on first sweep.
- [x] Task 11: coverage status API/dashboard (commit ea0d10b; 176/176 tests, tsc + lint clean, next build OK, audit 155/1/0). Rendered browser review NOT done: needs Redis data + authenticated session.
- [x] Task 12 (Release A subset): offline end-to-end proof, CI gate, runbook (commit 109b34c; 194/194 tests, audit 155/1/0, tsc + lint + build clean, fixture ledger valid 8 events, research:audit --input 2 positions)
  - [x] Runner `npm run test:upgrade` (fs-enumerated, no shell glob) and CI step before the strategy audit
  - [x] Import-safe daemons (`require.main` guard, checked under tsx 4.22 and pinned 4.19.1) and `setRedisClient` for in-memory tests
  - [x] tests/bybit-upgrade.integration.test.ts: real scan + watchdog vs fake Bybit fetch, in-memory Redis, temp ledger. 9/9 assets enter, fund once, exit, complete once; wrong metadata / stale quote / thin book / short history refused per asset; restart, partial, migration rerun, outage conserve state; XSEC breach only reduces; entry freeze keeps exits
  - [x] Fixes found by the fixture: EXIT_FILLED now precedes POSITION_COMPLETED; short-history HOLDs reported as WARMING_UP; capacity-capped sizes reported as LIQUIDITY; operator entry freeze `swing:entryFreeze`
  - [x] docs/BYBIT_ALL_ASSETS_ROLLOUT_RUNBOOK.md, docs/ARCHITECTURE.md refresh, docs/README.md link, in-container instrument check in scripts/vps-deploy-check.sh
  - [ ] Not done (needs authorization or live access): owner acceptance of the XSEC unwind, live snapshot migration preview, deploy, live observation, rendered dashboard review, Node 20 local run

Next: Tejas reviews the branch and the runbook. Release B (plan Tasks 8-10) only after that review. No push, merge or deploy without separate authorization.

## Current deployment continuation (authorized)
- [x] Independent review, Node 20 regression suite (197/197), type check, lint, offline strategy audit, fixture research/ledger checks.
- [x] Record explicit acceptance of XSEC risk reductions and preservation of manual BTC/history.
- [x] Remove confirmed unused execution/writer dependencies; automate compression and unused Docker cleanup; share one runtime image.
- [x] Finish production build, commit reviewed changes, and run pull-request CI plus private VPS migration/public-market preflight.
- [x] Merge verified result, deploy, compare live account/history and feeds, inspect rendered dashboard, and record final evidence.
Prior planning-only and Claude no-deploy boundaries above are historical checkpoints. Tejas's current request authorizes completion and deployment.

## Deployment recovery
- [x] PR #8 cloud preflight and deployment reached image/source/account validation; manual history preserved and approved XSEC unwind completed.
- [x] Diagnose restart lease delay and reset scan IDs; reproduce and repair current-commit scan health and persistent numbering.
- [x] Verify and deploy the restart fix, lift release freeze after real scan advancement, complete storage/UI proof.

## Shipped release checkpoint
- [x] Verify and deploy restart fix; final run 36854097722 successful at commit 191761f.
- [x] Lift release freeze after real scan advancement; verify normal nine-asset scan, account/history preservation and XSEC SHADOW state.
- [x] Reclaim 1782.2 MB by lossless ledger compression plus unused Docker artifacts; verify about 37 GB free and scheduled maintenance.
- [x] Complete rendered desktop/mobile coverage checks and save docs/BYBIT_RELEASE_VERIFICATION_2026-10-01.md.
Next optional slice: implement the documented subsecond quote display with separate connection/quote/candle-quality indicators. Release B strategy learning remains pending. The current release is deployed and operational.

## Complete remaining upgrade (authorized 2026-10-01)
- [x] Task 8: class-aware trend and shadow range strategy families evaluated across all nine (212/212 suite, TypeScript clean).
- [x] Task 9: independent, instrument-scoped learning with bounded adjustments and explicit units (221/221 suite, TypeScript clean).
- [ ] Task 10: reproducible candidate registry, cost stress, untouched evaluation and forward promotion gates.
- [ ] Extend real-daemon integration, coverage funnels and research visibility for the complete path.
- [ ] Subsecond browser quotes with reconnect/fallback and separate transport/candle-quality indicators.
- [ ] Whole-branch review, full validation, state-preserving cloud release and runtime/UI verification.
Authorization continues the existing end-to-end deployment request. New family activation and XSEC risk release remain separately evidence-gated. Profit is an evaluation result, not a feature promise.
