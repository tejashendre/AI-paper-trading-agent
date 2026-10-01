# Project architecture index

Canonical technical architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Current audit: docs/STRATEGY_COVERAGE_AUDIT_2026-10-01.md. Asset router is authoritative in src/lib/market.ts; docs/ARCHITECTURE.md was refreshed for Release A on 2026-10-01 (all nine assets on Bybit linear USDT perpetuals on the branch). Active daemons are swingDaemon and crossSectionalDaemon, with separate simulated accounts.

Current implementation handoff: [Bybit all-asset upgrade plan](docs/superpowers/plans/2026-10-01-bybit-all-assets-upgrade.md). The plan proposes all nine Bybit linear USDT paths, immutable economics, full-position learning, risk-state repair, and measured strategy promotion. Release A (plan Tasks 1-7, 11 and the Release A part of 12) is implemented and tested offline on branch claude/bybit-all-assets-release-a, not merged or deployed; rollout steps are in docs/BYBIT_ALL_ASSETS_ROLLOUT_RUNBOOK.md. Public REST and WS availability evidence is in docs/BYBIT_ALL_ASSETS_MARKET_EVIDENCE_2026-10-01.json.
