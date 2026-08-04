# Production Trading Strategy Remediation Architecture

**Status:** Phase 0, Phase 1, and urgent Phase 3 controls deployed; clean v4.2 paper probation active; Phase 2 and Phase 4 remain pending
**Created:** 2026-08-01
**Implementation started:** 2026-08-04
**Production remediation deployed:** 2026-08-04
**Capital mode:** PAPER_ONLY
**Change authority:** No production, VPS, portfolio, strategy, reset, margin, or deployment change may be made from this document without an explicit approved implementation phase.

### Implementation checkpoint: 2026-08-04

The operator explicitly approved implementation, public release, VPS deployment, and a new paper-state reset. The following work is complete in production:

- Phase 0 production baseline captured at deployed commit `c0694e872de5ac41fe6a3b5b37b5b0ac9b68a678`.
- Phase 1 crypto execution is bound to Bybit linear `BTCUSDT`, `ETHUSDT`, and `SOLUSDT` across candles, weekly bias, quotes, order-book imbalance, funding, open interest, entries, and lifecycle prices.
- Generic newest-source execution keys have been removed. Kraken and Binance remain source-scoped comparison feeds.
- Selected-venue provider, source, instrument, timestamp, bid, and ask now flow into signals, positions, trades, and execution-ledger payloads.
- The admission controller receives the effective entry mode. A controlled probe is forced to `PROBE`, `1x`, reduced risk, and reduced margin even at maximum conviction.
- Negative learning can no longer enter through exception or controlled-probe paths.
- Three correlated full-stop losses quarantine that risk cluster; four portfolio-wide full-stop losses quarantine all new entries.
- Strategy and policy versions are advanced to `swing-v4.2.0-2026-08-04`, `strong-margin-v2-2026-08-04`, and `portfolio-budget-v2-2026-08-04`.
- Runtime remediation commit `f9c41f53d8f675de1fb7b3b55664de88c942f114` is on `main`, GitHub Actions run `30881956801` completed successfully, and the VPS reported that exact commit after deployment.
- The follow-up release repaired sparse Bybit ticker deltas so a partial ticker or trade update cannot erase the selected-venue last price, bid, or ask.
- Local TypeScript, lint, build, ledger, source-manifest, and deterministic strategy gates passed. The fixture-only strategy audit passed with zero warnings and zero failures.
- The approved clean reset completed at `2026-08-04T05:55:54Z`. Both AI and user paper portfolios restarted at `10,000 USD`, with zero positions, zero trades, zero PnL, and zero execution costs.
- Autonomous scan `#7` completed after the reset at `2026-08-04T05:59:22Z`: all nine assets were evaluated, with `9 HOLD`, `0 BLOCKED`, `0 ENTRY`, `0 SKIPPED`, and `0 ERROR`.
- BTC, ETH, and SOL selected-venue prices were observed fresh from `BYBIT_LINEAR_WS`; comparison feeds remained independent and could not become execution prices.
- OIL and SILVER chart requests each returned `100` correctly labeled candles with HTTP `200`.
- The live strategy audit passed `112` checks with `0` failures and retained one research warning because the newly reset cohort has no closed trades yet. That warning must not be suppressed or called profitability evidence.

Still pending after this release:

- Phase 2 triple-barrier research and conditional first-passage promotion evidence;
- Phase 4 dashboard economics and complete per-asset market-state vocabulary;
- Phase 5 accumulation of a sufficiently large independent v4.2 paper cohort;
- Phase 6 evidence-based non-crypto source policy beyond the current free Yahoo slow-swing treatment; and
- any Phase 7 performance migration, which remains unauthorized until profiling demonstrates a material bottleneck.

No profitability claim is authorized by this checkpoint. The reset started a clean paper cohort; it did not restore old learning, manufacture activity, or manufacture statistical edge.

## 1. Purpose

This document is the current implementation architecture for repairing the trading system after the post-reset loss sequence. It converts the forensic audit into an ordered, testable program of work.

It is intentionally not a promise of profitability. The objective is to make every future trade:

1. traceable to one coherent market and execution venue;
2. statistically evaluated before risk is increased;
3. bounded by independent portfolio protections;
4. explainable to an operator after entry, exit, or non-entry; and
5. reproducible from stored decision evidence.

The system must remain a paper trading and research platform until all release gates in this document are passed. A healthy daemon, a green TypeScript build, a zero-warning fixture audit, or a profitable short sample are not evidence of an economic edge.

## 2. Current Evidence and Diagnosis

### 2.1 Verified operating state

The production status endpoint reported the same revision as local GitHub main:

- commit: c0694e872de5ac41fe6a3b5b37b5b0ac9b68a678;
- AI equity: approximately 9,876.83 USD;
- current AI realized PnL: approximately -123.17 USD;
- new-strategy closed trades: 5;
- wins / losses: 0 / 5;
- maximum drawdown: approximately 1.23%;
- no open AI positions;
- scan #8156 advanced with 0 errors at the 2026-08-04 baseline;
- current scan behavior: all 9 assets evaluated as HOLD, with no open AI positions.

This proves that the bot is running, scanning, receiving crypto ticks, and closing positions. It does not prove that it has a valid predictive or trading edge.

### 2.2 What the five losses do and do not prove

The five trades are too few to estimate a reliable long-run win rate. They are sufficient to reject any claim that the strategy has already demonstrated positive expectancy.

The post-reset losses were not caused by a simple stop-loss arithmetic inversion:

- four losses were near their modeled stop-risk budget;
- one ETH loss was compressed through a weakening-thesis stop;
- no reconstructed trade reached its intended target;
- none reached even one full R of favorable excursion in independent one-minute reconstruction.

The correct conclusion is: target distance is not the only problem. The entry direction, timing, venue consistency, and conditional target probability are not yet validated.

### 2.3 Why reset did not restore old intelligence

The full admin reset deliberately clears current-version portfolio state, current learning rules, opportunity observations, reviews, cooldowns, exit snapshots, and queued scan requests. Older versioned records are retained for audit, but do not automatically govern the new strategy version.

This behavior is correct. Reusing pre-upgrade losses and labels as active intelligence would contaminate the current strategy cohort. The cost is that the new cohort begins with insufficient current evidence and must use conservative probation rules.

## 3. Non-Negotiable Architecture Invariants

These are hard rules, not scoring preferences.

1. One asset, one execution venue, one price lineage per trade.
2. Every entry and exit must retain requested price, bid, ask, fill, source, venue, source timestamp, and execution-cost assumptions.
3. A provider used for historical candles must be compatible with the provider used for live entry and exit prices.
4. A paper cost model may not describe Bybit perpetual execution while entry and exit prices silently come from Kraken or Binance spot.
5. No order may be admitted because an LLM, narrative score, or dashboard label claims it is high confidence.
6. Target eligibility must be based on TP-first versus SL-first evidence, not favorable range alone.
7. Learning may reduce or block risk only when its sample definition, cohort version, and independence rules are recorded.
8. A controlled probe cannot receive STRONG margin or unrestricted leverage.
9. A reset must clear all transient execution state, but preserve immutable historical evidence.
10. No dashboard field may label stale data as live or show raw stop PnL as the modeled worst-case loss.

## 4. Target System Architecture

    External venue feeds
            |
            v
    Market Data Plane
      - venue-specific tick, bid/ask, order book, candles
      - source timestamps and health
      - no shared newest-source execution key
            |
            v
    Feature and Regime Plane
      - venue-consistent OHLCV and microstructure features
      - market session and data-quality classification
      - deterministic feature snapshot
            |
            v
    Research and Eligibility Plane
      - conditional triple-barrier statistics
      - after-cost expectancy and confidence intervals
      - cohort, setup, regime, and asset probation state
            |
            v
    Admission and Portfolio Risk Plane
      - hard eligibility gates
      - position sizing from risk-at-stop
      - loss streak, daily loss, correlation, and exposure circuits
            |
            v
    Paper Execution Plane
      - deterministic and calibrated fill simulation
      - venue-specific fees, spread, slippage, funding, stop gap
      - immutable execution ledger
            |
            v
    Lifecycle and Review Plane
      - stop, target, thesis invalidation, time stop
      - realized MFE, MAE, first-barrier outcome
      - post-trade classification and research updates
            |
            v
    Operator and Observability Plane
      - per-asset freshness, decision reason, net economics
      - release evidence, runbooks, rollback, and alerts

## 5. Remediation Findings and Required Design Decisions

### F-01: Mixed crypto venue provenance

**Observed defect**

The websocket mesh writes a generic market:live asset key using the newest tick from Kraken spot, Bybit linear, or Binance spot. MarketService uses that generic key for a crypto live price. Historical crypto candles are primarily Kraken, while the execution-cost profile labels crypto as BYBIT_VIP0_PERPETUAL.

The current live price endpoint demonstrated the defect directly: BTC could use Binance spot, ETH Bybit linear, and SOL Kraken spot in the same observation window.

**Required decision**

Select an execution venue per asset and strategy mode. The recommended first paper configuration is:

- BTC, ETH, SOL fast swing: Bybit USDT linear perpetual, if the account, region, and instrument support it;
- Kraken and Binance: independent health and divergence comparators only;
- FX and commodity instruments: separate slow-swing research only, never combined with crypto perpetual execution assumptions.

If Bybit linear cannot be the selected execution venue, choose Kraken spot instead and replace all fee, funding, and margin assumptions accordingly. Do not create a hybrid.

**Target implementation contract**

Every decision record must include:

    strategyVersion
    decisionId
    asset
    direction
    executionVenue
    executionInstrument
    candleVenue
    quoteVenue
    orderBookVenue
    entryBid
    entryAsk
    referencePrice
    referenceTimestamp
    sourceSequenceOrEventTime
    comparisonSources
    maximumObservedCrossVenueDivergenceBps

The execution price lookup must take an explicit venue argument. A generic asset-only execution key is prohibited.

**Acceptance criteria**

- No code path reads market:live:<asset> for an execution price.
- A trade cannot be created if candleVenue, quoteVenue, and costProfileVenue differ.
- Ledger verification rejects a close with missing venue provenance.
- A source-divergence alert blocks new entries if the selected venue is stale or cross-venue divergence exceeds a configured research threshold.

### F-02: Reachability is not a first-passage model

**Observed defect**

Current target reachability takes maximum favorable movement from a rolling one-hour window. It does not test whether stop or target was reached first, does not condition on current setup/regime, and uses a horizon that is inconsistent with fast crypto trigger data.

**Required model**

Use a conditional triple-barrier label for each candidate:

    upper barrier = take-profit level after modeled execution costs
    lower barrier = stop-loss level after modeled execution costs
    vertical barrier = maximum allowed holding time

For every historical candidate with the same asset, direction, regime, setup family, volatility bucket, and selected venue:

1. begin at the candidate entry timestamp;
2. use one-minute candles or better selected-venue data;
3. determine whether take profit, stop loss, or time barrier occurs first;
4. count same-bar target and stop touches pessimistically as STOP_FIRST unless ordered tick data resolves the sequence;
5. record MFE, MAE, time-to-first-barrier, net PnL, and cost assumptions.

The minimum viable eligibility calculation is:

    expected_value_net =
      P(TP_FIRST) * mean(net_target_reward)
      + P(STOP_FIRST) * mean(net_stop_loss)
      + P(TIME_EXIT) * mean(net_time_exit)

Target approval requires the lower confidence bound of expected_value_net to be positive. The current fixed net reward/risk minimum remains a secondary safety condition, not proof of edge.

**Acceptance criteria**

- Target reachability output contains TP-first, SL-first, timeout, sample size, sample independence count, confidence interval, and data window.
- A target cannot be approved merely because the maximum favorable range exceeded its distance.
- Trigger horizon, ATR timeframe, and vertical holding barrier are recorded together and validated as compatible.
- An empty or insufficient conditional sample produces SHADOW_ONLY, not a high-confidence exception.

### F-03: Learning reacts too early and protects too late

**Observed defect**

Local learning can emit a negative adjustment from a very small number of trades or overlapping opportunity records. Normal and exception entry paths block only watch-only state, allowing adverse learning to be advisory rather than decisive.

**Target learning state machine**

    INSUFFICIENT_EVIDENCE
      - fewer than the independent-sample minimum
      - fixed small paper size
      - no STRONG, exception, or recovery probe

    PROBATION
      - adequate data integrity but insufficient promotion evidence
      - paper only, conservative risk
      - shadow counterfactuals are required

    CAUTION
      - after-cost lower confidence bound is non-positive
      - no exception or probe entries
      - normal entries only at reduced paper risk if the portfolio governor permits

    QUARANTINE
      - repeated independent setup failure or a loss-streak circuit
      - no autonomous entry
      - collect shadow observations only

    PROMOTED_PAPER
      - sufficient independent out-of-sample evidence
      - still paper only until a separate capital authorization exists

Learning must distinguish between a true independent trade and repeated scans of the same market move. Opportunity records must be clustered by asset, direction, setup family, and overlapping holding window before sample size is counted.

**Acceptance criteria**

- Negative learning at or below the caution boundary blocks exception and probe paths.
- QUARANTINE blocks all autonomous entries for its key.
- The dashboard never describes correlated scan observations as independent trade evidence.
- Each rule stores strategy version, data range, independent sample count, confidence interval, and expiration / review condition.

### F-04: Loss protection is incomplete

**Observed defect**

The existing portfolio budget has daily and weekly loss controls, but a sequence of full losses across different assets can remain under the daily percentage threshold. Per-asset cooldowns do not constitute a portfolio loss-streak circuit.

**Target portfolio circuits**

All circuit values are paper-risk defaults to be validated by research, not permanent constants.

    Circuit A: selected-venue data integrity
      selected venue stale, invalid, or divergent beyond threshold
      => block entries immediately

    Circuit B: correlated stop-loss streak
      three full STOP_LOSS outcomes in correlated crypto exposure within a rolling regime window
      => QUARANTINE all correlated crypto entries, shadow only

    Circuit C: strategy cohort expectancy
      after-cost expected value lower confidence bound <= 0 after minimum independent sample
      => no new autonomous normal, exception, or probe entries

    Circuit D: rolling loss budget
      retain daily, weekly, open-risk, cost, and drawdown controls
      => block entries as currently designed

    Circuit E: accounting and provenance failure
      ledger inconsistency, missing venue fields, invalid model version, or source mismatch
      => block entries until reviewed

The loss-streak circuit must use closed risk-normalized outcomes. A -0.1R thesis exit is not equivalent to a full -1R stop. The trigger should inspect loss reason, realized R, setup family, and correlation group.

### F-05: Probe and margin policies are not coupled

**Observed defect**

The daemon determines an effective entry mode, but the admission input does not carry it. High conviction can receive 5x leverage even when the trade was conceptually a controlled probe.

**Target margin policy**

    SHADOW_ONLY
      leverage = 0
      no position

    CONTROLLED_PROBE
      leverage <= 1x
      risk budget <= 25 percent of standard probation risk
      no scale-in
      no STRONG mode

    HIGH_ACCURACY_EXCEPTION
      leverage <= 2x
      risk budget <= 50 percent of standard probation risk
      no scale-in
      requires positive learning and positive conditional expectancy

    NORMAL_PAPER
      leverage <= 3x for selected crypto perpetual research
      risk determined by stop distance and portfolio budgets

    STRONG_PAPER
      leverage <= 5x only after a separately approved promoted-paper gate
      never permitted after a recovery, probe, exception, negative-learning, or loss-streak path

The only user-visible risk number that matters is worstCaseNetLossUsd, including entry fee, stop fill impact, stop gap, exit fee, funding/carry estimate, and any selected-venue contract conversion.

### F-06: Cost model needs venue calibration

**Observed strength**

The system already models taker fees, spread, slippage, stop gap, and carry. The current crypto VIP0 perpetual taker assumption of 0.055% is consistent with Bybit's published base perpetual/futures VIP0 schedule, but actual rates can vary by account tier and region.

**Required extension**

Cost profiles must be keyed by:

    executionVenue
    instrument
    accountFeeTier
    makerOrTakerAssumption
    contractType
    selectedFundingSource
    calibrationWindow
    marketLiquidityBucket

Use deterministic cost values for regression tests and a separate calibrated stress distribution for research. Determinism makes CI reproducible; it does not make a static slippage estimate economically true.

### F-07: Observability currently masks important distinctions

**Observed defects**

- Cached non-crypto prices can be labeled fresh even with no source timestamp.
- The global market label can say open while an individual commodity market is closed.
- The dashboard's planned target/stop displays raw price PnL instead of modeled net economics.
- Unknown SKIPPED decisions can be summarized as a session block, hiding possible data or event problems.

**Target status vocabulary**

Every asset must report one of:

    LIVE_TRADEABLE
    DELAYED_NOT_TRADEABLE
    MARKET_CLOSED
    VENUE_STALE
    SOURCE_DIVERGENT
    DATA_UNAVAILABLE
    RESEARCH_ONLY
    SHADOW_ONLY

Every open or historical position must display:

    selected venue and instrument
    latest selected-venue timestamp and age
    bid / ask / mark or reference price
    planned net target reward
    planned worst-case net stop loss
    realized execution costs
    base stop and current stop
    entry mode and margin mode
    active portfolio circuit state

## 6. Data Plane Design

### 6.1 Venue adapters

Introduce a venue adapter boundary rather than directly sharing Redis keys:

    MarketVenueAdapter
      getQuote(instrument)
      getOrderBook(instrument)
      getCandles(instrument, timeframe, range)
      getFunding(instrument)
      normalizeInstrument(asset)
      validateFreshness(snapshot)
      describeFeeSchedule(accountProfile)

Adapters may expose comparator data, but only the selected adapter may be passed into entry, lifecycle, or execution calculations.

### 6.2 Redis key layout

Use versioned, provider-scoped keys:

    market:v2:<venue>:<instrument>:quote
    market:v2:<venue>:<instrument>:orderbook
    market:v2:<venue>:<instrument>:candles:<timeframe>
    market:v2:<venue>:<instrument>:health
    market:v2:<venue>:<instrument>:funding
    market:v2:comparison:<asset>

There must be no generic market:live:<asset> write path for execution. A derived display-only consensus price may exist, but it must never be used by the execution, stop, or admission paths.

### 6.3 Data freshness policy

    crypto selected venue quote: tradeable only if <= 5 seconds old
    crypto order book: tradeable only if <= 5 seconds old
    crypto one-minute candle: eligible only if source complete / current status is known
    FX and commodity cache: displayable with explicit as-of time, not tradeable when closed or stale

All values must carry observedAt, providerEventTime when available, receivedAt, and monotonic source sequence when available.

## 7. Research and Statistical Architecture

### 7.1 Dataset registry

Every research result requires an immutable manifest:

    datasetId
    venue
    instrument
    timeframe
    startTime
    endTime
    downloadTimestamp
    source checksum
    strategyVersion
    featureVersion
    costModelVersion
    parameterSetId

No result may be labeled out-of-sample if its data, feature logic, or parameters were reviewed and tuned after the evaluation interval was examined.

### 7.2 Walk-forward protocol

For each selected asset:

1. Split time chronologically into train, validation, and untouched final holdout windows.
2. Permit parameter selection only in the train / validation stage.
3. Use embargo or purge windows around overlapping holding periods.
4. Freeze the configuration before final holdout evaluation.
5. Record every tested configuration to estimate the effective number of trials.
6. Evaluate all output after fees, funding, spread, slippage, and stop gaps.
7. Report total trades, independent trade clusters, profit factor, expectancy, drawdown, MFE/MAE, TP-first rate, SL-first rate, and time-outcome distribution.

The goal is not to find a target multiplier that rescues five recent losses. The goal is to learn whether a stable condition has positive after-cost expectancy without curve fitting.

### 7.3 Promotion statistics

Suggested initial research gates:

    independent closed paper trades >= 30 per promoted setup family
    independent closed paper trades >= 100 before any live-capital discussion
    after-cost profit factor >= 1.10
    after-cost expected value lower confidence bound > 0
    no fatal provenance or accounting exceptions
    out-of-sample performance not materially worse than development performance
    no unresolved multiple-testing record

These are minimum gates, not guarantees. A short positive cohort does not override a wide confidence interval or weak source provenance.

### 7.4 Counterfactual recording

When an entry is blocked or held, record the same target, stop, selected venue price, and later triple-barrier outcome. This creates a control group.

The research store must make it possible to answer:

- Did the bot reject positive opportunities?
- Did it admit trades whose conditional TP-first probability was poor?
- Did a loss-streak block prevent further damage?
- Would a different target horizon have changed the first-barrier result after costs?

## 8. Admission, Risk, and Execution Architecture

### 8.1 Entry pipeline

The required order of evaluation is:

    1. data and venue integrity
    2. market session / tradeability
    3. feature and regime snapshot
    4. conditional triple-barrier eligibility
    5. learning cohort state
    6. portfolio circuits and correlation limits
    7. entry-mode eligibility
    8. risk-at-stop sizing
    9. paper execution-plan fitting
    10. ledger approval and position creation

No later step may make an earlier failed step pass.

### 8.2 Risk-at-stop equation

For selected-venue contract-aware units:

    maximum_amount_by_stop =
      approved_worst_case_net_loss_usd
      / worst_case_net_loss_per_unit

where:

    worst_case_net_loss_per_unit =
      selected_venue_stop_move
      + entry_spread_and_slippage
      + stop_gap
      + entry_fee
      + exit_fee
      + expected_carry

The amount must then be capped by:

- free margin;
- per-asset margin limit;
- total portfolio margin limit;
- correlation limit;
- entry-mode risk multiplier;
- daily / weekly / drawdown circuit;
- selected venue contract precision and minimum size.

### 8.3 Lifecycle discipline

An open position's selected execution venue may not change after entry. If selected-venue data becomes stale:

1. stop creating new positions;
2. retain the last verified state;
3. trigger a data-integrity incident;
4. do not fabricate a new generic-price stop fill;
5. record the incident and operator action.

The weakening-thesis stop must be evaluated as a research feature. Measure whether it improves after-cost outcome versus holding to original stop, under a frozen future cohort. It must not be justified solely because one previous ETH trade lost less.

## 9. State, Ledger, and Reset Design

### 9.1 Durable evidence

The execution ledger must retain an append-only record for:

    DATA_SNAPSHOT
    SIGNAL_CREATED
    RESEARCH_GATE_RESULT
    PORTFOLIO_GATE_RESULT
    ENTRY_APPROVED
    ENTRY_REJECTED
    ENTRY_FILLED
    POSITION_UPDATED
    EXIT_FILLED
    RESET
    DEPLOYMENT_VERIFIED
    INCIDENT_OPENED
    INCIDENT_RESOLVED

All records include strategy version, code revision, dataset / venue fields where relevant, and a hash-chain predecessor.

### 9.2 Reset contract

An approved full paper reset must:

1. reset portfolio and live paper positions;
2. clear only current-version learning, opportunity, and review state;
3. clear all per-asset cooldowns;
4. clear exit snapshots and pending scan requests;
5. preserve immutable historical ledger and versioned cohorts;
6. create a SYSTEM_RESET ledger event with exact cleared keys;
7. verify an autonomous post-reset scan before declaring success.

Reset is never a statistical cure for negative expectancy. It is an operational state transition.

## 10. Dashboard and Operator Architecture

### 10.1 Required views

**Live market panel**

- selected execution venue;
- comparator venues and divergence in basis points;
- selected quote bid/ask and timestamp;
- market state per asset, not one global label;
- chart last candle timestamp and whether it is display-only.

**Decision panel**

- feature snapshot version;
- regime;
- target / stop barriers;
- TP-first, SL-first, timeout probabilities;
- conditional sample and independent cluster count;
- after-cost expected value and lower confidence bound;
- exact primary blocker when no entry is taken.

**Position panel**

- entry source and selected venue;
- worst-case net loss, not raw stop PnL;
- current MFE / MAE in R;
- base stop, current stop, and reason for every stop change;
- margin mode, leverage, risk budget, and actual capped risk;
- active circuits.

**Research panel**

- strategy cohort boundaries;
- frozen parameter set;
- current promotion state;
- out-of-sample metrics;
- configuration trial count;
- unresolved warnings as warnings, never silently hidden.

### 10.2 Operator roles

    Operator
      observes, investigates, approves planned resets and deployments

    Research owner
      defines dataset manifests, frozen experiments, promotion evidence

    Engineering owner
      implements reviewed phases, tests, deployment and rollback artifacts

    System
      may scan, paper trade only when eligible, and stop itself through circuits

No LLM output can override the hard data, research, risk, or circuit layers.

## 11. Implementation Phases

### Phase 0: Freeze and capture baseline

**Goal:** Preserve the current cohort and prevent accidental interpretation of contaminated evidence.

**Work**

- Export a read-only snapshot of current ledger, portfolios, scans, learning rules, reviews, opportunities, and market-source metadata.
- Mark the five closed post-reset trades as the v4.1 probation cohort.
- Add a research note that they are insufficient for parameter tuning.
- Record current selected-price/source behavior as the baseline defect.

**Acceptance**

- Snapshot manifest is immutable and checksummed.
- No reset is performed.
- No strategy threshold is changed.
- Existing five trades remain auditable.

### Phase 1: Venue-consistent crypto data plane

**Goal:** Eliminate mixed-source execution.

**Likely files**

    src/daemon/websocketDataMesh.ts
    src/lib/market.ts
    src/app/api/live-prices/route.ts
    src/lib/execution/swingLifecycle.ts
    src/lib/trading/executionCostModel.ts
    src/lib/trading/executionLedger.ts

**Work**

- Introduce venue-specific adapters and keys.
- Choose one selected execution venue for BTC, ETH, and SOL paper trades.
- Route candles, quotes, order-book features, funding, entry, stop, target, and close prices through that venue.
- Keep other venues only as health and divergence comparisons.
- Persist all price provenance in the ledger.

**Acceptance**

- A controlled test proves that a Binance tick cannot change a Bybit-selected execution price.
- A selected venue outage blocks entry rather than silently switching to another venue.
- All existing unit, type, and ledger verification tests pass.
- Live price API distinguishes selected versus comparator values.

### Phase 2: Research harness and first-passage labeling

**Goal:** Replace range-based target confidence with conditional TP-first / SL-first evidence.

**Likely files**

    src/lib/research/
    src/lib/swingEngine.ts
    src/lib/trading/opportunityJournal.ts
    scripts/replay-strategy.ts
    scripts/research-audit.ts
    scripts/strategy-audit.ts

**Work**

- Build selected-venue one-minute data ingestion for historical research.
- Implement triple-barrier labels with deterministic tie handling.
- Make opportunity observations cluster-aware.
- Add counterfactual records for held and blocked signals.
- Require a data manifest for every replay.

**Acceptance**

- Test fixtures cover TP-first, SL-first, timeout, gap, same-bar tie, and stale source cases.
- Research outputs include a provenance manifest and reproducible hash.
- Synthetic fixtures remain engineering tests only and cannot pass a profitability gate.

### Phase 3: Admission and portfolio hardening

**Goal:** Prevent weak evidence from becoming high-leverage entries.

**Likely files**

    src/lib/swingEngine.ts
    src/daemon/swingDaemon.ts
    src/lib/trading/localLearning.ts
    src/lib/trading/portfolioGuards.ts
    src/lib/trading/portfolioRiskBudget.ts
    src/lib/trading/tradeAdmission.ts

**Work**

- Pass entryMode through every admission call.
- Enforce the learning state machine.
- Add cross-asset correlated stop-loss circuit.
- Enforce low leverage and risk for probes and exceptions.
- Calculate and persist worstCaseNetLossUsd.

**Acceptance**

- A PROBE can never receive 5x.
- Negative learning cannot enter through an exception or probe path.
- Three correlated full stops cause an autonomous quarantine.
- All portfolio gates produce an explicit dashboard and ledger reason.

### Phase 4: Dashboard truthfulness and operations

**Goal:** Make the live screen honest enough for an operator to act on.

**Likely files**

    src/components/Dashboard.tsx
    src/app/api/user/status/route.ts
    src/app/api/live-prices/route.ts
    src/daemon/swingDaemon.ts

**Work**

- Replace raw planned stop/target PnL with modeled net economics.
- Add per-asset market state and as-of timestamp.
- Display selected venue, divergence, circuit state, and entry mode.
- Fix generic SKIPPED classification so unknown skip reasons cannot masquerade as session closure.

**Acceptance**

- Weekend commodity data is labeled MARKET_CLOSED with its latest as-of timestamp.
- A non-market data failure is shown as DATA_UNAVAILABLE or VENUE_STALE.
- A planned stop display reconciles exactly with ledger worstCaseNetLossUsd.

### Phase 5: Paper probation and promotion evidence

**Goal:** Establish or reject strategy edge without changing parameters repeatedly.

**Work**

- Freeze venue, cost model, feature version, thresholds, target logic, and holding horizon.
- Run paper-only observation until the minimum independent cohort is reached.
- Review metrics by asset, direction, regime, setup family, and entry mode.
- Use walk-forward, purged windows, and a final untouched holdout.

**Acceptance**

- Minimum independent cohort gate is passed or the strategy is rejected / revised.
- Out-of-sample after-cost confidence interval is reported.
- No open research warnings are reclassified as green merely to satisfy a zero-warning cosmetic rule.

### Phase 6: Non-crypto policy

**Goal:** Prevent FX and commodity data from being treated as realistic derivatives execution.

**Work**

- Retain Yahoo-backed FX / commodity charts as display and slow research feeds.
- Do not allow real or strong-margin execution until a broker / venue-specific instrument, contract multiplier, margin, spread, commission, rollover, and data policy are implemented.

**Acceptance**

- Dashboard labels these instruments RESEARCH_ONLY or MARKET_CLOSED when applicable.
- Cost profile does not claim synthetic fees are broker-realistic.

### Phase 7: Performance engineering only after edge proof

**Goal:** Decide whether Rust, Python, or infrastructure changes are justified by measurements.

**Work**

- Measure tick-to-decision latency, source delay, execution-plan latency, Redis latency, and missed-signal rate.
- Define a service-level objective for the chosen swing horizon.
- Compare TypeScript runtime performance against the required service-level objective.

**Decision rule**

Do not migrate to Rust because it sounds like HFT. Move a narrow performance-critical component only if a measured bottleneck materially changes selected-venue paper execution or strategy outcome after source and research defects are fixed.

## 12. Release Gates

### 12.1 Engineering gate

Required before deployment:

- lint, build, TypeScript typecheck, and unit tests pass;
- strategy audit reports no engineering failures;
- ledger verification passes;
- source-manifest parity passes for host and both containers;
- deployment status revision matches the pushed revision;
- scan counter advances after deployment;
- selected venue has fresh ticks and no missing required data;
- rollback revision and state snapshot are recorded.

### 12.2 Research gate

Required before relaxing paper restrictions:

- selected-venue dataset manifest exists;
- conditional first-passage metrics exist;
- after-cost economics are used throughout;
- parameter search and trial count are recorded;
- independent sample criteria are satisfied;
- lower confidence bound of after-cost expectancy is positive;
- no active source-provenance exception exists.

### 12.3 Capital gate

Not authorized by this document. It would require a separate written decision after the engineering and research gates have remained valid across a sufficiently large, independent paper cohort.

### 12.4 Current gate state: 2026-08-04

- **Engineering gate:** passed for runtime remediation commit `f9c41f53d8f675de1fb7b3b55664de88c942f114`. The deployed revision, selected-venue feed, clean reset, autonomous scan, chart identity, ledger presence, and release checks were observed directly.
- **Research gate:** not passed. Replay evidence is useful for engineering validation, but the v4.2 live cohort has no closed trades and no completed triple-barrier conditional first-passage report.
- **Capital gate:** not authorized. The system remains `PAPER_ONLY`.
- **Operational interpretation:** a `HOLD` result with a documented blocker is healthy selectivity, not proof of dormancy. A repeated rejected setup becomes actionable only after its counterfactual outcome matures and demonstrates positive after-cost expectancy.

## 13. Operator Runbooks

### 13.1 Daily paper operations

1. Check deployment revision, container health, ledger verification, and scan advancement.
2. Review selected-venue freshness and comparator divergence.
3. Check active circuit states before interpreting a lack of trades.
4. Review every new close in R, MFE, MAE, venue source, and net-cost terms.
5. Record anomalies as incidents; do not change thresholds during the same session.

### 13.2 When the bot makes no trades

1. Confirm scan advancement.
2. Separate MARKET_CLOSED, DATA_UNAVAILABLE, VENUE_STALE, HOLD, BLOCKED_RISK, and SHADOW_ONLY.
3. Read the primary blocker and current conditional sample.
4. Do not lower thresholds simply to generate activity.
5. Create a research question only if repeated valid opportunities are being rejected and later counterfactual evidence shows positive after-cost outcomes.

### 13.3 After a stop-loss sequence

1. Preserve the ledger and raw source snapshots.
2. Check whether the correlated loss-streak circuit activated.
3. Calculate realized R, MFE, MAE, TP-first / SL-first labels, and selected-venue source integrity.
4. Do not tune stop or target values from the sequence alone.
5. If a provenance or accounting defect occurred, quarantine new entries before analysis.
6. Resume only according to the explicit circuit and research-state rules.

### 13.4 Before a reset

Require explicit human approval specifying:

- which portfolio(s) are reset;
- capital amount;
- whether current strategy learning is cleared;
- whether a deployment is also occurring;
- expected post-reset validation scan;
- record-retention confirmation.

After reset, verify empty portfolio state, cleared transient keys, preserved historical ledger, fresh selected-venue data, and an autonomous scan.

### 13.5 Before a deployment

1. Confirm the exact commit and changed-file list.
2. Run all engineering gates.
3. Create a pre-deployment state snapshot.
4. Deploy only the approved revision.
5. Verify host checkout, container manifests, image revision, health checks, ledger, API revision, and scan advancement.
6. If any check fails, stop and roll back code only; preserve paper state unless a separately approved recovery action exists.

## 14. Explicit Non-Goals

- Do not promise an autonomous profitable system.
- Do not call the present one-minute public-WebSocket architecture HFT.
- Do not use LLM confidence as a source of edge or as permission to bypass risk controls.
- Do not mix venue prices because a later tick appears fresher.
- Do not delete historical evidence to make a dashboard look clean.
- Do not reset repeatedly to erase an unfavorable sample.
- Do not classify all warnings as failures or hide genuine research warnings to obtain a cosmetic zero-warning result.
- Do not enable real-money or increase margin based on this document alone.

## 15. Definition of a Workable System

The system is workable as a paper trading research platform when:

1. every live decision and close can be reproduced from selected-venue evidence;
2. all price, fee, and contract assumptions agree with the same venue;
3. loss circuits stop correlated bad regimes before portfolio damage escalates;
4. dashboards communicate actual data age and net risk;
5. negative-learning and probe paths cannot bypass hard gates;
6. research data demonstrates positive after-cost conditional expectancy with uncertainty reported honestly; and
7. deployments preserve source parity, paper evidence, and rollback capability.

The system is not workable for real capital merely because it has completed these engineering tasks. Profitability remains a separate empirical claim requiring clean, sufficient, independent evidence.

## 16. Remaining Work Handoff

Phase 0, Phase 1, and the urgent Phase 3 controls are complete. The next approved implementation must begin with Phase 2 first-passage research, without changing the frozen v4.2 admission thresholds, stop model, target model, margin policy, or reset state in the same release.

The remaining priority order is:

    1. collect immutable selected-venue counterfactual outcomes for every HOLD and entry candidate
    2. implement triple-barrier TP-first, SL-first, neither, MFE, MAE, and time-to-event labels
    3. run purged walk-forward conditional studies with after-cost uncertainty intervals
    4. add Phase 4 dashboard views for path-specific blockers, data age, risk-at-stop, and cohort maturity
    5. observe the frozen v4.2 paper probation cohort without repeated resets
    6. revise a threshold only when independent counterfactual evidence identifies a specific false-negative or false-positive condition
    7. profile latency before considering a narrow Rust or Python service

The current live scan is reachable, not dead: deterministic replay produces qualifying entries and production exposes watch states and explicit blockers. No manual or synthetic trade should be inserted merely to prove activity. The next statistical question is whether the opportunities rejected by each gate later produce positive after-cost outcomes, not how to force a higher trade count.
