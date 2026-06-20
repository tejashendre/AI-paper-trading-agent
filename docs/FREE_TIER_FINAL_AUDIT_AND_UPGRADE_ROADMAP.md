# Free-Tier Autonomous Trading Agent: Final Audit And Upgrade Roadmap

## Executive Summary

The system is not broken, and it is not random. It is now a working free-tier autonomous paper-trading agent with live market scans, risk sizing, simulated execution, learning memory, public spectator mode, Docker deployment, and a dashboard that can explain what the bot is doing.

The current weakness is not that the bot cannot find winners. The live audit shows the bot has been able to recover meaningfully from deeper drawdown and has a positive win count. The main weakness is that losing exits are still too expensive relative to winning exits.

Current live audit snapshot:

```text
AI total value: about $9,499
AI closed P&L: about -$494
Closed AI trades: 90
Win rate: about 53.3%
Profit factor: about 0.64
Learning rules active: 24
Opportunity evaluations: 1000
Data health: 5 good, 4 degraded, 0 bad
Live scan errors: 0
```

Interpretation:

```text
The bot can win trades, but the loss side still dominates the profit side.
The next upgrades should focus on adaptive loss control, setup-level accountability, and public explainability.
```

## What Is Working Well

### 1. The System Is Actually Running

The VPS is live, Docker containers are running, and the daemon is scanning.

Current runtime structure:

```text
quant-dashboard     - Next.js dashboard and API
quant-swing-daemon  - autonomous scan and exit loop
quant-redis         - state and memory store
```

The live scan summary had:

```text
HOLD: 2
BLOCKED: 0
ENTRY: 0
SKIPPED: 7
ERROR: 0
```

That means the bot is not dead. It is choosing not to enter some markets because of open positions, closed sessions, data quality, or insufficient setup quality.

### 2. Learning Is Active

The live system reports:

```text
Learning rules: 24
Boost rules: 13
Caution rules: 11
Watched/evaluated opportunities: 1000
Favorable rate: about 67.6%
```

This is important because it means the bot is not only trading and forgetting. It is comparing watched opportunities against later market movement.

### 3. The Best Observed Setup Has Real Evidence

Current best setup:

```text
VWAP_REJECTION
Trade count: 27
Wins: 20
Losses: 7
Win rate: about 74%
Realized P&L: about +$66
Profit factor: about 1.29
```

This is one of the most important positive signals in the system. It suggests that at least some setup categories are useful.

### 4. The Dashboard Is Becoming More Honest

Recent fixes made the dashboard less misleading:

- Mobile/spectator curve now uses full sanitized closed-trade equity history.
- Spectator detailed trades remain bounded for safety.
- Dashboard fetches use no-store to avoid stale mobile cache.
- BTC candle high display was corrected to avoid misleading historical high values.
- The performance curve now distinguishes closed-trade history from live mark-to-market value.

### 5. The System Is Free-Tier Realistic

The architecture fits the free constraint:

- Free public data feeds.
- Oracle VPS.
- Redis state.
- Docker Compose.
- Paper exchange.
- No paid broker dependency.
- LLM is optional/fallback-based, not mandatory for every scan.

## Main Problems Found

### Problem 1: Stop-Loss Damage Is Too Large

Current closed-trade exit breakdown:

```text
STOP_LOSS:              about -$1,351
TAKE_PROFIT:            about +$379
TRAILING_STOP_PROFIT:   about +$495
SIGNAL_REVERSAL:        about -$17
```

This is the central issue.

The bot wins often enough to be interesting, but when it loses, the loss side overwhelms the wins.

### Problem 2: Some Assets Are Underperforming

The live dashboard already reports caution around some assets and setups. Earlier analysis showed ETH, USDJPY, and BTC were major negative contributors, while SOL/SILVER/OIL/GOLD had better moments.

This means the bot should not treat all assets equally.

The next system should use:

```text
asset-specific trust
setup-specific trust
direction-specific trust
session-specific trust
```

### Problem 3: Legacy Position State Can Become Invalid

An active GOLD short had a stop-loss below the entry/current protective side. That is invalid for a protective short stop unless it is still above the current price as a profit-locking trailing stop.

Fix added:

```text
If an active position has a protective stop on the wrong side of live price,
the exit sweep repairs it and logs the repair.
```

This prevents old bad state from creating strange exits.

### Problem 4: Data Health Is Mixed

The system currently has:

```text
5 good feeds
4 degraded feeds
0 bad feeds
3 fast-eligible assets
7 swing-eligible assets
```

This is workable for a free-tier system, but not perfect.

The bot should be more careful with degraded assets, especially for aggressive sizing.

### Problem 5: Public Demo Reliability Depends On Domain Trust

DuckDNS is acceptable for development but weak for public demos. Some school/company networks may block dynamic DNS or show TLS trust warnings.

For Kaggle or LinkedIn:

```text
Use a real domain behind Cloudflare Free.
```

## Fixes Applied In This Audit

### Fix 1: Equity Curve Diagnostic Enrichment

The equity curve feed now includes more safe fields:

```text
timestamp
asset
action
direction
exitReason
pnl
```

This allows future curve/debug tools to explain which asset or exit reason shaped the curve without exposing full trade internals.

### Fix 2: Invalid Protective Stop Repair

Added a safety normalizer to the swing exit sweep.

Behavior:

```text
SHORT stop must be above current live price.
LONG stop must be below current live price.
If not, repair it to a small protective buffer and mark the position as trailing.
```

Why this matters:

```text
It protects the bot from legacy bad state and prevents weird stop behavior.
```

## Necessary Upgrades For The Ultimate Free-Tier Version

These upgrades are ranked by real value. They are designed to improve the bot without making it a black box.

## Upgrade 1: Adaptive Loss-Control Layer

### Why It Is Necessary

The bot's main issue is not win rate. It is loss size.

The system needs to reduce damage after repeated stop-losses without completely stopping the bot from trading.

### Required Behavior

For each asset and setup:

```text
If recent stop-loss rate is high:
  reduce size
  require stronger trigger confirmation
  keep watching opportunities
  do not permanently ban the asset
```

### Suggested Rules

```text
If asset has 2 stop-losses in last 5 closed trades:
  reduce max margin by 35% for that asset

If asset has 3 stop-losses in last 7 closed trades:
  require +5 final conviction and +2 trigger score

If setup has stop-loss rate above 45% with at least 8 examples:
  mark setup as caution

If setup has stop-loss rate above 60% with at least 10 examples:
  watch-only until performance improves
```

### Why This Does Not Kill Trading

This does not say "never trade".

It says:

```text
Trade smaller when evidence says the setup is currently damaging.
Trade normally again when performance recovers.
```

## Upgrade 2: Expected Value Gate

### Why It Is Necessary

Win rate alone is not enough. A setup can win 55% of the time and still lose money if losses are larger than wins.

### Required Behavior

Before entry, estimate:

```text
expected value = winProbability * averageWin - lossProbability * averageLoss
```

If expected value is negative:

```text
hold or reduce size
```

### Data Sources

Use:

- Closed trades.
- Opportunity journal.
- Setup performance.
- Asset performance.
- Direction performance.

### Dashboard Display

Show plain language:

```text
Expected edge: positive / weak / negative
Why: VWAP_REJECTION has worked recently, but ETH shorts have poor loss history.
```

## Upgrade 3: Setup-Level Accountability

### Why It Is Necessary

The bot currently has many signals and tags, but the dashboard should make it obvious which setup caused each trade.

### Required Behavior

Each trade should store:

```text
primarySetup
secondarySetups
asset
direction
session
dataQuality
entryReason
exitReason
plannedRisk
realizedPnl
```

### Benefit

This lets the bot answer:

```text
Which setup is making money?
Which setup is losing money?
Which asset should be trusted?
Which market condition is dangerous?
```

## Upgrade 4: Current Market Regime Trust

### Why It Is Necessary

A setup that works in trend may fail in chop. A setup that works during high volume may fail in low volume.

### Required Behavior

Store performance by:

```text
asset
direction
setup
market regime
volatility level
data quality
session
```

### Example

```text
BTC short + VWAP_REJECTION + high volatility = allowed
BTC short + weak trigger + choppy regime = reduced size or hold
```

## Upgrade 5: Loss-Aware Position Sizing

### Why It Is Necessary

The bot currently allows large trades when conviction is high. That can be good, but conviction should be corrected by recent realized performance.

### Required Behavior

Use:

```text
finalSize = convictionSize * assetTrust * setupTrust * drawdownMultiplier * dataQualityMultiplier
```

### Example Multipliers

```text
assetTrust:
  strong = 1.00
  neutral = 0.75
  caution = 0.50
  penalty = 0.30

setupTrust:
  positive EV = 1.00
  uncertain = 0.70
  negative EV = 0.35

dataQuality:
  good = 1.00
  degraded = 0.50
  bad = 0.00
```

## Upgrade 6: Trade Review Agent

### Why It Is Necessary

For Kaggle and public demo, the system must be explainable.

### Required Behavior

After every closed trade, create a short review:

```text
Did the entry logic make sense?
Was the stop reasonable?
Was the exit caused by market reversal or bad entry?
Should the setup be boosted, reduced, or watched only?
```

### Important Safety Rule

This reviewer should be read-only and explanatory.

It should not directly trade.

## Upgrade 7: Public Spectator Mode Polish

### Why It Is Necessary

If this will be shown publicly, normal people need to understand it.

### Required Behavior

Public mode should show:

```text
What the bot is doing now
Why it is or is not trading
Current paper account value
Closed-trade curve
Learning summary
Data health summary
Risk safety summary
```

Hide or collapse:

```text
raw logs
too many backend details
admin-only controls
sensitive AI internals
```

## Upgrade 8: Kaggle-Agent Layer

### Why It Is Necessary

Kaggle asks for agent concepts like MCP, ADK, Antigravity, security, deployability, and agent skills.

### Build This Locally First

Let Antigravity create the Kaggle folder and supporting files locally, but do not push directly to main.

Recommended instruction:

```text
Implement Kaggle capstone support locally only.
Do not modify live trading behavior.
Do not push to GitHub.
Do not deploy to VPS.
Keep MCP/ADK tools read-only.
```

### Suggested Files

```text
kaggle/
  KAGGLE_WRITEUP_DRAFT.md
  VIDEO_SCRIPT.md
  ARCHITECTURE.md
  README_FOR_JUDGES.md
  mcp/
  agents/
```

## What Should Not Be Done

Do not:

- Make the bot more aggressive immediately.
- Add real-money trading.
- Let Antigravity rewrite the trading core in one pass.
- Push Kaggle docs/tools directly to VPS without review.
- Add complicated ML until the loss-control layer is stable.
- Claim guaranteed profit.

## Recommended Sprint Order

### Sprint 1: Stability And Truthfulness

Status:

```text
Mostly done.
```

Includes:

- Fix mobile/desktop curve mismatch.
- Fix BTC high display.
- Fix invalid trailing stop behavior.
- Keep dashboard honest.

### Sprint 2: Adaptive Loss Control

Highest priority next trading upgrade.

Build:

- Asset loss penalty.
- Setup stop-loss penalty.
- Expected value gate.
- Size reduction instead of hard blocking.

### Sprint 3: Setup Accountability Dashboard

Build:

- Best/worst setup cards.
- Asset trust score.
- Last 10 closed trades by setup.
- Plain-English "why bot reduced size" text.

### Sprint 4: Kaggle Public Layer

Build locally:

- MCP read-only tools.
- ADK-style reviewer.
- Agent CLI scripts.
- Kaggle writeup.
- Video script.

### Sprint 5: Public Domain Reliability

Use:

- Real domain.
- Cloudflare Free.
- Full strict TLS.
- Nginx subdomain routing.

## Final Assessment

The bot has reached a credible free-tier autonomous paper-trading architecture.

It is not perfect, and it is not a guaranteed profit machine. But it is now a real system with:

- Autonomous scanning.
- Multi-asset observation.
- Risk controls.
- Paper execution.
- Learning memory.
- Public dashboard.
- Docker/VPS deployment.
- Explainability layers.

The most valuable next upgrade is not "more AI" or "more aggression".

The most valuable next upgrade is:

```text
Let winners continue, but make repeated losers smaller and harder to approve.
```

That is how the system becomes more professional without becoming frozen or black-boxed.

