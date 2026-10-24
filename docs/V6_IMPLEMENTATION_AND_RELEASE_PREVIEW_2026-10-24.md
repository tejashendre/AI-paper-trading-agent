# Replacement swing brain: local candidate and release preview

The approved replacement is implemented in the isolated `codex/replacement-swing-brain` worktree. It has not been pushed, deployed or used to reset either production account. The primary checkout and its incident work remain separate. SSH exposure remediation is deferred as requested.

## What the candidate changes

| Area | Implemented behavior |
| --- | --- |
| Crypto | Completed daily trend confirmation and fresh four-hour channel breakout. |
| FX | Four-hour trend and range breakout during the specified London/New York windows. |
| Metals | Daily trend with a completed four-hour pullback reclaim. |
| Oil | Daily trend and four-hour breakout with shock, session and EIA-calendar exclusions. |
| Capital | One shared $10,000 AI run. Historical XSEC receives no additional allocation. |
| Position risk | Initial planned net stop loss at most 0.25% of marked equity, reduced by the down-only 30-day volatility overlay. The separate evidence policy supports a later 0.50% tier. No confidence score increases size. |
| Shared limits | Planned open risk 2%, gross factor risk 1%, aggregate margin 40%, gross notional 2.5 times equity, and the tighter remaining drawdown-floor budget. |
| Halt | The floor is the greater of $9,000 and 90% of the run's high-water marked equity. A breach latches reduction mode. Timers and restarts cannot clear it. |
| Exits | Frozen entry ATR and price-distance R; full-position targets, stops, trailing and maximum holding times. Emergency reductions may be staged against observed capacity. Profit-taking partials and scale-ins stay disabled. |
| Execution integrity | Epoch, lease, deadline and source comparisons fence financial state changes. Cash, position, trade and durable ledger outbox commit together. Lost replies do not duplicate fills. |
| Funding | A separate worker fetches public settlement history outside the financial lease. The protective loop records pending liabilities and continues reducing risk without waiting for funding transport. Unresolved funding blocks new entries and reset. |
| Evidence | Exact definition, source, frozen costs and risk/exit policies identify every cohort. Future portfolio marks and quotes unavailable at a fill cannot qualify it. Historical candles alone never create observed execution evidence. |
| Storage | Compressed decision archives deduplicate feature bars and reconstruct original source clocks and hashes. A storage cap refuses new captures and entries while preserving earlier evidence and financial records. |
| Reset | Read-only preview first, complete local archive, live coordinated leases, exact source/human comparisons, atomic AI epoch switch, then durable ledger acknowledgement. Human state and old AI/XSEC histories remain preserved. |
| Dashboard | Current-run status, actual evidence counts, blockers and unavailable metrics are explicit. Historical AI/XSEC panels cannot imply they control the new run. The invented profit-factor fallback is removed. |

The approved parameter definitions and research sources are in [the design](superpowers/specs/2026-10-24-replacement-swing-brain-design.md). Implementation sequencing is in [the plan](superpowers/plans/2026-10-24-replacement-swing-brain.md).

## Real public-data diagnostic

Native Bybit OHLC, mark and funding histories were captured for all nine mapped perpetuals. Source receipts and actual capture clocks are retained outside Git under `C:/Users/tejas/.codex/audit-evidence/swing-v6-economic-native-2026-10-24`. No account credentials were used for these public requests.

The January 2024 through 24 October 2026 descriptive scenario evaluated 23,341 decision points. Its shared virtual book produced 18 modeled trades before the crypto factor stop-loss streak latched. Modeled final equity was $10,093.95; the fixed-quantity scenario with doubled execution costs and adverse payer funding ended at $10,081.28. These figures are hypothetical sensitivity outputs. They are not observed profits or proof of an edge.

There are too few completed positions to qualify. Native TradFi histories start later than the requested interval, historical metadata schedules and execution depth are unavailable, and no verified historical calendar snapshots were supplied. Calendar-gated FX, metals and oil therefore produced no scenario orders. Zero orders in those classes are a coverage block, not a successful backtest. The verdict remains `NOT_TESTABLE`, `eligible: false`, with zero orders submitted and zero real capital allocated.

The full report is `descriptive-replay-2024-2026.json` in the evidence directory. Its scenario, standalone comparisons, actual funding coverage, blocked decision tape, declared assumptions and non-preregistered evaluation status are inspectable. No fold was invented after seeing these results.

## Validation and review status

The final verification results and source-manifest digest are recorded in `AUDIT_LOG.md`. Focused regressions cover causal bars, session/DST and calendar exclusions, net cost sizing, risk allocation, temporal evidence, retirement and rearm, reset crashes and human preservation, stale leases, duplicate fills, staged exit cash/fees, missing funding, archive budgets, and legacy-worker retirement.

The production build and type/lint checks are part of the local release checks. The status component was visually checked in a desktop browser fixture and an isolated 390-pixel frame. The fixture was clearly labeled and did not read or change account state. Production Redis Lua could not be exercised locally because a separate Redis server was unavailable; production-wrapper argument tests and the in-memory transaction implementation were exercised instead.

Independent scoped reviews found and led to fixes for production NX behavior, temporal proof defects, interrupted reset recovery, active-epoch flatness, malformed transaction arguments, exit ordering and executable-price parity. A final independent whole-branch review is still required. Reviewer agents hit their usage limit before that review could be completed. In particular, the later integration changes must receive that review before release.

## Concrete release and reset boundary

1. Review this complete source candidate and its recorded verification. Do not deploy an earlier partial commit.
2. Complete the independent whole-branch review, including the final funding worker, volatility parity, archive cap, review fencing and staged reductions. Fix any material finding and rerun affected checks.
3. Verify the public fee assumptions and obtain current production source/ledger/account snapshots without exposing credentials. Prepare the exact production AI-only reset preview. Its archive digest and human-preservation digest must be reviewable before execution.
4. Keep entries frozen during migration. Existing legacy AI or XSEC positions must be closed through an explicitly reviewed, capacity-aware preparation step and their funding and ledger liabilities drained. The reset refuses open or malformed positions; it does not discard them. Automatic pre-reset flattening of legacy positions is not provided by this candidate.
5. Release the reviewed source, verify its exact runtime commit and protective watchdog, then perform only the reviewed AI reset. The new epoch starts with $10,000 in SHADOW. No new capital is assigned to XSEC or the human account.
6. Observe genuine forward outcomes and source coverage. Qualification may take months. A reset or passing software tests does not authorize a strategy to trade, erase an adverse review or promise recovery of prior losses.

CLI entry points are `brain:capture`, `brain:calendar`, `brain:replay` and `brain:reset`. The reset CLI requires an explicit run ID and absolute archive directory and defaults to a read-only preview. The dashboard API exposes preview only and cannot execute a reset.

Production release, the production reset preview, legacy flatten preparation and reset execution remain open. No additional human-account reset or SSH remediation is included.
