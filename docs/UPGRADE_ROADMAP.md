# Upgrade Roadmap

**Written:** 2026-08-26
**Updated:** 2026-08-27, after building Phase 1 and testing Phase 2's premise.
**Question it answers:** what would take this from a 7/10 system to a 10/10 one, in what order, and what should deliberately never be built.

---

## The headline finding, added 2026-08-27

Phase 1 was built to make the system check its own claims. It did, and the
answer is not the one the earlier version of this document expected.

**Over 24 months the cross-sectional book's edge is not distinguishable from
zero.** Mean 2.7bps per period, t = 0.87, deflated Sharpe 13.1%. Extending the
window from 12 months to 24 made the result *worse*, not better — the Sharpe
fell from 1.33 to 0.79 — which is the signature of a 12-month window that
happened to be favourable rather than of an edge that persists.

The rolling re-validation says the same thing in a different way: window
averages swing between −11.9bps and +12.1bps with no window reaching t = 2.
That is the spread noise alone produces.

**This is a finding, not a malfunction.** The strategy has not broken; it was
never established in the first place, and the previous headline t of 2.58 was a
12-month figure quoted without saying how many configurations were searched to
find it. Phase 1b exists precisely to catch that, and it caught it.

What follows from it:

- The paper book should keep running. It is the only thing that will settle the question, and it costs nothing.
- No parameter should be re-tuned to make the number pass. Searching for a configuration that clears the bar raises the trial count and the bar with it. That is the error the deflated Sharpe measures.
- The dashboard now says "not proven yet" in those words rather than reporting a return percentage as though it were skill.

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

**Now computed in code, not by hand** — `src/lib/execution/capacity.ts`, shown
live on the dashboard, recomputed from current turnover on every request.

The constraint is per name, not per book. A book of twelve names a side at ten
percent each is limited by its *thinnest* holding: if one name can absorb only
a few hundred thousand of the rebalance, the whole book is capped there however
deep the other twenty-three markets are.

Measured against live Bybit turnover on 2026-08-27, holding the book to two
percent of any market's daily volume:

| Liquidity screen | Eligible names | Thinnest | Book ceiling |
|---|---|---|---|
| $2M/day | 60 (universe cap) | $15.5M/day | **$6.9M** |
| $10M/day — *current* | 60 (universe cap) | $15.5M/day | **$6.9M** |
| $25M/day | 42 | $25.3M/day | $11.2M |
| $100M/day | 13 — too few to rank 12 a side | $122.8M/day | $54.6M |

The `maxSymbols: 60` cap binds before the turnover floor does, which is why the
first three rows agree. Raising the floor only helps by removing thin names
from the top 60, and past $25M there are not enough markets left to build the
book at all.

**Realistic capacity is single-digit millions.** Around $7M this strategy starts
trading against itself. The most liquid-only variant reaches ~$55M but cannot
form a twelve-a-side book.

At the current $10,000, each position is ~$417 — about **0.003%** of a thin
symbol's daily volume. Market impact is genuinely zero. That is a real edge
small accounts have and large funds do not.

For scale: **$1 billion is roughly 150× beyond this strategy's ceiling.**
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

## Phase 1 — make the system verify itself (the 7 → 9 jump) — **BUILT 2026-08-27**

This is where almost all the remaining value is. None of it adds return; all of
it tells you whether the return you think you have is real. All four parts are
now live. What each one returned is recorded below its description.

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

**Built** — `src/lib/execution/costModelReconciliation.ts`. A paper system has
no real fill to compare against, so three genuinely observable things are
recorded per fill instead: the half-spread actually quoted at execution, the
adverse move actually realised a minute later, and the funding actually
charged. Sampling happens in the mark loop rather than at fill time, because
slippage is only measurable once the market has had a chance to move. Thirty
settled fills are required before any verdict is offered. The dashboard states
the result as a sentence: whether the model is honest, optimistic, or
conservative.

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

**Built** — `src/lib/research/deflatedSharpe.ts`, the Bailey and López de Prado
correction. Trials drawn from a plateau are correlated rather than independent,
so only a quarter of them are counted; that discount is conservative in the
strategy's favour.

The number went down a long way. **12-month window: 21.9%. 24-month window:
13.1%.** Both far below the 95% bar. The replay now prints the deflated figure
beside the raw one and fails its acceptance run on it. It is a research
command, not a deploy gate, so it reports the truth without blocking anything.

*Effort: ~1 day. Value: replaces a flattering statistic with an honest one.*

### 1c. Rolling re-validation

Parameters were chosen once on a 12-month window. Edges decay, and
cross-sectional crypto momentum is well known enough that crowding is plausible.

Build: re-run the study monthly on a rolling window; plot edge over time.

**Built** — `src/lib/research/edgeDecay.ts`, running in two places: offline over
replayed history, and live in the daemon, which records one equity point per
rebalance and re-runs the test each period.

Two design decisions worth keeping in mind if this is ever revisited.

The test judges the *baseline* periods, not the whole series. Judging the series
whole is subtly wrong: a strategy that worked and then died drags its own total
down, so a whole-series check reports "never had an edge" precisely when it
should report decay. There is a regression test for that specific inversion.

A near-zero baseline gets no verdict at all. The first version graded the real
24-month replay `EDGE_STABLE` at "539% retained" — arithmetically true against
a 1.9bps baseline, and meaningless. `NO_ESTABLISHED_EDGE` now covers that case
and suppresses the ratio. That is the verdict the live book currently shows.

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

**Built** — a `PLAIN ENGLISH` toggle on the dashboard, persisted per viewer.
It swaps jargon for the sentences the engine already computes, explains what
dollar-neutrality means in the exposure tile, and states the cost verdict, the
edge verdict and the capacity ceiling as sentences rather than as ratios.

*Effort: ~1 day. Value: the system becomes explainable to anyone.*

---

## Phase 2 — breadth — **premise tested 2026-08-27 and largely refuted**

The original plan was to expand from ~44 markets to 150+ by adding OKX (438
USDT perps) and Hyperliquid (232 markets). Those counts are raw listings. When
you count only markets that clear a liquidity floor, and deduplicate by
underlying asset — BTC on two venues is one bet, not two — the picture changes
completely.

Measured 2026-08-27, at a $10M/day floor:

| Venue | Liquid names | Adds vs Bybit |
|---|---|---|
| Bybit | 77 | — |
| OKX | 81 | +26 |
| Hyperliquid | 22 | **+0 unique** |
| **Union** | **104** | **1.35×, not 3.4×** |

Hyperliquid's only name absent from the others is `kPEPE`, which is Bybit's
`1000PEPE` under a different scaling convention — the same asset. **Building
that adapter would buy nothing.**

Of OKX's 26 additions, only three are absent from Bybit entirely (PEPE, PUMP,
SHIB — two of which are again scaling-convention duplicates). The other 23 are
the same crypto assets, simply deeper on OKX. That is a real gain, but a modest
one.

**And roughly ten of the 26 are tokenised equities** — INTC, MRVL, QQQ, SOXS,
MSTR among them. SOXS is a −3× leveraged semiconductor ETF. They all quote 24/7
on OKX, so the existing bar-coverage screen does **not** exclude them, exactly
as it failed to on Bybit. Adding OKX without an explicit equity filter would
silently start ranking Intel against Solana by 72-hour return.

### What was tested instead

Broadening Bybit's own liquidity floor is cheaper than a second venue and gives
a larger gain: 77 names at $10M becomes 187 at $2M. History was fetched for 187
symbols over 24 months and the universe swept, charging **each name at its own
liquidity** rather than a flat rate (see `liquidityCost.ts`, built for this).

| Screen | Eligible | Cost | Mean | t | Sharpe | Max DD |
|---|---|---|---|---|---|---|
| $10M, book 12 | 37 | 5.0bps | 3.04bps | 0.97 | 0.88 | 19.7% |
| $5M, book 12 | 58 | 5.8bps | 4.49bps | 1.51 | 1.07 | 33.1% |
| $2M, book 12 | 91 | 7.0bps | 6.11bps | 1.70 | 1.21 | 35.8% |

That looks like a clear win until you read the rest of the $2M run: **in-sample
−14.4%, out-of-sample +146.2%, and only 10 of 24 months positive.** The entire
return comes from the recent stretch. Deflated Sharpe 35.2% — still a fail.

The only effect that is monotone and reliable across every configuration tested
is that **a larger book lowers drawdown** — 52.7% at four names a side down to
24.6% at twenty. Breadth buys stability, not return.

### Conclusion

**Not building the venue adapters.** The measured gain is 1.35× rather than the
3.4× this document assumed, half of it is tokenised equities that would change
what the strategy is, and the broader test shows more names do not produce a
demonstrably better strategy anyway.

**Not changing the live configuration either.** Selecting the $2M/book-12
settings because they scored best is exactly the multiple-testing error Phase 1b
was built to catch, and Phase 1b says that configuration fails.

What *was* kept from this phase: `src/lib/execution/liquidityCost.ts`, a
turnover-to-spread curve measured from all 740 live Bybit perpetuals. Every
future universe experiment now charges thin markets what they actually cost.
Without it, a flat rate makes a $2M market look as cheap as a $2B one and
decides the breadth question before it is asked.

*Actual effort: ~1 day, most of it fetching two years of history for 187 symbols.*

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

**Selection rule built 2026-08-27** — `src/lib/research/sleeveCorrelation.ts`,
exposed at `/api/sleeves`. Written against two arbitrary return series rather
than against either strategy, so it can grade a candidate before the candidate
exists.

Its first use is on the pair already running. **Nobody had ever checked whether
the swing engine and the cross-sectional book are the same bet in different
clothing.** If they are, running both carries operational risk without buying
protection, and "two strategies" is a false sense of safety.

That required giving the swing engine an equity curve it never had. Both sides
use *realised* equity: the swing engine only books a result on exit, so
correlating its curve against the book's continuously marked one would measure
the recording schedules rather than the strategies. Returns bucket by calendar
day for the same reason, and gaps stay gaps — filling them with zeros drags
every correlation toward zero.

**No verdict yet.** The book's curve began 2026-08-27 and twenty shared days
are required. The endpoint reports the shortfall rather than a number. Check
back around 2026-09-17.

*Effort: ~1 week per candidate, including the 8–12 month out-of-sample bar. Expect most to fail — funding-as-signal already did (t ≈ −0.6).*

---

## Phase 4 — operational maturity

- **Kill-switch on edge decay** — **BUILT**. The daemon re-runs the rolling test each rebalance and stands the book down when an *established* edge turns negative. It holds rather than liquidates: flattening on one noisy window would deadlock recovery, because a flat book produces flat returns that can never clear the bar to resume. Unwinding stays a human decision. An unproven strategy is deliberately *not* halted — the paper book exists to gather the evidence that would settle the question, and freezing it prevents that.
- **Capacity monitoring** — **BUILT**. `capacity.ts`, live on the dashboard, recomputed from current turnover per request. Current ceiling ~$6.9M, set by the thinnest name the book is allowed to hold.
- **Regime conditioning** — **MEASURED, and the answer is no.**

### The regime label carries no information

Tested the only way it can be: bucket 891 realised rebalance periods by the
regime in force when each began, using the same Hurst estimator and the same
0.45/0.55 thresholds production classifies with.

| Regime | Periods | Mean edge | t | Hit rate |
|---|---|---|---|---|
| MEAN_REVERTING | 354 | +4.0bps | 0.81 | 54% |
| TRENDING | 164 | +3.8bps | 0.48 | 52% |
| CHOPPY | 373 | +1.8bps | 0.38 | 50% |

Best minus worst is 2.2bps per period at **Welch p = 0.75** — comfortably
inside what sampling noise produces. Welch rather than Student because the
buckets have neither equal sizes nor equal variances, which is exactly the
situation where assuming otherwise makes a noise label look informative.

The dashboard tooltip claimed *"TRENDING executes breakout trades;
MEAN_REVERTING buys swings; CHOPPY scales down risk."* Both halves of that were
wrong: the label predicts nothing, and no entry, sizing or exit path reads it.
The tooltip now states what was measured.

**One caveat, stated because it limits the conclusion.** This tested the label
against the *book's* period returns using BTC as the reference series. The
swing engine computes its own per-asset 4-hour label. That one is display-only
today, so nothing trades on it either — but it has not been separately tested,
and this result should not be quoted as though it had been.

Untouched: the richer `worldModel.regime` taxonomy (PANIC, BREAKOUT,
STRONG_TREND_DOWN and so on) *does* drive real vetoes in the risk governor and
position manager. It is a different classifier and was not tested here.

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

Everything below is done as of 2026-08-27, except where marked.

1. ~~Phase 1a — execution reconciliation.~~ **Built.** Verdict pending the 30-fill minimum.
2. ~~Phase 1d — plain-language mode.~~ **Built.**
3. ~~Phase 1b + 1c — honest statistics and decay monitoring.~~ **Built.** Both say the edge is unproven.
4. ~~Phase 2 — breadth.~~ **Tested and largely refuted.** Kept the measured cost curve; did not build the venue adapters or change the live configuration.
5. ~~Phase 4 — kill-switch, capacity, regime.~~ **Built and measured.** Regime label found to be decorative.
6. **Phase 3 — a second sleeve.** Selection rule built; needs ~20 shared days before it can report. **This is the only item still waiting on time rather than work.**

### What is left, and it is not code

The system now verifies itself, and what it says is that the strategy is
unproven. Nothing in the remaining backlog changes that — the only thing that
can is forward data accumulating at its own pace.

The temptation from here is to tune until a number passes. Resist it: every
configuration tried raises the multiple-testing bar, and Phase 1b measures
exactly that. The right action is to let it run and check back in a month.

Judged on what it *is* rather than on what it earns, this is now a
small-capital, free-data, market-neutral paper trading system that measures its
own execution costs, discounts its own backtests for search effort, re-validates
its own edge on a rolling basis, knows the size at which it would stop working,
and says "not proven" on its own dashboard when that is the truth.

**Very few systems at any size do all five.** That is the thing that was
actually built here.
