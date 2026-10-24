# Replacement Swing Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace AI entries with four qualified slow strategies, preserving human behavior and enabling an archived AI-only $10,000 run.

**Architecture:** Pure class evaluators and a shared exit state machine feed one batch risk allocator and an exact-identity evidence gate. A dedicated replacement daemon reuses market, ledger, settlement and human protection infrastructure without calling the retired entry scanner. A fenced Redis epoch switch performs the AI-only reset after verified archival.

**Tech Stack:** Existing TypeScript, Node, Next.js, Redis and node:test/tsx. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-24-replacement-swing-brain-design.md`, approved by Tejas on 24 October 2026 with the instruction to implement.

## Global Constraints

- One shared $10,000 AI account; human account is not reset or traded by the new strategies.
- Initial activated planned risk 0.25%, later at most 0.50%; aggregate 2%, class/FX gross factor 1%; drawdown floor max(9000, 0.9 * high-water equity).
- Fully closed 4h and daily entry features; no 1m/5m flow dependence; no v5 fallback, score leverage, partials or scale-ins for v6.
- Every new exact configuration starts SHADOW; data/engineering success does not authorize promotion.
- Archive before AI reset; preserve all old records, human raw values and cash conservation; no resetArena call.
- SSH work deferred. Never read environment/private-key contents. Never use U+2014 or its HTML entity.
- Current local worktree only. Do not push main, merge, deploy or execute a production reset until the tested source and concrete reset preview are reviewable.

## Review Focus

1. Future/duplicate/gapped bars or inconsistent information clocks cannot create an earlier setup (Task 1 tests).
2. A score, stale proof or evidence for another asset cannot bypass SHADOW (Task 3 tests).
3. Simultaneous candidates, opposing FX directions, near-floor equity and nonfinite inputs cannot oversubscribe risk (Task 2 tests).
4. Crashes, stale leases, changed human values or archive failures cannot duplicate capital or erase either run (Task 5 tests).
5. New daemon operation, health/API rendering and legacy compatibility cannot silently restore old entries or alter human exits (Tasks 6-7 tests).

## Files and shared interfaces

- `src/lib/strategy/v6/engine.ts`: pure class rules, immutable setup identities and pure v6 exit decisions. Defines exported `BrainSnapshot`, `BrainDecision`, `SwingSetup`, `BrainPositionPolicy`, `CalendarManifest` and `BrainDefinition` contracts.
- `src/lib/strategy/v6/risk.ts`: proportional batch risk allocation, modeled size/cost solver and persistent-breaker pure decisions. Consumes `SwingSetup`.
- `src/lib/strategy/v6/evidence.ts`: versioned definitions, exact-cohort permission, daily-return statistics, qualification/demotion/escalation/rearm evidence.
- `src/lib/strategy/v6/calendar.ts`: source-stamped calendar manifests and verified event/session admission; no fabricated coverage or decision times.
- `src/lib/strategy/v6/replay.ts`, `scripts/replay-swing-v6.ts`: reproducible contract-native research, conservative exits/funding and coverage manifests.
- `src/lib/strategy/v6/runtime.ts`, `src/daemon/replacementSwingDaemon.ts`: causal snapshots, capture, paper shadow labels, research reviews and qualified batch fills; new default daemon command.
- `src/lib/admin/resetAiRun.ts`, `scripts/reset-ai-run.ts`, `src/lib/redis.ts`: preview, durable archive, fenced atomic/idempotent AI epoch switch.
- `src/lib/execution/swingLifecycle.ts`, `src/lib/types.ts`: frozen v6 position policy and AI-specific protective exits, without changing human/legacy exit policy.
- `src/app/api/brain/route.ts`, `src/components/Dashboard.tsx`: clear v6 status, evidence, reset preview/epochs and honest diagnostics.
- `tests/v6-*.test.ts`: meaningful targeted behavior tests; existing regression suite retained.

Task 1 contracts: `evaluateBrain(input: BrainSnapshot): BrainDecision`, `brainDefinition(asset): BrainDefinition`, `decideBrainExit(input: { policy: BrainPositionPolicy; direction: 'LONG'|'SHORT'; entryPrice: number; stopLoss: number; currentPrice: number; openedAtMs: number; nowMs: number; watermark: number }): BrainExitDecision`.

`BrainSnapshot` contains `asset`, `nowMs`, `h4`, `d1`, a venue quote, and a calendar manifest. `SwingSetup` contains `id`, `asset`, `strategyId`, `configHash`, `direction`, `entryPrice`, `stopLoss`, `takeProfit`, `atr`, `priceRDistance`, `featureStartMs`, `featureCutoffMs`, `expiresAtMs`, `policy`. `BrainPositionPolicy` freezes strategy/config, ATR, price R, target/trailing geometry and max hold. Definitions include exact parameters and version identity. Task 1 publishes concrete exported types before dependent integration.

## Task 1: Four causal strategies and v6 exits

**Files:** engine.ts, calendar.ts (pure admission only), tests/v6-engine.test.ts.
**Consumes:** Candle, MarketPriceSnapshot, ConfiguredAsset, existing indicator/registry helpers and approved class parameters.
**Produces:** the engine contracts above, four class evaluators, `validateCalendar` and `strategySessionAllowed` pure helpers.
- [ ] Write tests for long/short/no-setup/warmup per class, mirrored geometry, future/forming/duplicate/gap rejection, exact channels and stale setup, FX DST/weekend and EIA event behavior, immutable IDs and trailing/time exits.
- [ ] Run `node --import tsx --test tests/v6-engine.test.ts`; prove expected RED before implementation.
- [ ] Implement the four approved definitions and pure evaluators; price R and net risk stay distinct. Freeze initial ATR for trailing distances so runtime/replay share the exact policy. Calendar coverage requires valid source/times, next seven days and expiry within 24h.
- [ ] Run the targeted tests and TypeScript, self-review, record RED/GREEN output and commit only owned files.

## Task 2: Risk, costs and batch sizing

**Files:** risk.ts, tests/v6-risk.test.ts.
**Consumes:** SwingSetup, marked equity, frozen contract economics/profile, open exposures and current observed liquidity.
**Produces:** `allocateBrainRisk({equity,initialCapital,peakEquity,open,candidates,halted?}): RiskAllocation[]`, `sizeBrainOrder(input): BrainOrderPlan`, and pure breaker transition helpers. Concrete types exported from risk.ts.
- [ ] Write RED tests asserting equal proportional allocation independent of input order, 0.25% base/0.50% ceiling, 2% global, 1% gross factor, 40% margin/2.5x notional caps, near-floor and invalid-number rejection, funding reserve and stressed cost geometry, lot/tick rounding and explicit latch/rearm requirements.
- [ ] Implement the approved cost/risk definitions, full maximum-hold adverse funding reserve and exact frozen stress scenario. Reuse assetSpecs/executionCostModel helpers; no second accounting formula and no conviction sizing.
- [ ] Test RED/GREEN, TypeScript and self-review; record scoped proof and commit owned files.

## Task 3: Economic qualification and persistent identity

**Files:** evidence.ts, tests/v6-evidence.test.ts.
**Consumes:** BrainDefinition and position outcomes, daily marked equity returns, causal/cost manifests and known trial registry.
**Produces:** `evaluateBrainEvidence(input): BrainEvidenceReview`, `brainPermission(definition,review,nowMs): {allowed,reason}`, versioned registry read/write helpers and source-stamped proof hashes.
- [ ] RED tests: new definitions SHADOW, wrong asset/config/risk/cost or old run cannot promote, absent/gapped cost evidence cannot promote, no statistical output for tiny samples, historical vs forward-only exact thresholds, block/holding-interval independence, daily DSR effective observations/trial counts, demotion terminality, 15-new-outcome streak rearm and 30-additional-position risk escalation.
- [ ] Implement approved evidence routes with netR bootstrap, daily-return DSR, exact trial accounting, immutable review inputs and conservative undefined-estimate rejection. Reuse statistics/research helpers where compatible; do not reuse their wrong unit silently.
- [ ] Verify RED/GREEN and TypeScript, self-review and commit owned files.

## Task 4: Replay, data capture and event calendar ingestion

**Files:** replay.ts, scripts/replay-swing-v6.ts, scripts/capture-swing-v6.ts, calendar.ts source ingestion additions if needed, tests/v6-replay.test.ts and tests/v6-calendar.test.ts.
**Consumes:** engine/risk/evidence interfaces, native Bybit kline/funding/mark API and explicit local dataset paths.
**Produces:** manifest-checked offline replay and read-only public capture CLI; calendar CLI/manifests consumed by runtime.
- [ ] RED tests for future invariance, actual entry availability, quote/settlement timing, conservative same-bar stop/target, targets/trailing/time exits, funding boundaries/cost coverage, serial portfolio capacity and no orders/capital from shadow.
- [ ] Implement paged native 4h/daily and 1h exit-path capture with stable hashes, source clocks, fee/cost profiles, calendar coverage and honest missing historical depth. Freeze evaluation splits/identities before reporting results; emit per-instrument and shared-book metrics, comparison baselines, daily returns and explicit eligibility verdicts.
- [ ] Parse official event schedules or accept a strictly verified source-stamped manual manifest where a parser cannot establish coverage. Missing calendar coverage remains a visible block. Do not invent dates from generic weekday recurrence or silently assert all sources parsed.
- [ ] Run real public capture and current candidate replay with data/economic gaps labelled. No positive-results claim without complete evidence.
- [ ] Verify targeted tests, self-review and commit.

## Task 5: AI-only reset and epoch isolation

**Files:** resetAiRun.ts, scripts/reset-ai-run.ts, redis.ts, tests/helpers/memoryRedis.ts, tests/v6-reset.test.ts.
**Consumes:** raw AI/XSEC/user keys, explicit archive directory, live fencing tokens and expected human raw state. Never resetArena.
**Produces:** `previewAiRunReset(...)`, `resetAiRun(...)`, `activeAiRun(...)`, and one atomic Redis commit primitive with an in-memory test equivalent. Epoch key: `brain:v6:activeRun`. Archive old versioned data; old XSEC is research-only.
- [ ] Write RED tests for read-only preview, $10,000 conservation, zeroed AI current-run counters, unchanged human bytes/trades/transients, archive/lease/human-change/open-position failures, idempotent retry and crashes around durable archive/commit/ledger acknowledgement.
- [ ] Implement fail-closed preview and durable hash-verified archive before the fenced atomic switch. The primitive checks all held lease tokens and expected human/AI source values, writes only explicit AI/XSEC run-control keys, archives old data without deleting the ledger, and returns prior result on identical run-ID retry. No unknown key deletion.
- [ ] Open positions must be flat with all funding/ledger liabilities drained before switch. Preview/refusal supplies exact required staged closure; runtime supplies capacity-aware REDUCE_ONLY preparation before executing reset. Do not abandon positions or touch human data.
- [ ] CLI defaults to preview, requires explicit run ID and execute flag, validates safe archive paths and never reads secrets. Unit/integration proof precedes any production preview or reset.
- [ ] Verify RED/GREEN and TypeScript, self-review and commit.

## Task 6: Replacement runtime and protective integration

**Files:** runtime.ts, replacementSwingDaemon.ts, swingLifecycle.ts, types.ts, crossSectionalDaemon.ts, package.json, tests/v6-runtime.test.ts.
**Consumes:** Tasks 1-5. Reuses raw portfolio locks, ledger, frozen instrument economics and exit settlement.
**Produces:** new default `daemon:swing` command running v6; causal snapshots/decision tape, shadow outcomes/reviews, qualified batch paper execution and v6 exits. Human exits remain legacy/manual.
- [ ] RED tests: default runtime cannot call v5 entries; uninitialized run cannot trade; all SHADOW setups record outcomes without portfolio writes; fake official data advances scans; only exact proved permission admits a fill; batch/lease/crash/dedupe preserve cash and position identity.
- [ ] Implement runtime scheduling with 60-second entry scans and continuous 5-second protection. Share one batch snapshot boundary; archive full decision inputs and actual capture availability. Drive shadow outcomes with the same risk/exit/cost logic, not an unrelated generic evaluator.
- [ ] Stamp v6 policy on AI positions/trades. In sweepSwingExits route only AI v6 positions through decideBrainExit, bypassing legacy partials/scales/reversal logic. Preserve human/legacy paths and versioned settlement. Keep funds/protection safe through freeze and reset preparation.
- [ ] XSEC capital release is disabled for the replacement run; old XSEC can observe only. No extra $10,000 allocation. Risk/evidence permissions and global latch persist across restart.
- [ ] Verify fake-venue end-to-end scans, entry/funding/exit/completed outcome, restart/outage/failed-write scenarios and human behavior. Self-review and commit.

## Task 7: API/dashboard, full verification and release preview

**Files:** api/brain/route.ts, Dashboard.tsx, package.json CLI scripts, tests/v6-api.test.ts, documentation and source/release checks where required.
**Produces:** honest strategy/run/evidence display, read-only reset preview, candidate backtest output and a concrete release package.
- [ ] RED tests for public read-only status, no GET reset, authenticated scoped reset preview/execute contract, historical/current-run separation and unavailable metrics. Remove invented profit-factor fallback and label/retire the unrelated worker validation UI.
- [ ] Implement clear per-class state/count/reasons, risk budget, active run and historical archive references; no success probability from a score. Ensure old research widgets cannot imply they control v6.
- [ ] Run full regression suite, strategy audit, TypeScript/lint/build, diff checks, secret-pattern/no-em-dash checks and meaningful real-data replay. Review scope and unresolved data blockers explicitly.
- [ ] Obtain independent whole-branch review, fix concrete findings, rerun affected verification and save proof. Create a concrete production deployment/reset preview without mutating human or security state; only execute an authorized reviewed release/reset after prerequisites pass. Never fabricate promotion to make the fresh account trade.
- [ ] Update task.md/AUDIT_LOG.md with each verified slice, exact commands/results and remaining approval/data limits. Commit only this work; no unrelated incident files.

## Execution decision and preflight

The owner explicitly said to approve the design and implement it. Carry out the plan in this session without another plan-approval pause. Controller uses native implementation for shared integration and fresh bounded subagents for independent pure units, with task reviews and a whole-branch review. The skill's method menu is not an additional permission requirement for already-authorized reversible work.

Interfaces are fixed by Task 1 before dependent agents implement against them. Task 5 owns Redis/test-memory mutations. Task 6 owns existing daemon/lifecycle/type changes. Task 7 owns dashboard/API changes. Parallel agents must not edit each other's files or commit each other's staged work.

Ruling: the first release refuses activation when critical historical cost coverage is missing; sensitivity bounds are descriptive only. This matches the approved spec and avoids choosing optimistic assumptions after seeing results.
