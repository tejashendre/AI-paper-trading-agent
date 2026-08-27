# Documentation

## Current

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Operating contract, topology, and what the system deliberately is not. |
| [CROSS_SECTIONAL_MOMENTUM_2026-08-25.md](./CROSS_SECTIONAL_MOMENTUM_2026-08-25.md) | The ranked long/short perp book: why breadth is the mechanism, the robustness checks, and what was tested and rejected. |
| [EXIT_POLICY_AND_STOP_GEOMETRY_2026-08-25.md](./EXIT_POLICY_AND_STOP_GEOMETRY_2026-08-25.md) | The swing-engine repair: six competing dollar-threshold exit guards replaced by one R-based policy, and a stop widened to sit outside the signal's own noise. |
| [UPGRADE_ROADMAP.md](./UPGRADE_ROADMAP.md) | What would take this from 7/10 to 10/10, in what order, what the strategy's real capacity is, and what should deliberately never be built. |

Read the two dated documents together. The first explains why the swing engine
alone could not become profitable; the second explains why it was losing money
faster than it had to.

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
