# Replacement AI swing brain

Status: researched design awaiting owner approval. No replacement trading code, deployment or reset has been performed. Prepared on 24 October 2026 after the loss diagnosis in `docs/LOSS_STREAK_AND_RECOVERY_2026-10-24.md`.

## Intent and confirmed choices

Tejas wants to replace the failed AI decision system with distinct swing strategies for crypto, FX, metals and oil, rather than add another set of confidence-score adjustments. Setups should develop on slow bars and execute promptly once qualified. The eventual new AI run starts with $10,000. The human account must not be reset. SSH and other credential remediation are out of scope for this work.

Confirmed by Tejas during this design:

- Separate class strategies with shared risk controls.
- One shared $10,000 AI account, rather than multiple newly capitalized books.
- Retain the 10% ($1,000 on initial capital) drawdown stop.
- Preserve the human account.

Builder proposals requiring approval with this document: the precise candidate rules, initial risk limits, validation/activation sequence, and archive-first reset protocol below. These are research hypotheses, not statistically validated strategies or probabilities of profit. There is no 100% setup. The system must be able to say NO_TRADE for any asset and to leave the full AI account in cash.

## Decision summary for approval

| Class | New hypothesis | Entry/holding timescale |
| --- | --- | --- |
| Crypto | Daily trend regime plus a fresh 4h breakout | Up to ten calendar days |
| FX | Session-filtered 4h swing breakout with explicit USD exposure | Up to five calendar days |
| Gold and silver | Daily trend plus a closed 4h pullback reclaim | Up to ten calendar days |
| WTI oil | Multi-day breakout with inventory-event and shock controls | Up to seven calendar days |

One shared $10,000 AI book; the old XSEC book stays historical/research-only. Proposed first activated stop-risk is 0.25% ($25), with at most 0.50% after later evidence, a 2% aggregate planned-risk ceiling and the owner-selected 10% drawdown halt. Proposed risk can be reduced further by volatility, costs, factor concentration or remaining drawdown capacity. A large quoted reward/risk ratio never overrides these controls.

Implementation and backtests come next after design approval. All new configurations start SHADOW and must qualify; approval does not mean immediate full-risk paper entries. FX is especially evidence-constrained by its recent listing. The eventual reset is AI-only, archive-first and idempotent, with a verified human-state preservation check. It happens with the tested release, not during research. No immediate reset, trading-profit claim or security work is part of this approval.

## Goals, constraints and anti-goals

1. Replace the AI's active entry-decision path, including its unqualified baseline exception. Every class receives a distinct strategy identity and explicit permission state.
2. Use fully closed 4h/daily bars, actual Bybit instrument semantics, realistic costs and the same pure strategy/execution policies for replay and runtime. No 1m/5m flow dependency for entry decisions.
3. Separate signal strength, empirical evidence and risk permission. Do not relabel a score as a success probability or set leverage from conviction.
4. Preserve execution integrity, immutable cost/risk provenance, position-level outcomes and useful market ingestion. Retain old versions for reading and incident/evidence purposes, with no path back into new AI entries.
5. Use existing TypeScript, Node, Redis, daemons and public-data clients. No new broker, paid dataset, LLM trading dependency or live-money order access is part of this design.
6. Use the nine configured instruments: BTCUSDT, ETHUSDT, SOLUSDT, EURUSDUSDT, GBPUSDUSDT, USDJPYUSDT, XAUUSDT, XAGUSDT and CLUSDT. Oil remains WTI exposure, not Brent.
7. A reset is a new measured run, not erasure of evidence or a remedy for negative expectancy. Never reset the human or inject another $10,000 through XSEC.

Out of scope: secret rotation, creating new capital books, exchange orders, scalping, leverage increases, martingale, averaging down, funding arbitrage without its hedging leg, and automatic strategy invention or parameter search from live losses.

## Approaches considered

| Approach | Benefit | Cost or limitation | Decision |
| --- | --- | --- | --- |
| Separate class strategies, shared execution/risk/account | Matches differences in sessions, volatility and catalysts; exposes each class's evidence | Four hypotheses must be validated separately; some will remain inactive | Selected by Tejas |
| One slow trend engine with class controls | Fewer parameters and a simpler test burden | Less specialization than requested | Not selected |
| Large predictive model or an LLM that reads news and chooses direction | Could eventually use richer information | Reliable labels, point-in-time inputs and calibration are missing; more complexity does not establish edge | Not proposed for this replacement |

The selected design shares infrastructure and simple indicator helpers. It does not duplicate accounting or implement four separate broker stacks.

## Research and what it actually supports

Primary sources reviewed on 24 October:

| ID | Source | Supported conclusion | Limit on its application here |
| --- | --- | --- | --- |
| R1 | [Moskowitz, Ooi and Pedersen, Time Series Momentum](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) | Own past returns motivate testing trend strategies across futures and currency forwards | The principal published horizons are much slower than a 4h entry; it does not validate our parameters or Bybit instruments |
| R2 | [Hurst, Ooi and Pedersen, A Century of Evidence](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing) | Long-history evidence makes diversified trend a useful research baseline | Not a guarantee for a nine-contract, young-instrument portfolio |
| R3 | [Liu and Tsyvinski, Risks and Returns of Cryptocurrency](https://www.nber.org/papers/w24877) | Crypto-specific time-series momentum merits testing | Older BTC/ETH/Ripple research does not establish today's SOL/perpetual profitability |
| R4 | [Menkhoff et al., Currency Momentum Strategies](https://www.bis.org/publications/working-paper-366-currency-momentum-strategies) | FX momentum exists in studied broad universes, with meaningful transaction-cost limits | Cross-sectional evidence cannot be transplanted to three USD pairs or treated as proof of our swing breakout |
| R5 | [Neely, Weller and Ulrich, Adaptive Markets Hypothesis](https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/abs/adaptive-markets-hypothesis-evidence-from-the-foreign-exchange-market/9D336CDCA83233819EB5CDD0F4BC0DAA) | Previously profitable FX technical rules can lose their advantage in later data | An old published rule is not a permanent edge |
| R6 | [CME, Trading COMEX Gold and Silver](https://www.cmegroup.com/education/articles-and-reports/trading-comex-gold-and-silver) | Metals have distinct trading centers, release sensitivity and differing volatility | COMEX evidence is context, not a Bybit fill model or proof of a directional rule |
| R7 | [EIA, What Drives Crude Oil Prices](https://www.eia.gov/finance/markets/crudeoil/balance.php) and [release schedules](https://www.eia.gov/reports/upcoming.php) | Inventory and supply balance matter; report timing needs official holiday-aware dates | A calendar does not predict an inventory surprise or its price effect |
| R8 | [BIS, Crypto Carry](https://www.bis.org/publications/working-paper-1087-crypto-carry) | Carry can be associated with speculative demand and crash risk | Dated-futures basis evidence does not equal a validated perpetual funding signal |
| R9 | [Moreira and Muir, Volatility-Managed Portfolios](https://www.nber.org/papers/w22208) and [Cederburg et al., performance re-evaluation](https://www.lehigh.edu/~xuy219/research/COWY.pdf) | Volatility reduction is worth evaluating, with real-time performance caveats | Do not assume volatility timing improves every strategy; the proposed overlay only reduces risk |
| R10 | [Bailey et al., Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) | Repeated strategy selection requires explicit trial accounting and later evaluation | A positive historical score alone cannot authorize activation |
| R11 | [Bybit, TradFi perpetual guide](https://www.bybit.com/en/learn/bybit-tradfi/trade-tradfi-perpetuals-bybit) | These are USDT perpetuals with funding, off-hours liquidity and gap risk | They are not spot FX, physical metals, CME futures or MT5 CFDs; account/regional fees can differ |
| R12 | [Bybit instrument API](https://bybit-exchange.github.io/docs/v5/market/instrument), [klines](https://bybit-exchange.github.io/docs/v5/market/kline), [funding history](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate) | Public contract-specific metadata and market data are available | Availability of candles does not prove historical spread/depth or funding-mark coverage |

The numerical rules below are deliberately small, frozen first hypotheses chosen by the builder. The cited literature does not supply their exact lookbacks, stop multipliers or target ratios. Initially register four strategies, not hundreds of fitted alternatives. Record any challenger as a separate trial before evaluation. Existing daily trend and hold baselines remain comparators, not automatic production winners.

## Data feasibility checked today

Queried public Bybit metadata and up to 1,000 daily candles per instrument, without authentication. Saved `docs/research-2026-10-24/instrument-feasibility.json` and `risk-data-summary.json`.

| Class | Instrument launch dates | Completed daily bars in this request | Implication |
| --- | --- | ---: | --- |
| Crypto | BTC March 2020; ETH March 2021; SOL October 2021 | 999 each, request capped | Paginate older native history; several market regimes can be studied |
| FX | All three 8 September 2026 | 46 each | No 60/120-day native history; 4h feature warmup is plausible but robust performance evidence is not yet available |
| Metals | Gold/silver 9 March 2026 | 229 each | Enough indicator warmup, limited independent regime history |
| Oil | 24 March 2026 | 214 | Enough indicator warmup, limited regime history |

Today's still-forming daily bar was excluded from the completed counts. Raw returned counts are one higher. The FX 4h series must still be fetched and validated before asserting contiguous warmup. A launch date is not proof that every bar exists.

Native funding intervals differ: metals currently report 240 minutes and the other seven 480. Read them from versioned metadata; never assume all funding is every eight hours. Lot/tick/quantity rules also come from the named contract.

Historical spot/reference FX and futures research can inform economic hypotheses. Keep it a separate labelled dataset, with currency convention, session and roll adjustments explicit. Do not splice it into the executable Bybit series, invent pre-listing history or use it to satisfy native-contract promotion counts.

## Common signal and timing contract

Each evaluator is a pure function from a typed, causal market snapshot plus class configuration to a decision. It returns NO_TRADE with a reason, or a setup containing side, initial stop, target, time exit, strategy/config identity, setup bar, feature interval, reference price and expiry. No portfolio writes, parameter adaptation, secrets, web calls or LLM output occur inside it.

- Signal time is a completed 4h bar close. Daily features are the most recent completed UTC daily bar. A bar closing after the decision time is unavailable, even if stored in the archive.
- EMA uses a fixed documented seed and sufficient warmup. ATR is Wilder ATR(14); prior channels exclude the signal bar. For channels, compare the current completed close with the preceding channel and record both values.
- Entry setup expires five minutes after its close. Scan promptly, normally within the existing 60-second scan interval; record actual latency. Do not claim guaranteed latency.
- Entry uses a fresh current quote, valid instrument metadata and measured spread/depth. Refuse if price has crossed the stop, price is more than 0.25 signal-ATR from the reference close, session/calendar restrictions apply, or costs/risk capacity fail.
- A setup can fill once. ID includes asset, actual strategy ID/config hash, direction and completed setup bar. Different strategies cannot share a promotion identity merely because both use the word trend.
- Initial stop and target are based on the eventual modeled entry price and frozen risk geometry. If repricing/rounding invalidates the setup or exceeds its approved risk, reject it rather than widen risk.
- Stops and emergency exits remain continuously watched; they do not wait four hours. Entries are slow, exits are protective. The five-second watchdog is an implementation target, not an assurance against gaps.
- Order flow, account ratios and liquidation activity may be archived for later research, but do not gate or score these entry hypotheses. Current funding can reduce or refuse an uneconomic hold; it never creates a directional success claim.

There are two explicitly different risk units. `priceRDistance` is the absolute distance between the modeled entry and the initial stop, frozen after rounding; every target multiple and favorable-price-excursion/trailing activation below uses that price distance. `initialRiskUsdt` is the executed quantity's modeled net loss at that initial stop, including entry and stop fees, adverse fill costs and a conservative payer-funding reserve through maximum hold. It is frozen at entry and used as the denominator of realized `netR = netPnlUsdt / initialRiskUsdt`. Targets labelled 3R below mean 3 price-distance units, not a promise to realize +3 netR. Quantity is solved against the net loss budget, and the separate net economics gate remains binding.

## The four initial hypotheses

All short rules mirror long rules. Exact settings are preregistered proposals. No asset is promised a minimum trade count.

### Crypto: CRYPTO_TREND_BREAKOUT_V1

Assets: BTC, ETH, SOL. Thesis: a medium-horizon directional regime can support continuation after a fresh 4h price breakout. Research motivation: R1-R3. It is not a small-universe cross-sectional ranking strategy.

1. Long regime: completed daily close above daily EMA(50), and 20-day and 60-day close returns both positive. Short regime is the reverse. Otherwise NO_TRADE. Require at least 151 daily closes so the EMA has a stable warmup and all return lookbacks exist.
2. Entry: completed 4h close crosses above the preceding 20-bar high, or below the preceding 20-bar low, in the regime's direction. Define a fresh cross using the preceding close against its own preceding 20-bar channel; do not enter on every bar of an already-running breakout.
3. Initial stop: the farther of 2.0 ATR from entry and the prior five-bar adverse extreme plus 0.1 ATR buffer. Reject if the resulting stop is farther than 4.0 ATR. No tightening to manufacture a larger target ratio.
4. Target: 3.0 initial R. Begin a 2.0 ATR trailing stop only after maximum favorable excursion reaches 2.0 initial R; a stop may only improve. No partial profit or scale-in in the initial version.
5. Maximum hold: ten calendar days. Estimate the full possible holding cost for admission. Extreme funding is a cost/risk veto, not a free carry-credit forecast.
6. BTC/ETH/SOL share one crypto risk bucket even when separate symbols qualify. Do not count three correlated shorts as three independent reasons to take larger exposure.

### FX: FX_SESSION_BREAKOUT_V1

Assets: EURUSD, GBPUSD, USDJPY using their Bybit USDT perpetuals. Thesis: a closed-bar directional trend and a fresh multi-session breakout may persist over a swing, provided the entry occurs during liquid underlying hours. R1/R4 motivate the hypothesis; R5 is a reason to require later evidence.

1. Long regime: completed 4h EMA(20) above EMA(50), EMA(50) higher than five closed bars earlier, and current close above EMA(20). Short mirrors this. Require 151 completed 4h bars.
2. Entry: fresh close crossing the prior 12-bar high/low in the regime direction. The preceding 12-bar range must not exceed 6.0 ATR(14), preventing a distant chase after an unusually broad move. No volume or crypto-order-flow requirement.
3. Entry hours: weekday 08:00-17:00 Europe/London or 08:00-17:00 America/New_York, with actual daylight saving conversion. No new Friday entries after 12:00 New York; no new weekend entries. Exit protection continues whenever the contract quotes.
4. Stop: farther of 2.0 ATR and the previous five-bar adverse extreme plus 0.1 ATR. Reject beyond 4.0 ATR. Target 2.5R; trail by 2.0 ATR after 2.0R. No partials or adds. Maximum hold five calendar days.
5. Calendar gates: Fed and US CPI/payrolls affect all three; ECB affects EURUSD, BoE GBPUSD, BoJ USDJPY. A date without a reliable BoJ decision time uses a conservative date-wide new-entry exclusion until the scheduled release is confirmed past.
6. USD direction is explicit: long EURUSD/GBPUSD is short USD; long USDJPY is long USD. Size the shared USD factor exposure accordingly.
7. Initial evidence state is insufficient for activation. Forty-six native daily closes are not a long backtest. The 4h strategy can be built and shadowed while evidence accumulates.

### Metals: METALS_TREND_RECLAIM_V1

Assets: gold and silver. Thesis: after a daily trend has formed, enter a closed 4h pullback reclaim rather than buy every extension. R1/R2 motivate trend; R6 supports treating metals' sessions, catalysts and volatility separately.

1. Daily trend: EMA(20) above EMA(60), close above EMA(20), and EMA(60) higher than five completed days earlier, or the exact short inverse. Require 181 completed daily closes.
2. Reclaim setup: the prior 4h close was at or below its EMA(20), and the current closed bar is above its EMA(20) with a higher close than the prior bar, in a long daily regime. Short mirrors this. Use only completed bars; no future pivot confirmation.
3. Stop: previous five-bar adverse extreme with a 0.2 ATR buffer, with a minimum 2.0 ATR distance from entry. Reject if farther than 4.0 ATR. Target 3R; trail by 2.0 ATR only after 2R. Maximum hold ten calendar days. No partials or adds initially.
4. New entries use weekday London or New York liquid windows as defined for FX. Block scheduled US inflation/payrolls/Fed release windows; validate contract spread, depth and mark/index quality. No weekend new entries.
5. Gold and silver share the metals risk bucket. Silver is independently volatility-scaled, not given gold's quantity or risk multiplier. All fees/funding are frozen using each instrument's actual schedule and interval.

### Oil: OIL_TREND_EXPANSION_V1

Asset: CLUSDT. Thesis: a multi-day price expansion in a daily trend may persist, but inventory events and shock gaps can invalidate ordinary volatility assumptions. R1/R2 motivate the price rule; R7 motivates event controls, not a prediction of the inventory number.

1. Daily regime: close and EMA(20) on the same side of EMA(50), with EMA(50) slope over five daily bars agreeing. Require 151 completed daily closes.
2. Entry: fresh completed 4h close crosses the prior 30-bar channel in the regime direction. This is a five-calendar-day channel on a continuously quoted contract, not a fictitious CME trading-week series.
3. Reject a signal bar whose true range exceeds three times the ATR known before that bar. Do not chase a news gap or infer that the next move must continue it.
4. Stop: farther of 2.5 ATR and the previous five-bar adverse extreme plus 0.2 ATR; reject beyond 5 ATR. Target 3R; trail by 2.5 ATR after 2R. Maximum hold seven calendar days. No partials or adds.
5. New entries: Monday-Thursday, 08:00-16:00 America/New_York. No Friday/weekend entries initially. Actual spread/depth remain binding; clock time alone cannot establish liquidity.
6. Use the official EIA Weekly Petroleum Status Report release schedule, including holiday shifts and the particular report/table release time. Exclude new entries from 60 minutes before until 60 minutes after its scheduled release. If current schedule coverage is unavailable or ambiguous, affected oil entries are unarmed. Continue protective exits.
7. Do not implement fundamental surprise trading without timestamped actual/consensus data. Do not call a single perpetual's funding rate a futures-curve carry signal.

## Shared risk and execution proposals

These are proposed limits to approve, not owner-selected numbers except the 10% drawdown stop.

| Item | Proposed rule |
| --- | --- |
| AI capital | One $10,000 starting equity pool for the new run |
| Initial activated risk | 0.25% of current marked equity per position, at most $25 at a $10,000 balance, including modeled stop execution and costs |
| Later normal risk | Up to 0.50% after the separate escalation evidence below; never increase because of a confidence score |
| Total open planned stop risk | 2% of marked equity; also subject to the stricter remaining drawdown-floor capacity |
| Class/factor stop risk | 1% per crypto, metals or oil bucket and per net USD factor, with gross same-factor risk separately bounded so opposing noisy trades cannot evade the cap |
| Drawdown floor | Refuse entries at or below max($9,000, 90% of the new run's high-water marked equity). Reduce entry risk as that floor approaches |
| Drawdown response | At a breached floor, enter REDUCE_ONLY and use capacity-aware protective closures; no automatic timer rearm. Gaps can exceed the intended threshold |
| Daily/weekly loss | Keep existing 2% rolling daily and 4% rolling weekly brakes; preserve tighter existing ceilings where applicable |
| Gross notional/margin/leverage | Preserve current instrument leverage ceilings, 40% aggregate margin ceiling and 2.5x gross-notional ceiling; new sizing selects the smallest margin leverage needed under caps, not leverage from a score |
| Loss-streak response | Four completed full-stop losses overall or three in a class/factor stop new entries for that scope, with recorded evidence review before rearm; no blind 72-hour restart |
| Sizing | Quantity from permitted net loss at the actual proposed stop, rounded down by lot rules, then capped by portfolio, factor, liquidity, margin and leverage limits |
| Down-only volatility overlay | min(1, 20% / trailing 30-day annualized realized volatility), never raising risk in quiet conditions; the baseline comparison includes the overlay as part of the strategy definition |
| Initial exit policy | Full-position stops/targets/trailing/time exits as specified above; scale-ins and partials disabled for these candidates until separately evaluated |

Notional is not risk at the stop. A $2,000 notional position with a 2% adverse stop move risks about $40 before costs; a $25 risk budget cannot take that full size. A high target multiple cannot determine win probability. For example, 3R reward and 1R loss breaks even at 25% wins before costs; below that it loses. Measured realized payoff and net R, not target geometry, drive evaluation.

Use conservative public paper fee baselines already versioned in `assetSpecs.ts`, reverified before release. Model taker crossing on actual side of spread, adverse slippage and gap risk. Maker fees are not earned without a realistic resting-order model. Funding is settled at actual instrument boundaries with actual rate and contemporaneous mark evidence; do not approximate every interval as the same eight-hour charge. Credit received funding only when realized; admission charges a conservative payer scenario through the maximum hold.

Pretrade projected net target reward must remain at least 1.5 times modeled stop loss after round-trip costs and conservative holding cost. This is an economics floor, not evidence of edge. Failing it means NO_TRADE, not increasing a target price.

The sizing solver must recompute stop-cost risk after lot/tick rounding. It may only shrink quantity or reject. It must also model all concurrent stops against the drawdown floor. Unknown/failing marks block new entries. Stops are never promises of a bounded fill under a gap or liquidity outage.

### Simultaneous candidates and scarce capacity

Batch all eligible setups for the same decision boundary before allocating capital. There is no first-asset advantage or score ranking. Begin with each candidate's equal base risk adjusted down by its volatility multiplier. Subtract the existing open positions' gross planned loss from every applicable capacity. Calculate one proportional factor for remaining global risk, drawdown-floor risk, aggregate margin and gross notional, and one factor per affected class/FX USD scope. Each candidate receives the minimum of 1 and all factors applying to it. This uniform shrinkage respects overlapping budgets; existing positions are not enlarged or implicitly closed to make room.

The FX USD gross planned-risk cap is 1% across all three FX instruments regardless of side. Net signed USD exposure is reported, but long/short offsets cannot create additional permitted gross stop risk. Crypto and metals have their own gross 1% buckets; oil has a 1% bucket. All four share the 2% account limit and remaining drawdown-floor capacity.

Round all quantities down, reject sub-minimum lots/margin and recheck capacities against actual fresh quotes before committing fills. Do not redistribute the rejected quantities within that batch or silently change ordering to improve a backtest. Source quote changes that invalidate a candidate cause its refusal, not an unrecorded second optimization. The plan must make batch reservation and fill idempotency atomic under the AI portfolio lease.

## Runtime and module boundaries

The implementation plan will choose minimal file layout around these responsibilities, reusing existing helpers:

1. Versioned strategy registry with four pure class evaluators and an explicit asset-to-class map.
2. Causal snapshot builder: completed 4h/daily bars, quote and source clocks, metadata, costs, session/calendar coverage and content hashes.
3. Single AI candidate router: obtains class setup, then evidence permission, economics, portfolio risk and execution. It contains no fallback to v5 scored entry logic.
4. Shared decision tape and position-level outcome attribution. Human/manual state is not an input to AI strategy learning or capital allocation.
5. Replay uses those same evaluators and exit state machines. The dashboard's separate EMA worker is retired from strategy-validation UI; a small chart experiment may remain only if explicitly labelled as a different rule with no invented metrics.
6. New strategies and reports use new version/config/epoch namespaces. Old candidate evidence, cached learning and account records cannot activate a new strategy.
7. Existing v5 and XSEC are historical/research views only in the replacement AI run. XSEC gets no additional live paper capital or independently reset allocation.

Protective exits for human/manual positions retain their existing policies. A new AI signal cannot create, scale, reverse or close a human position. If a shared API path currently applies AI signal reversal to a human position, isolate that behavior and test the boundary explicitly.

## Calendar and freshness requirements

Use authoritative schedules, not a perpetual list of stale July dates. Candidate source routes include [Fed](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm), [ECB decisions](https://www.ecb.europa.eu/press/govcdec/mopo/html/index.en.html), [BoE](https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates), [BoJ meetings](https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm), [BLS selected releases](https://www.bls.gov/schedule/2026/home.htm) and EIA. Official pages were reviewed during this design; verify each parser/adapter against the actual source before release. Some sources have variable or unknown announcement times; preserve that uncertainty.

Calendar data carries retrievedAt, source, timezone, coverage start/end and exact or uncertain time. A daily refresh does not prove complete coverage. A valid manifest must cover the next seven days for required releases; expired, unparseable, ambiguous or uncovered calendar windows block new entries in impacted classes while exits continue. Do not fetch calendars in the per-asset hot path. DST and holiday examples are regression fixtures.

New quote limits preserve the existing instrument registry freshness policy. Do not copy a fixed TTL into the strategy engine. Clock checks reject future timestamps and stale component observations. Every signal records the exact information-available cutoff and each source's capture/receipt time.

## Research, validation and activation

The owner selected class strategies, not a claim that every candidate deserves immediate activation. Initial mode is SHADOW for every new exact configuration. The new AI run can show $10,000 cash while validation continues. A reset never marks a strategy qualified. If none passes, the honest outcome is that nothing trades.

### Historical and causal checks

- Freeze registry definitions and count every tested class/parameter variation before seeing its evaluation outcomes. Source-code/config/exit/cost/risk changes create new evidence identities.
- Download complete native 4h/daily history since each launch, plus settlement-rate history and available mark-price information. Save manifest and coverage gaps. No pre-listing proxy splices.
- Use chronological training, validation and a final locked historical evaluation, with boundaries declared before the first performance run. Recently observed 2026 markets cannot be described as wholly unknown. Truly forward evidence begins after registration and release of the candidate definition.
- Purge overlapping trade/label intervals at fold boundaries and embargo using the actual maximum holding horizon. Keep indicator feature provenance without demanding non-overlapping full lookback histories between every sample. Use blocks/clusters to address serial and cross-asset dependence.
- Run all costs, funding, gap scenarios, realistic available entry times and shared portfolio capacity. If both stop and target can be touched in a replay bar and sequencing is unknown, use the adverse outcome or explicit bounds, never the favorable order.
- No claim of five-second fill parity from OHLC bars. Replay records which effects are modeled. 1h or finer price bars may be used for exit-path resolution without becoming entry features. Missing critical funding/mark/depth provenance prevents historical activation in this first release. Assumed historical costs support descriptive sensitivity only; they do not become observed evidence because the result is positive. A forward-only route remains available when later complete evidence satisfies its requirements.
- Data-error and engineering tests are separate from economic acceptance. Compare cash, equal-weight hold, existing slow daily trend and the candidate at the same calendar window and risk, with exposure differences shown.

### Permission states and initial release

States: DISABLED, WARMING_UP, SHADOW, VALIDATION_READY, PAPER_ACTIVE, REDUCE_ONLY and RETIRED. There is no permanently exempt baseline. Validation permission belongs to the exact instrument, strategy, costs and risk definition; code can share parameters within a class, but one asset's results cannot silently promote another.

Activation requires either:

1. Historical route: at least two complete purged folds, at least 30 non-overlapping completed evaluation positions per instrument/configuration, positive block-bootstrap 95% lower bound of net R, multiplicity-adjusted Sharpe probability at least 0.95 across all registered trials, and nonnegative expectancy under stressed costs. Then at least 15 non-overlapping forward shadow completions spanning at least 14 days, with positive block-bootstrap net R lower bound and no critical risk/data violation.
2. Forward-only route: at least 30 non-overlapping forward shadow completions spanning at least 30 days, meeting the same net-R confidence, multiplicity, stressed-cost, drawdown and data criteria. This is useful for young contracts but is not a shortcut around evidence.

In both routes, replay must not breach the 10% run-level drawdown constraint at the proposed activated size and portfolio allocation. Use calendar-time blocks and factor clusters in joint portfolio review; per-position rows across correlated assets are not independent wins. If a required Sharpe estimate is undefined, history or critical cost provenance is inadequate, or uncertainty cannot support the bound, the candidate stays SHADOW.

These thresholds are proposed policy, not universal proof of future profits. Samples may take months. The release must display the actual accepted sample count and next eligible label time, rather than imply 14 days guarantees promotion.

### Frozen costs, stress and statistical units

Freeze the current per-asset execution profiles and existing fee schedule versions from `src/lib/trading/executionCostModel.ts` and `assetSpecs.ts` into the v6 registration manifest, including a hash of the exact parameter values. The present profiles' half-spread/base-slippage/stop-gap assumptions in basis points are BTC 0.8/0.8/2, ETH 1.2/1.2/3, SOL 2.5/2.5/6, EURUSD 0.5/0.4/1.5, GBPUSD 0.8/0.6/2, USDJPY 0.7/0.5/2, GOLD 1.5/1/4, SILVER 3/2.5/8 and OIL 2.5/2/8. Their existing size-impact coefficient and reference notional are also frozen, not inferred from this abbreviated table. These numbers are modeling assumptions inherited for comparability, not measured execution guarantees.

Base simulations use the worse of the frozen half-spread floor and the observed spread at the relevant execution timestamp, plus the frozen size-dependent adverse slippage. Use actual observed funding settlements/marks where available. Existing context multipliers must be represented as explicit causal session/data inputs in the registration manifest, with no hidden dependence on retired confidence scores. Missing historical observations retain the descriptive-only label.

Stress is fixed before evaluation: double modeled/observed spread, base slippage, size impact, stop-gap charge and taker fee, and replace each funding settlement by an adverse payer charge of `2 * max(abs(actualRate), 0.0001 * actualIntervalMinutes / 480)` for either direction. A missing actual rate/mark cannot pass historical evidence coverage. A forward-admission funding reserve uses the same adverse floor with the current rate over the maximum hold and never forecasts received credits. No sensitivity setting may be selected after its outcomes are seen. Stress gaps are scenarios, not a proven upper bound on possible gaps.

The bootstrap expectancy statistic is on completed-position netR, de-overlapped within the instrument, using calendar-time blocks at least as long as that strategy's maximum hold. The separate deflated-Sharpe screen is on UTC daily marked equity returns of the standalone instrument/configuration at a frozen 0.25% base risk, including flat days and all costs, using non-annualized daily Sharpe, daily skew/kurtosis and the existing statistic's explicit approximation caveats. Do not substitute trade Sharpe or multiply trade returns by sqrt(252). For its observation count, reduce the number of days by the positive-autocorrelation effective-sample adjustment `n / (1 + 2 * sum((1-k/n) * max(0, rho[k])))` over lags 1 through the maximum hold in calendar days, clamped to [2, n]. Insufficient/nonfinite estimates cannot pass. Joint portfolio analysis uses aligned calendar blocks across assets, retaining common shocks.

The multiplicity count includes nine initial instrument/configuration trials, every additional candidate/parameter variant and comparator evaluated for selection, and existing registered project trials that informed the choice. Snapshot and report those identities before the first evaluation; the current registry had 30 legacy configurations in the prior audit, which must not silently disappear from this accounting. Use no independence discount. The statistic remains a screening measure under approximate distribution assumptions, not a probability a trade will win.

After activation, use 0.25% planned position risk. Escalation toward 0.50% requires a separately saved review after at least 30 additional completed paper positions spanning 30 days, positive conservative net-R evidence, no breaker violation and an eligible aggregate portfolio. Escalation is downscaled by the volatility overlay and remaining floor budget. No early increase to recover losses. Rule or cost changes restart affected evidence rather than relabel it.

Live paper evidence that fails the frozen demotion/risk policy stops new entries and preserves risk-reducing management. Drawdown or data-integrity breach acts immediately; statistical demotion uses sufficient samples and recorded confidence. Automatic reactivation must require a new eligible evidence review, not a timer.

### Breaker rearm and terminal states

- The 10% run-level drawdown breach latches the account in REDUCE_ONLY, then disabled for entries after flattening. No automatic rearm, restart, new deployment or timer clears that run's latch. Another capital reset would require a new explicit owner instruction, archive and reviewed run preview.
- A four-loss account streak or three-loss class/factor streak suspends entries in that scope while the frozen configuration continues shadow observation. Rearm needs at least 15 new, non-overlapping post-halt shadow completions across at least 14 days, a positive 95% block-bootstrap netR lower bound, the same cost-stress/data requirements, and no unresolved account breaker. Existing losing samples are retained. A routine clock tick or a single winner cannot rearm it.
- Statistical demotion occurs after at least 15 completed PAPER_ACTIVE positions when the 95% upper bound of netR is below zero. It retires that exact configuration permanently. A replacement requires a new preregistered definition and the full qualification process; changing only an ID or resetting the account cannot clear its adverse history.
- A critical integrity failure, unexplained accounting change or a realized loss beyond 1.5 times its frozen net stop-risk budget immediately freezes the affected scope pending a recorded operator review; global-account failures freeze all AI entries. Restore data/integrity before considering rearm. Risk reduction and human/manual protections continue.

## AI-only reset and release protocol

`resetArena` currently resets user and AI accounts together and clears human-related transient keys. It must not be used for this request. Build an explicit AI-only operation with preview and verified preservation.

1. Create a new run ID and a reset preview showing AI capital, old AI positions, old XSEC state, affected AI keys and unchanged human state. Default is preview; no mutation from opening a page or a GET request.
2. Acquire a coordinated AI migration/entry freeze and the necessary AI/XSEC write leases; keep protection running for every existing position until flattening is complete. If AI or XSEC positions are open, stage capacity-aware paper closures and complete settlement before reset. The design chooses flatten-and-archive rather than silently abandon positions. Never reset beneath an unmanaged open position.
3. Durably archive the old AI and XSEC portfolios, trades, equity, strategy/evidence versions, pending ledger/funding events, scheduler state and the ledger head. Verify archive contents/hash and recorded balances. No backup failure may proceed to mutation.
4. Snapshot/hash the exact raw human portfolio and trade keys. During the brief commit phase use a coordinated lock preventing human writers, without changing human data or disabling later manual trading. If that lock or unchanged hash cannot be obtained, abort. Human activity before/after that window is legitimate and is not an AI-reset write.
5. Commit a journaled, idempotent AI epoch switch: $10,000 cash, zero positions and funding liabilities, new peak and PnL/fees/counters for that run, new strategy/evidence namespaces and XSEC historical-only status. Use a scoped atomic Redis transaction/script or an equivalent recoverable two-phase protocol. No broad key deletion, user key reset, global ledger wipe or rewriting old trade records.
6. In the same protection window, assert human portfolio/trades raw values unchanged, append AI_RUN_STARTED and archive references durably, and verify initial capital/equity conservation. A crash can resume or roll back the incomplete AI transition from its journal, but must not duplicate capital, clear the human or lose the old archive.
7. Verify exact deployed source, scheduler/feed status, new registry permissions, ledger continuity and the human invariants. Release the AI freeze only into the declared permission states. Old strategies remain disabled; SHADOW candidates do not place orders.

The user has requested the eventual AI reset. Its execution belongs to the tested release of this design, after a valid preview and archive, not to today's research. Deployment should be a separate reviewed source release with explicit commit identity; never push to main merely to store the design, since main deploys automatically. If policy or access requires a separate approval for deployment, present the tested diff and reset preview as the final approval item.

## Acceptance tests a builder must plan

- Four class decision fixtures cover long, short, no setup, incomplete warmup, stale/future data, forming-bar exclusion, correct channels, session/DST/event restrictions and invalid cost geometry.
- Identical saved inputs produce identical decisions in runtime and replay; changing future bars cannot alter an earlier decision. The actual family/config used for a fill matches its evidence identity.
- Same setup never fills twice, even across restart; a new bar cannot revive an expired setup. Old v5 or a SHADOW candidate cannot leak through a fallback path.
- Position economics include stop/target/gap fills, taker fees, actual funding boundaries, lot/tick rounding, partial history and crash recovery, without cash or funding duplication.
- All classes obey one equity pool, marked drawdown, correlated factor risk, remaining floor capacity and existing notional/margin/leverage ceilings. Missing marks fail closed for entry.
- Winning target geometry cannot bypass economic acceptance, score does not raise risk, and no uncertainty is displayed as a calibrated probability.
- Exit logic is the same in replay and runtime, with explicitly conservative bar ambiguity. Stops are honored throughout entry freezes and the AI-only migration.
- Reset preview is read-only; reset touches no human value or history; backup failure, lease failure, concurrent activity, process crash and retry conserve the old/new runs. No double capital or silent XSEC activation.
- Historical metrics remain historical, new-run metrics begin at zero, and unavailable backtests remain unavailable. User account and manual behavior remain compatible with existing contracts.
- Run the existing regression suite, meaningful new behavior tests, strategy audit, types/lint/build and offline/live-data read-only release checks. Passing software checks do not override failed economic gates.

## Builder discretion and outstanding approval

The builder may choose minimal module placement, internal interfaces and test-fixture organization using existing dependencies. They may not silently alter candidate parameters, activate a strategy, increase limits, merge human/AI state or clear history. No additional account or dataset purchase is implied.

Approval of this design accepts four bounded hypotheses for implementation and testing, the proposed smaller initial risk, staged activation and the AI-only archive-first reset protocol. It does not certify that any strategy is profitable or that a reset will recover prior losses. Exact backtest results and a production reset preview must still be made reviewable before release.
