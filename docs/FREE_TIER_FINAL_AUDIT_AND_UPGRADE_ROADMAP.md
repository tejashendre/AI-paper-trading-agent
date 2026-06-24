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

### Fresh Live Audit: June 24, 2026

The live system was checked again after several more days of autonomous operation.

Current snapshot:

```text
AI total value: about $9,457
Closed/system total P&L: about -$522
Closed AI trades: 91
Win rate: about 48.4%
Profit factor: about 0.68
Max drawdown: about 7.55%
Open AI positions: 8
Live scan ID: 5739
Data health: 8 good, 1 degraded, 0 bad
Learning rules active: 19
Watched opportunities evaluated: 1000
Opportunity favorable rate: about 36.9%
```

Open AI positions at audit time:

```text
GBPUSD  SHORT  conviction 64  data 72  trailing true
EURUSD  SHORT  conviction 80  data 72  trailing true
GOLD    LONG   conviction 71  data 72  trailing true
ETH     SHORT  conviction 81  data 92
BTC     SHORT  conviction 81  data 92
SOL     SHORT  conviction 94  data 92  trailing true
SILVER  SHORT  conviction 75  data 72
OIL     SHORT  conviction 71  data 72
```

Interpretation:

```text
The bot is not dormant.
It is heavily allocated.
The scan is skipping most assets because positions are already open.
The current risk is not lack of scanning; it is being stuck in too many open theses while the market reverses.
```

Recent 50-trade exit contribution:

```text
STOP_LOSS:              about -$894
TAKE_PROFIT:            about +$294
TRAILING_STOP_PROFIT:   about +$230
SIGNAL_REVERSAL:        about -$25
```

This confirms the same core weakness as the earlier audit:

```text
Stop-loss damage is still larger than target and trailing-profit recovery.
```

Asset-level evidence:

```text
Strong / useful:
  SILVER: +$82, 83.3% win rate, profit factor about 14.7
  OIL:    +$72, 75.0% win rate, profit factor about 2.9
  GOLD:   +$28, 75.0% win rate, profit factor about 3.7
  SOL:    +$23, 68.0% win rate, profit factor about 1.1

Weak / damaging:
  ETH:   -$316, profit factor about 0.34
  USDJPY: -$218, 12.5% win rate
  BTC:   -$180, profit factor about 0.39
  EURUSD and GBPUSD are mildly negative.
```

Setup-level evidence:

```text
Best setup:
  VWAP REJECTION
  36 trades
  75% win rate
  about +$122 realized P&L
  profit factor about 1.42
  watched opportunity follow-through about 58.6%

Worst setup:
  VWAP RECLAIM
  52 trades
  44.2% win rate
  about -$640 realized P&L
  profit factor about 0.35
  watched opportunity follow-through about 0.2%
```

### What This Means About Learning

The bot is learning, but the learning layer is currently mostly a confidence-adjustment layer.

It is genuinely producing rules such as:

```text
REDUCE USDJPY
BOOST OIL
BOOST 4H Structural Downtrend (Hurst: 0.98)
REDUCE VWAP_RECLAIM
REDUCE VOLUME_BURST
BOOST SILVER
```

So learning is not fake.

However, it is not yet strong enough in three areas:

```text
1. It does not aggressively stop a live thesis after evidence flips.
2. It does not reverse non-crypto positions into the new market direction.
3. It can still hold many correlated positions at once, creating broad directional exposure.
```

The next fix should not be "more aggression". The correct fix is:

```text
More adaptive exits.
Faster thesis invalidation.
Smarter exposure caps.
Selective reversal only when the opposite setup is much stronger than the current thesis.
```

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

### Updated Live Requirement

The June 24 audit shows this layer must also act on open positions, not only future entries.

Required behavior:

```text
If an asset/setup is marked REDUCE while a live position is open:
  tighten the stop if the trade is not yet working
  disable scale-in for that position
  require stronger evidence before holding through a reversal

If an asset has strongly negative realized P&L:
  cap new margin lower
  cap simultaneous exposure lower
  require higher final conviction

If a setup has strongly negative realized P&L:
  prevent large entries
  allow probe-only entries until recovered
```

For the current data, examples would be:

```text
ETH, BTC, USDJPY: reduced size and stronger entry threshold.
VWAP_RECLAIM: probe-only or watch-only until evidence improves.
VWAP_REJECTION: allowed, but still subject to exit discipline.
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

### Updated Live Requirement: Portfolio Exposure Governor

The June 24 audit found 8 open AI positions at once.

That creates a different risk from single-trade risk:

```text
The bot can be individually "reasonable" on each trade,
but collectively overexposed to one broad market move.
```

Add a portfolio-level exposure governor:

```text
Max open swing positions:
  normal mode: 4
  cautious mode: 2
  recovery mode after drawdown: 1-2

Max same-direction thesis:
  no more than 3 concurrent shorts
  no more than 3 concurrent longs

Max weak-data positions:
  no more than 2 positions with dataQuality below 80

Max negative-edge assets:
  no more than 1 open position from assets currently marked REDUCE
```

Why:

```text
This prevents the bot from being trapped in eight open positions while the market changes direction.
```

### Implementation Checkpoint - 24 June 2026

Status: **implemented locally as Sprint 1 portfolio guard.**

Files:

```text
src/lib/trading/portfolioGuards.ts
src/daemon/swingDaemon.ts
```

What was added:

```text
Portfolio exposure mode:
  NORMAL
  DRAWDOWN
  RECOVERY

New-entry guard:
  blocks too many active swing positions
  blocks too many same-direction positions unless conviction is exceptional
  blocks additional degraded-data entries when weak-data exposure is already high
  blocks weak local-learning assets/setups unless conviction is strong enough
```

This is intentionally not a full multi-position asset-book engine yet.
It is the safe first layer that stops portfolio crowding while preserving the current stable data model.

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

## Upgrade 6A: Live Thesis Invalidation And Selective Reversal

### Why It Is Necessary

The live audit confirms the user-facing pain point:

```text
The bot can enter a thesis, then the market reverses,
and the bot may wait too long for stop loss instead of admitting the thesis is wrong.
```

The code already has a signal-reversal path, but it is limited:

```text
It is checked during entry-scan preflight.
The strong opposite-signal gate is currently crypto-fast focused.
Forex and commodities mostly rely on stop/target/trailing/profit giveback.
```

### Required Behavior

Add a live thesis invalidation layer before stop loss is hit:

```text
For every open position, every exit sweep:
  rebuild a lightweight live signal
  compare it against the original direction
  compare it against the original setup tags
  detect whether the market structure has flipped
```

Possible states:

```text
THESIS_VALID:
  Hold normally.

THESIS_WEAKENING:
  Tighten stop.
  Disable scale-in.
  Consider partial exit if green.

THESIS_INVALID:
  Close position even before hard stop.

OPPOSITE_EDGE_CONFIRMED:
  Close current position.
  Optionally allow a new opposite probe only if the opposite setup is much stronger.
```

### Reversal Must Be Selective

Do not blindly flip every stopped trade.

Reversal should require:

```text
opposite final conviction >= current conviction + 10
opposite data quality >= 80 for crypto, >= 75 for swing assets
opposite trigger score >= 18
market structure score clearly supports opposite direction
current position is not already deeply red beyond planned risk
asset is not in REDUCE mode unless opposite edge is exceptional
```

For non-crypto assets:

```text
Use reversal for exits first.
Use opposite entries more cautiously because forex/commodity data is slower.
```

### Dashboard Display

Add a plain-language line on every open position:

```text
Thesis status:
  Valid / Weakening / Invalid / Opposite setup forming

Why:
  "Market has moved against the short thesis and 5m structure is now bullish."
```

This reduces black-box feeling because the user can see whether the bot is stubbornly holding or rationally waiting.

### Implementation Checkpoint - 24 June 2026

Status: **implemented locally as Sprint 2 live thesis review.**

Files:

```text
src/lib/types.ts
src/lib/execution/swingLifecycle.ts
src/daemon/swingDaemon.ts
src/components/Dashboard.tsx
scripts/agent-status.ts
kaggle/scripts/agent-status.ts
```

What was added:

```text
Open positions now carry:
  thesisStatus
  thesisReason
  lastThesisCheckTime
  scaleInBlockedReason

Exit preflight now:
  rebuilds a live swing signal for open positions
  marks positions VALID, WEAKENING, or OPPOSITE_EDGE_CONFIRMED
  disables scale-in when the thesis is weakening
  tightens the stop when a non-confirmed opposite move appears
  closes only when the opposite edge is clearly stronger than the original thesis

Dashboard/status now:
  shows trade health for active positions
  explains whether scale-in is paused
  keeps the public view understandable without exposing backend internals
```

Important:

```text
This is not an always-flip reversal bot.
It first improves loss control and explanation.
Full tactical hedging / multi-position-per-asset belongs to Upgrade 6B.
```

## Upgrade 6B: Asset Book Manager And Interactive Position Layering

### Why It Is Necessary

The June 24 live audit showed that the bot can become frozen by this rule:

```text
Asset already has an open position, so skip new entries.
```

That rule prevents duplicate overtrading, but it also blocks useful actions when the market changes.

The better model is:

```text
Each asset should be managed as an asset book, not as a single isolated trade.
```

An asset book can contain:

```text
core swing position
tactical hedge/probe position
partial exits
scale-in history
thesis invalidation status
realized and unrealized P&L for the whole asset
learning outcome for the whole episode
```

This matters because the current biggest live weakness is:

```text
The bot may hold one stale thesis until stop loss,
even when market structure starts moving the other way.
```

### Core Concept

Instead of:

```text
BTC is already open -> skip BTC.
```

Use:

```text
BTC has an asset book.
Check whether the new setup is:
  duplicate noise,
  same-direction continuation,
  hedge/protection,
  thesis invalidation,
  confirmed reversal.
```

### Example

```text
BTC core position:
  direction: SHORT
  timeframe: 4h / 1h
  thesis: HTF downtrend + VWAP rejection

Market starts reversing upward:
  5m/15m structure turns bullish
  short thesis weakens
  long trigger appears

The bot should not blindly wait for short stop loss.
It should decide whether to:
  tighten the short stop,
  open a very small long hedge/probe,
  partially close the short,
  fully close the short,
  flip into a new long only if opposite edge is strong.
```

### Position Types Inside One Asset Book

#### 1. Core Swing Position

Purpose:

```text
Main higher-timeframe thesis.
```

Rules:

```text
Uses normal swing sizing.
Can last hours to days.
Must have clear stop, take profit, and thesis tags.
Can be reduced if thesis weakens.
```

#### 2. Tactical Probe

Purpose:

```text
Small test trade when a short-term setup appears but confirmation is not complete.
```

Rules:

```text
Must be smaller than core position.
Must have fast invalidation.
Cannot be used to average down a loser.
Can graduate into core only after strong follow-through.
```

#### 3. Hedge Probe

Purpose:

```text
Protect the asset book when the market starts moving against the core thesis.
```

Rules:

```text
Must be much smaller than the core position.
Must be opposite direction.
Must be opened only when thesis status is WEAKENING or INVALID.
Must force the bot to review the core trade.
Cannot remain open indefinitely.
```

#### 4. Reversal Position

Purpose:

```text
Transition from a failed thesis into the newly confirmed direction.
```

Rules:

```text
Requires confirmed opposite edge.
Requires closing or heavily reducing the old core position.
Should begin as a probe unless the opposite setup is exceptional.
Must record the full episode for learning.
```

### Guardrails

This upgrade must not become uncontrolled stacking.

Hard rules:

```text
Max positions per asset:
  crypto: 2
  forex/commodity: 1 normally, 2 only when dataQuality is strong

Max core positions per asset:
  1

Max hedge/probe positions per asset:
  1

No averaging down:
  Do not add same-direction size to a losing core trade.

No duplicate thesis:
  Do not open a second trade if it has the same direction, timeframe, and setup tags as the current core.

No hidden exposure:
  Dashboard must show net asset exposure.
```

Portfolio-level guardrails:

```text
Max total open AI positions:
  normal mode: 6
  drawdown mode: 3
  recovery mode: 2

Max same-direction market exposure:
  no more than 3 net-short asset books
  no more than 3 net-long asset books

Max weak-data layered books:
  0 if dataQuality < 70
  1 if dataQuality is 70-79
```

### Interactive Rules

If the core trade is green:

```text
protect profit with trailing stop
allow scale-in only if same-direction evidence improves
do not hedge unless opposite thesis becomes strong
```

If the core trade is slightly red and opposite signal appears:

```text
open tiny hedge/probe only if the opposite setup is meaningfully different
tighten the core stop
disable same-direction scale-in
watch for confirmation
```

If the hedge starts working:

```text
reduce or close the core position
move asset book toward neutral
optionally convert the hedge into a new core only after confirmation
```

If the hedge fails quickly:

```text
close the hedge
keep the core only if thesis is still valid
record the hedge as failed protection attempt
```

If both sides are confused:

```text
flatten the asset book
wait for a cleaner setup
mark the episode as chop/no-edge
```

### Episode-Based Learning

Learning should not judge each trade in isolation.

For layered books, judge the full asset episode:

```text
Did the hedge reduce loss?
Did the reversal save capital?
Did the tactical probe improve total outcome?
Did the bot exit earlier than stop loss?
Did the bot overcomplicate a trade that should have been closed?
```

Store episode metrics:

```text
asset
episodeId
coreDirection
hedgeDirection
startTime
endTime
netRealizedPnl
maxDrawdownDuringEpisode
maxProfitDuringEpisode
hedgeHelped: true/false
reversalHelped: true/false
finalOutcome: WIN / SMALL_LOSS / LARGE_LOSS / CHOP_EXIT
lessons
```

This teaches the bot:

```text
when hedging helps
when reversing helps
when holding helps
when flattening is better
```

### Dashboard Display

Each asset book should show:

```text
Asset: BTC
Net exposure: SHORT / LONG / NEUTRAL
Core thesis: SHORT, valid / weakening / invalid
Hedge: none / active / failed / helped
Open risk: $...
Locked profit: $...
Episode status: trending / reversing / choppy / no edge
Next planned action: hold / tighten / reduce / hedge / flatten / reverse
```

Plain-English examples:

```text
BTC: Core short is weakening. The bot tightened the stop and is watching for a confirmed long reversal.

OIL: Core short is working. The bot is protecting profit and will not add unless downside momentum continues.

USDJPY: No new position. Asset is in reduce mode because recent trades have performed poorly.
```

### Implementation Notes

This should be built after thesis invalidation, not before.

Required building blocks:

```text
1. thesisStatus per open position
2. assetBook summary per asset
3. same-asset multi-position data model
4. hedge/probe admission gate
5. net exposure calculator
6. episode ledger
7. dashboard asset-book panel
```

Do not build this as a blind "multiple positions per asset" feature.

Build it as:

```text
controlled asset-book management.
```

That is what makes it professional rather than reckless.

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

### Antigravity Kaggle Folder Audit

Status:

```text
Useful and directionally correct, but not ready to merge blindly.
```

Antigravity created a strong Kaggle presentation layer:

```text
kaggle/
  README.md
  KAGGLE_README_UPGRADE.md
  KAGGLE_WRITEUP_DRAFT.md
  KAGGLE_VIDEO_SCRIPT.md
  DOMAIN_SETUP.md
  SECURITY_CHECKLIST.md
  SUBMISSION_ASSETS.md
  mcp/trading_mcp_server.ts
  agents/trading_reviewer_agent.py
  scripts/agent-status.ts
  scripts/explain-latest-scan.ts
```

It also copied some files into root-level folders:

```text
agents/
mcp/
scripts/agent-status.ts
scripts/explain-latest-scan.ts
```

The concept is valuable because it turns the project from only a trading dashboard into a demonstrable agent system:

- The MCP server exposes read-only tools for portfolio status, latest scan, data health, learning summary, and public demo summary.
- The reviewer agent is read-only and checks current system state, portfolio drawdown, scan freshness, feed health, and risk warnings.
- The CLI scripts demonstrate agent skills for terminal-based inspection.
- The writeup, video script, domain guide, and security checklist directly map the project to Kaggle's required concepts.

This layer should be kept as a public-demo and judging layer. It should not be allowed to rewrite the production trading brain.

### Problems Found In The Kaggle Layer

#### 1. Encoding Damage In Markdown And Source Comments

Many files contain mojibake characters such as:

```text
garbled em dashes
garbled emoji byte sequences
garbled check marks
garbled warning symbols
```

This does not usually break execution, but it looks unprofessional in a Kaggle submission and can make terminal output ugly.

Required fix before public submission:

```text
Normalize all Kaggle docs and copied source comments to UTF-8.
Use either clean Unicode or plain ASCII consistently.
```

#### 2. Root README Replacement Loses Important Engineering Detail

The modified `README.md` is better for Kaggle storytelling, but it removes useful engineering sections from the previous README:

- exact runtime files,
- VPS maintenance commands,
- Docker cache cleanup guidance,
- live deploy verifier details,
- deterministic replay validation,
- current strategy philosophy,
- environment variable explanation.

Recommended solution:

```text
Do not replace the main README with only the Kaggle narrative.
Merge them:
  top = polished Kaggle/public explanation
  middle = architecture and agent concepts
  bottom = operational README for developers and VPS maintenance
```

#### 3. Package Script Compatibility Risk

Original Antigravity issue:

```text
audit:strategy
```

with:

```text
agent:audit
```

This is risky because existing validation, docs, deployment habits, and previous checks still call:

```text
npm run audit:strategy
```

Required fix before merging:

```json
{
  "audit:strategy": "npx tsx scripts/strategy-audit.ts",
  "agent:audit": "npx tsx scripts/strategy-audit.ts"
}
```

Keep both names. `audit:strategy` is the engineering command. `agent:audit` is the Kaggle-facing command.

Status:

```text
Fixed locally. Both commands now exist.
```

#### 4. Agent CLI Shape Mismatch With Live API

Original live test result:

```text
npm run agent:status
Fatal error: (status.aiPortfolio || []).filter is not a function
```

Cause:

```text
The script assumes aiPortfolio is an array.
The live API currently returns aiPortfolio in an object shape for some responses.
```

Live test result:

```text
npm run agent:explain
Portfolio is currently managing undefined open positions.
Some SKIPPED rows show undefined simpleStatus.
```

Cause:

```text
The script assumes fields that are not guaranteed on every scan result.
```

Required fix before claiming these CLI skills work:

```text
Normalize aiPortfolio in the scripts:
  if array, count quantity > 0
  if object with positions/scalpPositions/swingPositions, count those safely
  if missing, print "unknown" rather than crashing

Normalize scan text:
  use simpleStatus || simpleReason || nextStep || entryGate.primaryBlocker || "No public reason supplied"
```

Status:

```text
Fixed locally.
agent:status now handles array and object portfolio shapes.
agent:explain now falls back through multiple explanation fields.
Both root scripts and kaggle/scripts copies were updated.
```

#### 5. MCP Server Is Read-Only But Needs API Shape Hardening

The MCP server is directionally safe because it only reads from `/api/user/status` and exposes no mutation tools.

Original issue:

```text
(status.aiPortfolio || []).filter(...)
```

Before it is used in a video or submitted as proof, it should defensively normalize API response shapes.

Required behavior:

```text
MCP tools should never crash because a dashboard field changed shape.
They should return a clear diagnostic:
  "portfolio_shape": "object"
  "open_positions": "unknown"
  "warning": "API shape changed; update parser"
```

Status:

```text
Fixed locally.
Root mcp/ and kaggle/mcp copies now normalize portfolio positions from either array or object shapes.
```

#### 6. Security Checklist Correctly Identifies Risks But Needs Verification

The checklist is good, but it includes severe example findings about SSH keys and environment files.

Current tracked-file scan found:

```text
No tracked private key or real .env file in the current git tree.
.env.local.example is tracked, which is expected.
```

Before public submission, still run:

```bash
git ls-files | grep -iE '\.(env|key|pem)$|ssh-key|id_rsa|id_ed25519'
git log --all --diff-filter=A -- '.env' '.env.local' '.env.production'
git log --all --diff-filter=A -- 'ssh-key-*' '*.key' '*.pem' 'id_rsa' 'id_ed25519'
```

If secrets ever existed in git history, rotate them. Deleting them from the current tree is not enough.

#### 7. DuckDNS Is Weak For Public Judging

The domain guide is correct. DuckDNS can work for development, but some school/company networks block dynamic DNS or treat it as suspicious.

For Kaggle and LinkedIn, the best path is:

```text
Buy a real low-cost domain.
Use Cloudflare Free.
Point A record to the Oracle VPS.
Proxy through Cloudflare.
Use Full Strict TLS with a Cloudflare origin certificate.
Keep DuckDNS as backup only.
```

This is not required for the bot to trade, but it improves public accessibility and trust.

Best personal-domain recommendation:

```text
Primary choice: tejashendre.com
Why: globally understood, professional, best for LinkedIn/GitHub/Kaggle.

Second choice: tejashendre.dev
Why: clean developer branding and HTTPS-first perception.

Avoid for the main public demo:
  very cheap unknown TLDs,
  dynamic DNS domains,
  long novelty names,
  domains that look like temporary infrastructure.
```

Registrar guidance:

```text
Cloudflare Registrar:
  good for renewals because it is at-cost/no-markup and includes DNS/security features.

Porkbun:
  often good for cheap first purchase and simple management.

Recommended setup:
  buy/register domain,
  manage DNS on Cloudflare Free,
  proxy A record to Oracle VPS,
  use Full Strict TLS,
  keep DuckDNS as backup.
```

### Safe Merge Plan For The Kaggle Layer

Merge order:

```text
1. Keep kaggle/ as the source-of-truth submission folder.
2. Fix encoding in kaggle docs and copied root files.
3. Restore package script compatibility by keeping audit:strategy.
4. Fix agent:status, agent:explain, and MCP parser shape handling.
5. Run:
   npm run lint
   npx tsc --noEmit
   npm run build
   npm run audit:strategy
   npm run agent:status
   npm run agent:explain
6. Only then merge README changes.
7. Do not deploy Kaggle-only scripts to VPS unless they are needed there.
```

Recommended repository structure:

```text
kaggle/             public submission package and judge-facing docs
agents/             optional read-only reviewer agent, if validated
mcp/                optional read-only MCP server, if validated
scripts/            production-safe operational scripts only
docs/               architecture, roadmap, writeup drafts
```

### Final Kaggle Layer Assessment

The Antigravity work helps the project substantially as a showcase.

It gives the system:

- a Kaggle story,
- a writeup draft,
- a video plan,
- a read-only MCP concept,
- an ADK-style reviewer,
- CLI agent skills,
- a security checklist,
- a domain reliability path.

But it should be treated as:

```text
presentation and inspection infrastructure,
not trading alpha,
not a new trading brain,
not a reason to change production behavior.
```

The bot's trading quality still depends on the existing deterministic strategy, risk governor, feed health layer, learning memory, and exit watchdog. The Kaggle layer makes that system easier to inspect and explain.

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
