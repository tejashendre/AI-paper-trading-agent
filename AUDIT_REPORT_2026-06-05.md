# Autonomous Quant Trading Agent - Full Audit Report

Audit date: 2026-06-05  
Auditor: Codex  
Scope: local repository, GitHub origin state, live website/API, and active Oracle VPS runtime.  
Mode: read-only application audit. No application code was changed.

## 1. Executive Verdict

The system is now much cleaner and more deployable than the older multi-worker build. The current live/local architecture is basically:

- Next.js dashboard and API routes.
- One autonomous swing daemon.
- Redis for live state and logs.
- Local JSON backups mounted into Docker.
- Free market data from Kraken, Yahoo Finance, CoinGecko, Binance/Bybit WebSockets.
- Optional Supabase and optional LLM providers.

That is a good direction for a free 24/7 VPS deployment because it reduces moving parts. However, the system is not yet "ultra-bug-free" or safe to judge as a profitable autonomous trading engine.

The biggest issue found is not a blocked API. It is trade sizing/accounting. The live bot opened one USDJPY position that the logs described as "Risking $150", but it locked $8,781.49 of margin and paid $21.95 in entry fees. In business terms: the bot says it is risking 1.5% of the portfolio, but in actual capital usage it placed nearly the whole account into one position. That is the main reason the bot can appear to lose or swing wildly even when the signal logic looks controlled.

Overall rating today:

- Build/deployment structure: 7/10
- Local code health: 7.5/10
- Live server hygiene: 5.5/10
- Trading risk logic: 4/10 until sizing is fixed
- Free-mode viability: 7/10 after risk fixes
- Production real-money readiness: 2/10, intentionally not ready

Best short summary: the system runs, the live site responds, local lint and TypeScript pass, the VPS containers are healthy, but the current autonomous trading layer has a critical margin sizing bug and several stale architecture paths that must be cleaned before long-running evaluation.

## 2. Evidence Collected

### 2.1 Local Repository State

Workspace:

`C:\Users\tejas\Downloads\Building an Autonomous Paper Trading Agent with Next`

Local commit:

`eda532a 2026-06-05 14:16:45 +0200 v7: add volume mounts for json backups`

GitHub origin/main:

`eda532a1dd4a6c817a25ef91e428c9ed3e38d793 refs/heads/main`

Meaning: local HEAD and GitHub origin/main match.

Local working tree:

`v7-clean.tar.gz` is modified.

This means GitHub source is synced, but a generated release archive in the working tree has uncommitted binary changes.

Tracked artifact/secrets check:

- `.env` is ignored.
- `.env*.local` is ignored.
- `ssh-key-*.key*` is ignored.
- `v7-clean.tar.gz` is tracked.
- `.env.local.example` is tracked.

Main local checks:

- `npm run lint`: passed.
- `npx tsc --noEmit`: passed.
- Earlier build check: passed.

### 2.2 Live Website/API State

Live domain:

`https://ai-quant-trader.duckdns.org/`

Live API is responding.

Live `/api/prices` returned valid prices for BTC, ETH, SOL, EURUSD, GBPUSD, USDJPY, GOLD, OIL, and SILVER.

Live `/api/user/status` returned:

- AI free cash: `$1,196.56`
- AI total value: `$9,978.05`
- AI paid fees: `$21.95`
- AI closed trades: `0`
- AI trade records: `1`
- Open swing positions: `1`
- Open asset: `USDJPY`

Live `/api/signals?asset=USDJPY` returned:

- Action: `HOLD`
- Score shown to dashboard: `66`
- Reason: `Waiting for robust HTF statistical confluence (Score < 14)`

This is confusing to a human reader: a dashboard score of 66 looks buy-friendly, but the actual engine action is HOLD because the raw swing score is below 14. This needs UI/label cleanup.

### 2.3 VPS State

VPS:

- Public IP: `138.2.186.85`
- User: `ubuntu`
- Active project folder found: `/home/ubuntu/version-6`
- Old expected folder `/home/ubuntu/bitcoin-quant-trader` does not exist.

Important: `/home/ubuntu/version-6` is not a Git repository.

This means VPS deployment is currently an extracted/copied release folder, not a clean `git pull` deployment. That is workable, but it makes it easier for clutter, old files, and manual mistakes to accumulate.

Active Docker containers:

- `quant-dashboard`: running.
- `quant-swing-daemon`: running.
- `quant-redis`: running.

There is no active Python ML worker, no Rust engine, and no scalp daemon in the current live Docker stack.

VPS disk:

- Root disk usage: `37G / 49G`, 76% used.
- Docker images: `31.43GB`.
- Docker build cache: `31.94GB`.
- Reclaimable build cache: `30.71GB`.

This is a major cleanup need. The server is not full today, but it is carrying a lot of Docker build cache.

Sensitive/clutter files found inside `/home/ubuntu/version-6`:

- `.env`
- `.env.local`
- `.env.local.example`
- `v6-clean.zip`
- `v6-clean.tar.gz`
- `ssh-key-2026-05-31.key`
- `data/ai_portfolio_backup.json`
- `data/ai_trades_backup.json`

Critical security note: a private SSH key exists inside the active project folder on the VPS. It should not live inside an application directory.

### 2.4 Runtime Fingerprint

Key live VPS files match local files by SHA256 for:

- `package.json`
- `src/daemon/swingDaemon.ts`
- `src/lib/riskManager.ts`
- `src/lib/swingEngine.ts`
- `Dockerfile`
- `docker-compose.yml`

Meaning: the main runtime bug is not because the VPS has a different version of these files. The bug exists in the current code itself.

## 3. Current Architecture Observed

### 3.1 Actual Running Architecture

The actual current deployment is:

```text
Browser dashboard
  -> Next.js API routes
  -> Redis
  -> Portfolio/trade/log state

Swing daemon
  -> WebsocketDataMesh for crypto live prices only
  -> MarketService for Kraken/Yahoo/CoinGecko fallback
  -> SwingEngine signal
  -> Direct portfolio mutation
  -> Redis and JSON backup
```

### 3.2 Claimed/Leftover Architecture Not Fully Running

The codebase still contains references or wording around:

- HFT scalp engine.
- Python ML worker.
- Rust execution/listener engine.
- Hyperbolic optimization.
- AI brain and LLM decision loop.
- Prediction ledger.
- Supabase decision persistence.

But the current Docker stack only runs:

- Dashboard.
- Swing daemon.
- Redis.

This is not automatically bad. It may be the correct simplification. But the dashboard, README, and route labels should not imply active HFT/ML/scalp behavior unless those components are actually running.

## 4. Critical Findings

## Finding 1 - Critical: USDJPY Position Sizing Locks Almost The Whole Account

Severity: Critical  
Area: trading logic, risk, capital preservation  
Files:

- `src/daemon/swingDaemon.ts`
- `src/app/api/trade/route.ts`
- `src/app/api/trade/swing/route.ts`

Evidence from live Redis:

```json
{
  "usd": 1196.5556438833937,
  "openPositions": {
    "USDJPY": {
      "entryPrice": 159.167,
      "amount": 43907.45314771375,
      "usdInvested": 8781.49062954275,
      "entryFeePaid": 21.953726573856876
    }
  },
  "totalFeesPaid": 21.953726573856876
}
```

Evidence from live daemon log:

```text
[SWING ENTRY] USDJPY LONG @ $159.167 | Risking $150.00 | Margin: $8781.49 | SL: $158.62
```

Relevant code:

- `src/daemon/swingDaemon.ts:178`
- `src/daemon/swingDaemon.ts:183`
- `src/daemon/swingDaemon.ts:189`
- `src/daemon/swingDaemon.ts:196`
- `src/daemon/swingDaemon.ts:208`

What is happening:

The code calculates risk from stop distance, then converts USD-prefixed forex pairs using:

```ts
priceDistanceUsd = priceDistance / currentLivePrice;
amount = riskAmountUsd / priceDistanceUsd;
notionalPositionSizeUsd = amount;
requiredMarginUsd = notionalPositionSizeUsd / MAX_LEVERAGE;
```

For USDJPY this produces an enormous `amount`, then uses 5x leverage to allow almost all cash to become margin.

Business-language explanation:

The system is not losing because the "AI is dumb" here. It is acting like a trader who says, "I only risk $150," but then puts almost the entire $10,000 account behind one trade. The risk sentence and the actual money locked do not match.

Why this matters:

- One bad forex trade can dominate the whole account.
- Fees become large.
- Dashboard PnL looks unstable.
- The bot cannot compound intelligently because one entry consumes most deployable cash.
- Long-running paper results become unreliable.

Recommended fix:

Introduce a single shared position sizing service used by all entry paths. It must enforce:

- Max margin per trade: 5% to 15% of equity.
- Max total active margin: 25% of equity.
- Max notional per asset class.
- Forex conversion rules per pair.
- No trade if margin-to-risk ratio is absurd.
- No direct custom sizing inside daemon/API routes.

Example policy:

```text
risk_amount = equity * 0.005 to 0.015
raw_size = risk_amount / stop_distance_value
required_margin = notional / leverage
if required_margin > equity * 0.10: cap or reject
if active_margin + required_margin > equity * 0.25: reject
if fee > risk_amount * 0.20: reject
```

For the free version, the most practical immediate rule is:

```text
Never allow one autonomous trade to lock more than 10% of account equity as margin.
```

## Finding 2 - Critical: Swing Daemon Bypasses The Central RiskManager

Severity: Critical  
Area: architecture, risk governance  
Files:

- `src/lib/riskManager.ts`
- `src/daemon/swingDaemon.ts`

Evidence:

`RiskManager.calculatePosition()` exists and has useful safeguards:

- Drawdown-based risk reduction.
- Correlation/concentration scaling.
- Forex max allocation.
- Non-forex max allocation.
- Cash cap.

Relevant code:

- `src/lib/riskManager.ts:4`
- `src/lib/riskManager.ts:38`
- `src/lib/riskManager.ts:82`
- `src/lib/riskManager.ts:126`

But the live daemon does not call:

- `RiskManager.calculatePosition()`
- `RiskManager.shouldTrade()`

The daemon only calls:

- `RiskManager.checkStopLossOrTakeProfit()`

Relevant code:

- `src/daemon/swingDaemon.ts:64`
- `src/daemon/swingDaemon.ts:178`
- `src/daemon/swingDaemon.ts:196`

Business-language explanation:

You built a risk department, but the actual trading desk is walking around it. The risk code exists, but the autonomous daemon uses its own sizing formula.

Recommended fix:

All entry paths should go through one `TradeAdmissionController` or `PositionSizer`.

It should return:

- `approved: true/false`
- `reason`
- `amount`
- `notionalUsd`
- `requiredMarginUsd`
- `entryFeeUsd`
- `riskAmountUsd`
- `stopLoss`
- `takeProfit`

Then the daemon should only execute if the controller approves.

## Finding 3 - High: Manual API And Main Trade API Have Duplicated Sizing Logic

Severity: High  
Area: maintainability, inconsistent behavior  
Files:

- `src/app/api/trade/route.ts`
- `src/app/api/trade/swing/route.ts`
- `src/daemon/swingDaemon.ts`

Evidence:

Sizing constants and formulas are duplicated:

- `src/app/api/trade/route.ts:63`
- `src/app/api/trade/swing/route.ts:64`
- `src/daemon/swingDaemon.ts:18`

The route and daemon can diverge. In fact, one route has a forex conversion path and another route showed a different formula during inspection.

Business-language explanation:

There are multiple brains deciding trade size. That creates a risk that "manual run", "API run", and "daemon run" behave differently for the same market.

Recommended fix:

Delete duplicated sizing logic and make every route call the same sizing/admission module.

## Finding 4 - High: Portfolio Reset Can Happen On Container Start If Redis/Backup Is Missing

Severity: High  
Area: data persistence, live continuity  
Files:

- `src/lib/portfolio.ts`
- `src/app/api/user/reset/route.ts`

Evidence from live logs:

```text
[INFO] Portfolio [USER] reset to initial state ($10,000 USD)
[INFO] Portfolio [AI] reset to initial state ($10,000 USD)
```

Relevant code:

- `src/lib/portfolio.ts:14`
- `src/lib/portfolio.ts:20`
- `src/lib/portfolio.ts:37`
- `src/lib/portfolio.ts:69`
- `src/lib/portfolio.ts:105`
- `src/app/api/user/reset/route.ts:31`

What is happening:

If Redis has no valid portfolio and the JSON backup is missing or unreadable, the system silently resets to $10,000.

Business-language explanation:

On a paper system, a reset can make results look clean, but it destroys performance continuity. If the bot is being judged over days, automatic resets can make the numbers untrustworthy.

Recommended fix:

Startup should never reset silently. It should:

- Try Redis.
- Try mounted JSON backup.
- If both fail, enter `SAFE_MODE_NO_TRADING`.
- Require explicit admin reset.
- Write a loud alert/log saying state is missing.

## Finding 5 - High: LiveExchange Can Activate When API Keys Exist

Severity: High  
Area: safety, future real-money risk  
Files:

- `src/lib/execution/paperExchange.ts`
- `src/lib/execution/liveExchange.ts`
- `src/lib/env.ts`

Evidence:

- `src/lib/execution/paperExchange.ts:33`
- `src/lib/execution/paperExchange.ts:35`
- `src/lib/execution/liveExchange.ts:24`
- `src/lib/execution/liveExchange.ts:35`

The exchange switches to live execution if Binance or Bybit keys exist. Sandbox mode is commented out.

Business-language explanation:

Adding exchange keys later could change behavior from pure paper to exchange routing unless there is a separate hard safety flag. That is dangerous because configuration mistakes happen.

Recommended fix:

Require all of these before any live exchange action:

```text
LIVE_TRADING_ENABLED=true
EXCHANGE_MODE=testnet or live
CONFIRM_LIVE_TRADING=I_UNDERSTAND_THIS_CAN_PLACE_REAL_ORDERS
```

For now, since this is free-only paper trading, default must be:

```text
LIVE_TRADING_ENABLED=false
```

Even with keys present, paper mode should remain paper unless explicitly unlocked.

## Finding 6 - High: VPS Contains Private SSH Key In Active Project Folder

Severity: High  
Area: VPS security  
Location: `/home/ubuntu/version-6/ssh-key-2026-05-31.key`

Business-language explanation:

An app folder should not contain server access keys. If the app folder is archived, copied, exposed, or accidentally pushed, server access can leak.

Recommended fix:

Move private keys out of the project folder. Keep them in a secure home-level `.ssh` location or local machine only. The deployed app does not need a private SSH key inside its runtime folder.

Do not put any private keys into Docker build context.

## Finding 7 - High: Docker Build Cache Is Consuming Too Much VPS Disk

Severity: High  
Area: VPS operations  
Evidence:

```text
Docker build cache: 31.94GB
Reclaimable build cache: 30.71GB
Root disk: 37G used / 49G total, 76%
```

Business-language explanation:

The bot is running, but the server is carrying unnecessary Docker build leftovers. If logs, cache, or images grow, the VPS can eventually run out of disk and containers can fail.

Recommended fix:

After backing up live data, prune Docker builder cache periodically.

Recommended operational rule:

- Before deploy: backup `/home/ubuntu/version-6/data`.
- Deploy.
- Confirm containers healthy.
- Prune unused build cache.
- Keep the Redis volume and data folder.

Do not blindly delete volumes unless you intentionally want to erase trading state.

## Finding 8 - Medium/High: VPS Deployment Is Not A Git Checkout

Severity: Medium/High  
Area: deployment reliability  
Evidence:

`/home/ubuntu/version-6` is not a Git repository.

Business-language explanation:

The server is currently using an extracted folder. That works, but it makes upgrades more manual and increases the chance of old files remaining around.

Recommended fix:

Use one of two clean deployment patterns:

Option A - Git deployment:

- `/opt/quant-trader/app` is a real Git clone.
- `git pull origin main`
- `docker compose up -d --build`

Option B - Release folder deployment:

- Upload versioned release to `/opt/quant-trader/releases/<commit-sha>`.
- Keep data in `/opt/quant-trader/shared/data`.
- Use a `current` symlink.
- Do not keep archives or private keys inside the release.

For your level right now, Git deployment is simpler.

## Finding 9 - Medium/High: Dockerfile Masks TypeScript Failures

Severity: Medium/High  
Area: build reliability  
File: `Dockerfile`

Evidence:

- `Dockerfile:16`

```dockerfile
RUN tsc --noEmit || echo "TypeScript compilation finished."
```

Business-language explanation:

If TypeScript fails during Docker build, the build still continues. That defeats the point of a compile check.

Recommended fix:

Change it to:

```dockerfile
RUN tsc --noEmit
```

Or remove it if `npm run build` already fully validates what you need. But do not hide failure.

## Finding 10 - Medium: Optimize Route References Missing Python Worker

Severity: Medium  
Area: stale architecture, endpoint reliability  
File: `src/app/api/agent/optimize/route.ts`

Evidence:

- `src/app/api/agent/optimize/route.ts:33`
- `src/app/api/agent/optimize/route.ts:35`
- `src/app/api/agent/optimize/route.ts:38`

The route tries:

```text
http://python-worker:5000/train
http://localhost:5000/train
```

But the current Docker stack has no Python worker.

Business-language explanation:

The route will not fully do what its name suggests. It may still return success after catching the error, but the ML training part is not real in this current deployment.

Recommended fix:

Choose one:

- Remove ML wording from this route until a worker exists.
- Add a real free local ML worker to Docker Compose.
- Make the route report `mlTraining: skipped` or `mlTraining: unavailable` honestly.

## Finding 11 - Medium: Hyperbolic Optimization Is Random Drift, Not Real Optimization

Severity: Medium  
Area: strategy credibility  
File: `src/lib/ai/hyperbolicTimeChamber.ts`

Evidence:

- `src/lib/ai/hyperbolicTimeChamber.ts:26`

The current optimization changes parameters using random drift.

Business-language explanation:

This is not actual learning from trade performance. It can create the feeling that the system is improving while it is only changing settings randomly.

Recommended fix:

Replace random drift with:

- Backtest over recent candles.
- Evaluate parameter candidates.
- Compare win rate, profit factor, max drawdown, expectancy.
- Save only if candidate beats current baseline.
- Keep previous stable config if no edge improves.

## Finding 12 - Medium: Supabase Is Connected But Not Yet Central To Trading Memory

Severity: Medium  
Area: memory, evaluation, ML readiness  
Files:

- `src/lib/supabase.ts`
- `src/lib/memory/tradeLedger.ts`
- `src/lib/database/databasePruner.ts`

Evidence:

- `src/lib/supabase.ts:54`
- `src/lib/supabase.ts:102`
- `src/lib/memory/tradeLedger.ts`
- `src/lib/database/databasePruner.ts:18`

Supabase insert helpers exist, but the current swing daemon logs trades through `PortfolioManager.logTrade()` and does not visibly record rich journal entries into `TradeLedger.recordTrade()` on close.

Business-language explanation:

Supabase exists as a storage option, but it is not yet the full "learning database" for every decision, trade, result, and lesson.

Recommended fix:

Persist every scan and every trade lifecycle:

- Decision considered.
- Why it was rejected or accepted.
- Features at the time.
- Entry.
- Stop/take-profit.
- Exit.
- PnL.
- Whether the original thesis was correct.
- Which rule should be adjusted.

For free-mode ML later, this is the foundation.

## Finding 13 - Medium: Signal UI Score Is Misleading

Severity: Medium  
Area: dashboard/business clarity  
Files:

- `src/lib/signals.ts`
- `src/components/Dashboard.tsx`

Evidence:

- `src/lib/signals.ts:24`
- `src/components/Dashboard.tsx:1061`

Live USDJPY returned:

```text
totalScore: 66
action: HOLD
reason: Score < 14
```

Business-language explanation:

A business user sees 66 and thinks the AI is positive. But the trading engine is holding because the raw score is below the actual entry threshold.

Recommended fix:

Show both:

- Raw swing confluence score: `8 / 14 needed`
- Dashboard normalized confidence: `66 / 100`
- Action: `HOLD`
- Plain explanation: `Score looks moderately positive, but it is below the required entry threshold.`

Do not label BUY >= 56 if the actual engine only buys at raw score >= 14.

## Finding 14 - Medium: Dashboard Still Mentions HFT Scalp Engine Although No Scalp Worker Runs

Severity: Medium  
Area: product truthfulness  
File: `src/components/Dashboard.tsx`

Evidence:

- Dashboard includes "HFT Scalp Engine".
- Current Docker Compose has no scalp daemon.
- Current package scripts have only `daemon:swing`.

Business-language explanation:

The user interface suggests an engine exists, but the live runtime does not show it as active.

Recommended fix:

Either:

- Hide the HFT/scalp panel when no scalp service is configured.
- Or rebuild a real free-mode scalp engine as a separate worker.

Do not let dead modules pretend to be active.

## Finding 15 - Medium: README And Env Example Are Stale

Severity: Medium  
Area: onboarding, deployment correctness  
Files:

- `README.md`
- `.env.local.example`
- `src/lib/env.ts`

Evidence:

`.env.local.example` still mentions Upstash Redis as required, but current `src/lib/redis.ts` uses local `ioredis` and Docker Redis by default.

`src/lib/env.ts` requires:

- `GEMINI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `DASHBOARD_SECRET`
- `ADMIN_SECRET`

But `.env.local.example` does not include all current optional/newer keys such as:

- `ADMIN_SECRET`
- `CRON_SECRET`
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `SUPABASE_ENABLED`

Business-language explanation:

A future deployment can fail because the documentation describes an older environment model.

Recommended fix:

Create a single `.env.example` matching exactly what `env.ts` expects.

## Finding 16 - Medium: QStash Security Comment Is Stale Or Misleading

Severity: Medium  
Area: security clarity  
File: `src/lib/auth.ts`

Evidence:

The file comments describe QStash signature concerns, but actual `verifyAuth()` only checks Bearer tokens and spectator GET access.

Relevant code:

- `src/lib/auth.ts:2`
- `src/lib/auth.ts:40`
- `src/lib/auth.ts:45`
- `src/lib/auth.ts:56`

Business-language explanation:

The comments describe a security path that is no longer implemented. That can confuse future fixes.

Recommended fix:

Update comments to match actual auth behavior.

## Finding 17 - Medium: Free Data Feeds Work, But Have No Formal Health Gate In Swing Daemon

Severity: Medium  
Area: data reliability  
Files:

- `src/lib/market.ts`
- `src/daemon/swingDaemon.ts`

Evidence:

MarketService has fallback feeds and cache:

- Kraken.
- Yahoo Finance.
- CoinGecko.
- WebSocket Redis price cache.

But the swing daemon does not have a formal "data quality score" gate before entering.

Business-language explanation:

The bot can trade on fallback data without clearly knowing whether data is fresh, agreed across sources, or degraded.

Recommended fix:

Before entry, require:

- Candle count above minimum.
- Latest candle not stale.
- Price source agreement within tolerance.
- ATR finite and sane.
- Spread/price sanity.
- No zero/invalid candle volume unless asset class allows it.

If data is degraded, HOLD.

## Finding 18 - Medium: Forex/Commodity Accounting Is Too Generic

Severity: Medium  
Area: financial model correctness  
Files:

- `src/daemon/swingDaemon.ts`
- `src/app/api/user/status/route.ts`
- `src/app/api/trade/manual/route.ts`
- `src/lib/execution/paperExchange.ts`

Problem:

Crypto, forex, gold, oil, and silver are treated with a mostly shared `amount * price` model, with small special handling for USD-prefixed forex pairs.

Business-language explanation:

Different assets do not behave the same:

- BTC amount is coins.
- Gold may be ounces/futures price proxy.
- Oil may be futures barrel proxy.
- USDJPY has USD as base and JPY as quote.
- EURUSD has EUR as base and USD as quote.

If the unit model is not explicit, PnL can be wrong.

Recommended fix:

Add an `AssetContractSpec` table:

```text
asset
assetClass
quoteCurrency
contractSize
pipSize
pipValueUsd
maxMarginPercent
maxLeverage
feeModel
minTradeNotional
```

Then PnL and margin must use the contract spec.

## Finding 19 - Low/Medium: Mojibake Encoding In Source/Logs

Severity: Low/Medium  
Area: polish, maintainability  
Files: many

Evidence:

Text such as:

```text
ðŸš€
âš¡
â”€â”€
```

appears in source/log strings.

Business-language explanation:

This does not break trading, but it makes logs look broken and can reduce trust in the dashboard.

Recommended fix:

Convert source files to UTF-8 cleanly or replace icon-heavy logs with ASCII labels.

## Finding 20 - Low/Medium: Release Archive Is Tracked And Modified

Severity: Low/Medium  
Area: repo hygiene  
Evidence:

`v7-clean.tar.gz` is tracked and modified locally.

Business-language explanation:

Binary archives in Git create noisy commits and make it harder to review actual code changes.

Recommended fix:

Do not track build/release archives in the source repo. Put archives in GitHub Releases or deployment storage, not normal source control.

## 5. Why The Bot May Be Losing Scalps Or Trades

In the current live build, I did not find an active scalp daemon. So if you are seeing "scalp losses" from previous versions, those may be from an older deployment or old Redis/trade history. In the current live state, the active issue is swing sizing.

Likely reasons for poor trading performance:

1. Position sizing bug creates huge margin exposure.
2. Forex accounting is too simplified.
3. RiskManager is not controlling the daemon entry path.
4. There is no strict daily/weekly kill switch in the running swing daemon.
5. Signals are not evaluated by historical edge per asset/setup.
6. Optimization is random drift, not evidence-based learning.
7. Supabase is not yet the full memory/evaluation backbone.
8. UI confidence score can make a weak HOLD look stronger than it is.
9. Free feeds are usable, but without a data health gate they can still produce weak entries.
10. Dashboard labels imply HFT/scalp sophistication that is not active in the current runtime.

## 6. Recommended Fix Plan

### Phase 1 - Stop The Bleeding

Priority: immediate

1. Add hard max margin per autonomous trade.
2. Add hard max total active margin.
3. Force swing daemon to use central risk sizing.
4. Add forex-specific contract and PnL rules.
5. Make startup state missing equal safe mode, not reset.
6. Add a visible "Trading Halted" state if risk/data fails.

Acceptance criteria:

- No single AI trade can lock more than 10% of account equity.
- No total open AI margin can exceed 25% of account equity.
- USDJPY no longer opens $8,781 margin from a $10,000 account unless explicitly allowed by admin config.
- Bot refuses trade if sizing math produces absurd margin-to-risk ratio.

### Phase 2 - Make Results Trustworthy

Priority: high

1. Persist every trade and decision to Supabase.
2. Record rejected decisions too, not only executed trades.
3. Track setup category:
   - mean reversion
   - structural trend
   - volatility squeeze
   - VWAP deviation
   - forex
   - crypto
   - commodity
4. Calculate performance by setup category.
5. Stop trading categories with no edge.

Acceptance criteria:

- Dashboard can answer: "Which setup makes money?"
- Dashboard can answer: "Which asset is hurting the bot?"
- Bot can automatically stop trading bad categories.

### Phase 3 - Make AI/ML Real In Free Mode

Priority: high after risk fix

A free local ML brain is possible on the Oracle VPS, but it should not be the first fix. First fix sizing.

Free ML path:

- Use Supabase/Redis as historical storage.
- Train local lightweight model:
  - logistic regression
  - random forest
  - gradient boosting if VPS handles it
  - small PyTorch model only later
- Predict:
  - probability trade reaches TP before SL
  - expected value
  - no-trade probability

The ML should be a filter, not a god.

Rule:

```text
Technical strategy proposes.
Risk engine sizes.
ML filter approves/rejects.
LLM explains only when available.
```

### Phase 4 - Honest Free-Mode Autonomy

Priority: medium

1. LLM optional.
2. LLM cached.
3. LLM not required to trade.
4. Free LLM failures should not break trading loop.
5. When LLM unavailable, use deterministic math fallback.
6. Dashboard should show:
   - LLM provider status
   - last LLM success
   - current cooldown
   - decision source: ML, math, LLM, or risk block

### Phase 5 - VPS Hygiene

Priority: high

1. Remove SSH private key from app folder.
2. Remove old archives from app folder.
3. Remove `.env.local` if `.env` is the only runtime env needed.
4. Keep data outside release folder.
5. Make deployment Git-based or release-symlink based.
6. Prune Docker build cache after confirming backups.
7. Add a simple deployment checklist.

## 7. Ideal Free-Only Target Architecture

```text
Free market feeds
  -> Feed health checker
  -> Candle/price cache in Redis
  -> Signal engine
  -> Setup classifier
  -> Local ML probability filter
  -> Central risk admission controller
  -> Paper execution simulator
  -> Portfolio state in Redis
  -> JSON backup + Supabase permanent journal
  -> Dashboard + health endpoints
```

Key philosophy:

The AI should be autonomous, but autonomy must include the ability to say "do nothing." The best free system is not the one that trades most often. It is the one that only trades when it has measurable edge and protects the paper account like it is real money.

## 8. Highest-Value Bug Fix Tickets For Antigravity/Codex

### Ticket 1 - Central TradeAdmissionController

Build a shared service that all trade entry paths must call.

Inputs:

- portfolio
- asset
- direction
- entryPrice
- stopLoss
- takeProfit
- signalScore
- strategyType

Outputs:

- approved
- blockReason
- riskAmountUsd
- notionalUsd
- requiredMarginUsd
- entryFeeUsd
- amount
- maxLossUsd
- expectedRewardUsd

Rules:

- max margin per trade = 10%
- max total margin = 25%
- reject if fee > 20% of risk amount
- reject if stop distance invalid
- reject if asset contract spec missing
- reject if data quality bad

### Ticket 2 - AssetContractSpec

Create a central asset spec for:

- BTC
- ETH
- SOL
- EURUSD
- GBPUSD
- USDJPY
- GOLD
- OIL
- SILVER

Include:

- class
- quote currency
- unit meaning
- max leverage
- max margin percent
- fee rate
- pip size
- PnL conversion function

### Ticket 3 - Swing Daemon Uses Admission Controller Only

Remove direct sizing from:

- `src/daemon/swingDaemon.ts`
- `src/app/api/trade/route.ts`
- `src/app/api/trade/swing/route.ts`

Every entry must call the shared controller.

### Ticket 4 - State Recovery Safe Mode

If Redis and backup are missing:

- do not auto reset
- set `system:trading_halted = true`
- expose this in `/api/user/status`
- require admin reset

### Ticket 5 - Supabase Decision Journal

Every scan should create:

- asset
- timestamp
- action proposed
- action taken
- score
- reason
- risk block reason
- entry/SL/TP
- current market features

Every exit should update:

- actual PnL
- exit reason
- thesis correct or wrong
- setup type result

### Ticket 6 - Dashboard Truth Cleanup

Fix UI labels:

- "HFT Scalp Engine" only appears when scalp engine is active.
- Show raw confluence score and required threshold.
- Show margin percent used.
- Show current risk lock status.
- Show data feed health.
- Show "paper mode" clearly.

### Ticket 7 - Deployment Hygiene

Create:

- `deploy_checklist.md`
- `.env.example`
- `docker-cleanup-safe.md`
- `vps_folder_policy.md`

Rules:

- No SSH keys in project folder.
- No build archives in active folder.
- No `.next`/`node_modules` copied manually if Docker is building.
- Data lives in a persistent shared folder.

## 9. What Is Working Well

1. Local repository and GitHub origin are synced.
2. Main runtime files on VPS match local files.
3. Live site is reachable.
4. Live API endpoints respond.
5. Docker services are running.
6. Redis is working.
7. JSON backup persistence exists.
8. Local lint passes.
9. Local TypeScript passes.
10. The architecture is simpler than before and therefore easier to stabilize.
11. Free data feeds are functioning right now.
12. Spectator API access is read-only for action endpoints.

## 10. Final Assessment

The system is promising, but the current live results should not yet be used to judge strategy profitability. The account is being distorted by incorrect margin sizing, especially for forex. Fixing that should come before ML, Hugging Face, LLM ops, or new strategy complexity.

The best next move is not to make the bot more intelligent. The best next move is to make it impossible for the bot to size a trade badly.

After that, the future path is strong:

1. Correct risk and contract accounting.
2. Make all decisions measurable.
3. Store all outcomes.
4. Train a local free ML filter.
5. Let AI explain and improve rules, but never bypass risk.
6. Run the bot for days and judge by setup-level performance.

If those layers are added, this can become a serious free-mode autonomous paper trading lab. Right now it is a working prototype with one critical trading-accounting bug that must be fixed first.

## 11. Addendum - Leveraged High-Accuracy Trading Vision

The desired long-term trading philosophy is valid for this architecture:

```text
The bot should use leverage only when the setup quality is unusually high, the historical edge is proven, the risk engine approves the exposure, and the account can survive the stop loss without meaningful damage.
```

This means leverage is not rejected as a concept. The current problem is that leverage is being applied without a strong enough admission layer. The architecture can support leveraged paper trading, but only after the following rules exist.

### 11.1 Leverage Should Be A Reward For Proven Edge

The bot should not use leverage simply because leverage is available. It should unlock leverage only when all of these are true:

- The signal has high confluence.
- The same setup category has positive historical expectancy.
- The asset has recent win-rate and profit-factor support.
- Market data quality is good.
- Volatility is not extreme or broken.
- Stop loss is clearly defined.
- Fee drag is small compared to expected reward.
- The trade has enough reward-to-risk after fees and slippage.
- The bot is not in drawdown protection mode.

Business interpretation:

Leverage should be treated like a promotion. The bot earns the right to use it only when the evidence is strong.

### 11.2 Recommended Free-Mode Leverage Ladder

Use a leverage ladder rather than one fixed leverage value.

```text
Tier 0 - No trade
Condition: no edge, bad data, weak confluence, active drawdown guard
Action: HOLD

Tier 1 - Unlevered or near-unlevered paper trade
Condition: acceptable setup, but not elite
Suggested leverage: 1.0x

Tier 2 - Conservative leverage
Condition: strong setup with historical edge
Suggested leverage: 1.5x to 2.0x

Tier 3 - High-confidence leverage
Condition: elite setup, positive expectancy, strong market confirmation
Suggested leverage: 2.0x to 3.0x

Tier 4 - Maximum paper-only leverage
Condition: rare best-quality setup, strict stop, low fee drag, low active exposure
Suggested leverage: 3.0x to 5.0x
```

Important: even at 5x, margin must still be capped. The system must never allow one trade to consume most of the account.

### 11.3 Required Rule: Risk Is Capped Before Leverage Is Applied

The correct model is:

```text
1. Decide maximum dollars allowed to lose.
2. Calculate stop-loss distance.
3. Calculate position size from that risk.
4. Calculate notional and margin.
5. Apply hard margin caps.
6. Reject the trade if leverage creates too much exposure.
```

The wrong model is:

```text
Use leverage first, then hope the risk is acceptable.
```

The current USDJPY issue came from this kind of exposure mismatch. The bot said the risk was small, but the margin locked was huge.

### 11.4 Leveraged Trade Admission Score

Before leverage is allowed, create a `LeverageAdmissionScore` from 0 to 100.

Suggested components:

- Signal confluence: 25 points
- Historical setup expectancy: 20 points
- Asset-specific recent performance: 15 points
- Risk/reward after fees: 15 points
- Data quality/source agreement: 10 points
- Volatility sanity: 10 points
- Current portfolio health: 5 points

Suggested action:

```text
0-59: no leverage, likely no trade
60-74: 1x only
75-84: up to 2x
85-92: up to 3x
93-100: up to 5x paper-only maximum
```

This keeps the system aligned with the user's goal: high profit potential only for high-accuracy trades.

### 11.5 Leveraged Trading Must Still Protect The Account

Hard laws:

- Max loss per trade: 0.5% to 1.5% of equity.
- Max margin per trade: 5% to 10% of equity by default.
- Max total active margin: 25% of equity.
- Max open leveraged trades: 1 to 3 depending on correlation.
- If daily drawdown exceeds 3%, reduce leverage to 1x.
- If daily drawdown exceeds 5%, stop autonomous entries.
- If total drawdown exceeds 10%, halt trading until manual review.

This does not make the bot timid. It makes the bot survive long enough to compound.

### 11.6 Self-Learning Loop Should Be The Foundation Model

The architecture should become a self-learning loop, but not by letting the LLM freely invent trades. The right free-mode foundation loop is:

```text
Market data
  -> feature extraction
  -> signal generation
  -> setup classification
  -> risk admission
  -> leverage admission
  -> paper execution
  -> outcome logging
  -> Supabase/Redis memory
  -> local model training
  -> strategy confidence update
  -> future trade filtering
```

The self-learning model should learn:

- Which setup categories make money.
- Which assets perform best.
- Which volatility regimes are dangerous.
- Which signal combinations work.
- Which timeframes are reliable.
- When leverage helps.
- When leverage destroys expectancy.

The system should eventually create a `StrategyConfidenceScore` for every setup type.

Example:

```text
USDJPY structural trend breakout:
Recent trades: 24
Win rate: 62.5%
Profit factor: 1.84
Average R: +0.42
Max adverse excursion: controlled
Confidence score: 86/100
Allowed leverage: up to 3x
```

If the confidence score drops, leverage drops automatically.

### 11.7 Clean-Slate Free VPS Deployment Principle

Because the VPS is a free Oracle server and the goal is zero recurring cost, the next upload should be treated as a clean-slate production reset of the application folder, but not as careless data deletion.

Recommended clean-slate policy:

```text
Keep:
- .env
- persistent Redis volume, unless intentionally resetting
- /data backups, unless intentionally resetting
- current source code
- docker-compose.yml

Remove:
- old release archives
- old extracted folders
- private SSH keys inside app folders
- Docker build cache
- stale .next/node_modules copied outside Docker
- dead Python/Rust/scalp folders if not used
```

For the free version, the architecture should stay simple:

- One VPS.
- Docker Compose.
- Redis local container.
- Next.js dashboard/API.
- One or two daemon workers maximum until the system is stable.
- Supabase free tier for long-term memory if it remains within free limits.
- Free LLM providers as optional helpers, never required for core trading.
- Local deterministic math/ML as the default decision backbone.

This is the right foundation for a zero-cost autonomous paper trading lab.

