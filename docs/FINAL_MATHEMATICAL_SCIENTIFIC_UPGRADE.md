# Final Mathematical and Scientific Trading-System Upgrade

**Audit date:** 2026-07-18 to 2026-07-20
**Scope:** repository, production spectator telemetry, chart behavior, execution mathematics, learning, risk, and deployment readiness
**Change status:** v4.0 is deployed; v4.1 strategy-isolation and guarded STRONG paper-margin implementation is verified locally and pending publication/deployment
**Capital mode:** paper trading only

## Executive Verdict

The infrastructure is active, but the deployed strategy does not currently have
a demonstrated after-cost edge. The production snapshot contained 275 closed
trades, a 54.91% win rate, a 0.81 profit factor, and -$504.04 net PnL. The main
problem is not an absence of scans. It is an admission model that permitted
repeated controlled probes after the same setup families had already failed in
later chronological samples.

The chart defect and the major mathematical defects are fixed in this local
branch. The upgrade does not force trades. It makes profitable economics a
precondition for an entry and quarantines patterns with measured negative
out-of-sample expectancy.

The final implementation also replaces the fee-only paper approximation with a
versioned deterministic execution-cost model, enforces independent portfolio
circuit breakers, writes a durable hash-chained execution ledger, isolates the
new strategy's probation cohort, and proves source parity between Git, the VPS
checkout, and both application containers during deployment.

This system must not be described as HFT. A one-minute decision loop, public
WebSockets, Yahoo fallback candles, Internet routing, and a general Oracle VPS
are suitable for autonomous paper swing or fast-swing research. They do not
provide exchange co-location, deterministic microsecond latency, tick-level
licensed data, or queue-position execution required for genuine HFT.

## Final v4.1 Dormancy Diagnosis and Margin Upgrade

### The bot was scanning; legacy memory was suppressing the new strategy

The final production diagnosis was taken from healthy deployment `8f019f5`.
All three containers were healthy, the scan counter was advancing, all nine
assets returned a decision, and the latest scan contained no execution error.
It nevertheless produced nine `HOLD` decisions and no entry. Seven blockers
said that local learning had placed the pattern in watch-only mode.

That behavior exposed a provenance defect. The research audit correctly
reported zero closed trades for the current `swing-v4.0.0-2026-07-19` cohort,
but live admission still built setup and asset performance from all 276 legacy
closed trades. Local-learning, opportunity, and trade-review Redis keys were
also global. The new strategy therefore inherited vetoes learned under old
entry mathematics even though its own probation cohort contained no trades.

The v4.1 correction preserves every old trade and Redis record for audit, but
removes their authority over the current strategy:

- setup and asset performance filter to the exact current strategy version;
- local-learning rules use a strategy-version namespace;
- opportunity observations, pending evaluations, summaries, and dedupe keys
  use a strategy-version namespace;
- trade reviews and their digest use a strategy-version namespace;
- the status API reports only current-version setup performance;
- the strategy version advances to `swing-v4.1.0-2026-07-20` so probation starts
  honestly from zero current-version closes.

This does not force an entry when market structure, liquidity, economics, or
feeds fail. It removes only the false cross-version veto.

### Guarded STRONG paper-margin policy

The paper engine now persists one of three margin modes on each position,
entry, scale-in, partial exit, and close:

| Mode | Selection | Sizing behavior |
| --- | --- | --- |
| `PROBE` | Conviction below 68 | Smallest conviction-scaled asset allocation |
| `STANDARD` | Conviction at least 68, or STRONG prerequisites not met | Existing stop-risk, leverage, feed, learning, and asset caps |
| `STRONG` | Swing; conviction at least 85; `REALTIME_FAST`; data quality at least 85; non-negative learning; setup multiplier at least 1 | Up to the full per-asset 10% margin cap and 5x crypto leverage, still constrained by modeled stop loss and portfolio breakers |

`STRONG` is deliberately an eligibility class, not permission to spend a fixed
amount. The final amount remains the minimum of stop-risk sizing, available
cash, the per-asset margin cap, the 40% total portfolio margin cap, and any
requested-margin limit. Fee drag, realistic after-fee profit, duplicate-asset,
daily loss, turnover, correlation, stress, and accounting-drift gates remain
fail-closed.

The base stop-risk budget is 1% of estimated equity before conviction, setup,
learning, and feed multipliers. Drawdown throttles it to 0.75x above 3%, 0.5x
above 5%, and 0.25x above 8%. The deterministic audit therefore produced:

```text
healthy $10,000 portfolio, conviction 85, verified fast data:
  mode              = STRONG
  margin            = $1,000.00
  leverage          = 5x
  modeled stop loss = $83.33 after the asset margin cap

$9,000 equity at 10% drawdown, conviction 92, verified fast data:
  base risk         = 1.00% * 0.25 drawdown throttle
  strong multiplier = 1.50
  risk budget       = $9,000 * 0.01 * 0.25 * 1.50 = $33.75
  modeled stop loss = $33.75
```

A negative learning adjustment removes STRONG eligibility. A slow cached feed
also removes STRONG eligibility and retains its 0.65 risk multiplier. This is
the necessary distinction between stronger deployment and reckless sizing.

## Production Evidence Before This Upgrade

The following values came from the deployed spectator status API before any
local code was changed:

| Metric | Observed value | Interpretation |
| --- | ---: | --- |
| Initial paper capital | $10,000.00 | Evaluation baseline |
| Current value | $9,495.96 | 5.04% below initial capital |
| Closed trades | 275 | Sufficient to reject a claim that no trading occurred |
| Wins / losses | 151 / 124 | 54.91% observed win rate |
| Gross profit | $2,162.06 | Sum of positive net close records |
| Gross loss | $2,666.10 | Absolute sum of negative net close records |
| Profit factor | 0.81095 | Losing after modeled costs |
| Net PnL | -$504.04 | Current realized result |
| Total fees | $628.91 | Larger than the entire loss magnitude |
| Average win | $14.32 | Too small relative to average loss |
| Average loss | $21.50 | 1.50 times the average win |
| Net expectancy | -$1.83/close | Negative realized expectancy |
| Maximum drawdown | 9.12% | Already in recovery-risk territory |
| Open positions | 0 | Not blocked by occupied asset slots |

### Final pre-deployment checkpoint

Immediately before publication, the Oracle VPS remained clean on commit
`f5cf5f8`, with all three containers healthy, 41 GB free disk, Redis AOF enabled,
and its latest RDB save successful. Production scan 6,153 completed at
2026-07-19T18:26:18Z with no errors: six assets were session-closed, two were
watch-only, and one lacked a confirmed short-term trigger. All nine price
assets returned positive values.

The realized baseline had advanced by one losing close to 276 completed trades,
-$508.62 net PnL, 0.8096 profit factor, -$1.84 expectancy per close, and $630.30
in fees. There were no open positions. This confirms the old system was active,
not crashed, while reinforcing that its historical results cannot validate the
new strategy version.

### Accounting reconstruction

The key equations are:

```text
profit_factor = gross_profit / gross_loss
              = 2162.06 / 2666.10
              = 0.81095

net_expectancy = total_net_pnl / closed_trades
               = -504.04 / 275
               = -1.8329 USD per close

approximate_pre_fee_edge = net_pnl + total_fees
                         = -504.04 + 628.91
                         = +124.87 USD

approximate_pre_fee_expectancy = 124.87 / 275
                               = +0.4541 USD per close

break_even_win_rate = average_loss / (average_win + average_loss)
                    = 21.50 / (14.32 + 21.50)
                    = 60.03%
```

The actual 54.91% win rate is approximately 5.12 percentage points below the
payoff-implied break-even rate. Fees consumed 6.29% of initial capital and
124.77% of the net loss magnitude. The strategy had a very small approximate
pre-fee edge, but turnover converted it into a material after-fee loss.

A 95% Wilson interval for the observed win rate is approximately 49.00% to
60.68%. This interval is too broad to claim a stable positive win probability,
and its upper edge only barely reaches the observed 60.03% break-even rate. PnL,
profit factor, payoff ratio, and costs must therefore remain first-class gates;
win rate alone is not sufficient.

## Reproduced Desktop Chart Defect

### Symptom

On the production desktop dashboard:

1. Select `Commodities`.
2. Select `Crude Oil` or `Silver`.
3. The heading changes to the requested asset.
4. The plotted values remain around Gold's price near 4,009 instead of Oil near
   81 or Silver near its own market price.

### Root cause

`src/components/Dashboard.tsx` retained the previous successful `chartData`
when a new chart request failed. The heading came from `activeAsset`, while the
candles came from stale React state. Closed commodity markets made this easy to
trigger because `MarketService.getCandles()` correctly rejected stale candles
for trading, and `/api/chart` reused the same fail-closed method.

The symbol map itself was correct:

- Gold: `GC=F`
- Oil: `CL=F`
- Silver: `SI=F`

### Implemented correction

- Trading calls still reject stale candles by default.
- Read-only chart calls may explicitly request the latest historical series.
- `/api/chart` returns `asset`, `interval`, `stale`, and `asOf` metadata.
- The dashboard clears the previous series when asset/timeframe changes.
- Requests are abortable, and mismatched asset or interval responses are
  rejected.
- Closed-market candles are labeled `LAST`, never `LIVE`.
- Loading and unavailable states cannot display another asset's candles.

## Mathematical Root Causes

### 1. Entry was decided before target economics

In `src/lib/swingEngine.ts`, `normalEntry`, `exceptionEntry`, and probe decisions
were calculated before `evaluateTargetReachability()`. A target could be
compressed after the trade was already logically approved. Target reachability
therefore did not control admission.

**Correction:** stop, target, reachable target, after-fee reward/risk, and then
conviction are now calculated in that order. No entry path can bypass the
economics gate.

### 2. Every candidate received a fictional reward/risk bonus

The old formula included a constant `riskRewardScore = 10`, even before stop and
target economics existed:

```text
old_conviction = 2.2*HTF + 1.4*trigger + liquidity + flow
               + data_score + 10 + learning
```

This gave weak candidates free conviction and allowed a very high short-term
trigger to overpower poor higher-timeframe evidence.

**Correction:** the fixed bonus is removed. Reward/risk contributes zero to ten
points based on the actual net ratio after estimated entry and exit fees.

### 3. Trigger evidence was unbounded relative to HTF evidence

Recent BTC probes had HTF scores around 9 to 11 but trigger scores around 19 to
30, producing displayed convictions as high as the 90s. Some entries also
contained `STRUCTURE_AGAINST_TREND` tags.

**Correction:** calibrated conviction has explicit contribution caps:

| Component | Maximum contribution |
| --- | ---: |
| HTF evidence | 45 |
| Trigger evidence | 20 |
| Liquidity/structure | +10 / -10 |
| Microstructure | +10 / -10 |
| Data quality | 10 |
| Net reward/risk | 10 |
| Weekly alignment | +5 / -8 |
| Learning | +8 / -12 |

A deterministic regression test now gives a weak-HTF/high-trigger candidate a
conviction of 61, while a fully aligned candidate reaches 100.

### 4. Fee viability was checked too late and too loosely

Trade admission checked whether a fraction of full target profit could clear
fees, but the signal engine did not use the net payoff ratio. A compressed
target could remain nominally profitable while offering poor risk-adjusted
economics.

**Correction:** per-unit contract-aware economics are now:

```text
net_reward = gross_profit_at_target - entry_fee - target_exit_fee
net_loss   = gross_loss_at_stop + entry_fee + stop_exit_fee
net_RR     = net_reward / net_loss
```

- Standard and exception entries require net reward/risk >= 1.35.
- Probe entries require net reward/risk >= 1.50.
- Invalid or non-positive net reward fails closed.
- USD/JPY conversion uses the contract-aware PnL helpers rather than treating a
  JPY price move as USD.

The deterministic test produces 1.81 for a viable target and 1.06 for a
compressed target; only the first passes.

### 5. Later-sample failure did not demote a historically good setup

The system required later chronological evidence before promoting a setup, but
did not apply the symmetrical rule when later evidence collapsed. For example,
`VWAP_REJECTION` was positive over its lifetime yet had approximately 23 later
trades with a 0.285 out-of-sample profit factor and negative average PnL. It was
only mildly penalized and remained tradable.

Other major setup families also showed strongly negative later samples,
including trend breakout, momentum continuation, volatility expansion, volume
burst, and VWAP reclaim.

**Correction:** a setup or asset is quarantined when all are true:

```text
out_of_sample_trades >= 12
out_of_sample_average_pnl < 0
out_of_sample_profit_factor < 0.85
```

Quarantine creates a `WATCH_ONLY` learning rule. It is a veto in both the signal
engine and portfolio guard, not a small size reduction. A different, unfailed
setup remains able to earn admission.

Quarantine is not permanent. A failed setup becomes eligible only for a reduced
recovery probe after at least 20 independent watched opportunities achieve all
of the following without risking capital:

```text
watched_favorable_rate >= 60%
average_watched_net_pnl > 0
watched_profit_factor >= 1.15
```

The recovery probe's close then re-enters the chronological trade sample. This
provides an autonomous relearning path without erasing the failed evidence.

### 6. Probe losses were excluded from asset expectancy

The previous design tried to prevent small exploratory losses from poisoning an
entire asset. In production this created the opposite failure: repeated probes
could lose money without ever teaching the asset-level safety model.

**Correction:** every closed position now contributes to asset performance.
Probe size already limits dollar impact; its outcome cannot be omitted from
capital-based learning.

### 7. Probe thresholds and retry cadence were too permissive

Crypto probes could use HTF evidence as low as 8 against a normal threshold of
14, and a losing asset could retry after only ten minutes.

**Correction:**

- probes require HTF evidence no more than two points below the normal threshold;
- exception entries require HTF evidence no more than three points below normal;
- probe learning adjustment must be at least -4;
- probes require stronger net reward/risk than standard entries;
- a losing probe receives a four-hour asset cooldown;
- a standard stop loss receives a two-hour cooldown;
- other negative invalidations receive a one-hour cooldown.

### 8. Conviction multiplied risk too aggressively

The prior no-drawdown maximum was 1.5% base risk multiplied by 2.25, or 3.375%
of estimated equity before learning, feed, and setup adjustments. Conviction
also influenced leverage and margin caps, so an uncalibrated score affected
several controls at once.

**Correction:**

- base risk-at-stop is 1.0% of estimated equity;
- maximum conviction multiplier is 1.5;
- no-drawdown maximum risk-at-stop is therefore 1.5% before protective
  reductions;
- drawdown reductions remain active;
- a setup-size boost now requires a positive learning adjustment, not merely
  high conviction.

At the current drawdown above 8%, the existing 25% drawdown multiplier limits
the pre-setup risk budget to at most 0.375% of equity.

### 9. Close records omitted decision evidence

Close records did not preserve `entryMode`, `learningAdjustment`, or the net
reward/risk ratio, making post-trade forensic analysis incomplete.

**Correction:** these values are persisted from the open position into the
close record. Future trades can be segmented by standard versus probe entry and
by the learning/economic state that admitted them.

## Files Changed Locally

| File | Purpose |
| --- | --- |
| `src/lib/market.ts` | Separate stale read-only charts from fail-closed trading data |
| `src/app/api/chart/route.ts` | Return asset identity and freshness metadata |
| `src/components/Dashboard.tsx` | Clear stale UI state, abort requests, reject mismatched series, label historical data |
| `src/lib/swingEngine.ts` | Reorder admission, add fee-aware net reward/risk, calibrate conviction, tighten probes |
| `src/lib/trading/setupPerformance.ts` | Add chronological quarantine and count probe outcomes at asset level |
| `src/lib/trading/localLearning.ts` | Convert failed holdouts into `WATCH_ONLY` veto rules |
| `src/lib/trading/portfolioGuards.ts` | Enforce quarantine as a defense-in-depth block |
| `src/lib/trading/tradeAdmission.ts` | Reduce risk amplification and require earned setup boosts |
| `src/lib/execution/swingLifecycle.ts` | Extend loss cooldowns and preserve close evidence |
| `src/lib/types.ts` | Add persisted learning and reward/risk fields |
| `src/daemon/swingDaemon.ts` | Store the new admission evidence on positions and trades |
| `scripts/strategy-audit.ts` | Add deterministic mathematical, quarantine, and chart regressions |
| `src/lib/trading/executionCostModel.ts` | Versioned deterministic fills, fees, spread, slippage, stop gaps, and carry |
| `src/lib/trading/portfolioRiskBudget.ts` | Rolling turnover, loss, correlation, stress, cost, drawdown, and reconciliation breakers |
| `src/lib/trading/executionLedger.ts` | Durable append-only NDJSON decision/fill ledger with a SHA-256 hash chain |
| `src/lib/research/walkForward.ts` | Embargoed expanding walk-forward folds, bootstrap intervals, trial adjustment, and segmentation |
| `src/lib/backtest/replayEngine.ts` | Apply the same adverse execution model and accounting rules in replay |
| `src/lib/riskManager.ts` | Use modeled liquidation value for profit protection |
| `src/lib/trading/opportunityJournal.ts` | Score watched outcomes after modeled execution costs |
| `scripts/research-audit.ts` | Report the current strategy version as an isolated post-upgrade cohort by default |
| `scripts/verify-execution-ledger.ts` | Verify every ledger hash and cross-file predecessor link |
| `scripts/source-manifest.mjs` | Produce a deterministic runtime-source manifest for host/container parity |
| `.github/workflows/deploy.yml` | Exact-SHA state-preserving deployment, backups, CI gates, and post-deploy verification |
| `Dockerfile`, `docker-compose.yml` | Embed and expose deployment revision metadata in both application containers |
| `scripts/vps-deploy-check.sh` | Verify clean Git state, exact source manifests, image revisions, ledger integrity, APIs, and scan advancement |
| `src/app/api/trade/route.ts`, `src/app/api/trade/swing/route.ts` | Replace duplicate fee-only portfolio mutation with an authenticated daemon scan request |
| `src/lib/trading/scanControl.ts`, `src/lib/redis.ts` | Atomically hand admin scan requests to the single-writer daemon |

## Verification Completed

All verification was performed locally without changing the VPS or GitHub.

```text
TypeScript:       PASS (0 errors)
ESLint:           PASS (0 warnings, 0 errors)
Strategy audit:   PASS (82 passed, 0 warnings, 0 failures)
Next.js 15 build: PASS
Source manifest:  PASS (90 runtime files, deterministic SHA-256 manifest)
Ledger verifier:  PASS (valid empty pre-deployment ledger)
Shell syntax:     PASS (deployment and maintenance scripts under Git Bash)
Desktop chart:   PASS (Oil 81.78; Silver 56.33; both labeled LAST)
```

The desktop check used the local application with a temporary empty Redis test
service. The chart API returned the requested asset identity in every response:

| Requested | Returned | Last 1h close | Freshness label |
| --- | --- | ---: | --- |
| Gold | Gold | 4,009.43 | `LIVE` |
| Oil | Oil | 81.78 | `LAST` |
| Silver | Silver | 56.33 | `LAST` |

The temporary application and Redis test processes were stopped after the
check.

New deterministic checks cover:

- after-fee net reward/risk acceptance and rejection;
- bounded calibrated conviction;
- probe outcomes reaching asset learning;
- positive out-of-sample promotion;
- negative out-of-sample quarantine;
- measured quarantine requalification from independent watched outcomes;
- setup quarantine reaching live admission;
- chart asset identity and closed-market fallback;
- existing fees, USD/JPY conversion, stop geometry, drawdown, total margin,
  duplicate positions, feed safety, lock safety, and replay accounting;
- adverse entry/target/stop fill direction and deterministic repeatability;
- instrument-specific execution profiles and carry calculations;
- after-cost risk sizing that reduces position size instead of deadlocking valid
  candidates at the final execution gate;
- rolling turnover, daily loss, correlated exposure, and accounting-drift
  circuit breakers;
- execution-ledger tamper detection;
- walk-forward uncertainty statistics and strategy-version cohort isolation;
- replay/live consistency under the same modeled execution assumptions.

## Final Upgrade Implementation

### Versioned execution mathematics

The paper engine now records requested and modeled fill prices separately. All
entry, target, stop, reversal, invalidation, scale-in, partial-exit, replay, and
mark paths use adverse fills. The model is deterministic so the same evidence
always reproduces the same result.

```text
size_impact_bps = profile_size_bps * sqrt(order_notional / reference_notional)
adverse_bps = half_spread_bps + slippage_bps + stop_gap_bps
fill_price = requested_price * (1 +/- adverse_bps / 10,000)
net_pnl = pnl(actual_entry_fill, actual_exit_fill) - entry_fee - exit_fee - carry
```

Crypto currently uses a Bybit VIP0 perpetual paper profile. The fee component
uses 0.055% taker and 0.02% maker assumptions, matching Bybit's published VIP0
perpetual schedule at audit time. FX and commodity profiles are explicitly
labeled synthetic proxies; their spreads, slippage, stop gaps, and carry are
research assumptions, not broker quotes. Kraken's published spot schedule is
materially more expensive at low volume, which is why a strategy cannot claim
portable profitability from one venue profile.

Sources: [Bybit trading fee structure](https://www.bybit.com/en/help-center/article/Trading-Fee-Structure),
[Kraken spot fee schedule](https://www.kraken.com/features/fee-schedule?lid=zixhejn7oc72)

### Independent portfolio governor

Signal conviction can no longer override portfolio safety. New entries fail
closed when any rolling budget is exhausted:

- two entries per asset per hour or five per asset per day;
- twelve total entries or 2.5 times equity in entry notional per day;
- execution costs above 0.5% of equity per day or 35% of recent gross edge;
- losses above 2% over 24 hours or 4% over seven days;
- planned stop risk above 3% of equity;
- historical expected shortfall plus planned risk above 6% of equity;
- two existing same-direction correlated exposures;
- drawdown at or above 10%;
- accounting drift above the larger of $5 or 0.5% of equity.

These are conservative paper-system controls inspired by the pre-trade capital,
size, duplicate-action, and ongoing-review principles in the
[SEC Market Access Rule FAQ](https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/divisionsmarketregfaq-0).

### Durable execution evidence

Every scan and order lifecycle event is appended to daily NDJSON files under
`data/execution-ledger`. Each record includes the previous event hash, current
strategy and execution-model versions, sanitized evidence, and its own SHA-256
hash. The daemon refuses to mutate capital if the pre-entry approval event
cannot be durably written. Redis mirrors recent events for fast inspection, but
the mounted data directory is the durable source of execution evidence.

### Single-writer execution ownership

The two POST scan routes previously contained a second copy of the portfolio
entry algorithm. That path could bypass the daemon's final execution model,
portfolio budget, and ledger. Both routes now submit one atomic Redis request;
the daemon consumes it within five seconds and runs the same locked, audited
cycle used by the schedule. No API route can independently open an autonomous
AI position.

### Scientific probation and anti-overfitting controls

`npm run research:audit` evaluates only
`swing-v4.1.0-2026-07-20` by default. Legacy trades cannot inflate or depress
the new strategy's readiness. `--all-versions` is reserved for comparative
research. The harness provides expanding train/validation/test folds with a
trade embargo, bootstrap 95% intervals, a trial-adjusted Sharpe probability,
asset/regime/entry-mode segmentation, and a rough PBO estimate only when at
least two independently versioned strategies exist.

### Exact deployment and source parity

Deployment now materializes the exact GitHub SHA after saving the prior commit,
worktree patch, runtime-source archive, and Redis snapshot. It preserves `.env`,
the mounted `data` directory, and the Redis volume. The post-deploy checker then
requires:

- a clean runtime checkout at the expected commit;
- healthy Redis, dashboard, and daemon containers;
- identical SHA-256 manifests for every runtime source file on the host and in
  both application containers;
- matching OCI image revision labels and status-API deployment metadata;
- a valid execution ledger;
- all strategy-audit gates, live API health, and advancing scan IDs.

## Scientific Basis

This upgrade deliberately separates observation, validation, and deployment:

1. **Chronological validation:** Bailey et al. show why ordinary holdout methods
   can be unreliable after repeated strategy selection and propose measuring
   backtest-overfitting probability with combinatorially symmetric
   cross-validation. The current quarantine is a minimum protection, not a
   replacement for full CSCV.
   Source: [The Probability of Backtest Overfitting](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253)

2. **Selection-bias control:** the Deflated Sharpe Ratio adjusts performance
   claims for multiple testing and non-normal returns. It should be added before
   any future strategy is promoted from research to capital.
   Source: [The Deflated Sharpe Ratio](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551)

3. **Small-sample uncertainty:** NIST documents Wilson and exact binomial
   intervals and warns that simple symmetric normal intervals can be inaccurate
   for small samples. Setup dashboards should show uncertainty bounds, not only
   point win rates.
   Source: [NIST confidence intervals for proportions](https://itl.nist.gov/div898/handbook/prc/section2/prc241.htm)

4. **Transaction-cost analysis:** execution benchmarks have fat tails,
   skewness, and changing variance; finite-sample transaction-cost estimates
   should retain uncertainty rather than use one universal fixed number.
   Source: [Bayesian Trading Cost Analysis and Ranking of Broker Algorithms](https://arxiv.org/abs/1904.01566)

5. **Pre-trade controls:** SEC market-access guidance emphasizes pre-set capital
   limits, order price/size controls, duplicate-order prevention, and ongoing
   review because automation errors can compound rapidly. This paper system is
   not asserted to be subject to that rule, but the engineering principles are
   directly relevant to autonomous execution safety.
   Source: [SEC Market Access Rule FAQ](https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/divisionsmarketregfaq-0)

## Remaining Evidence Before Any Real-Money Discussion

### P0: paper probation on the corrected engine

Do not use historical trades as proof of the new engine. They were generated by
the old admission mathematics. After deployment, collect at least 30 to 50 new
closed paper trades for an initial review and 100 or more for a stronger
assessment. Time coverage across multiple regimes matters as much as trade
count.

Minimum preliminary gates:

- after-fee profit factor >= 1.10;
- after-fee expectancy > 0;
- no stale-data entries;
- no chart asset-identity mismatch;
- no quarantine bypass;
- no duplicate asset entries;
- probe entries below 20% of new entries;
- fees below 25% of gross profit;
- drawdown not worse than the pre-upgrade 9.12% peak;
- every close retains entry mode, learning adjustment, and net reward/risk.

These are acceptance criteria, not profit guarantees.

### P1 foundation: implemented; venue calibration remains

The single universal fee approximation has been replaced by versioned
asset/venue profiles containing:

- maker and taker fee schedule;
- bid/ask spread adjusted by session, feed quality, and liquidity state;
- order-size-dependent slippage;
- gap-through stop execution;
- funding or carry where applicable;
- deterministic adverse fills and lifecycle-aware partial exits.

Store assumed and realized execution cost separately. Never tune a strategy on
one cost model and report it under another.

Before any real-money discussion, replace synthetic FX/commodity parameters
with the exact intended broker/contract specifications and calibrate delayed,
rejected, and partial-fill distributions from captured venue evidence. Futures
roll behavior remains intentionally out of scope while the system trades
continuous public-data proxies.

### P1 foundation: implemented; sample collection remains

The repository now contains train/validation/test windows and rolling
walk-forward evaluation with:

- purged/embargoed folds for overlapping labels;
- CSCV or an equivalent probability-of-backtest-overfitting report;
- a Deflated-Sharpe-like trial adjustment and number-of-trials tracking;
- bootstrap confidence intervals for expectancy, profit factor, and drawdown;
- regime and asset segmentation;
- champion/challenger strategy versions;
- an isolated strategy-version probation cohort.

A truly frozen final test set cannot exist until the new strategy has generated
enough post-deployment trades. The first 30 to 50 closes are preliminary only;
100 or more closes across multiple regimes provide the stronger review sample.

### P1: implemented

Rolling limits are now independent of signal conviction:

- entries per asset per hour/day;
- total entry notional per day;
- fees per day as a percentage of equity and gross edge;
- correlated directional exposure;
- expected shortfall and stress losses;
- daily and weekly loss circuit-breakers;
- automatic strategy quarantine on telemetry or accounting drift.

### P1: implemented

Redis remains useful for fast state, while decisions and order lifecycle events
now also use an append-only durable event ledger containing:

- strategy and model version;
- market-data source and timestamps;
- feature values and thresholds;
- original and adjusted stop/target;
- cost assumptions;
- admission and guard decisions;
- order/fill lifecycle;
- realized and hypothetical outcomes.

### P2: Rust only where measurements justify it

Rust is appropriate later for deterministic feed ingestion, order-book state,
normalization, risk checks, and a low-latency execution gateway. Python remains
appropriate for research, statistical validation, and model development.
TypeScript can continue serving the dashboard and control plane.

Do not rewrite the current signal engine in Rust to make it "HFT." Language
speed cannot compensate for public Internet data, one-minute scans, uncertain
fills, or an unproven edge. First prove after-cost strategy quality and measure
where latency is actually lost.

## Push and Deployment Checklist

This release is authorized for GitHub publication and state-preserving VPS
deployment. Execute and retain evidence for every step:

1. Review `git diff` and commit only the files listed in this report.
2. Do not include unrelated untracked local files.
3. Push the review branch and open a pull request.
4. Require TypeScript, strategy audit, and production build checks.
5. Snapshot the VPS Redis volume and portfolio state; do not reset history.
6. Deploy with the existing state-preserving VPS procedure.
7. Restart the swing daemon so learning rules rebuild from closed trades.
8. Verify container health, deployment commit, and advancing scan IDs.
9. Test Oil and Silver charts during a closed market and confirm `LAST` data is
   the selected instrument.
10. Confirm the first scans show quarantined setup/asset blockers where
    expected and no stale-feed entries.
11. Confirm the status API reports the exact commit, strategy version, cost
    model version, paper-only boundary, and a non-empty ledger head.
12. Treat only trades carrying the new strategy version as the probation
    cohort.
13. Review after 30 to 50 new closes; do not infer profitability from a deploy
    success or one winning trade.

## Final Boundary

This upgrade fixes identified software and mathematical defects. It does not
establish that the strategy is profitable, does not enable live-money trading,
and does not turn the Oracle VPS into an HFT platform. The next valid claim is
only that the corrected paper engine is ready for a fresh, measured probation
after review and deployment.
