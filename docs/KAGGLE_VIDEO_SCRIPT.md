# Kaggle Capstone Demo Video — 5-Minute Script

**Project:** Autonomous Paper Trading Agent  
**Duration:** 5:00  
**Resolution:** 1080p minimum  

---

## Segment Overview

| Segment | Timestamp | Duration | Topic |
|---|---|---|---|
| 1 — Hook | 0:00–0:30 | 30s | Problem statement + what the bot does |
| 2 — Problem & Value | 0:30–1:10 | 40s | Dashboard tour, human vs AI, paper trading |
| 3 — Architecture | 1:10–2:00 | 50s | Mermaid diagram, 6 agent roles |
| 4 — Live Demo | 2:00–2:50 | 50s | Dashboard walkthrough |
| 5 — Safety | 2:50–3:30 | 40s | Spectator mode, locked execution, no secrets |
| 6 — MCP / CLI / ADK | 3:30–4:10 | 40s | Agent CLI, MCP server, reviewer agent |
| 7 — Antigravity | 4:10–4:40 | 30s | Google Antigravity development workflow |
| 8 — Closing | 4:40–5:00 | 20s | Safety disclaimer, research platform framing |

---

## Segment 1: Hook (0:00–0:30)

**Visual:** Dashboard loading screen → live prices populating → portfolio summary visible.

**Spoken:**

> "What if an AI agent could watch nine markets twenty-four hours a day, decide when to trade based on multi-timeframe technical confluence, manage risk automatically, and learn from every outcome — all without risking a single dollar of real money?"
>
> "That's exactly what this project does."
>
> "I'm Tejas Hendre, and this is the Autonomous Paper Trading Agent - my Kaggle AI Agents Capstone project."

**Timing notes:** Start with the dashboard URL loading in a browser. Let the live prices fill in for visual impact. Transition to your face or a title slide as you introduce yourself.

---

## Segment 2: Problem & Value (0:30–1:10)

**Visual:** Dashboard showing portfolio overview, recent scan decisions (HOLD/SKIPPED visible), and the equity curve.

**Spoken:**

> "Retail traders face three consistent problems."
>
> "First, overtrading. Humans enter positions out of boredom, fear of missing out, or revenge after losses — not because the data supports it."
>
> "Second, missed setups. No person can watch BTC, ETH, Solana, three forex pairs, gold, oil, and silver across six timeframes, twenty-four-seven."
>
> "Third, inconsistent risk discipline. Traders vary their position sizes, move their stops, and ignore drawdown limits — especially during losing streaks."
>
> "This system solves all three. It monitors nine assets continuously, only enters when multi-timeframe confluence is strong, sizes every trade with Kelly Criterion and ATR-based stops, and records every decision for review."
>
> "And importantly — this is paper trading. No real money. It's a research and learning platform."

**Visual cues:**
- Point to the portfolio summary showing tracked assets
- Highlight a HOLD or SKIPPED decision in the recent scans
- Point to the equity curve

---

## Segment 3: Architecture (1:10–2:00)

**Visual:** Show the Mermaid architecture diagram (pre-rendered screenshot or slide). Highlight each agent role as you describe it.

**Spoken:**

> "The system is built as a multi-agent architecture with six specialized modules."
>
> "The Market Observer fetches free data from Binance and Bybit WebSockets, Kraken, Yahoo Finance, and CoinGecko. It normalizes candles and monitors feed health."
>
> "The Decision Agent evaluates technical confluence across one-minute to four-hour timeframes — RSI, MACD, Bollinger Bands, ATR, VWAP, Market Structure, Order Blocks, Fair Value Gaps, and more."
>
> "The Risk Governor validates every trade. It caps leverage, enforces drawdown guards, and sizes positions with Kelly Criterion."
>
> "The Paper Execution Agent simulates the trade — recording entry, exit, fees, and PnL."
>
> "The Exit Watchdog monitors open positions every five seconds, protecting profit and cutting losses."
>
> "And the Learning Agent records outcomes and adjusts conviction for future decisions, creating a feedback loop."
>
> "The full cycle: Observe, Decide, Risk Check, Execute, Monitor, Learn — running autonomously, every minute."

**Visual cues:**
- Use arrows or highlights to trace the data flow through the diagram
- Briefly flash the `Observe → Decide → Risk Check → Execute → Monitor → Learn` text

---

## Segment 4: Live Demo (2:00–2:50)

**Visual:** Screen recording of the live dashboard at https://ai-quant-trader.duckdns.org

**Spoken:**

> "Here's the live spectator dashboard. Anyone can access it — no login required."
>
> "At the top, the portfolio summary shows current equity, total PnL, and active positions. You can see the system is tracking all nine assets."
>
> "The swing scan section shows the most recent analysis. Notice the decision says [HOLD/SKIPPED/ENTRY] — with a full explanation of why. The confluence score, which indicators aligned, which failed."
>
> "The opportunity radar shows setups the system evaluated but didn't take — and what would have happened. This feeds into the learning memory."
>
> "The equity curve tracks portfolio performance over time."
>
> "And the trade history shows every entry and exit with exact prices, PnL, and reasoning."
>
> "Notice how many decisions are HOLD or SKIPPED. That's intentional. The system prefers no trade over a weak trade. Discipline over activity."

**Visual cues:**
- Scroll through the dashboard naturally
- Pause on the scan result to show the decision reasoning
- Point to the opportunity radar
- Show the equity curve
- Scroll through trade history

---

## Segment 5: Safety (2:50–3:30)

**Visual:** Show the spectator Bearer token in a request header, `.env.local.example` file, `.gitignore` entries.

**Spoken:**

> "Safety is fundamental to this project."
>
> "First — this is paper trading only. The environment variable LIVE_TRADING_ENABLED is false by default. No real brokerage is connected. No real money can be lost."
>
> "Second — the public dashboard uses spectator mode. The Bearer SPECTATOR token provides read-only access. Spectators can view everything but cannot open trades, close positions, or reset the portfolio."
>
> "Admin mutations — manual trades, portfolio resets — require separate authentication that is never exposed publicly."
>
> "The MCP server is read-only. The ADK reviewer agent is read-only. Neither can modify system state."
>
> "And you can see in the gitignore — environment files, SSH keys, and credentials are excluded from the repository. No secrets committed."

**Visual cues:**
- Show `.env.local.example` with placeholder values (not real keys)
- Show `.gitignore` entries for `.env`, `.key`, etc.
- Show a failed mutation attempt with SPECTATOR token (if prepared)

---

## Segment 6: MCP / Agent CLI / ADK (3:30–4:10)

**Visual:** Terminal window with commands running.

**Spoken:**

> "The project demonstrates three Kaggle concepts through tools you can run right now."
>
> "First, Agent Skills. Running `npm run agent:status` gives a structured portfolio and system health report."

*[Run the command, show output]*

> "Second, the MCP Server. The file `trading_mcp_server.ts` implements a read-only Model Context Protocol server. Here's a tool call to get portfolio status — and the structured JSON response."

*[Show a `tools/list` call or a `get_public_demo_summary` response from the MCP server.]*

> "Third, the ADK Reviewer Agent. This Python script audits recent trade decisions for safety and explainability. Here's a sample report — it checks risk compliance, validates reasoning quality, and flags any concerns."

*[Show the reviewer agent script and sample output]*

> "These three demonstrate Agent Skills, MCP Server, and ADK Agent — three of the six Kaggle concepts this project covers."

**Visual cues:**
- Terminal font should be 16px+ for readability
- Show full command and key parts of output
- Briefly show the source files for MCP and ADK

---

## Segment 7: Antigravity (4:10–4:40)

**Visual:** Show Google Antigravity (Gemini Code Assist / Agent) in the IDE, working on project files.

**Spoken:**

> "This project was developed with the help of Google Antigravity — Gemini's agentic coding assistant."
>
> "Here you can see Antigravity helping me review the Kaggle layer, inspect the MCP server, improve the read-only reviewer agent, and document the system safely for submission."
>
> "It understood the full project context — the agent architecture, the risk constraints, the data pipeline — and could suggest, write, and review code across the entire codebase."
>
> "Antigravity significantly accelerated development, especially for the safety-critical components where correctness matters most."

**Visual cues:**
- Show Antigravity in the IDE with project files open
- Show a specific interaction (e.g., asking it to review a function)
- Show generated or modified code

---

## Segment 8: Closing (4:40–5:00)

**Visual:** Dashboard with overlay text: "Autonomous Paper Trading Agent — Kaggle AI Agents Capstone" and the URL.

**Spoken:**

> "The Autonomous Paper Trading Agent is a research platform for exploring whether AI agents can observe, decide, execute, and learn in financial markets — safely, transparently, and without risking real money."
>
> "It demonstrates six Kaggle Capstone concepts: multi-agent architecture, MCP server, Antigravity, security features, deployability, and agent CLI skills."
>
> "The live demo is available at the URL on screen. Thank you for watching."

**On-screen text:**
```
Autonomous Paper Trading Agent
Kaggle AI Agents Capstone — Freestyle Track

🌐 https://ai-quant-trader.duckdns.org

⚠️ Educational paper-trading simulation.
Not financial advice.
```

---

## Recording Notes

### Equipment
- **Screen recording:** OBS Studio, Loom, or similar
- **Microphone:** External USB mic recommended; avoid laptop mic
- **Resolution:** 1080p (1920×1080) minimum

### Preparation
- [ ] Practice each segment and time it individually
- [ ] Ensure dashboard has recent data (run daemon for 30+ minutes before recording)
- [ ] Pre-run all terminal commands once to verify output
- [ ] Set terminal font size to 16px+ for readability
- [ ] Close unnecessary browser tabs and notifications
- [ ] Set browser zoom to 100% or 110% for dashboard readability

### During Recording
- [ ] Speak clearly and at a measured pace
- [ ] Pause briefly between segments for editing
- [ ] Let dashboard animations complete before moving on
- [ ] Keep mouse movements deliberate (avoid circling)
- [ ] Scroll slowly through content

### Post-Production
- [ ] Trim dead air and long pauses
- [ ] Verify total duration is under 5:00
- [ ] Check that no secrets are visible in any frame
- [ ] Add simple transitions between segments (optional)
- [ ] Export at 1080p, H.264, reasonable bitrate

### YouTube Upload
- **Title:** Autonomous Paper Trading Agent — Kaggle AI Agents Capstone Demo
- **Description:** Include project name, live demo URL, GitHub repo URL, and safety disclaimer
- **Tags:** kaggle, ai-agents, paper-trading, autonomous-agent, capstone, multi-agent-system
- **Visibility:** Unlisted or Public (not Private)
- **Thumbnail:** Dashboard screenshot or custom graphic

---

> ⚠️ **Disclaimer**: This is an educational paper-trading simulation. It does not execute real-money trades and does not provide financial advice.
