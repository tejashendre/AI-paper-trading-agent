# Project architecture index

Canonical technical architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Current audit: docs/STRATEGY_COVERAGE_AUDIT_2026-10-01.md. Asset router is authoritative in src/lib/market.ts; docs/ARCHITECTURE.md was refreshed for Release A on 2026-10-01 (all nine assets on Bybit linear USDT perpetuals on the branch). Active daemons are swingDaemon and crossSectionalDaemon, with separate simulated accounts.

Implementation specification: [Bybit all-asset upgrade plan](docs/superpowers/plans/2026-10-01-bybit-all-assets-upgrade.md). Release A is deployed. The complete upgrade is implemented and reviewed on codex/bybit-complete-upgrade; exact-artifact cloud verification remains pending. Rollout steps: docs/BYBIT_ALL_ASSETS_ROLLOUT_RUNBOOK.md. Full review/evidence limits: docs/BYBIT_COMPLETE_UPGRADE_VERIFICATION_2026-10-01.md.

Deployed Release A: 191761f (2026-10-01), verified in docs/BYBIT_RELEASE_VERIFICATION_2026-10-01.md. Both daemons and dashboard share one image. Daily maintenance preserves accounts/history while compressing older ledger days and reclaiming unused Docker artifacts. The pending complete release adds a browser Bybit stream, with rendering capped at 100 ms, REST recovery and background-tab cleanup. Daemon entry scans remain 60 seconds and exit checks five seconds.

Remaining-upgrade branch codex/bybit-complete-upgrade implements two closed-bar families using one pure live/replay evaluator: trend baseline requires 4h ADX >=25, range reversion requires ADX <20 and starts research-only. Candidate identity combines instrument, family, config and completed setup bar. The daemon journals shadow candidates without portfolio writes.

Research preregisters 18 instrument/family baselines and reviews outcomes hourly. Review requires purged chronological folds, block-bootstrap net confidence, full-count Sharpe correction, cost stress, verified fees and forward shadow evidence. Eligibility never activates a strategy. Daemon capture keeps compressed closed bars and market summaries under a configurable 1 GiB limit. Offline capture/replay commands require explicit local paths. Bar replay shares admission and R exit thresholds but does not reproduce every watchdog tick, scale-in or baseline reversal; missing critical cost evidence blocks promotion.

Complete upgrade deployed as c90483d, verified 1 October 2026. All nine data-ready, 18 SHADOW research configurations, independent learning and bounded storage active. Full proof: docs/BYBIT_COMPLETE_UPGRADE_VERIFICATION_2026-10-01.md. Runtime code is complete; profitability, critical historical cost evidence and sufficient independent strategy samples remain unestablished.
