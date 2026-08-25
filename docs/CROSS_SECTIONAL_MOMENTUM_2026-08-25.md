# Cross-Sectional Momentum: the strategy change

**Date:** 2026-08-25
**Scope:** a second, independent strategy running alongside the swing engine
**Capital mode:** paper trading only

## Why a new strategy at all

The swing engine was repaired the same day (see
[EXIT_POLICY_AND_STOP_GEOMETRY_2026-08-25.md](./EXIT_POLICY_AND_STOP_GEOMETRY_2026-08-25.md)).
That work removed mechanisms that were destroying value and moved it from a
reliable loss to roughly breakeven. It could not do better than that, because
of an arithmetic problem no amount of exit tuning reaches:

- Round-trip cost per trade: **14–22 bps** (taker fees both sides, spread, slippage).
- Measured forward edge of the signal: **7–12 bps**.

The bot was paying more to trade than the signal was worth.

## The finding

Ranking assets **against each other** and holding a dollar-neutral book — long
the strongest, short the weakest — behaves completely differently from asking
"is this asset a buy?" one asset at a time.

Measured over 12 months of Bybit hourly data on 49 liquid USDT perpetuals:

| Universe | Book | Annualised, net of 6bps one-way |
|---|---|---|
| **BTC/ETH/SOL — what the swing daemon trades** | k=1 | **−38%** (t = −2.69) |
| top-30 by turnover | k=5 | +57% |
| all 49 | k=8 | **+84%** |

(These three rows come from the earlier fixed-universe study and share its
look-ahead bias. The *relative* ordering is the point, and it is reproduced by
the corrected point-in-time replay below; the absolute levels are not
trustworthy.)

**Breadth is not an optimisation here; it is the entire mechanism.** Three
highly correlated majors contain almost no cross-sectional dispersion, so
ranking them is ranking noise and paying fees for the privilege — a
*statistically significant loser*, not merely a weak one. The same method over
fifty markets has real dispersion to harvest.

The universe costs nothing: Bybit lists 732 USDT perpetuals on the same free
public API the bot already uses, 55 of them above $20M daily turnover.

## Robustness

Every check that normally kills a backtest was run before this was written.

| Check | Result |
|---|---|
| Survivorship — restrict to symbols listed at window start | **Better**, not worse: gross t=2.84 vs 2.39 |
| Excluding the top-5 mega caps | Still works, t=2.19 |
| Quarterly stability | **All four quarters positive** (+40%, +73%, +245%, +165% ann.) |
| Parameter plateau — lookback | 48h through 336h all positive, flat, no isolated peak |
| Parameter plateau — hold | 12h through 72h all positive |
| Book size | k=5 through k=15 all positive |
| Cost break-even | ~26 bps one-way, against an expected 6–12 |

A confirmation grid over hold ∈ {12h, 24h}, book ∈ {8, 10, 12} and rank buffer
∈ {1.5, 2.0, 2.5} produced **18 of 18 combinations positive in both halves of
the sample**. A whole neighbourhood working is much stronger evidence than one
cell working.

This is also a documented anomaly rather than a novel pattern found by
searching: cross-sectional momentum is one of the most replicated effects in
finance, and specifically so in crypto. The work here confirms it on this
venue, at this size, net of this cost model.

## What the strategy does

`src/lib/strategy/crossSectionalMomentum.ts`, pure and replayable:

1. **Screen** every USDT perpetual for ≥ $10M trailing-24h turnover *measured
   at that instant*, ≥ 30 days of history, and a contiguous bar series.
2. **Rank** the survivors by trailing 72h return.
3. **Build** a book: long the 12 strongest, short the 12 weakest, equal weight
   per side, dollar-neutral and unlevered.
4. **Rebalance** every 12 hours, with rank hysteresis.

### Parameters, and why these ones

Chosen for in-sample/out-of-sample agreement and drawdown, **not** peak return.

| Parameter | Value | Reason |
|---|---|---|
| Lookback | 72h | Middle of the 48–336h plateau. Longer lookbacks scored better in-sample and worse out-of-sample; 72h is the most balanced. |
| Hold | 12h | Twice the observations of a 24h rebalance (n=689 vs 344), better half-to-half agreement. |
| Book size | 12 per side | Largest tested that keeps the edge. Diversification is structural: max drawdown falls from 20% at k=8 to 12% at k=12 for the same return. |
| Rank buffer | 2.0× | Cuts turnover from ~89% to ~27%. Deliberately *below* the 2.5 that scored highest, since the turnover benefit is monotone but the return ranking across buffer values is not. |

### Rank hysteresis

Without it the book replaces ~89% of its notional every rebalance, purely
because names shuffle around the cut-off. Keeping a held name while it stays
inside `bookSize × rankBuffer` drops that to ~27% with no loss of signal — and
the gap *widens* as costs rise (at 20bps one-way: 26% total return with
hysteresis versus 12.5% without). That is robustness worth buying.

## Result

`npm run replay:xsec`, driving the production module:

```
Universe:        84 loaded, 44 eligible on average (point-in-time)
Window:          2025-08-15 .. 2026-08-25
Config:          72h lookback, 12h hold, 12 per side, 6bps one-way
Periods:         640 (615 rebalanced, 25 held below threshold)
Avg turnover:    34.2% one-way per rebalance
Mean period:     11.1bps  (t = 2.58)
Sharpe:          2.76
Total return:    96.3%
Max drawdown:    13.5%
In-sample:       28.8%      Out-of-sample: 52.4%
Positive months: 9/12
RESULT: PASS
```

### A bias that had to be corrected first

The first version of this replay screened the universe on **today's** turnover
and applied that fixed list across the whole year. That is look-ahead bias: it
assumed ~49 symbols were liquid throughout a period in which most of them had
not yet reached $20M/day, and credited the book with trades it could never have
placed.

Rebuilding the universe at every rebalance from trailing turnover *as of that
moment* changed the picture in two ways. At the original $20M floor only 23
rebalance periods had enough eligible names to form a book at all — no sample.
Lowering the floor to $10M, which is still far deeper than a $10k book needs,
restored a 640-period sample and a **stronger** result than the biased version:
t rose from 2.41 to 2.58 and return from 65% to 96%.

That is consistent with the central finding rather than a lucky escape: a wider
eligible cross-section is exactly what the strategy feeds on. The point-in-time
screen also removed the earlier claim that a bar-coverage test excluded Bybit's
tokenised equities — it does not. Those perps quote continuously even while the
underlying market is closed, so they pass every continuity test. They are simply
allowed to compete on liquidity and history like everything else.

## Things that were tested and rejected

- **Reversal instead of momentum** — strongly negative, t = −4.6 to −5.2.
- **Funding rate as a crowding signal** — no gross edge (t ≈ −0.6); the
  apparent significance was entirely the cost term. Funding is still *charged*
  on the book, it is just not used as a signal.
- **Inverse-volatility weighting** — 35% annualised versus 79% equal-weight.
  The edge sits in the higher-volatility names that vol-scaling shrinks.
- **Capping extreme movers** (e.g. excluding a −81% 72h collapse) — makes it
  monotonically *worse*: t falls 2.46 → 2.04 and drawdown rises 11.9% → 17.4%.
  The extremes carry edge, and with 24 names the worst single 12h period is
  −3.4%, so no one name can do real damage.
- **Long-only** — carries crypto beta and a 34–52% drawdown for less return.

## Honest limitations

- **Twelve months, one regime.** The sample covers a period that was broadly
  favourable for crypto. The book is dollar-neutral, which removes most of the
  directional exposure, but a year is a year.
- **The download shortlist still starts from today's turnover.** The
  point-in-time screen then selects within it at each date, but a symbol that
  was liquid last year and is illiquid now would never be downloaded and so
  never appears. This biases toward survivors and cannot be fully removed
  without a historical listing snapshot Bybit does not publish.
- **Paper, not live.** Fills are modelled: maker fees for scheduled rebalances,
  taker for reductions, plus spread and size impact scaled by each symbol's
  turnover. At $10k the book's largest position is a few hundred dollars, so
  market impact is genuinely negligible — this is one of the few strategies
  that is *easier* at small size.
- **Delisting risk is not modelled.** A short in a token that gets delisted
  settles in a way this simulation does not represent. It has no effect on a
  paper account.
- **A Sharpe of 2.5 will not persist.** Backtested Sharpe is almost always
  optimistic. Treat the direction and the robustness as the finding, and the
  magnitude as an upper bound.

## Operating it

```bash
npm run replay:xsec          # acceptance test on cached Bybit history
npm run daemon:xsec          # the live paper book
npm run redis:housekeeping   # inventory stale Redis keys (dry run)
```

The book is exposed read-only at `GET /api/book` and rendered on the dashboard
in the AI view. It runs as its own compose service (`xsec-daemon`) with its own
Redis namespace (`xsec:*`), so it neither reads nor writes the swing engine's
state — the two strategies can be compared on the same screen without either
being able to corrupt the other.

Request budget on the free tier: one tickers call returns every price at once,
and momentum needs one kline call per symbol per rebalance. At a 12-hour
cadence over 50 symbols that is roughly a hundred requests a day.
