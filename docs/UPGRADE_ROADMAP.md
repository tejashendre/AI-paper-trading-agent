# Upgrade Roadmap

**Written:** 2026-08-26
**Question it answers:** what would take this from a 7/10 system to a 10/10 one, in what order, and what should deliberately never be built.

---

## What the system is, in plain terms

There is one human and two bots. They are three separate $10,000 paper accounts.

| | Who | What it does | Holding period |
|---|---|---|---|
| **Human portfolio** | You, by hand | Whatever you enter manually | Your choice |
| **Swing engine** | Bot #1 | Picks *individual* markets it likes: 3 crypto, 3 forex, 3 commodities. Each trade gets a stop and a target. | Hours to a day |
| **Cross-sectional book** | Bot #2 | Ranks ~44 crypto perps against each other, buys the 12 strongest, sells the 12 weakest. No stops — it rebalances. | 12 hours |

**They are not the same thing with different names.** The difference is the
question each one asks:

- The swing engine asks **"is Bitcoin a buy?"** — an absolute judgement about one market.
- The book asks **"which 12 of these 44 are strongest relative to the others?"** — a *relative* judgement, where being right about the ranking matters and the market's overall direction largely cancels out.

That second question turned out to be far more answerable. The same ranking
method applied to only 3 correlated majors is a statistically significant
*loser*; applied to 44 markets it works. Breadth is the mechanism.

The book is also **market-neutral**: equal money long and short, so it can make
money whether crypto rises or falls. The swing engine is directional.

---

## Capacity: how much money this could ever manage

Measured against live Bybit turnover, 75 symbols currently clear the $10M/day
screen; the median is $29M/day and the 25th percentile is $15M/day.

Sizing against the *thin* end of the universe, not the median:

| Position as % of a thin symbol's daily volume | Per position | Total book |
|---|---|---|
| 0.5% | $75k | **$1.8M** |
| 1% | $151k | **$3.6M** |
| 2% | $301k | **$7.2M** |
| 5% | $753k | $18.1M — impact becomes material |

**Realistic capacity is single-digit millions.** Somewhere around $3–7M this
strategy starts trading against itself; past roughly $20M it stops working.

At the current $10,000, each position is ~$417 — about **0.003%** of a thin
symbol's daily volume. Market impact is genuinely zero. That is a real edge
small accounts have and large funds do not.

For scale: **$1 billion is roughly 150–300× beyond this strategy's ceiling.**
No amount of engineering changes that. It is a property of how much volume
exists in these markets, not of how good the code is.

---

## Phase 0 — do nothing (now → 2 weeks)

The highest-value action today is to let it run. Two weeks is ~30 rebalances,
the point at which live numbers start carrying information. Reacting sooner
means reacting to noise, which is precisely how the previous system acquired a
learning penalty that disabled its own entry paths.

Phase 1 is also *much* more informative once real fills exist to check against.

---

## Phase 1 — make the system verify itself (the 7 → 9 jump)

This is where almost all the remaining value is. None of it adds return; all of
it tells you whether the return you think you have is real.

### 1a. Execution reconciliation — the single biggest gap

Every number in the backtest rests on `executionCostModel.ts`: spread,
slippage, stop-gap, funding. **Nothing currently checks whether that model is
true.**

Build: for every fill, log what the model predicted against what the market
actually did over the following seconds. Track the ratio. Alarm when it
systematically diverges.

Why it matters: if real slippage is 3× the model, the backtest was fiction and
there is currently no way to find out. If it is *better* than modelled, edge is
being left on the table. Either way you are flying on an unverified instrument.

*Effort: ~2 days. Value: this is what separates a believable backtest from a verified system.*

### 1b. Multiple-testing correction

Roughly a hundred parameter combinations were tried while building the book.
Under pure noise the *expected maximum* t-statistic across that many trials sits
around 2.6–3.0. **The headline t was 2.58.**

The defence is genuine — 18 of 18 neighbouring parameter cells were positive in
both halves of the sample, and a plateau is far stronger evidence than a lone
peak. But those cells share overlapping data, so 18 cells are not 18 independent
tests.

Build: compute a **deflated Sharpe ratio** that formally discounts for the
number of trials, and report that as the headline instead.

The number will go down. Knowing by how much is the point.

*Effort: ~1 day. Value: replaces a flattering statistic with an honest one.*

### 1c. Rolling re-validation

Parameters were chosen once on a 12-month window. Edges decay, and
cross-sectional crypto momentum is well known enough that crowding is plausible.

Build: re-run the study monthly on a rolling window; plot edge over time.

*Effort: ~1 day, mostly scheduling what already exists. Value: decay shows up as a trend rather than as a surprise drawdown.*

### 1d. Plain-language dashboard mode

The current dashboard is written for someone who already knows what an HTF
score, a liquidity score and a rank buffer are. That is a real barrier — if the
person who commissioned it finds it dense, a visitor has no chance.

Build: a toggle that replaces every jargon panel with a sentence. Not
"HTF score 15, trigger 4, liquidity −5" but *"The bot likes Bitcoin's bigger
trend but is waiting for a short-term confirmation that hasn't arrived."*

The plain sentences already exist in the code — `simpleStatus`, `simpleReason`
and `nextStep` are computed on every scan and largely unused by the UI.

*Effort: ~1 day. Value: the system becomes explainable to anyone.*

---

## Phase 2 — breadth (the change the evidence already argues for)

Expand from ~44 markets to 150+ by adding OKX (438 USDT perps) and Hyperliquid
(232 markets, both free, no API key).

This is the only *return-seeking* upgrade supported by measurements already in
hand rather than by a new hypothesis:

```
3 assets  → −38% annualised (t = −2.69, significantly negative)
44 assets → +96% over 12 months
```

More independent bets is the mechanism. It also raises capacity, since the book
spreads across more venues.

*Effort: ~3 days. Risk: cross-venue symbol mapping and differing fee schedules must be modelled honestly, or this quietly inflates the backtest.*

---

## Phase 3 — a second, uncorrelated sleeve

One signal is fragile. If cross-sectional momentum stops working there is no
second source of return.

The selection rule matters more than the candidates: **choose on correlation to
what you already have, not on individual attractiveness.** A signal that is 0.8
correlated with the book adds complexity and nothing else. One at 0.2
correlation raises Sharpe materially even if it is individually weaker.

Candidates worth *testing* on that basis: time-series momentum (trend per asset
independently), cross-venue basis/carry, short-horizon reversal.

*Effort: ~1 week per candidate, including the 8–12 month out-of-sample bar. Expect most to fail — funding-as-signal already did (t ≈ −0.6).*

---

## Phase 4 — operational maturity

- **Kill-switch on edge decay**: if live results diverge from backtest beyond a threshold, stop trading and alert. Currently there is a drawdown breaker but nothing that detects *the strategy no longer working*.
- **Capacity monitoring**: track book size against universe liquidity, warn before impact becomes material.
- **Regime conditioning, measured**: the dashboard reports "CHOPPY" from a Hurst exponent. Nobody has checked whether that label changes expected returns. Either measure it and use it, or delete it — right now it is decoration wearing the authority of a number.

---

## What should deliberately never be built

### Scalping — actively advise against

Scalping means capturing moves of 5–20 bps. Round-trip cost here is 14–22 bps
taker. The arithmetic does not work, and no API upgrade fixes it, because the
edge in scalping is **not** data quality — it is latency and queue position.

That is a race against firms with FPGAs, colocation inside the exchange's own
data centre, and maker-rebate tiers. An Oracle Cloud VPS is 50–200ms away from
the matching engine. You would be the slowest participant in the game, paying
taker fees, against opponents measuring in microseconds.

**The current book is competitive precisely because it refuses to compete on
speed.** A 12-hour holding period cannot be beaten by being faster.

### A Rust rewrite — no return for this strategy

Rust would take execution from ~50ms to ~1ms. The strategy makes decisions
**twice a day**. Saving 49ms on a twice-daily decision is worth exactly nothing.

Rust matters when latency is the edge — market making, HFT, arbitrage. Those are
different businesses requiring colocation and exchange relationships, not a
different language. Rewriting this in Rust would be weeks of work for zero
measurable improvement.

### "A Jane Street-style bot"

Worth separating two things:

- Their **market-making and HFT** business rests on colocation, exchange rebates, proprietary order flow, and hundreds of researchers. Not replicable, at any language or API tier.
- Their **systematic long/short book** style — rank a universe, go long the top, short the bottom, stay market-neutral, control turnover — is *exactly what you already have*. That family of strategy is real, is used by real funds, and does not require any of the above.

You already built the part that is achievable. The other part is not gated on skill or effort — it is gated on being physically inside the exchange.

---

## The honest ceiling on free data

At some point the binding constraint stops being engineering and becomes data
depth. Free crypto perp history gives roughly 2–3 years for major names and far
less for the long tail. Most of this universe has never traded through a proper
bear market because it did not exist yet.

So the achievable 10/10 is: **a system that knows exactly what it does and does
not know, verifies its own assumptions continuously, and stops itself when
reality diverges from the model.** That is reachable with the phases above.

"Validated across multiple market regimes" is not reachable on this data for a
few more years, and no upgrade shortens that wait.

---

## Recommended order

1. **Wait two weeks.** Collect forward data.
2. **Phase 1a** — execution reconciliation. Everything rests on it.
3. **Phase 1d** — plain-language mode. Cheap, and makes the system explainable.
4. **Phase 1b + 1c** — honest statistics and decay monitoring.
5. **Phase 2** — breadth, if 1a shows the cost model holds up.
6. **Phase 3** — a second sleeve, only after all of the above.

Phases 1 and 2 together would genuinely justify calling this a 10/10 system *of
its kind*: a small-capital, free-data, market-neutral paper trading system that
is honest about its own edge. That is a real thing to have built.
