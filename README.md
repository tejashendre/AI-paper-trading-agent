# Autonomous Quant Trading Agent

A free-first autonomous paper trading system built for selective, higher-timeframe swing trading. The system runs on a Next.js dashboard, a Node.js trading daemon, Docker Redis, and free market data fallbacks.

This project is intentionally **paper trading by default**. The goal is to test whether a deterministic math engine can wait for rare, high-confluence setups, size them safely, explain every action, and run continuously on a zero-cost VPS.

> This is research software, not financial advice. No trading system can guarantee profit or 100% accuracy.

---

## What The Bot Is Designed To Do

- Run 24/7 on a free VPS.
- Watch supported assets through free market data sources.
- Use 15m, 1h, and 4h candle structure to find stronger swing setups.
- Align entries with liquidity sweeps, market structure, and volume-confirmed continuation.
- Use crypto live-flow evidence from order-book imbalance, funding, and open-interest sensors where free data is available.
- Avoid obvious trap trades where price sweeps one side and rejects against the intended direction.
- Trade only when confluence passes the required score.
- Block oversized trades through a centralized risk admission controller.
- Simulate paper entries, exits, fees, leverage, margin, stop loss, and take profit.
- Protect winning swing trades earlier with breakeven/partial-profit stop movement.
- Work even when LLM APIs are missing, blocked, or rate-limited.
- Keep live trading disabled unless it is explicitly enabled.

The system is **not** designed to spam one-second scalps. It can consume fast price updates where free WebSocket data is available, updates the visible dashboard price layer every second, checks active swing exits every 5 seconds, and keeps new entry decisions intentionally slower and more selective.

---

## Current Core Architecture

```mermaid
flowchart TB
    subgraph Runtime["Free Oracle VPS / Docker Runtime"]
        Dashboard["Spectator + Admin Dashboard"]
        Api["Next.js API Routes"]
        LiveApi["1s Live Price API"]
        Redis[("Redis State Store")]
        Daemon["Autonomous Swing Daemon"]
        Watchdog["5s Exit Watchdog"]
    end

    subgraph Data["Free Market Data Mesh"]
        CryptoWS["Binance / Bybit Crypto Ticks"]
        Kraken["Kraken OHLC + Ticker"]
        Yahoo["Yahoo Finance Fallback"]
        CoinGecko["CoinGecko Crypto Fallback"]
        FeedHealth["Feed Health + Staleness Scoring"]
    end

    subgraph Intelligence["Math-First Decision Engine"]
        HTF["15m / 1h / 4h HTF Confluence"]
        Trigger["1m / 5m Live Trigger"]
        Flow["Crypto Flow Score"]
        Liquidity["Market Structure + Liquidity Map"]
        TrapGate["Anti-Trap Entry Gate"]
        Learning["Local Learning Memory"]
        LLM["Optional LLM Reflection"]
    end

    subgraph Risk["Risk + Execution Simulation"]
        Admission["Trade Admission Controller"]
        Sizing["Conviction-Based Margin + Leverage"]
        ProfitLock["Swing Breakeven + Profit Lock"]
        Ledger["Paper Portfolio Ledger"]
    end

    subgraph Ops["Validation + VPS Operations"]
        Replay["Deterministic Replay Validator"]
        Audit["Strategy Audit"]
        DeployCheck["Live VPS Deploy Verifier"]
        Maintenance["Safe Docker Cache Cleanup"]
    end

    CryptoWS --> Redis
    Kraken --> FeedHealth
    Yahoo --> FeedHealth
    CoinGecko --> FeedHealth
    FeedHealth --> HTF
    Redis --> Trigger
    Dashboard <--> Api
    Dashboard --> LiveApi
    LiveApi --> Redis
    Api <--> Redis
    Daemon --> HTF
    Daemon --> Watchdog
    HTF --> Liquidity
    Trigger --> Liquidity
    Redis --> Flow
    Flow --> TrapGate
    Liquidity --> TrapGate
    Learning --> TrapGate
    LLM -. optional only .-> Learning
    TrapGate --> Admission
    Admission --> Sizing
    Sizing --> Ledger
    Watchdog --> ProfitLock
    ProfitLock --> Ledger
    Ledger <--> Redis
    Replay --> Audit
    Audit --> DeployCheck
    DeployCheck --> Maintenance

    classDef runtime fill:#2563eb,stroke:#1e3a8a,color:#fff,stroke-width:2px;
    classDef data fill:#f59e0b,stroke:#92400e,color:#111827,stroke-width:2px;
    classDef brain fill:#7c3aed,stroke:#4c1d95,color:#fff,stroke-width:2px;
    classDef guard fill:#dc2626,stroke:#7f1d1d,color:#fff,stroke-width:2px;
    classDef state fill:#16a34a,stroke:#14532d,color:#fff,stroke-width:2px;
    classDef ops fill:#0891b2,stroke:#164e63,color:#fff,stroke-width:2px;

    class Dashboard,Api,LiveApi,Daemon,Watchdog runtime;
    class CryptoWS,Kraken,Yahoo,CoinGecko,FeedHealth data;
    class HTF,Trigger,Flow,Liquidity,Learning,LLM brain;
    class TrapGate,Admission,Sizing,ProfitLock guard;
    class Redis,Ledger state;
    class Replay,Audit,DeployCheck,Maintenance ops;
```

---

## How The Autonomous Loop Works

1. The daemon starts and connects the crypto WebSocket mesh for live price cache updates.
2. The dashboard polls `/api/live-prices` once per second for a cheap Redis-only live price heartbeat.
3. A fast exit watchdog checks active swing positions every 5 seconds.
4. If stop loss or take profit is hit, it closes the paper position.
5. If there is no open position for an asset, it scans for a new setup.
6. The `SwingEngine` pulls 1m, 5m, 15m, 1h, and 4h context.
7. Technical indicators and statistics are computed locally.
8. A confluence score is produced.
9. Crypto signals receive an additional live-flow score from order-book imbalance, funding, and open-interest sensors.
10. The bot checks market structure, liquidity sweeps, volume confirmation, and trap risk.
11. If the score, structure, data quality, or live flow is too weak, the bot holds.
12. If the setup is strong and liquidity-aligned, the trade is sent to the `TradeAdmissionController`.
13. The risk controller sizes margin, leverage, notional exposure, fees, max loss, and portfolio exposure.
14. If approved, a paper trade is opened and written to Redis.
15. The exit watchdog protects open positions, including earlier breakeven/profit-lock movement when a swing trade starts working.
16. The dashboard reads Redis and displays the current portfolio, logs, trades, chart state, latest scan results, learning verdict, and no-trade reasons.

The current daemon entry scan interval is one minute. That is deliberate for this version because the strategy depends on higher-timeframe candles, not sub-second order flow. Active swing exits are monitored separately every 5 seconds.

---

## Important Safety Rules

- `LIVE_TRADING_ENABLED` must be `true` before any live exchange execution path can be used.
- Exchange API keys alone do not activate live trading.
- LLM keys are optional.
- Missing or failed LLM calls should not stop the math-first swing system.
- Each trade goes through margin and risk admission before opening.
- Each trade must pass the market-structure/liquidity gate before opening.
- Trap-risk states block entries even if the old HTF score looks attractive.
- The system blocks duplicate active positions in the same asset.
- The system caps total portfolio margin exposure.
- Leverage is score-based, not fixed.
- Forex and commodity entries are blocked outside weekday market sessions to avoid stale weekend prices.

---

## Key Runtime Files

| Area | File |
| --- | --- |
| Dashboard | `src/components/Dashboard.tsx` |
| Main page | `src/app/page.tsx` |
| Status API | `src/app/api/user/status/route.ts` |
| 1s live price API | `src/app/api/live-prices/route.ts` |
| Manual trade API | `src/app/api/trade/manual/route.ts` |
| Swing trade API | `src/app/api/trade/swing/route.ts` |
| Market data | `src/lib/market.ts` |
| Swing signal engine | `src/lib/swingEngine.ts` |
| Trading indicators | `src/lib/indicators.ts` |
| Statistical metrics | `src/lib/statistics.ts` |
| Risk admission | `src/lib/trading/tradeAdmission.ts` |
| Asset sizing and PnL | `src/lib/trading/assetSpecs.ts` |
| Portfolio state | `src/lib/portfolio.ts` |
| Redis state | `src/lib/redis.ts` |
| Swing daemon | `src/daemon/swingDaemon.ts` |
| WebSocket mesh | `src/daemon/websocketDataMesh.ts` |

---

## Local Development

```bash
npm install
cp .env.local.example .env.local
docker compose up -d redis
npm run dev
```

Start the autonomous swing daemon in a second terminal:

```bash
npm run daemon:swing
```

---

## VPS Deployment

```bash
git pull origin main
docker compose down
docker compose up -d --build
docker compose ps
```

Useful checks:

```bash
docker logs quant-swing-daemon --tail=100
docker logs quant-dashboard --tail=100
docker system df
```

Safe VPS maintenance is dry-run first:

```bash
sh scripts/vps-maintenance.sh --dry-run
```

Apply safe Docker cleanup only after reviewing the dry-run output:

```bash
sh scripts/vps-maintenance.sh --apply
```

This script does not prune Docker volumes and does not delete `data/`, so Redis and local portfolio/trade backups are protected.

After deployment, run the read-only VPS verifier:

```bash
STATUS_URL=https://ai-quant-trader.duckdns.org/api/user/status \
STATUS_AUTH_TOKEN=SPECTATOR \
sh scripts/vps-deploy-check.sh --expected-commit "$(git rev-parse --short HEAD)"
```

This checks the current commit, free disk space, Docker storage, Compose service health, live strategy audit, scan advancement, and recent daemon logs.

---

## Environment

Use `.env.local.example` as the template.

Required:

- `DASHBOARD_SECRET`
- `ADMIN_SECRET`
- `REDIS_URL`

Optional:

- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `BINANCE_API_KEY`
- `BINANCE_SECRET_KEY`
- `BYBIT_API_KEY`
- `BYBIT_SECRET_KEY`

Safety:

```env
LIVE_TRADING_ENABLED=false
```

Keep this false for paper trading.

---

## Current Strategy Philosophy

The system should prefer **no trade** over a weak trade.

Good behavior means:

- many cycles with no entry,
- clear reasons for blocked trades,
- rare entries with stronger confluence,
- small controlled loss when wrong,
- larger planned reward than risk,
- stable operation without depending on paid APIs.

A bot that waits days or weeks for a better swing setup may be behaving correctly. The objective is not activity; the objective is disciplined selection.

---

## Known Constraints

- Free data is useful but not institutional-grade.
- Forex and commodity data may be slower or less complete than crypto data.
- WebSocket coverage is strongest for crypto.
- One-minute scanning is not real HFT.
- Paper results can differ from real execution due to slippage, liquidity, spreads, and exchange behavior.
- LLM APIs can be rate-limited, unavailable, or return invalid data, so they must remain optional.

---

## Validation

Before shipping changes:

```bash
npm run lint
npx tsc --noEmit
npm run build
npm run audit:strategy
npm run replay:strategy -- --assets=BTC,ETH,SOL --timeframe=15m --limit=300
```

The strategy audit is a free local evaluation check. It validates asset specs, conviction-based paper sizing, total margin caps, duplicate-position blocking, and deterministic replay acceptance gates.

The replay command is a free market-candle validation pass. It reports win rate, profit factor, drawdown, score distribution, missed-opportunity rate, false-positive rate, and setup-level performance. It is read-only and does not mutate live Redis state.

To audit the live VPS dashboard API as part of the same command:

```bash
STATUS_URL=https://ai-quant-trader.duckdns.org/api/user/status STATUS_AUTH_TOKEN=SPECTATOR npm run audit:strategy
```

For Docker:

```bash
docker compose up -d --build
docker compose ps
```

---

## Project Direction

The next best upgrades are:

- Per-position exit watchdog refinements and feed-health alerts.
- Per-setup performance analytics.
- Trade-quality memory from real completed paper trades.
- More transparent dashboard explanations.
- Better feed health scoring.
- Local ML filter trained only on actual trade outcomes.
- Strict cooldowns after losing streaks or bad market regimes.

The foundation is now a clean autonomous swing system. The next goal is to make every trade more selective, more explainable, and easier to audit.
