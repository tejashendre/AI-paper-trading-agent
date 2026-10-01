# Strategy coverage audit and improvement design

Audit date: 1 October 2026. User priority: broader coverage across every configured asset class. Scope completed: local code review, public spectator runtime checks, reproducible diagnostics, and a proposed implementation sequence. Trading behavior and deployed services were not changed.

## Verdict

The first improvement should be correctness, followed by asset-specific research. An LLM is not required to repair this system or run its trading and learning loop. Five of the nine configured instruments cannot pass the current entry provenance gate even when their feed and signal are valid. The learning evaluator also drops profitable partial exits, turning the overall closed-position outcome from +$68.43 into -$80.88 in its asset buckets. The separate cross-sectional book has breached its drawdown breaker, which leaves existing positions open and disables future rebalancing.

These findings explain concrete parts of the poor coverage and apparent lack of improvement. They do not establish that opening more positions will create positive expectancy. Every asset should receive valid observation, evaluation, and an explicit decision; an asset should receive a trade only when a strategy passes data, execution, and portfolio checks.

## Evidence and limits

The final live status sample completed at 2026-10-01 06:19:32 UTC, or 11:49:32 IST. The book sample was generated at 06:20:26 UTC. Public GET requests used the existing spectator access to `/api/user/status`, `/api/book`, `/api/sleeves`, `/api/live-prices`, and `/api/health/feeds`. No administrator operation or live order was submitted.

The reported deployment commit `1242b2c850f975010f67639aea5ccfaba4747de7` matches local HEAD. This confirms the reported revision, not a fresh VPS container/source-manifest verification. Scan IDs advanced from 32327 to 33060, with no errors in the sampled scan. The historical trade rows currently exposed begin in late August; they cannot establish performance continuously since the May build.

| Account | Latest sampled result | Interpretation |
|---|---|---|
| Swing | $10,068.43 equity on $10,000 initial capital, +0.684%; no open positions | Small positive simulated result, with 35 completed positions and 13 partial exit records |
| Swing dashboard | 48 realized exit records; profit factor 1.216 | Partial exits are counted separately, so this is not a 48-position independent sample |
| Cross-sectional crypto | $8,363.59 equity, -16.364%; maximum drawdown 28.152% | Weak live result, 60 rebalances and 1,739 fills; 24 positions remain open |
| Cross-sectional edge review | `NO_ESTABLISHED_EDGE`, last updated 24 September | An unproven strategy; this verdict is not evidence that an edge was learned |

The existing `npm run audit:strategy` completed with 179 passes, one warning, and zero failures. The warning concerned an eight-trade replay fixture, not a new historical replay. `npx tsc --noEmit --incremental false` passed. Neither result proves profitable behavior. The new read-only diagnostic executes the actual entry-gate expression extracted from the daemon and the actual `SetupPerformance.build` evaluator. Its results are stored in `STRATEGY_COVERAGE_EVIDENCE_2026-10-01.json`.

## 1. Repair the coverage blocker before changing entry thresholds

The router in `src/lib/market.ts:102` selects Bybit for crypto and commodity perpetuals, Kraken for EURUSD/GBPUSD, and Yahoo for USDJPY. The gate in `src/daemon/swingDaemon.ts:655` still branches on asset category: crypto must come from Bybit, and everything else must come from Yahoo. A correctly routed quote therefore fails for five assets. Live logs independently confirm repeated OIL rejection on 1 October at 06:02 through 06:06 UTC, despite the instrument being the configured `CLUSDT`.

| Asset | Configured quote instrument | Correct quote passes current entry gate? | Completed positions in exposed history | Immediate action |
|---|---|---|---|---|
| BTC | Bybit BTCUSDT | Yes | 10 | Preserve gate; correct outcome accounting and evaluate setup edge |
| ETH | Bybit ETHUSDT | Yes | 11 | Preserve gate; keep caution supported by actual losses |
| SOL | Bybit SOLUSDT | Yes | 12 | Correct profitable partial-exit exclusion before evaluating restrictions |
| EURUSD | Kraken ZEURZUSD | No | 0 | Repair provenance routing; explicitly choose synthetic FX or Kraken execution economics |
| GBPUSD | Kraken ZGBPZUSD | No | 0 | Same repair and execution-model decision |
| USDJPY | Yahoo USDJPY=X | Yes | 0 | Audit delayed quote age, volume-dependent indicators, and learning restrictions |
| GOLD | Bybit XAUUSDT | No | 2, both using the earlier Yahoo route | Repair provenance; start a distinct Bybit instrument cohort |
| OIL | Bybit CLUSDT | No | 0 | Repair confirmed live blocker; WTI remains the intended exposure |
| SILVER | Bybit XAGUSDT | No | 0 | Repair provenance; evaluate current watch restriction from correct evidence |

No non-crypto entry is present after the 8 September routing changes in the exposed history. The diagnostic rejects wrong instruments for all nine assets. It also finds that the Yahoo branch itself imposes no quote-age check; this does not prove other freshness checks are absent.

Repair specification: centralize instrument identity and quote-age policy in one instrument registry/helper, and use it in feed health, admission, execution, and audit. Keep asset category for risk limits. Accept a configured venue/instrument with its appropriate freshness policy, and reject wrong venues, wrong instruments, missing timestamps, future timestamps, and stale quotes. Do not weaken validation globally.

The `/api/health/feeds` message that all nine assets 'can trade' currently describes feed readiness only. Publish separate states for data availability, signal eligibility, entry-path eligibility, and risk permission. Track 7-day and 30-day funnels per asset: healthy closed bars -> evaluations -> candidates -> provenance pass -> cost pass -> risk pass -> fills -> complete positions. Attribute vetoes explicitly rather than classifying every quiet asset as having no setup.

## 2. Learn from complete economic outcomes

`src/lib/trading/setupPerformance.ts:299` excludes partial exits and then uses the final leg's `pnl` as the outcome. Partial profits are already separate realized records. They are not included again in the final leg.

| Asset | Final-leg P&L used by learning | Full position P&L including partial exits |
|---|---:|---:|
| BTC | +$63.13 | +$109.73 |
| ETH | -$114.09 | -$89.37 |
| SOL | -$24.53 | +$53.47 |
| GOLD | -$5.39 | -$5.39 |
| Total | -$80.88 | +$68.43 |

The omitted profits total $149.31. A fixture with a +$15 partial and -$5 final close reproduces a learned loss of $5 for an economically profitable $10 position. On the actual data, diagnostic position aggregation changes SOL's setup-performance adjustment from -12 to -4, with remaining caution coming from watched outcomes. Correct accounting does not automatically justify removing all caution.

Repair specification: introduce an immutable position ID, join all fills and realized legs, allocate fees and carry exactly once, and emit one completed-position result when flat. Keep realized cash accounting for partial positions while distinguishing incomplete positions from final outcomes. Use the same position result in setup performance, trade reviews, walk-forward research, and dashboard position statistics. Historical diagnostic grouping by asset/direction/entryTime is adequate for this snapshot, with zero unmatched partial legs, but should not become the production identity scheme without checking scaling and migrations.

Normalize learning targets to net return and initial-risk multiples (R). The current `avgMove` rule field can contain dollars from closed trades or percentages from opportunities, while a common numerical threshold is applied in `localLearning.ts:205`. Label units explicitly and avoid comparing unlike quantities.

## 3. Replace the frozen-book risk state

`src/daemon/crossSectionalDaemon.ts:79` returns before rebalancing when lifetime maximum drawdown reaches 25%. The sampled maximum is 28.152%, and live logs confirm this breaker is active. Twenty-four positions remain open at approximately 102.4% gross exposure. Marking and funding continue.

Because the check uses lifetime maximum drawdown, a subsequent equity recovery does not clear it. The branch also precedes `reviewEdge`, so the published edge review becomes stale while the book is frozen. This is a persistent risk state, not an adaptive learning state.

Proposed state machine: `ACTIVE`, `ENTRY_HALTED`, `REDUCE_ONLY`, and `SHADOW_RESEARCH`. New-risk limits must never suppress risk-reducing exits, exposure caps, stale-price handling, or scheduled risk reviews. Specify whether a drawdown breach unwinds gradually, reduces gross exposure, or closes the paper book under an explicitly selected policy. Keep a separate shadow book collecting recovery evidence while the managed book is restricted. Resetting historic drawdown or granting a recovery budget requires a recorded policy transition; do not silently clear it or erase losses.

The cross-sectional method intentionally excludes non-crypto underlyings. Adding gold, oil, and FX to its ranking to satisfy coverage would mix different market drivers. Dollar neutrality also does not establish beta neutrality. Study volatility-scaled weights, BTC/ETH beta, sector clusters, funding exposure, and turnover in separate candidates.

The August 25 document's 12-month +96.3% replay is superseded by the August 27 headline in `docs/UPGRADE_ROADMAP.md:9`: the 24-month edge was not distinguishable from zero. That is recorded research evidence, not a replay rerun during this audit. Current live weakness makes the older positive result especially unsuitable as a deployment justification.

## 4. What the current self-learning loop actually does

The active swing and cross-sectional daemons run deterministic trading logic. Swing learning rebuilds rules from closed outcomes, watched opportunities, and trade reviews. It changes confidence or restricts patterns; it does not invent, evaluate, and promote a new strategy. Cross-sectional ranking parameters remain fixed while its risk and research monitors observe results.

The sampled learning digest reports 17 rules: one boost and 16 caution rules. No setup has earned promotion. The spectator response exposes only the first eight rule records, so the digest and entry outcomes are necessary to understand the remaining rules.

Specific gaps:

- The same strategy version survives the Yahoo-to-Bybit/Kraken feed changes. Learning keys therefore do not fully isolate changed instrument semantics. GOLD's old Yahoo closes still influence its current Bybit instrument.
- Generic setup rules are shared across asset classes. An unsuccessful crypto VWAP pattern can penalize FX or commodities without evidence that the same feature means the same thing there.
- A performance rule may be allowed because its opportunity count is large, then report a closed-trade sample of only two. Minimum evidence is not a single coherent policy across rule sources.
- A `REDUCE` rule can trigger effective watch-only behavior even when the digest's explicit `WATCH_ONLY` count is zero. The initial snapshot showed this for USDJPY and SILVER.
- Normal and recovery-probe paths can remain unavailable because negative learning blocks probes as well as full entries. Recovery therefore needs independent shadow evidence rather than more forced trades.
- The journal selects one horizon per opportunity, which is good, but defaults to preferring 4h over 24h regardless of strategy family. Distinct opportunity IDs are not proof of statistical independence when their price paths overlap.

Upgrade the loop to: record complete decisions -> label complete net outcomes -> evaluate a small preregistered candidate set -> test later untouched periods -> shadow the winner -> promote within bounded risk -> monitor and revert. Store asset class, instrument, data version, strategy family, regime, session, and risk policy with each observation. Pool small samples within justified groups using shrinkage, and prevent poorly sampled asset/regime buckets from producing strong automatic adjustments.

Reuse the existing replay and research harnesses. The current walk-forward design needs 30 training positions, 10 validation positions, 10 test positions, and two one-position embargoes: 52 positions for the first complete fold. Thirty observations alone cannot satisfy it. Replace position-count embargoes with interval-aware purging when observations overlap. Record all tested configurations; the current trial count derived from strategy-version count misses parameter experiments under the same version. A rolling latest-30% split used repeatedly for adaptations is later chronological evidence, not a permanently untouched test set.

## 5. Strategies to research for the configured classes

These are proposed candidates, not established profitable strategies or immediate production parameters. Keep the existing strategy as the baseline and compare candidates on identical causal data and execution costs. Begin with two distinct families: trend continuation and range reversion. Evaluate breakout continuation as a bounded alternative within the trend family.

| Class | Trend candidate | Range candidate | Instrument-specific constraints |
|---|---|---|---|
| BTC, ETH, SOL | 4h trend plus 1h pullback/reclaim; alternatively closed-bar channel breakout with an ATR buffer | Extreme standardized deviation that re-enters its band when trend strength is low | Live spread, depth, funding, volatility, and shared crypto exposure |
| EURUSD, GBPUSD | Session-aware 4h/1h continuation with a 15m closed-bar trigger | Range-edge rejection during a stable range, evaluated separately by session | Broker-proxy versus exchange-FX semantics, shared USD factor, daylight saving, event windows |
| USDJPY | Slower 4h/1h candidate using reliable closed bars | Price-band reversion without pretending Yahoo volume represents centralized FX flow | JPY-to-USD accounting, quote delay, Tokyo session, separate event risk |
| GOLD, SILVER | Closed-bar breakout/retest or trend pullback on the actual Bybit contract | Low-trend range reversion, separately tested for each metal | Perpetual basis, actual funding interval, gold/silver correlation, underlying closures |
| OIL | Volatility-scaled WTI breakout/continuation | Separate slower range model; disable it during expansion | CL contract identity, energy-event windows, thin-session spread and basis |

A concrete research baseline can use a 20-bar channel excluding the current bar, ATR(14), and a 4h trend filter. A trend entry requires a closed-bar breakout/retest and positive economics. A range entry requires low trend strength and a close back inside a two-standard-deviation band; its initial target is the range center. Treat these numerical settings as one preregistered baseline, not a large optimization grid. Use protective stops based on invalidation and volatility, an explicit time horizon, and the existing risk-unit exit policy as the comparison baseline. Never use current-bar highs/lows to justify a fill that happened earlier.

Separate family-specific exits. A trend runner, a quick range reversion, and a cross-sectional rebalance do not need the same target horizon. Keep sizing bounded by loss at the modeled stop, correlated exposure, and execution capacity. For new shadow candidates, a conservative initial paper risk budget can be 0.25% per position and a 1% aggregate stop-risk budget per account, with tighter cluster caps. These are proposed test settings and must be compared against the baseline; leverage is a consequence of sizing and liquidity, not an improvement target.

Do not require an arbitrary number of real paper entries per asset. Require complete observation and explanation for all nine, complete execution capability for all nine under valid test fixtures, and independent shadow evaluation wherever a family is unproven.

## 6. Make data and simulated execution agree

EURUSD/GBPUSD prices are Kraken exchange FX observations while execution still uses `SYNTHETIC_FX_PROXY` with zero trading commissions. Decide explicitly whether Kraken is a quote source for a synthetic FX study or the modeled execution venue. Kraken's published base FX maker/taker fee is 0.20% per side, making venue-realistic round-trip economics very different from the zero-commission proxy. Do not claim the synthetic account reproduces Kraken execution. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule)

Commodity contracts now use Bybit data but retain `SYNTHETIC_COMMODITY_PROXY` labels and a fixed 0.01% fee per side. The official TradFi VIP0 schedule introduced on 16 June lists 0.0275% taker and 0% maker; the September update says VIP retail pricing is unchanged. Verify instrument and applicable tier when repairing the model rather than assuming spread conservatism compensates for missing fees. [June TradFi schedule](https://announcements.bybit.com/en/article/tradfi-perpetuals-lower-fees-across-all-tiers-bltb196506dada4be39/), [September derivatives update](https://announcements.bybit.com/en/article/lower-fees-simpler-structure-bybit-derivatives-fee-update--art70d07aff01f2/)

The swing carry estimator uses the absolute entry funding rate, assumes eight-hour periods, and charges at least a fixed daily amount. That is a conservative stress model, not actual directional funding settlement. Distinguish modeled stress carry from funding actually paid/received. Read contract funding intervals, quantity steps, minimum notional, and status from venue metadata; commodity perpetuals also need these fields. [Bybit instruments API](https://bybit-exchange.github.io/docs/v5/market/instrument)

Kraken OHLC always includes an unfinished last candle and offers limited recent history. The parser retains that row and normalization does not remove unfinished bars. Define closed-bar semantics for higher-timeframe decisions and keep live intrabar triggers separately labeled. Start a bounded local historical store for ongoing research. Preserve raw bars and flag suspect bars; normalization currently uses neighboring bars, including next-open values, so causal equivalence between replay and live processing needs explicit tests. [Kraken OHLC documentation](https://docs.kraken.com/api-reference/market-data/get-ohlc-data)

Finally, one-minute adverse price movement is not a measured execution slippage fill. `costModelReconciliation.ts` uses this movement as its proxy. Keep it as a post-trade adverse-movement diagnostic, use contemporaneous bid/ask and depth to estimate fills, and remove statements that a near-one proxy ratio makes backtests trustworthy at face value. Low sleeve correlation likewise does not justify combining a negative-edge account with a positive one; the sampled sleeve blend has worse Sharpe than swing alone despite being labeled `DIVERSIFYING`.

## 7. A free core with an optional LLM

Keep the current TypeScript daemons, Next.js viewer, Redis, execution ledger, and scheduled research scripts. Add a bounded append-only market/decision archive on the existing disk, with incremental snapshots and verified backups. Run decisions when relevant bars close instead of recomputing the same high-timeframe state every minute; retain the frequent exit watchdog and freshness monitoring. Rebuild learning after completed outcomes, not for cosmetic scan-count growth. No model subscription is needed.

Existing public exchange data can support the crypto and commodity-perpetual research. The USDJPY Yahoo path supports a labeled proxy study subject to quote quality, not an assurance of executable broker prices. Reliable broker-grade multi-asset data and production availability are not guaranteed at zero cost. Keep usage within actual Oracle tenancy entitlements and retain a restart/restore path: idle Always Free instances can be reclaimed. [Oracle Always Free documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

An optional LLM can summarize completed trade reviews, explain blockers, turn documented research into testable proposals, or extract structured events for review. Run it asynchronously or on demand using redacted inputs. Cache output, validate its schema, track model/prompt versions, and disable the feature when quota or inference is unavailable. Trading must continue with deterministic inputs. Free hosted quotas and local inference do not provide a guaranteed free continuous reasoning service; local inference still uses compute.

An LLM should not fabricate prices, override data provenance, bypass risk, change leverage, or promote an untested strategy. Any LLM-produced hypothesis goes through the same recorded trial, replay, holdout, and shadow gates. The current defects are accounting, routing, and policy defects that a model call does not solve.

## Recommended implementation sequence and acceptance gates

1. Repair instrument provenance and expose separate feed/entry eligibility. All nine correct instrument fixtures must pass; forged/stale fixtures must fail; a controlled paper integration fixture for each class must reach the simulated ledger.
2. Unify completed-position outcomes, including partial exits and costs. The stored realized sum, completed-position sum plus incomplete realized legs, and cash ledger must reconcile. The +15/-5 fixture must produce one +10 position outcome. Rebuild learning into a new evidence version while preserving the historical state.
3. Define the cross-sectional restriction/recovery policy. At a breached drawdown, new risk must remain blocked while risk-reducing exits, fresh marking, funding, and research still run. Verify restart persistence and recovery through explicit transitions.
4. Correct instrument economics and causal data semantics. Test FX source/venue separation, USDJPY conversion, actual commodity fee/funding schedules, unfinished bars, gap handling, and partial fills. Archive source and cost versions with observations.
5. Launch the two family candidates in shadow mode for all configured assets. Use non-overlapping outcomes appropriate to each horizon. Compare after-cost R expectancy, loss tails, drawdown, cost burden, opportunity-to-fill ratio, and class exposure against the baseline and staying in cash.
6. Promote only with later-period evidence, realistic stressed costs, recorded trial counts, and bounded risk. Preliminary counts trigger review, not proof. A minimum sample never guarantees statistical support; sparse asset buckets remain unproven. Record every promotion and rollback.
7. Add the optional review LLM only if an evaluation shows it improves review usefulness or research throughput without changing deterministic trade safety.

Implementation remains pending. The audit adds documentation, sanitized diagnostic evidence, and a read-only diagnostic script. It does not reset accounts, alter gates, close positions, retune parameters, commit, push, or deploy.

Reproduce the diagnostic with a saved spectator status snapshot:

```powershell
npx tsx scripts/coverage-learning-audit.ts <status-snapshot.json> <output.json>
```

The diagnostic reports current defects rather than constituting a passing promotion gate. It intentionally detects the current final-leg-only accounting behavior; update it into regression assertions when repairing that behavior.
