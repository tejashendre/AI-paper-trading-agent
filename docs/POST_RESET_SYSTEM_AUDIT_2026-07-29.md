# Post-Reset System and Strategy Audit

**Audit date:** 2026-07-29
**Production site:** https://trader.tejashendre.com
**Audited release:** `2f95bf0d078eda23c3f0d6bcdbc423ea474aff2c`
**Capital mode:** `PAPER_ONLY`

## Executive Verdict

The bot is running. It is not asleep, crashed, disconnected, or stuck on an old
Vercel cron. The VPS daemon continues to scan all nine assets, the live API
reports the expected commit, the three crypto WebSocket sources are producing
fresh independent prices, and Gold, Oil, and Silver charts all load on the
desktop production site.

The bot is also not ready to be called a proven autonomous profit system.
Post-reset evidence shows a severe admission bottleneck and no closed outcomes,
while the current live-data replay is loss-making. During the audit, however,
the daemon autonomously opened its first observed post-reset USDJPY controlled
probe. This proves that the execution path is reachable. Increasing trade count
by lowering thresholds would still add unvalidated exposure rather than repair
a demonstrated bug.

The correct conclusion is:

- **Engineering runtime:** healthy and active.
- **Autonomous entry path:** confirmed by a live USDJPY paper probe.
- **Chart timestamp presentation:** misleading, now fixed locally.
- **Entry diagnostics:** contained one truthful-reporting bug, now fixed locally.
- **Replay certification:** previously mislabeled execution integrity as a full
  PASS; now split into engineering and research-quality gates.
- **Trading edge:** unproven and currently contradicted by the latest replay.
- **Deployment state:** production remains on `2f95bf0`; the audited fixes in
  this report are local until a new commit is approved, pushed, and deployed.

## Scope and Evidence

This audit covered:

- the current local Git checkout and tracked source tree;
- GitHub `main` and recent Actions deployments;
- production spectator APIs;
- live browser interaction on the desktop site;
- post-reset decision-ledger aggregates from Redis;
- current learning state and reset provenance;
- deterministic strategy tests and a fresh nine-asset replay;
- import and route reachability for suspected obsolete modules;
- current official documentation for exchange feeds, chart timezones, and
  Oracle Always Free resources.

No real-money execution was enabled or tested.

## Version Parity

At audit time:

| Surface | Commit |
|---|---|
| Local `main` base | `2f95bf0d078eda23c3f0d6bcdbc423ea474aff2c` |
| GitHub `main` | `2f95bf0d078eda23c3f0d6bcdbc423ea474aff2c` |
| Production API | `2f95bf0d078eda23c3f0d6bcdbc423ea474aff2c` |
| Successful deploy run | GitHub Actions run `30357010006` |

Production reported:

| Component | Version |
|---|---|
| Strategy | `swing-v4.1.0-2026-07-20` |
| Execution cost model | `paper-cost-v2-2026-07-19` |
| Portfolio policy | `portfolio-budget-v1-2026-07-19` |
| Margin policy | `strong-margin-v1-2026-07-20` |
| Research harness | `walk-forward-v1-2026-07-19` |

The exact deployed commit was therefore known. A complete next-release check
must still compare the VPS checkout and generated source manifest after the new
commit is deployed.

## Live Runtime Findings

### Scan Loop

The production snapshot at `2026-07-29T07:02:55Z` reported:

- scan ID `1141`;
- nine `HOLD` decisions;
- zero entries, blocks, skips, and errors;
- two `WATCH_SHORT`;
- two `TRIGGER_PENDING`;
- five `NO_BIAS`.

The scan ID advanced during the audit. This is active execution, not dormancy.

### Autonomous Entry Proof

At `2026-07-29T07:08:55Z`, production autonomously opened a USDJPY long:

| Field | Value |
|---|---:|
| Requested price | 165.778 |
| Modeled fill | 165.806324 |
| Stop | 164.162176 |
| Target | 169.009647 |
| Entry path | `CONTROLLED_PROBE` |
| Margin mode | `STANDARD` |
| Paper margin | `$287.30` |
| Modeled notional | `$861.90` |
| Leverage | `3x` |
| Modeled maximum loss | `$9.02` |
| Expected net reward | `$16.19` |
| After-cost reward/risk | `1.79` |

The position used slower-feed sizing, a 0.65 setup multiplier, and a 0.8
learning-risk multiplier. It did not receive `STRONG` margin. At
`2026-07-29T07:21:54Z`, the watchdog still marked the thesis `VALID`, and later
scans skipped duplicate USDJPY entries while continuing to manage the open
position.

This is direct evidence that the reset bot can find, admit, execute, and manage
an autonomous paper trade. It is not evidence that the trade or strategy will
be profitable; there was still no post-reset closed outcome at audit time.

### Market Feeds

The dashboard reported:

- three live crypto feeds;
- six slower swing feeds;
- zero missing assets.

BTC independently received fresh prices from:

- Kraken Spot WebSocket;
- Bybit Linear WebSocket;
- Binance Spot WebSocket.

This redundancy is appropriate. Binance documents mandatory ping/pong handling,
a 24-hour connection lifetime, and reconnect expectations. Bybit documents
frequent public ticker updates. Kraken includes an exchange timestamp in ticker
updates. The system must continue to validate actual message timestamps rather
than treating an open socket as a fresh source.

Official references:

- [Binance Spot WebSocket streams](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md)
- [Bybit public ticker](https://bybit-exchange.github.io/docs/v5/websocket/public/ticker)
- [Kraken WebSocket v2 ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker)

### Chart Delay Investigation

BTC candle ages observed directly:

| Interval | Latest UTC bucket | Approximate age | Result |
|---|---:|---:|---|
| 1m | current minute | 30 seconds | Fresh |
| 5m | current 5m bucket | 3.5 minutes | Fresh |
| 15m | current 15m bucket | 13.5 minutes | Fresh |
| 30m | current 30m bucket | 13.5 minutes | Fresh |
| 1h | current hourly bucket | 43.5 minutes | Fresh |

The apparent two-hour delay was not a feed delay. The UI defaulted to
Europe/Paris while the user was reading the chart in India. It also labeled the
current interval candle `LIVE`, even though the timestamp represents the start
of the candle bucket.

TradingView Lightweight Charts treats timestamps as UTC and leaves timezone
adjustment to the application. The implementation follows that model, but the
default and label were misleading. See the official
[Lightweight Charts timezone documentation](https://tradingview.github.io/lightweight-charts/docs/next/time-zones).

The local fix:

- detects the closest supported browser timezone on first load;
- maps India to `IST`;
- persists an explicit user choice;
- separates latest `PRICE` from `CANDLE`;
- displays the candle-open time and selected timezone.

### Gold, Oil, and Silver Desktop Regression

A real production browser session verified:

- the Commodities tab exposes Gold, Crude Oil, and Silver buttons;
- each button changes the selected asset;
- each asset returns chart data;
- each chart renders on desktop;
- interval and timezone controls remain present.

The previously reported Oil/Silver missing-chart bug is not present in
`2f95bf0`.

## Post-Reset Trading Funnel

A read-only aggregation over the first 1,123 scans after reset, before the
USDJPY entry described above, found:

- `10,107` asset decisions;
- `10,104` `HOLD`;
- `3` `BLOCKED`;
- `0` executed entries.

Decision states:

| State | Count |
|---|---:|
| `NO_BIAS` | 5,342 |
| `WATCH_SHORT` | 2,823 |
| `TRIGGER_PENDING` | 1,931 |
| `WATCH_LONG` | 8 |
| `BLOCKED_RISK` | 3 |

Primary blockers:

| Blocker | Count | Share |
|---|---:|---:|
| Structure/liquidity not aligned | 7,529 | 74.5% |
| After-cost reward/risk too weak | 1,917 | 19.0% |
| Live price too far from signal candle | 542 | 5.4% |
| Higher-timeframe evidence too weak | 107 | 1.1% |
| Data quality below minimum | 3 | less than 0.1% |

This early funnel proves that the system was evaluating markets but was
extremely selective. The later USDJPY probe proves that selectivity was not a
permanent execution lock.

### The First Three Engine-Ready Candidates

Three EURUSD decisions reached an engine entry path. The final admission
controller rejected each because estimated realistic captured profit was about
`$0.82`, below the hard `$3.00` useful-net-profit floor.

That floor contributes to inactivity, but removing it is not currently
justified:

- the expected dollar result was very small;
- the strategy has no post-reset closed-trade evidence;
- the latest replay is negative;
- more tiny trades can create turnover and model noise without establishing an
  edge.

The floor should be reconsidered only through a versioned experiment. A safe
experiment would keep normal admission unchanged and test a tightly bounded
paper-only probe cohort with explicit daily count, risk, turnover, and
after-cost expectancy limits.

The later USDJPY probe did not need such a relaxation. It reached the existing
controlled-probe path with an expected net reward of `$16.19`, comfortably
cleared the useful-profit floor, and was admitted under the existing policy.
This is another reason not to loosen the current gate merely to increase count.

### Misleading `all entry gates passed`

Nine ledger rows used the fallback text `all entry gates passed`. Only three had
a real entry path. The other six satisfied generic booleans but did not satisfy
a complete normal, exception, or controlled-probe mode.

This was a diagnostics bug, not six missing trades. The local fix emits:

`no complete normal, exception, or controlled-probe entry path is satisfied`

unless a complete mode is actually true.

## Reset and Learning Audit

The reset did not reactivate all old patterns. That would have recreated the
legacy contamination bug.

The reset:

- cleared current-strategy portfolio and derived learning state;
- retained older versioned records for audit only;
- recorded reset provenance;
- began rebuilding rules from post-reset opportunities.

At audit time the dashboard showed:

- hundreds of post-reset opportunities evaluated;
- eight current rules;
- zero current closed trades;
- learning making the bot more selective.

Therefore the current rules come mostly from watched-opportunity outcomes, not
new realized P&L. They can reduce confidence, but they are not proof that a
pattern is profitable. Closed trades and chronological holdout evidence are
still required for stronger promotion or quarantine conclusions.

## Mathematical and Replay Audit

The deterministic engineering audit passed all 85 pre-change checks. It
validated:

- asset-specific contract math;
- fee-aware reward/risk;
- adverse and deterministic paper fills;
- risk-at-stop sizing;
- margin, drawdown, turnover, correlation, and accounting guards;
- strategy-version isolation;
- WebSocket redundancy;
- reset recovery;
- stop, target, trailing, and signal-invalidation behavior.

A fresh replay over 720 15-minute candles for all nine assets produced:

| Metric | Result |
|---|---:|
| Closed trades | 6 |
| Wins / losses | 1 / 5 |
| Win rate | 16.7% |
| Profit factor | 0.14 |
| Net return | `-$161.51` / `-1.62%` |
| Maximum drawdown | 1.62% |
| False-positive rate | 83.3% |
| Missed-opportunity rate | 27.4% |

The old acceptance function still returned PASS because it checked only whether
the execution harness ran correctly. It did not require a positive strategy
result.

The local upgrade separates:

1. **Engineering integrity:** modeled fills, fee reconciliation, stale-data
   exclusion, score coverage, and sizing safety.
2. **Research quality:** at least 30 closed trades, positive after-cost return,
   and profit factor of at least 1.10.

The current replay now correctly fails research quality. This is a guardrail
against promoting a mechanically valid but loss-making strategy.

## Code and Repository Findings

### Removed as Proven Dead or Misleading

The former authenticated `/api/agent/optimize` route:

- added random drift to indicator parameters;
- stored those values under `quant:optimized_params`;
- had no consumer in the live strategy;
- attempted to call a nonexistent `python-worker`;
- attempted optional Supabase pruning;
- described the operation as optimization despite no objective function,
  validation, or holdout evidence.

The route and its two exclusive helper modules were removed locally. This is
cleanup of a no-op black-box surface, not a strategy behavior change.

### Retained Pending More Evidence

Supabase was not removed. Although it is not required for runtime decisions,
the trade journal still references its optional closed-trade mirror. Removing
the package requires a separate persistence decision and recovery test.

Historical planning documents and untracked reviewer materials were not
deleted. A filename looking old is not sufficient evidence that it has no audit
or user value.

### Refreshed

- `docs/ARCHITECTURE.md` now describes the VPS single-writer runtime, current
  feed mesh, reset semantics, research gates, exact-SHA deployment, and
  deliberately excluded capabilities.
- stale QStash/Vercel comments were removed from current auth/logging code.
- the OpenRouter referrer and CLI documentation now use
  `trader.tejashendre.com`.

## External Architecture Reality Check

The supplied agentic-investing transcript is directionally relevant, but its
strongest lesson is caution rather than unlimited autonomy. It includes a small
retail bot that lost money and repeatedly states that users review workflows,
retain final approval, and need guardrails.

This system is ahead of a basic prototype in observability, feed redundancy,
paper execution realism, and versioned learning. It is not ahead of the
evidence required for autonomous capital allocation.

Oracle currently documents Always Free A1 capacity as equivalent to 2 OCPUs and
12 GB of memory, and notes that idle free instances may be reclaimed. Confirm
the tenancy's current console limits before adding heavy self-hosted telemetry
or databases. See [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

Rust is not the next bottleneck. A Rust rewrite would not repair weak
expectancy, free-feed latency, candle semantics, or sparse admission. Profile
first. Keep TypeScript for the current minute-scale paper system; use Rust only
if a measured parser, simulation, or event-throughput hotspot justifies it.
Genuine HFT would require exchange colocation or very low-latency hosting,
direct/paid market data, order-book reconstruction, live execution, and
microsecond-level telemetry that this architecture intentionally does not have.

## Priority Upgrade Plan

### P0 - Required Before Strategy Expansion

1. Deploy and verify the truthful chart and diagnostics fixes.
2. Keep the new replay research-quality gate.
3. Add a frozen replay dataset so strategy comparisons are reproducible across
   releases instead of depending only on the latest Yahoo window.
4. Record an explicit candidate funnel per scan:
   analyzed -> directional -> trigger -> economic -> engine-ready -> admitted.
5. Observe the current version until it has enough post-reset outcomes to
   estimate opportunity quality without legacy contamination.

### P1 - Versioned Strategy Research

1. Evaluate structure-continuation logic in replay without changing production.
2. Compare the current structure gate with a continuation-specific state using
   purged walk-forward folds.
3. Test a paper-only micro-probe cohort for economically positive engine-ready
   candidates that miss only the fixed dollar floor.
4. Reject any candidate version that does not improve after-cost expectancy,
   profit factor, and drawdown together.
5. Promote only a new explicit strategy version; never silently mutate v4.1
   thresholds.

### P2 - Operations

1. Add resource alerts for disk, memory, Redis persistence, container restarts,
   and feed reconnect counts.
2. Retain exact source-manifest verification after deployment.
3. Add scheduled state backups with restore drills.
4. Use OCI's included monitoring before self-hosting a heavy observability
   stack on limited Always Free capacity.

### P3 - Future Execution Research

1. Keep live brokerage execution disabled.
2. Add shadow order-book reconstruction and latency histograms if moving toward
   faster crypto research.
3. Add exchange-specific fee tiers and basis/funding attribution before any
   live-capital discussion.
4. Require human approval, kill switches, and legal/regulatory review before
   connecting accounts.

## Release Acceptance Gates

A next release should not be called complete until:

- local lint, typecheck, build, strategy audit, and source manifest pass;
- the live-data replay reports engineering integrity separately from research
  quality;
- GitHub Actions succeeds for the intended SHA;
- production API, VPS checkout, and source manifest agree on that SHA;
- all three containers are healthy;
- scan IDs advance across repeated observations;
- crypto has at least two fresh independent sources;
- all nine chart assets load;
- IST is selected automatically for an India browser without overwriting a
  saved user selection;
- chart `PRICE`, `CANDLE`, and candle-open time are not conflated;
- no new daemon/dashboard errors appear;
- Redis and local portfolio state are preserved.
- the open USDJPY position and its watchdog state survive the deployment
  without duplicate entry, accounting drift, or ledger discontinuity.

## Final Answer

The reset did not destroy the bot. It produced a clean current-version learning
cohort, the runtime is actively evaluating markets, and the first observed
post-reset USDJPY controlled probe proves that autonomous entry and management
still work. The long initial wait was mostly a consequence of strict structure
and economics gates, with three earlier candidates blocked by the minimum
useful-profit floor.

The system should not be forced into mass trading today. The latest replay does
not show an edge. The best next move is to deploy the transparency and research
gate fixes, preserve the current thresholds, collect clean paper evidence, and
research any higher-cadence candidate as a separate strategy version.
