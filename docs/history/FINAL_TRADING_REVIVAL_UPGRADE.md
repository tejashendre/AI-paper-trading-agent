# Final Trading Revival Upgrade

## Purpose

This upgrade restores a healthy path from market observation to paper-trade
admission without removing the system's security, data-quality, fee, stop-loss,
portfolio-exposure, or drawdown protections.

The live audit on 2026-07-15 showed that the infrastructure was healthy but the
strategy was over-selective:

- the swing daemon completed a scan every 60 seconds;
- all nine assets were evaluated with no scan errors;
- no feed was marked bad;
- seven assets were rejected primarily for weak higher-timeframe evidence;
- the repository replay reported an 87% missed-opportunity rate;
- recent entries were dominated by controlled probes rather than normal entries;
- broad asset-level learning penalties reduced conviction across unrelated setups.

The goal is not to force trades. The goal is to make valid, fee-aware normal
entries reachable when independent evidence agrees, while retaining HOLD as the
correct result when no edge exists.

## Non-Negotiable Safety Constraints

The upgrade must preserve all of the following:

1. Paper trading remains the default and live trading is not enabled.
2. Bad or stale data cannot open a position.
3. Invalid stop-loss or take-profit geometry cannot pass admission.
4. Fees, slippage, leverage, margin caps, and risk-at-stop remain enforced.
5. Duplicate positions and excessive correlated exposure remain blocked.
6. Negative-expectancy evidence may reduce size, but must not permanently freeze
   an entire asset based on one setup or a cluster of correlated observations.
7. Every entry path must remain visible in scan telemetry and replay tests.

## Root Causes

### Sparse HTF scoring

The old HTF score relied on four rare binary conditions. A clean structural trend
usually earned eight points while a normal crypto entry required fourteen. This
made the standard entry path depend on combinations of extreme z-score,
volatility squeeze, or VWAP-deviation conditions.

### Probe-path dependence

Because normal entries rarely qualified, most recent trades came through the
controlled-probe path. Probe losses then generated negative learning evidence,
making subsequent normal entries even less reachable.

### Over-broad learning scope

Asset-level rules mixed normal entries, probes, directions, regimes, and setups.
A losing probe could therefore reduce conviction for every future setup on the
same asset.

### Correlated sample inflation

One watched opportunity was evaluated at four horizons. Each horizon was counted
as an independent asset/setup sample, overstating confidence in derived learning
rules.

### Broken diagnostics

The status tools still targeted the retired DuckDNS URL and failed on its 308
redirect. Neutral crypto results also claimed that the asset was not in fast
mode, even when the real reason was simply that no direction existed.

## Required Changes

### 1. Continuous HTF evidence

Add bounded, independently interpretable evidence for:

- 4h EMA alignment;
- 1h EMA alignment;
- regression direction weighted by R-squared;
- price relative to 1h VWAP;
- RSI directional momentum without rewarding exhausted extremes;
- existing extreme mean-reversion, structural-trend, squeeze, and VWAP signals.

Continuous evidence must supplement the existing model, not bypass trigger,
structure, flow, slippage, data-quality, or admission checks.

### 2. Calibrated entry thresholds

Use separate thresholds for real-time crypto and slower cached-feed assets. A
well-aligned ordinary setup should be able to reach the normal entry path, while
exception and probe paths remain stricter and smaller.

Acceptance criteria:

- an isolated weak trend cannot enter;
- aligned HTF trend plus a confirmed trigger can reach normal admission;
- a probe still requires strong live confirmation and acceptable structure;
- learning watch-only, bad data, adverse flow, or excessive slippage still vetoes
  the trade.

### 3. Entry-mode-aware learning

Persist and evaluate `entryMode` alongside asset, direction, and setup metadata.
Probe evidence must not automatically become a blanket asset-level penalty for
standard entries.

Asset-level watch-only mode must require materially negative closed-trade
evidence and a sufficient independent sample. Opportunity-only evidence may
reduce size or confidence, but cannot permanently freeze an asset.

### 4. One independent sample per opportunity

Keep all horizon outcomes for diagnostics, but aggregate learning by opportunity
before calculating sample size and favorable rate. A 15m, 1h, 4h, and 24h review
of one decision counts as one independent opportunity.

The aggregation should prefer the strategy-relevant horizon and retain the
worst-path information for risk review.

### 5. Learning decay and bounded influence

Rules must include freshness. Old negative evidence should decay toward neutral
unless confirmed by newer closed trades. Setup-level and asset-level evidence
remain bounded so correlated rules cannot stack into an accidental permanent
halt.

### 6. Reliable diagnostics

- Default status tools to `https://trader.tejashendre.com`.
- Distinguish `NEUTRAL_DIRECTION` from `NON_CRYPTO_MODE` in microstructure text.
- Ensure entry-gate diagnostics use the same thresholds as actual admission.
- Keep blocker summaries available in the spectator-safe status response.

## Verification Plan

The change is acceptable only when all of these pass:

1. `npx tsc --noEmit`
2. Repository strategy audit
3. Production Next.js build
4. Deterministic tests for continuous HTF scoring
5. Deterministic tests proving correlated horizons count as one opportunity
6. Tests proving probe losses do not globally freeze standard setups
7. Read-only live status verification after deployment
8. Two live scan IDs advance at least 60 seconds apart
9. No live or paper order is manually triggered as part of deployment validation

## Operational Success Metrics

Success is measured over a rolling 14-day paper window, not by immediate trade
count alone:

- zero daemon scan errors;
- zero entries on bad data;
- normal entries are no longer absent from the trade distribution;
- probe entries remain a minority of entries;
- missed-opportunity rate falls below 60% without negative net expectancy;
- net expectancy after fees improves versus the previous strategy version;
- drawdown and per-trade max-loss limits remain within published caps;
- every HOLD and BLOCKED decision identifies its primary gate.

## Rollback

Rollback is performed by deploying the previous known-good Git commit. Redis
portfolio state, trade history, opportunity history, and learning history must
not be deleted during rollback. Derived learning uses versioned keys so a future
version can rebuild its rules without mutating historical evidence.

