# 🔌 Trading MCP Server — Read-Only Inspection

A **self-contained** Model Context Protocol (MCP) server that provides read-only inspection tools for the Autonomous Paper Trading Agent. No external MCP SDK dependency — it implements the MCP protocol directly over stdio JSON-RPC 2.0.

## What It Does

This MCP server connects to the live paper trading dashboard API and exposes **5 read-only tools** that any MCP-compatible AI assistant (Claude, Cursor, etc.) can call:

| Tool | Description |
|------|-------------|
| `get_portfolio_status` | AI & Human portfolio values, realized PnL, open positions, total trades |
| `get_latest_scan` | Last scan ID, timestamp, per-asset summaries, main blockers |
| `get_data_health` | Feed health matrix — good/degraded/bad counts, problem assets |
| `get_learning_summary` | Watched opportunities, favorable rate, active rules, best setup |
| `get_public_demo_summary` | Judge-friendly plain-English summary of system state & safety |

## 🛡️ Safety

> **This server is strictly read-only.**
> - ❌ Cannot execute trades
> - ❌ Cannot modify positions
> - ❌ Cannot access admin endpoints
> - ❌ No API keys or secrets exposed
> - ✅ Uses the public `SPECTATOR` token for read-only access

## Quick Start

```bash
# Run directly
npx tsx kaggle/mcp/trading_mcp_server.ts

# With custom environment
STATUS_URL=https://your-server.com/api/user/status \
STATUS_AUTH_TOKEN=your-token \
npx tsx kaggle/mcp/trading_mcp_server.ts
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STATUS_URL` | `https://ai-quant-trader.duckdns.org/api/user/status` | The status API endpoint |
| `STATUS_AUTH_TOKEN` | `SPECTATOR` | Bearer token for API auth (read-only) |

## Register in Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "trading-paper-agent": {
      "command": "npx",
      "args": ["tsx", "C:/path/to/project/kaggle/mcp/trading_mcp_server.ts"],
      "env": {
        "STATUS_URL": "https://ai-quant-trader.duckdns.org/api/user/status",
        "STATUS_AUTH_TOKEN": "SPECTATOR"
      }
    }
  }
}
```

### Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Register in Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json` in your project root):

```json
{
  "mcpServers": {
    "trading-paper-agent": {
      "command": "npx",
      "args": ["tsx", "./kaggle/mcp/trading_mcp_server.ts"],
      "env": {
        "STATUS_URL": "https://ai-quant-trader.duckdns.org/api/user/status",
        "STATUS_AUTH_TOKEN": "SPECTATOR"
      }
    }
  }
}
```

## Example Tool Outputs

### `get_portfolio_status`
```json
{
  "btcPrice": 104230.5,
  "ai": {
    "totalValue": 10245.67,
    "realizedPnl": 245.67,
    "openPositions": 2,
    "totalTrades": 15,
    "positions": [
      { "asset": "BTCUSDT", "quantity": 0.01, "avgPrice": 102100 },
      { "asset": "ETHUSDT", "quantity": 0.5, "avgPrice": 3850 }
    ]
  },
  "human": {
    "totalValue": 10000,
    "totalTrades": 0
  }
}
```

### `get_latest_scan`
```json
{
  "scanId": "scan_20250620_143022",
  "completedAt": "2025-06-20T14:30:22.000Z",
  "counts": {
    "total": 12,
    "entries": 1,
    "holds": 5,
    "blocks": 4,
    "skips": 2
  },
  "mainBlockers": {
    "LOW_DATA_QUALITY": ["DOTUSDT", "AVAXUSDT"],
    "HTF_BEARISH": ["XRPUSDT", "ADAUSDT"]
  }
}
```

### `get_public_demo_summary`
```
=== Autonomous Paper Trading Agent — Live System Summary ===

⏸️  WATCHING: The AI is monitoring markets but has not entered new trades.
💰 AI Portfolio Value: $10,245
📊 Open Positions: 2 (BTCUSDT, ETHUSDT)
🔍 Last Scan: 12 minutes ago (fresh)
   Scanned 12 assets: 1 entries, 5 holds, 4 blocked
🩺 Data Feeds: 9 good, 2 degraded, 1 bad
🧠 Learning: Favorable setups identified in 3 of 12 assets

🛡️  SAFETY: This is a PAPER TRADING system. No real money is at risk.
   All trades are simulated. The system uses multi-gate risk checks
   before any entry: data quality, market structure, HTF alignment,
   liquidity, and conviction scoring.

🌐 Live Dashboard: https://ai-quant-trader.duckdns.org
```

## Architecture

```
┌─────────────────┐      stdio       ┌──────────────────┐      HTTPS      ┌─────────────────┐
│  Claude/Cursor   │ ◄──JSON-RPC──►  │  MCP Server      │ ◄──────────────  │  Trading API    │
│  (MCP Client)    │                  │  (this file)     │   GET /status   │  (Live System)  │
└─────────────────┘                  └──────────────────┘                  └─────────────────┘
```

## Protocol Details

- **Transport**: stdio (stdin/stdout)
- **Protocol**: JSON-RPC 2.0
- **MCP Version**: 2024-11-05
- **Methods**: `initialize`, `tools/list`, `tools/call`
- **Notifications**: `notifications/initialized` (acknowledged silently)
