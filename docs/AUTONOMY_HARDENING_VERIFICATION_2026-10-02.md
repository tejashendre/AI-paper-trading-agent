# Autonomy hardening verification, 2 October 2026

The completed implementation is on `claude/autonomy-hardening`, PR [11](https://github.com/tejashendre/AI-paper-trading-agent/pull/11). The tested code commit is `abd2c2dc201495325ec7b134fe6dbe4a702fc5d0`; later documentation commits do not change runtime behavior. This is a release candidate, not a production deployment. Explicit owner approval is required before merging or deploying.

## Completed changes

The original 20 handoff fixes remain intact. Follow-up slices resolve the remaining code defects and review findings:

| Area | Verified behavior |
|---|---|
| Release safety | Stop every ledger writer, including the dashboard, before compaction. Failed stop, existing recovery state or failed verification refuses the release. |
| Swing risk | Every drawdown calculation includes frozen-model unrealized P&L and unpaid exit costs. Entries and scale-ins require fresh marks; the aggregate margin ceiling remains 40%. |
| Probe visibility | Display and retain approved versus actual initial risk. No sizing cap or risk ceiling was raised. |
| Recorded replay | Read hash-verified archives offline. Preserve original component clocks and collection availability. Reject unknown/future/stale flow; report incomplete assets as NOT_TESTABLE. |
| Learning progress | Show independent forward completions / 30, evidence days / 14, bootstrap lower bound and remaining checks. Show XSEC shadow release progress and binding reasons. |
| Durable transitions | Save complete promotion/book-release proof before activation. Preserve demotion proof in a Redis retry outbox while immediately stopping risk. Rare arrays are lossless; large proofs do not block later financial appends. |
| Charts | Load exclusive backward pages of up to 1,000 public Bybit candles. A 20,000-candle browser window rolls into older history, with Back to latest. Refresh and failures preserve loaded history. No historical chart disk cache. |
| Comparison cards | Primary numbers are signed total gains/losses, updated from fresh quotes under frozen economics and existing exit costs. Account value is secondary. The XSEC book stays separate. |
| Missing marks | Retain an actual stored loss mark during quote outages. Missing valuation evidence stays Unavailable across all account-value, return and margin displays. True zero equity still reports its actual loss. |

## Verification

Every behavior slice began with a failing regression, then ran the full upgrade suite and strategy audit. The final local production build and rendered checks used the tested code above.

| Check | Result |
|---|---|
| `npm run test:upgrade` | 325 passed, 0 failed |
| `npm run audit:strategy` | 156 passed, 0 warnings, 0 failed |
| TypeScript, including `--noUnusedLocals` | Clean |
| `npm run lint` | No lint warnings or errors |
| `npm run build` | Successful production build |
| Branch-wide `git diff --check` | Clean |
| Fixture execution ledger | Valid 8-event chain; head `2ebce6912157e5b4cf88f28f66fe4e8169b0627e8715a9b51ce29a15c1cdbcf3` |
| Fixture compaction dry run | SKIPPED_BELOW_THRESHOLD; 3,964 bytes unchanged |
| Fixture research audit | Exit 0; descriptive sample does not pass research acceptance |
| Independent amended review | All findings resolved; 33/33 evidence/replay checks and 7/7 display/outage checks passed; no remaining Critical/Important finding |
| Node 20 Linux CI at tested code commit | [Run 37042756402](https://github.com/tejashendre/AI-paper-trading-agent/actions/runs/37042756402) passed lint/build/types/full suite/audit/ledger/source manifest and VPS market/continuity preflight; production deployment step skipped |

Playwright on the local production build, with isolated status fixtures and intercepted ticker frames, verified a signed `+$10.00` changing to `-$29.97`, red loss color, separate book P&L, stale labels and unknown-mark displays without invented losses. These amounts demonstrate UI behavior, not production performance. A second browser proof exercised 21 chart pages, the 20,000 bound, refresh retention, Back to latest, a 503 preserving the chart, retry and a 390px layout. Both had no page errors or horizontal overflow. Trading requests were intercepted and aborted.

Raw future/stale/untimestamped archive tests exercise normalization before snapshot selection. Transition fixtures reproduce promotion, demotion, book release, ledger/storage outages and acknowledgement retries. The integration tests preserve all nine assets, frozen legacy quantities, fees, funding and account history.

Local checks used Node 26 on Windows; the tested code also passed Node 20 Linux CI. The final documentation head is checked again before requesting approval. PR checks and preview builds do not deploy the VPS application.

## Replay and fee evidence limits

The actual bounded runtime archive is `data/research`, not the earlier handoff name `data/research-archive`. Two VPS public-market day archives were copied to temporary local storage and hash verified. Offline replay produced two descriptive non-crypto fills, zero engine errors and failed research acceptance. Crypto lacks complete fast-bar/flow evidence and is NOT_TESTABLE. Periodic captures cannot reconstruct intervening order books. This replay does not prove positive expectancy, watchdog parity or promotion eligibility.

Follow-up verification on 2 October found the official [TradFi scope and fee guide](https://www.bybit.com/en/learn/bybit-tradfi/trade-tradfi-perpetuals-bybit), which includes forex and applies discounted fees to all TradFi perpetuals except Pre-IPO. The [G9 announcement](https://announcements.bybit.com/en/article/tradfi-perpetuals-lower-fees-across-all-tiers-bltb196506dada4be39/) supplies exact VIP0 maker 0% and taker 0.0275%; the [FX guide](https://www.bybit.com/en/learn/bybit-tradfi/what-are-fx-perpetual-contracts-bybit) identifies the three configured USDT contracts. New paper FX fills use a new `PUBLIC_BASELINE` version. All old positions and unstamped observations retain the prior stress version. New FX research and learning use a distinct cost cohort; old definitions stay present and unverified. This establishes a public paper-model baseline, not an authenticated account's actual rate. No credential was read or used.

Bybit's [kline API](https://bybit-exchange.github.io/docs/v5/market/kline) has a per-request limit of 1,000 with start/end timestamps. This is not a 72-day calendar limit. Paging reaches the contract's available history; it cannot create candles before listing or fill genuine venue gaps. The 20,000 bound limits browser memory, not the oldest reachable date.

## Probe sizing decision

The documented GOLD example approved $13.74 initial risk but took $2.42, about 17.6%, because the PROBE margin policy bound notional. The historical 36-position snapshot had $87.95 modeled costs and $65.91 net profit. These show cost drag and risk underuse, not that greater size will improve net returns.

Retain current sizing for this release. Before proposing a policy change, compare current sizing with approved-risk-derived notional using each candidate's frozen stop, lot rules, liquidity cap and adverse cost scenario. Require complete costs and independent forward evidence. Reject sizes breaching any unchanged portfolio, leverage, per-position or class ceiling. Present the expected after-cost difference and drawdown distribution to the owner; do not automatically bypass the PROBE cap.

## Production state and release sequence

The last read-only VPS check on 2 October still showed `c90483d4aa8418ad8567379639f9cfecbe4bd3ee`, with dashboard, swing, XSEC and Redis containers healthy under that release's healthchecks. The observed XSEC rebalance remains stalled under the old code. Old healthchecks and unit fixtures do not confirm its production cause or prove the new scheduler is deployed.

The owner said to preserve required learning data and remove only unnecessary content, and expressed uncertainty about an offline copy. Preserve every trade, funding, research, risk and account record. Before the first approved destructive compaction, take one verified full ledger recovery copy offline, outside Git and the cloud runtime. No such copy or destructive operation has been performed during this review.

After explicit approval:

1. Save a fresh private account/history continuity manifest, open-position economics, deployed commit and source/image identity. Keep private account material outside Git and public reports.
2. The release now takes the on-server recovery copy itself (2026-10-03): with all writers stopped, and only when the dry run reports WOULD_COMPACT, it copies the full ledger into that deploy's backup directory and verifies the copy's hash chain before compacting; any failure restarts the previous release and fails the deploy. Deploy backups keep the newest 3. An additional off-server copy (outside the VPS) remains the owner's optional choice before merging.
3. Merge only the reviewed PR head. The main workflow backs up Redis/source, freezes new entries, builds the shared image and runs fail-closed ledger maintenance with all writers stopped. Only old SCAN_COMPLETED telemetry can be removed above the unchanged 50 MB threshold. Every other event is retained with original lineage and a verified compaction checkpoint.
4. Verify the exact merged commit in source and every app image, healthy containers, ledger validity and financial continuity. Confirm normal scans advance, existing position management resumes and all nine feeds recover before entries are unfrozen.
5. Record actual compaction status, kept-event counts, dropped-type counts and bytes. Confirm research retention under 256 MiB, three deploy backups, latest reset backup, and no volume pruning.
6. Confirm XSEC is not overdue under the new 13-hour healthcheck, serialized cycle logs show actual rebalance, and the next 12-hour shadow rebalance/funding period advances. Diagnose any remaining cause from observed logs; do not call the inferred lock collision confirmed.
7. After 24 hours, check opportunity pending count remains well below 4,096 and rejectedNew is zero, with usable FX streamed quotes and nine streamed subscriptions.
8. When a real production RESEARCH_PROMOTED, RESEARCH_DEMOTED or BOOK_RISK_RELEASED event occurs, reproduce its complete saved proof independently and add the observed integration fixture. Forward promotion needs at least 14 days; book release needs at least 30 shadow periods. Do not replace those gates with synthetic fixtures.

If maintenance refuses, the workflow intentionally leaves writers stopped and the entry freeze in place. Inspect its refusal and protected recovery evidence. Verify the authoritative ledger and original image/source before restarting existing containers or retrying. Do not delete `.pre-compaction`, `.compacting` or ledger history to bypass a refusal, and do not restore stale Redis over subsequent financial events. Follow [the rollback runbook](BYBIT_ALL_ASSETS_ROLLOUT_RUNBOOK.md).

Owner approved final upload and merge after fixes, then requested completion in real time. The final FX slice is undergoing full verification before release. Deployment verification, 24-hour observations and the first actual learning transition require live evidence after release. No risk limit, leverage ceiling, past fill or account balance was reset, and no runtime LLM dependency was added.

Final FX follow-up: 334/334 upgrade tests, audit 156/0/0, strict TypeScript, lint and production build pass. Red-first regressions cover manual new-fill stamping and old-fee settlement, frozen mark/risk costs, historical descriptive labels, old research definitions and the actual engine's exact learning-cohort selection. Old FX records remain unverified; the new fee baseline opens collection of qualifying evidence without shortening its gates.
