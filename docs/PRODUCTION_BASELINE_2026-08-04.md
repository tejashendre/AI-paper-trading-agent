# Production Baseline Before Strategy Remediation

**Captured:** 2026-08-04
**Capital mode:** PAPER_ONLY
**Purpose:** Preserve the pre-remediation operating evidence before deployment or reset.

## Release Identity

- Local HEAD: `c0694e872de5ac41fe6a3b5b37b5b0ac9b68a678`
- GitHub `origin/main`: `c0694e872de5ac41fe6a3b5b37b5b0ac9b68a678`
- VPS reported commit: `c0694e872de5ac41fe6a3b5b37b5b0ac9b68a678`
- VPS reported deployment time: `2026-07-29T13:14:17Z`
- Existing strategy version: `swing-v4.1.0-2026-07-20`

## Runtime State

- Latest observed scan: `#8156`
- Scan completion: `2026-08-04T05:10:02.221Z`
- Assets evaluated: `9`
- Decisions: `9 HOLD`, `0 entry`, `0 error`
- Open AI positions: `0`
- AI equity: `9876.832377 USD`
- Realized PnL: `-123.167623 USD`
- Closed trades: `5`
- Wins / losses: `0 / 5`
- Consecutive losses: `5`
- Maximum drawdown: `1.231676%`
- Recorded execution costs: `22.125344 USD`

The scan was advancing, so the daemon was not dead. The evidence instead showed an admission and expectancy problem: the bot evaluated markets continuously but had no validated reason to take more risk after five losses.

## Defects Reproduced From The Cohort

1. A `CONTROLLED_PROBE` BTC short was recorded as `STRONG` at `5x`. Conviction-based leverage promotion ignored entry mode.
2. Crypto candles, live ticks, order-book signals, funding, and lifecycle prices could describe different venue instruments while the cost model claimed Bybit perpetual execution.
3. A generic `market:live:<asset>` key allowed whichever WebSocket wrote most recently to become the execution price.
4. Negative learning could still pass the exception or controlled-probe entry path.
5. Daily and weekly PnL circuits existed, but no correlated sequence circuit stopped three full crypto stop-outs as a distinct regime failure.
6. Target reachability used favorable range without proving that target occurred before stop.

## Release Boundary

This baseline is evidence, not a profitability estimate. Five losses are enough to reject the claim that the current strategy has demonstrated an edge, but too few to estimate its long-run win rate reliably.

The approved reset must occur only after the corrected release is deployed and verified. It must preserve the immutable execution ledger, clear current-version derived state and transient keys, request a new autonomous scan, and prove that the scan advances with coherent selected-venue data.
