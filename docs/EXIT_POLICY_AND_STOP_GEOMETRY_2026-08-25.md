# Exit Policy and Stop Geometry Remediation

**Date:** 2026-08-25
**Scope:** swing exit management, protective-stop width, position-size admission, local-learning sample sizes, and the research/replay path
**Capital mode:** paper trading only

## Symptom

The deployed agent was doing two things at once:

1. **Cutting trades badly.** Live trade history showed winners closed for a few
   dollars while losers ran to their full planned stop — for example a BTC short
   opened 13 Aug with a plan of `TP +$19.14 / SL -$9.95`, held 23 hours, closed
   as `BREAKEVEN EXIT +$1.55`.
2. **Barely trading at all.** The dashboard reported 105,642 scan cycles and
   950,778 asset checks against a handful of positions, with the decision engine
   reporting `Learning adjustment -12` and `7 assets: market structure and
   liquidity are not aligned`.

## Method

Findings below were measured on eight months of Bybit `BTCUSDT`/`ETHUSDT`/
`SOLUSDT` klines (15m base, with 1m and 5m series for the short-term trigger),
replaying the real `TradeAdmissionController`, `executionCostModel`, and
`swingEngine` scoring functions. Results are reported split in-sample /
out-of-sample so that a change which only works on one window is visible as
such. Several candidate changes were rejected on exactly that basis (see
*Rejected*).

## Root causes and fixes

### 1. Six exit guards raced each other, all denominated in dollars

`swingLifecycle.ts` ran a profit-giveback ladder, a planned-risk breach check,
a weak-thesis loss-compression check, a weak-thesis profit-decay check, a
weak-thesis stop-tightening step, and `RiskManager`'s own trailing logic — every
sweep, against the same position. The tightest one always won.

Their thresholds were absolute dollar amounts: close after giving back **$3**
from a **$20** peak; close if profit decayed past **$8**; tighten the stop to
**0.35% of price** whenever any opposing signal appeared. On a normally-sized
crypto swing those fire inside ordinary noise, and they are meaningless across
different position sizes and volatility regimes.

**Fix.** All exit decisions now come from one pure function,
`decideSwingExit` in `src/lib/execution/exitPolicy.ts`, with every threshold
expressed in **R** — multiples of the trade's own planned loss.
`RiskManager.checkStopLossOrTakeProfit` no longer places stops for swings; it
only tracks watermarks and reports hard stop/target hits.

Same entries, only the exits changed:

| | trades | win rate | avg win | avg loss | profit factor | net |
|---|---|---|---|---|---|---|
| before | 247 | 41% | 0.80R | −0.89R | 0.60 | −$1,588 |
| after | 222 | 40% | 1.14R | −0.96R | 0.85 | −$775 |

The old stack produced a *higher* win rate and a much worse result, which is the
signature of cutting winners early while letting losers run.

### 2. The protective stop sat inside the signal's own working range

Stops were `1.5 × ATR(1h)`. Measured against the trades that eventually reached
a `+2 ATR` favourable move, a `1.5 ATR` stop closed **15%** of them first at the
8-hour horizon and **29%** at 16 hours. At `2.5 ATR` those fall to **5%** and
**13%**. The figures are within a hundredth of each other across BTC, ETH and
SOL, so this is a property of the signal, not of one asset.

**Fix.** `SWING_STOP_ATR_MULTIPLE = 2.5`, `SWING_TARGET_R_MULTIPLE = 2.5`,
exported from `swingEngine.ts` and shared with the replay engine. Because sizing
is risk-based, a wider stop shrinks notional proportionally: risk per trade in
dollars is unchanged.

### 3. Target reachability was measured over the wrong horizon

`evaluateTargetReachability` compressed any target that recent price action had
not covered **within 8 hours**, while trades now hold for roughly a day. Every
target was being cut down to an intraday move, which then failed the after-fee
reward/risk gate. The lookahead now defaults to 24 bars for fast crypto and 36
for slow-feed assets, and is an explicit parameter.

### 4. Correlated risk multipliers were multiplied together

`TradeAdmissionController` multiplied a drawdown multiplier, a conviction
multiplier, a learning multiplier, a setup multiplier, a data-feed multiplier and
a probe multiplier. The learning, setup and feed multipliers all answer the same
question from overlapping evidence, so multiplying them counts one observation up
to three times. Stacked, risk could compound down to about **0.009% of equity** —
every candidate then failed the minimum-useful-margin check and the bot went
quiet without saying why.

**Fix.** `combineRiskMultipliers` takes the strongest single reduction rather
than the product, with a floor, mirroring how `calculateLearningAdjustment`
already combines correlated rules. The fee-viability guard's assumed capture
fraction moved from 0.5 to 0.75, matching the measured average winner now that
exits no longer clip them.

### 5. Local learning formed rules from coin flips

A rule could form from **4** closed observations, and a `-8` confidence
adjustment from **3**. At n=4 a fair coin produces "1 win or fewer" about 31% of
the time, so roughly one asset in three was down-weighted on noise — and because
the resulting `REDUCE` shrank size below the minimum useful margin, a run of bad
luck could stop the bot trading that asset indefinitely. This is the mechanism
behind the live `Learning adjustment -12`.

**Fix.** Minimum sample raised to 15 observations for a rule, 12 closed trades
for a size reduction, 25 watched opportunities for the opportunity-based penalty.
The out-of-sample quarantine logic, which already required 12 holdout trades, is
unchanged.

### 6. The acceptance gate graded a strategy that was never deployed

`replayEngine.ts` contained its own EMA/VWAP signal, its own structure scorer,
its own stop geometry and its own exit rules. `npm run replay:strategy` was
therefore reporting the performance of a system the daemon does not run, and any
tuning aimed at it was aimed at the wrong target.

**Fix.** The whole swing decision was extracted from `SwingEngine.analyze` into
a pure `evaluateSwingSignal(input)`. `analyze` now does the I/O and delegates;
the replay calls the same function against historical candles. The replay's
duplicate strategy is deleted, and it uses the shared `decideSwingExit` for
management. Crypto history now comes from Bybit — the venue the daemon executes
on — paginated, instead of the five days Yahoo serves at 15m. Bars without 1m
trigger history are skipped and counted rather than silently scored as
no-trigger.

## Result

Two independent simulations were used, and they are reported together rather
than picking the more flattering one.

**A. Standalone harness** (8 months, BTC + ETH + SOL, $10,000, merged
chronological tape, stop fills at the stop price, portfolio position cap):

| | trades | win rate | avg win / loss | profit factor | net | max DD |
|---|---|---|---|---|---|---|
| before | 247 | 41% | 0.80R / −0.89R | 0.60 | −$1,588 (−15.9%) | 17.0% |
| after | 196 | 44% | 1.20R / −0.97R | 1.05 | +$338 (+3.4%) | 16.0% |

Consistent per asset — BTC 0.61 → 0.96, ETH 0.69 → 1.10, SOL 0.50 → 1.13 — and
positive in both halves of the sample (in-sample 1.08, out-of-sample 1.01).

**B. `npm run replay:strategy`** (125 days limited by 1m trigger coverage,
gapped stops filled at the bar open, no portfolio position cap — so the more
pessimistic of the two). Isolating the stop-geometry change alone, with the new
exit policy already in place on both sides:

| | trades | win rate | profit factor | net |
|---|---|---|---|---|
| 1.5 ATR stop / 2.0R target | 124 | 32.3% | 0.66 | −$799.73 (−8.00%) |
| 2.5 ATR stop / 2.5R target | 111 | 38.7% | 0.89 | −$323.37 (−3.23%) |

The two agree on direction and rough magnitude and disagree on the absolute
level. Average hold moved from about 5 hours to about 20–25 hours, which is what
a swing strategy is supposed to look like.

## What this does not claim

**None of this establishes a profitable strategy.** Across the two simulations
the post-fix profit factor lands somewhere between 0.89 and 1.05 — that is, from
a small loss to a small gain, and not statistically distinguishable from
breakeven at these sample sizes.

What the evidence does support is narrower and still worth having: the agent was
carrying mechanisms that reliably destroyed value — exits that clipped winners at
0.80R while losers ran to 0.89R, a stop placed inside the signal's own noise, and
a risk stack that could size a trade down to nothing — and those are now gone.
The bot moved from *losing consistently* to *roughly breakeven*.

Getting past breakeven requires an entry signal with a demonstrable edge. That
work has not been done, and the measurements in this document say the current
signal does not obviously have one at the horizon it trades.

## Rejected changes

These were tested and **not** shipped, because they worked on a three-month
window and failed on eight months. They are recorded so the same ground is not
covered twice:

- Requiring weekly-trend agreement as a hard entry gate (3-month PF 1.24;
  8-month PF 0.66).
- Replacing the market-structure alignment veto with trap-rejection only.
- Capping the short-term trigger score to avoid chasing.
- Lowering the higher-timeframe floor from 14 to 12.
- Removing or shortening the post-loss cooldown (2h tested best; 0 gave PF 0.97).
- Moving the partial-profit threshold off 1.2R (no material effect either way;
  it does reduce drawdown slightly, so it was left alone).

## Verifying

```bash
npm run replay:strategy -- --assets BTC,ETH,SOL --timeframe 15m --limit 12000
```

This now exercises the real signal, stop geometry, admission rules, cost model
and exit policy. Candle history is cached under `.replay-cache/` for 12 hours,
so the first run downloads and later runs are fast.

Two things to read before trusting a number it prints:

- `Bars skipped for missing 1m trigger history` — if this is large, the sample
  is much smaller than `--limit` implies, because the short-term trigger cannot
  be scored without 1m data.
- Trade count — below roughly 100 closed trades, the profit factor is noise.

Note also that `RESULT: FAIL` is currently the correct and expected outcome: the
gate requires a profit factor of 1.10, and the strategy does not clear it. The
gate is doing its job. It should not be relaxed to make the report green.
