# Kaggle AI Agents Capstone - Submission Workspace

This folder contains the Kaggle-facing evidence for the Autonomous Paper Trading Agent. The trading core remains in the main app; this folder packages the project story, demo script, security checklist, and read-only agent tools so the submission is easy for judges to inspect.

Recommended track: **Freestyle**

## What This Folder Proves

| Kaggle concept | Evidence | Status |
| --- | --- | --- |
| Agent / multi-agent system | `agents/trading_reviewer_agent.py` and `kaggle/agents/trading_reviewer_agent.py` | Implemented |
| MCP Server | `mcp/trading_mcp_server.ts` and `kaggle/mcp/trading_mcp_server.ts` | Implemented |
| Antigravity | `kaggle/KAGGLE_VIDEO_SCRIPT.md` and `docs/KAGGLE_CAPSTONE_ANTIGRAVITY_BRIEF.md` | Video evidence required |
| Security features | `kaggle/SECURITY_CHECKLIST.md`, `.env.local.example`, read-only spectator/API tools | Implemented, final manual check required |
| Deployability | Live dashboard plus Docker/VPS deployment files | Implemented |
| Agent skills | `npm run agent:status`, `npm run agent:explain`, `npm run agent:audit` | Implemented |

## Folder Map

```text
kaggle/
  README.md                         Submission workspace overview
  KAGGLE_WRITEUP_DRAFT.md           Paste-ready Kaggle writeup draft
  KAGGLE_VIDEO_SCRIPT.md            5-minute YouTube demo script
  SUBMISSION_ASSETS.md              Final checklist and media plan
  SECURITY_CHECKLIST.md             Secret/security review checklist
  DOMAIN_SETUP.md                   Optional domain and Cloudflare plan
  agents/
    trading_reviewer_agent.py       Read-only ADK-style reviewer agent
  mcp/
    trading_mcp_server.ts           Read-only MCP server
  scripts/
    agent-status.ts                 CLI status skill copy
    explain-latest-scan.ts          CLI explanation skill copy
```

Root-level copies also exist for judge-friendly paths:

```text
agents/trading_reviewer_agent.py
mcp/trading_mcp_server.ts
scripts/agent-status.ts
scripts/explain-latest-scan.ts
```

## How To Demo

Run these from the repository root:

```bash
npm run agent:status
npm run agent:explain
npm run agent:audit
```

Run the reviewer agent:

```bash
python agents/trading_reviewer_agent.py
```

List MCP tools:

```bash
npx tsx mcp/trading_mcp_server.ts
```

Then send a JSON-RPC `tools/list` request from an MCP client or terminal.

## Safety Boundary

The Kaggle tools are intentionally read-only. They query the spectator status API and generate reports. They do not place trades, close positions, reset portfolios, write to the database, or expose secrets.

The live system is paper trading only for this submission. It is a research and explainability demo, not financial advice and not a real-money trading product.

## Remaining Human Tasks

1. Record the YouTube video using `kaggle/KAGGLE_VIDEO_SCRIPT.md`.
2. Paste `kaggle/KAGGLE_WRITEUP_DRAFT.md` into the Kaggle writeup.
3. Attach the public GitHub link: `https://github.com/tejashendre/AI-paper-trading-agent`.
4. Attach the live project link: `https://ai-quant-trader.duckdns.org`.
5. Complete `kaggle/SUBMISSION_ASSETS.md` after the video and screenshots are created.
