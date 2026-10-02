# Documentation

## Current

| Document | What it covers |
|---|---|
| [Autonomy hardening verification, 2 October](./AUTONOMY_HARDENING_VERIFICATION_2026-10-02.md) | Current release candidate, completed handoff, 325-test proof, live gain cards, deeper charts, evidence limits and approval-gated release steps. |
| [Codex handoff, 2 October](./CODEX_HANDOFF_2026-10-02.md) | Original 20 fixes and remaining production observation requirements, with a pointer to current verification. |
| [Bybit all-asset implementation plan](./superpowers/plans/2026-10-01-bybit-all-assets-upgrade.md) | Full specification; complete upgrade deployed as c90483d. |
| [Complete upgrade verification](./BYBIT_COMPLETE_UPGRADE_VERIFICATION_2026-10-01.md) | Review fixes, 238-test validation, evidence limits and exact-artifact deployment proof. |
| [Strategy coverage audit, 1 October 2026](./STRATEGY_COVERAGE_AUDIT_2026-10-01.md) | Verified routing, full-position accounting, risk-state, and learning defects with linked evidence. |
| [Bybit all-assets rollout runbook](./BYBIT_ALL_ASSETS_ROLLOUT_RUNBOOK.md) | Release A state changes, entry freeze, read-only snapshot and migration preview, in-container checks, rollback hazards, recorded offline results, and evidence limits. Not a release authorization. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Operating contract, topology, and what the system deliberately is not. |
| [CROSS_SECTIONAL_MOMENTUM_2026-08-25.md](./CROSS_SECTIONAL_MOMENTUM_2026-08-25.md) | The ranked long/short perp book: why breadth is the mechanism, the robustness checks, and what was tested and rejected. |
| [EXIT_POLICY_AND_STOP_GEOMETRY_2026-08-25.md](./EXIT_POLICY_AND_STOP_GEOMETRY_2026-08-25.md) | The swing-engine repair: six competing dollar-threshold exit guards replaced by one R-based policy, and a stop widened to sit outside the signal's own noise. |
| [UPGRADE_ROADMAP.md](./UPGRADE_ROADMAP.md) | What would take this from 7/10 to 10/10, in what order, what the strategy's real capacity is, and what should deliberately never be built. |

Start with the October audit and implementation plan for current work. The August
research documents record earlier strategy and exit-policy experiments; their
performance figures are historical evidence, not a current live verdict.

## history/

Superseded plans and audits, kept because they record what was believed at the
time and why it changed. Nothing here describes current behaviour — several
documents propose designs that were later measured and rejected.

## notes/

Personal working notes. Gitignored, not part of the system.

## Verifying claims

Every performance number in the current documents is reproducible:

```bash
npm run replay:xsec        # cross-sectional book, 12 months of Bybit history
npm run replay:strategy    # swing engine, same cost model
npm run audit:strategy      # 94 invariant checks, also gates every deploy
```
