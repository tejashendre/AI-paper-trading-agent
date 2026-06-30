# Kaggle Capstone - Final Submission Assets Checklist

This checklist is the final packaging plan for the Autonomous Paper Trading Agent Kaggle submission.

Competition deadline from the provided rules: **July 6, 2026 at 11:59 PM PT** / **July 7, 2026 at 8:59 AM GMT+2**.

## Required Submission Items

| Item | File or link | Status |
| --- | --- | --- |
| Kaggle writeup | `kaggle/KAGGLE_WRITEUP_DRAFT.md` | Draft ready, needs final paste |
| Public YouTube video | To be recorded | Pending |
| Project link | `https://ai-quant-trader.duckdns.org` | Live, final access check recommended |
| GitHub repository | `https://github.com/tejashendre/AI-paper-trading-agent` | Ready after final push |
| Media gallery screenshots | Dashboard, architecture, CLI/MCP output | Pending |

## Kaggle Concepts Evidence

| Concept | Evidence to show | Where |
| --- | --- | --- |
| Agent / multi-agent system | Read-only reviewer agent audits bot state and safety | `agents/trading_reviewer_agent.py` |
| MCP Server | Read-only JSON-RPC tool server exposes status, scan, data health, learning summary | `mcp/trading_mcp_server.ts` |
| Antigravity | Show Antigravity editing/reviewing the repo in the video | Video segment 4:10-4:40 |
| Security features | Paper-only mode, read-only spectator token, no secret commits, admin separation | `kaggle/SECURITY_CHECKLIST.md` and video |
| Deployability | Live VPS dashboard, Docker/VPS scripts, GitHub repo | Video and README |
| Agent skills | CLI commands for status, scan explanation, and strategy audit | `npm run agent:status`, `npm run agent:explain`, `npm run agent:audit` |

## Video Recording Checklist

Target length: 4:30 to 5:00.

- [ ] Start with the live dashboard and one-sentence problem statement.
- [ ] Show the architecture diagram or README architecture section.
- [ ] Show spectator dashboard state and explain that it is paper trading only.
- [ ] Run `npm run agent:status`.
- [ ] Run `npm run agent:explain`.
- [ ] Run `python agents/trading_reviewer_agent.py`.
- [ ] Show MCP server file and one MCP tool response.
- [ ] Show `.env.local.example` only, never real `.env` files.
- [ ] Show Antigravity workflow in the IDE.
- [ ] End with GitHub link, live demo link, and safety disclaimer.

## Screenshot Checklist

- [ ] Live dashboard desktop view.
- [ ] Mobile dashboard view.
- [ ] Agent status CLI output.
- [ ] Reviewer agent report output.
- [ ] MCP tool list or tool response.
- [ ] Security checklist or `.env.local.example`.
- [ ] Architecture diagram from README or docs.

## Security Checklist Before Submission

- [ ] Do not upload `.env`, `.env.local`, private keys, SSH keys, Supabase service keys, exchange keys, or admin tokens.
- [ ] Confirm `.gitignore` excludes real secret files.
- [ ] Confirm public docs mention paper trading only.
- [ ] Confirm MCP server exposes no mutation tools.
- [ ] Confirm reviewer agent is read-only.
- [ ] Confirm video does not reveal terminals containing secrets.
- [ ] Confirm the live dashboard can be opened from an incognito browser.

## Suggested Kaggle Writeup Title

**Autonomous Paper Trading Agent: A Read-Only, Explainable AI Market Research System**

## Suggested YouTube Title

**Autonomous Paper Trading Agent - Kaggle AI Agents Capstone Demo**

## Honest Demo Notes

- This is a paper-trading research system, not a profit guarantee.
- The bot can win or lose simulated trades.
- The project value is the autonomous observation loop, risk controls, learning memory, live deployment, and explainability tooling.
- The DuckDNS live link may be blocked on strict corporate or school networks because some filters distrust dynamic DNS domains. The GitHub repository and YouTube video should be the reliable fallback evidence.

## Final Submit Order

1. Run local validation commands.
2. Push final code to GitHub.
3. Record and upload the YouTube video as public or unlisted.
4. Paste the writeup into Kaggle.
5. Add the YouTube link, GitHub link, live dashboard link, and screenshots.
6. Re-open the submitted Kaggle page in a fresh browser and verify every link works.
