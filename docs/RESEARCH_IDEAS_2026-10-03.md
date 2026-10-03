# Missing capabilities worth adding, 2026-10-03

Scope: ideas the bot does not have today (checked against the code on
`claude/autonomy-hardening`), that use free public data, need no LLM and
raise no risk ceiling. Every new strategy idea enters as a SHADOW family and
earns live paper trading only through the existing promotion gates (forward
evidence, cost stress, deflated Sharpe, automatic demotion). Nothing here is
a profit promise or financial advice.

## Evidence gathered for this note

- **Bybit public data (official docs, checked 2026-10-03):**
  [allLiquidation](https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation)
  streams every liquidation (side, size, price, every 500 ms) but has no
  history, so it must be recorded going forward.
  [Long/short account ratio](https://bybit-exchange.github.io/docs/v5/market/long-short-ratio)
  (`/v5/market/account-ratio`, 5 min to 1 day) has history from July 2020.
  Live check: ratio and open-interest history exist for BTC (ratio since
  2025-05 in one page), gold and oil (since their March listings) and FX (since
  2026-09-09). Gold showed 78% of accounts long.
- **Real-data trend check** (Bybit daily candles, preregistered grid, taker
  cost included, funding not included; script kept outside the repo):

  | Asset | Buy and hold Sharpe / max drawdown | Vol-targeted trend, lookbacks 20 / 60 / 120 days: Sharpe | Trend max drawdown |
  |---|---|---|---|
  | BTC (2020-) | 0.90 / 77% | 0.86 / 0.78 / 0.75 | 25-31% |
  | ETH (2021-) | 0.43 / 79% | -0.13 / 0.59 / 0.59 | 28-58% |
  | SOL (2021-) | 0.55 / 93% | 0.60 / 0.02 / 0.95 | 29-51% |

  Robust: volatility scaling cut the worst drawdown by about two thirds
  everywhere. Not robust: which lookback wins changes by asset, so blend
  lookbacks instead of choosing the best one in hindsight.
- **Literature** (well established; the least familiar one verified online):
  Moskowitz, Ooi and Pedersen, *Time series momentum*, JFE 2012;
  Barroso and Santa-Clara, *Momentum has its moments*, JFE 2015;
  Daniel and Moskowitz, *Momentum crashes*, JFE 2016;
  Moreira and Muir, *Volatility-managed portfolios*, JF 2017;
  Schmeling, Schrimpf and Todorov, [*Crypto carry*](https://www.bis.org/publ/work1087.htm),
  BIS WP 1087, 2023 (crypto carry above 10% a year on average, and predictive of crashes);
  Lopez de Prado, *Advances in Financial Machine Learning*, 2018 (meta-labeling).

## Tier 1: highest value, strongest evidence, low cost

### 1. Alerts when the bot stops doing its job
- **Missing because:** the XSEC rebalance silently stopped for about two days
  and nobody was told; the only alerts in the code are browser pop-ups.
- **Build:** a scheduled GitHub Actions workflow (every 15-30 min) that reads
  the public spectator endpoints and fails when: swing scan older than 5 min,
  `/api/book` `rebalanceSchedule.overdue`, any of nine feeds stale over 10 min,
  ledger invalid, opportunity `rejectedNew > 0`, or a ledger transition event
  appears. A failed workflow emails the owner by default: no new service, no
  new secret.
- **Value:** turns silent failures into same-hour notice. Pure operations.

### 2. Volatility-scaled sizing, used only to shrink risk
- **Missing because:** sizes come from stop distance and conviction; nothing
  scales the swing sleeve or the XSEC book by realized volatility.
- **Evidence:** Moreira and Muir 2017; Barroso and Santa-Clara 2015 and Daniel
  and Moskowitz 2016 show volatility scaling largely removes momentum crashes,
  which is exactly the XSEC failure (28% drawdown). The check above cut
  drawdowns by about two thirds.
- **Build:** multiply existing size by `min(1, targetVol / realizedVol)`
  (30-day realized, per asset and for the whole XSEC book). Capped at 1, so it
  can only reduce risk and needs no ceiling change.
- **Gate:** run the scaled XSEC book as a second shadow book next to the
  current one; promote if its forward evidence beats the unscaled shadow.

### 3. A slow trend-following family across all nine assets
- **Missing because:** the swing engine is a fast, multi-gate entry system;
  there is no simple daily trend sleeve, the best-documented strategy for a
  crypto, FX, gold, silver and oil mix.
- **Evidence:** Moskowitz, Ooi and Pedersen 2012 across futures; the check
  above shows the drawdown benefit on crypto with mixed returns.
- **Build:** a `TREND_DAILY` candidate family: sign of 20/60/120-day returns
  averaged (blend, not a picked lookback), volatility-targeted, daily
  rebalance, taker costs plus actual funding. Register as SHADOW; it earns
  probes only through the gates.

### 4. Benchmarks next to every result
- **Missing because:** nothing on the dashboard says whether the bot beats
  doing something simple.
- **Build:** show, for the same period and capital, buy-and-hold of the nine
  assets and the item 3 trend baseline, net of the same costs. If the complex
  engine cannot beat a simple baseline after costs, that is the most useful
  fact the dashboard can show.

## Tier 2: valuable, needs recording or careful modeling first

### 5. Crowding and crash-risk filter (funding, long/short ratio, open interest)
- **Idea:** use positioning to reduce or skip trades on the crowded side, not
  to "follow" anyone. High funding means crowded longs and crash risk (BIS WP
  1087); extreme account ratios (gold at 78% long) are the classic contrarian
  warning.
- **Data:** funding and open-interest history (already partly used), account
  ratio from 2020; all free.
- **Build:** a filter feature that lowers size or blocks entries on the side
  where funding and the ratio are both in their top decile; test it as a
  SHADOW variant against the unfiltered family.

### 6. Liquidation-cascade recording
- **Idea:** large liquidation clusters often mark exhaustion or acceleration;
  evidence is mostly anecdotal, so record first.
- **Build:** subscribe to `allLiquidation` for the nine symbols in the existing
  stream daemon; store per-minute aggregates (count, notional, side) in the
  research archive (well under the 256 MB cap). After 30 or more days, test it
  as a feature through the gates.

### 7. Cheaper execution with post-only entries
- **Missing because:** every fill is modeled as a taker. Modeled costs
  ($87.95) already exceed the swing sleeve's net profit ($65.91). TradFi maker
  fee is 0%, crypto maker 0.02% versus taker 0.055%.
- **Risk:** paper maker fills are easy to fake. Use a conservative rule: a
  resting order fills only if price trades through it by at least one tick
  within N minutes, else it is cancelled and the setup is skipped (record the
  missed trades too).
- **Gate:** compare maker-mode shadow results, including missed trades, with
  taker mode before switching.

### 8. Historical backfill for research
- **Missing because:** the research archive starts on 2026-10-01, so the
  replay route has almost no history and learning waits for forward data.
- **Build:** a bounded one-off backfill of closed 1h and 1d candles plus
  funding and account-ratio history for the nine contracts since listing,
  stored compactly within the archive cap. Speeds up the replay route; forward
  shadow evidence is still required for promotion.

## Tier 3: later, once there is enough data

- **Meta-labeling** (Lopez de Prado 2018): learn which signals to trust and
  size by that probability. Needs hundreds of independent outcomes; there are
  36. Revisit later.
- **Weekend rule for TradFi perpetuals:** the contracts trade 24/7 but the
  underlying markets close; test "flat or smaller on weekends" as a SHADOW
  variant using recorded weekend gaps.

## Not recommended

- Following named firms (Jane Street and similar): their orders are not
  visible in public data, and market makers mostly do not take direction.
- LLM news or sentiment: cost, latency and no evidence here; the never-used
  LLM code was removed on 2026-10-02.
- Higher leverage, looser breakers or faster trading to "make more": the
  evidence so far does not show an edge to scale.

## Suggested order

1 (alerts) and 4 (benchmarks) first: cheap and they make every later decision
better informed. Then 2 (volatility scaling, as a shadow book), 3 (daily trend
family) and 6 (start recording liquidations now, since history cannot be
recovered later). 5, 7 and 8 next; Tier 3 when data allows.

## Addendum: strategy families checked on real Bybit data (2026-10-03)

Existing families: swing trend pullback (live), range reversion (shadow),
crypto cross-sectional 72h momentum (halted). Checks below are descriptive,
preregistered and include taker costs; scripts are kept outside the repo.

| Candidate | Finding | Verdict |
|---|---|---|
| FX carry via Bybit FX perpetuals | Funding over 25 days: EURUSD -1.5%/yr, GBPUSD 0.0%, USDJPY -0.4%. Funding does not carry the interest-rate differential. | Not implementable here. |
| Commodity funding asymmetry | Oil (CLUSDT) longs received about 33%/yr (shorts paid on 98% of settlements); gold longs paid about 16%/yr, silver about 12%/yr. | Use as a holding-cost tilt for multi-day positions in every family, not a standalone strategy. |
| Crypto cross-sectional funding carry (weekly, long 6 lowest / short 6 highest funding of 40 liquid perps, 29 weeks) | Funding leg +0.22%/week, positive every week; price leg -0.61%/week; total -13.5%, max drawdown 25%, t = -0.44. High-funding coins kept trending up. Survivorship bias: today's universe. | Do not build standalone. Possible shadow variant: carry only when 72h momentum agrees. |
| Daily cross-asset trend (see table above) | Drawdown cut by about two thirds; returns depend on lookback. | Build as a blended-lookback SHADOW family (Tier 1, item 3). |

Still untested candidates, in order of evidence and data availability:
crowding/contrarian filter from the account long/short ratio (history from
2020, backtestable now); BTC/ETH ratio mean reversion (history from 2021;
gold/silver only since March 2026); session-open breakouts on TradFi perps
around the London, COMEX and NYMEX opens (15m history since March 2026);
liquidation-cascade reactions (record first). Not available or not
recommended: FX carry, naive crypto carry, market making or high-frequency
strategies (paper fills and free data cannot model queue position or latency).
