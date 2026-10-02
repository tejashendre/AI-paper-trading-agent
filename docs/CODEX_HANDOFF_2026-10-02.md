# Codex handoff, 2026-10-02

Branch: `claude/autonomy-hardening`, 20 commits on top of `main` (`c90483d`, the
deployed release). Not pushed, not merged, not deployed. Read `../AGENTS.md`
(Code Projects), this project's Memory Quad (`task.md`, latest `AUDIT_LOG.md`
entries, `LEARNINGS.md`) and `docs/ARCHITECTURE.md` before changing anything.

Verified on the branch at `e1ba96a`: `npm run test:upgrade` 285/285,
`npm run audit:strategy` 156 passed / 0 warnings / 0 failed,
`npm run research:audit -- --input tests/fixtures/upgrade/trades.json` exit 0,
`npm run ledger:verify -- --directory tests/fixtures/upgrade/ledger` valid,
`npx tsc --noEmit --incremental false`, `npm run lint`, `npm run build` and
`git diff --check origin/main HEAD` all clean. Windows, Node 26; CI uses Node 20.

## 1. What the branch already fixed (do not redo)

| Commit | Problem found | Fix |
|---|---|---|
| a74840b | XSEC 12h rebalance stopped on the VPS since 2026-10-01 10:59 UTC. Mark, rebalance and funding ran on separate timers sharing one Redis lock; a lost race returned silently and retried in the same phase forever. Healthcheck only checked a heartbeat. | One serialized cycle per minute, bounded logged lock wait, healthcheck requires a rebalance within 13 h, `/api/book` reports `rebalanceSchedule`. |
| a74840b | Dashboard showed 51% win rate (exit legs) beside 36.1% (completed positions); flat halted book said "No book yet"; an unwind was labeled a ranking rebalance. | Tested label helpers in `src/lib/ui/dashboardLabels.ts`. |
| 3c14a83 | 13 unreachable modules (never-wired LLM "brain", Telegram, news sentiment, old fill simulator), 37 dead exports, dead Monte Carlo path, 15 unread env keys. | Removed (-3,107 lines); still in git history. |
| 1d36e54 | Halted XSEC book could never be released: nothing produced the release verdict, and a flat book's drawdown is frozen above 25%. | Autonomous release on shadow evidence (>= 30 periods, positive 95% bootstrap lower bound, shadow drawdown < 15%); release-epoch drawdown; lifetime breaker still re-halts (about 2% further loss today). Owner chose full autonomy. |
| b9f02ca | Learning could never change behavior: forward shadow outcomes hard-coded `historicalCostsAvailable: false`, promotion needed replay folds only a manual script produced, nothing set or read `PAPER_ACTIVE`. | Observed costs recorded; forward-only promotion route (>= 30 forward positions, >= 14 days, bootstrap, deflated Sharpe, cost stress); hourly autonomous PAPER_ACTIVE / final REJECTED (6R loss budget or negative upper bound); promoted families enter as controlled probes; live results feed demotion only. |
| 247bae5 | FX/commodity fills labeled `SYNTHETIC_*_PROXY` on Bybit contracts. | Labels only. |
| 659dd14 | Quiet FX contracts looked stale: Bybit deltas omit unchanged fields but the merge only stamped fields that arrived, so FX fell back to REST and the dashboard showed "recovered". | Deltas confirm omitted fields; dashboard shows Bybit index as a non-tradable reference. Measured live: crypto 8-10 msg/s, commodities 4-6, FX about 1 with last trade nearly static. |
| 3fa6fac | Per-minute `SCAN_COMPLETED` ledger record was 27.7 KB (about 40 MB/day) and nothing read it. | Compact heartbeat under 2 KB. |
| fc998c8 | `scoreDataQuality` used `Date.now()`, so every historical replay scored non-crypto bars stale and they never traded in replay. | Uses the evaluation (quote) time. |
| f58b3bb | Audit WARN measured profitability on a synthetic sine fixture with dollar-scaled noise (not evidence). | Check now verifies the research gate applies its rule; numbers still printed. |
| d6be0b9 | Two daemons (separate containers, shared volume) could fork the hash-chained ledger; reproduced with 3 processes. | Cross-process append lock file with stale takeover. |
| df54fbb | Storage (owner chose option 1). | `compactLedger` re-seal without old scan records (checkpoint `LEDGER_COMPACTED`, `originalHash` kept, verified before swap) run by deploy with daemons stopped when >= 50 MB reclaimable; research archive 256 MB with oldest-day rotation (it used to halt capture forever); maintenance keeps newest 3 deploy backups and newest reset backup. |
| 7a92362 | Scale-in could fill beyond the target (22 Sept BTC add at 85,125 above an 85,082 target). | Add needs its own reward/risk >= 1.35. |
| 15239d2 | Cost tile hid spread/slippage; drawdown line paired worst-ever with a current-drawdown breaker; cost verdict claimed backtests are trustworthy. | Wording and breakdown fixed. |
| 994259d | Label queue (4,096) filled daily from about 244 baseline records/hour, then refused candidates; 24h summary list flushed by short-horizon labels within about 1.5 h. | One baseline record per asset/direction/closed 15m bar, candidates displace oldest baseline when full, separate 24h list. |
| c880b53 | XSEC loop stopped if a cycle ever threw. | Always reschedules. |

## 2. Work for Codex, in priority order

Each item: write the failing behavior test first, then the fix; one slice per
commit; update `task.md` and `AUDIT_LOG.md` after each slice.

### P0. Release this branch safely (needs Tejas's explicit go-ahead to merge and deploy)

1. Review the branch diff (`git diff origin/main...claude/autonomy-hardening`). Open a PR; let CI run `test:upgrade`.
2. **The first deploy deletes ledger history permanently.** `deploy.yml` backs up Redis and source, but not `data/execution-ledger`. Before merging, ask Tejas whether to keep one offline copy of the current ledger directory. Do not skip this question.
3. After deploy, verify on the VPS and record evidence:
   - the compaction log line from the deploy (status, events kept, bytes before and after) and `npm run ledger:verify` valid;
   - `quant-xsec-daemon` healthy, `/api/book` `rebalanceSchedule.overdue` false, shadow book rebalances incrementing every 12 h, shadow funding no longer 0;
   - container logs: `docker compose logs --since 2h xsec-daemon` show `[XSEC] rebalance` and no repeated `deferred: the book lock stayed held`;
   - FX feeds stay `Live WebSocket` on the dashboard (Data Coverage "9 streamed");
   - opportunity queue status: `pending` stays well under 4,096 after 24 h, `rejectedNew` 0;
   - `data/deploy-backups` holds 3 entries, research archive under 256 MB.

### P1. Known defects not fixed yet

1. **Swing drawdown guards ignore unrealized P&L.** `estimateEquity` in `src/lib/trading/portfolioGuards.ts`, `drawdownAdjustedRiskPercent` in `src/lib/trading/tradeAdmission.ts`, `currentDrawdownPercent` in `src/lib/trading/portfolioRiskBudget.ts`, and the peak/drawdown update in `runEntryScan` (`src/daemon/swingDaemon.ts`) all use cash plus margin at cost basis. A position deep in loss does not count until it closes. Fix by marking open positions (store a last mark price and time on each position from the exit watchdog, at most every few seconds and only when it changes materially) and using marked equity everywhere a drawdown limit is enforced. Do not loosen any limit.
2. **Probe positions use a fraction of their approved risk.** Live example (GOLD, 2026-10-01): admission approved $13.74 risk, the fill risked $2.42 because PROBE margin mode caps notional near 2.3% of equity at 1x. Over 36 positions, modeled costs ($87.95) exceed net profit ($65.91). Do not raise risk ceilings. Instead, make the shortfall visible (record approved vs taken risk per entry and show it on the dashboard), then propose to Tejas, with evidence, whether probe notional should be derived from the approved risk rather than a flat margin fraction.
3. **Replay cannot exercise crypto entries realistically.** With realistic, price-proportional noise the replay makes zero trades: crypto entries need order-book flow that replays pass as `null`, and the market-structure gate needs a sweep or volume breakout. Build replay inputs from the recorded research archive (`data/research-archive`, real Bybit closed bars) and, where order-book history is missing, report those assets as "not testable in replay" instead of silently zero. Never tune the strategy to the synthetic fixture in `scripts/strategy-audit.ts`.
4. **FX fee schedule is unverified**, so FX can never be promoted (`UNVERIFIED_STRESS_RATE` in `src/lib/trading/assetSpecs.ts`). Find Bybit's official current fee source for `EURUSDUSDT`, `GBPUSDUSDT`, `USDJPYUSDT`; if confirmed, record it with the source and date. If not, leave it blocked.
5. **XSEC stall root cause is inferred, not observed.** The fix removes the cause the code allows, but confirm from VPS logs after deploy (P0.3). If logs show another cause, fix that too.

### P2. Verify the new autonomy paths live (nothing has been promoted or released yet)

1. Promotion needs at least 14 days of forward shadow evidence; XSEC release needs at least 15 days. Add a dashboard line per candidate showing progress toward each gate (forward positions so far / 30, days so far / 14, current bootstrap lower bound), so silence is explainable.
2. When the first `RESEARCH_PROMOTED`, `RESEARCH_DEMOTED` or `BOOK_RISK_RELEASED` ledger event appears, review it against its evidence and add an integration fixture reproducing that path.
3. Keep `npm run audit:strategy` at 156/0/0 by fixing causes, never by weakening a check. A check may only change what it measures if the old measurement was not evidence (see `f58b3bb`), and that reason must be written in the commit.

## 3. Rules that still apply

- No em dashes anywhere (files, commits, messages); use `-` or `:`.
- Never reset accounts, rewrite past fills, or raise risk limits, leverage or drawdown breakers.
- No LLM dependency. Learning is deterministic from completed results.
- Preserve account and trade history. The ledger re-seal is the one approved exception and keeps every trade, funding, research and risk event.
- Never read or commit `.env`, keys or tokens.
- Test-first, one slice per commit, Memory Quad updated each slice.
- Merging to `main` deploys to production. Merge and deploy only with Tejas's explicit approval.
