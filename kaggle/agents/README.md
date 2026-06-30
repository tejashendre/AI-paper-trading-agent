# 🤖 Trading Reviewer Agent — Safety & Explainability

A Python agent that inspects the Autonomous Paper Trading Agent's live state and generates a comprehensive safety report. Follows the **ADK (Agent Development Kit)** pattern for composable, single-purpose AI agents.

## What It Does

The reviewer agent connects to the live trading dashboard API and produces a structured safety report covering:

| Section | What It Checks |
|---------|----------------|
| **System State** | Is the system active, idle, or inactive? (based on scan recency) |
| **Latest Scan** | Entry/hold/block/skip counts, primary blockers per asset |
| **Portfolio Health** | AI value vs. initial capital, drawdown percentage |
| **Active Positions** | Count, sizing validation, concentration warnings |
| **Risk Warnings** | Bad feeds, high drawdown, stale scans, position concentration |
| **Safety Verdict** | Confirms paper-trading-only mode, no real-money execution |
| **Gemini Critique** | *(Optional)* AI-powered natural-language review of system state |

## 🛡️ Safety

> This agent is **strictly read-only**.
> - Uses the public `SPECTATOR` token
> - Cannot execute trades or modify state
> - No admin credentials or API keys are accessed
> - The agent prompt explicitly prohibits real-money recommendations

## Quick Start

```bash
# Basic run — rule-based report only
python kaggle/agents/trading_reviewer_agent.py

# With Gemini AI critique
GEMINI_API_KEY=your-key-here python kaggle/agents/trading_reviewer_agent.py

# Custom API endpoint
STATUS_URL=https://your-server.com/api/user/status \
STATUS_AUTH_TOKEN=your-token \
python kaggle/agents/trading_reviewer_agent.py
```

**No pip installs needed** — uses only Python standard library (`urllib`, `json`, `os`, `sys`, `ssl`).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STATUS_URL` | `https://ai-quant-trader.duckdns.org/api/user/status` | The status API endpoint |
| `STATUS_AUTH_TOKEN` | `SPECTATOR` | Bearer token for API auth (read-only) |
| `GEMINI_API_KEY` | *(none)* | Optional. Enables Gemini-powered natural language critique |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model to use for critique |

## Example Output

```
════════════════════════════════════════════════════════════════
  🔍 Trading System Safety Review
════════════════════════════════════════════════════════════════
  Report Time: 2025-06-20 14:30:22 UTC
  Source: https://ai-quant-trader.duckdns.org/api/user/status

▶ 1. System State
────────────────────────────────────────────────────────────────
  Status: ACTIVE
  Detail: Scan completed 12m ago

▶ 2. Latest Scan Summary
────────────────────────────────────────────────────────────────
  Scan ID:    scan_20250620_143022
  Completed:  2025-06-20T14:30:22.000Z
  Assets:     12
  Entries:    1
  Holds:      5
  Blocked:    4
  Skipped:    2
  Main Blockers:
    • LOW_DATA_QUALITY: DOTUSDT, AVAXUSDT
    • HTF_BEARISH: XRPUSDT, ADAUSDT

▶ 3. Portfolio Health
────────────────────────────────────────────────────────────────
  AI Portfolio Value:  $10,245.67
  Initial Capital:    $10,000.00
  PnL:                +2.46%

▶ 4. Active Positions
────────────────────────────────────────────────────────────────
  Open: 2
    • BTCUSDT: qty=0.01, avgPrice=$102,100.00
    • ETHUSDT: qty=0.5, avgPrice=$3,850.00

▶ 5. Risk Warnings
────────────────────────────────────────────────────────────────
  ✅ No risk warnings detected

▶ 6. Safety Verdict
────────────────────────────────────────────────────────────────
   PAPER TRADING ONLY
  This system operates exclusively in paper-trading mode.
  • No real funds are at risk
  • All orders are simulated
  • No exchange API keys are used for execution
  • The SPECTATOR token provides read-only access
```

## ADK Alignment

This agent follows the **Agent Development Kit (ADK)** design principles:

1. **Single Purpose**: Focused exclusively on safety review and explainability
2. **Stateless Execution**: Fetches fresh state on each run — no persistent state or side effects
3. **Composable Output**: Structured report that can be piped into other agents or tools
4. **Clear Agent Prompt**: The agent's role and constraints are defined in the module docstring
5. **Safety by Design**: Read-only access, no mutation capabilities, explicit safety disclaimers
6. **Optional AI Enhancement**: Rule-based by default, with optional Gemini integration for deeper analysis
7. **Zero Dependencies**: Runs with Python standard library only — no pip install required

### Agent Prompt (from docstring)

> *You are a read-only trading system reviewer. Your job is to inspect the paper-trading agent's latest state, explain what it is doing, identify risk warnings, and summarize whether the system is behaving safely. You must never recommend real-money trading or execute orders.*

## Architecture

```
┌───────────────────┐       HTTPS        ┌─────────────────┐
│  Reviewer Agent    │ ◄────────────────  │  Trading API     │
│  (this script)     │   GET /status      │  (Live System)   │
└────────┬──────────┘                    └─────────────────┘
         │
         ├── Rule-based analysis (always)
         │   • System state check
         │   • Scan summary
         │   • Portfolio health
         │   • Risk warnings
         │
         └── Gemini critique (optional)
             • Natural-language review
             • Pattern identification
             • Monitoring recommendations
```
