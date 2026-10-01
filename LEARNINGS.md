# Project learnings

- Browser display can consume Bybit's public stream independently of daemon scan cadence. Rendering each message is unnecessary; latest-state rendering at up to 10 Hz is sufficient and carries no tick archive.
- Increasing uncertainty pushes a below-benchmark Sharpe probability toward 0.5. The audit's fat-tail comparison must use a Sharpe above its full-trial benchmark to assert lower confidence; changing the trial count exposed the old fixture's wrong-tail assumption.

- Trial count means attempted configurations, including variants under the same display version. A discount without measured covariance overstates evidence.
- A hypothetical result must use closed prices inside its label window. Delayed evaluation cannot substitute the current live price.
- Shadow bar replay is descriptive when funding, fee or execution evidence is incomplete. Raw candidate counts are not independent completed trades.

Audit findings will be recorded after verification. Existing technical decisions are in docs/ARCHITECTURE.md and dated research documents.
## 2026-10-01 verified findings
- Feed health is distinct from entry capability: a category-based legacy gate can reject correctly routed instrument snapshots.
- Learning must aggregate partial and final exits by stable position identity. Excluding partial profits can invert the sign of a profitable strategy's learned outcome.
- A lifetime-maximum-drawdown gate that skips the entire rebalance freezes a book indefinitely and can starve fresh edge reviews while leaving open risk.
- Existing invariant audits passed despite these economic defects. Replayable execution fixtures and full-position accounting fixtures are required.
- Current exposed history is late-August onward, not continuous evidence from May. Never equate fill count, scan count, or an earlier favorable replay with established edge.

## 2026-10-01 Bybit plan evidence

- All nine configured assets have public Bybit linear USDT metadata, candles, and observed WS ticker messages. Bybit FX perpetuals resolve the earlier mixed-venue choice; they are separate from MT5 CFDs.
- USDJPYUSDT has linear USDT settlement. The old synthetic USDJPY quantity/notional and JPY conversion cannot be reused or retroactively reinterpreted.
- Metadata reports four-hour funding for gold/silver and eight-hour funding for the other seven at this capture. Refresh per symbol and settle actual boundaries with idempotent signed cashflows.
- New FX contracts have only four weekly bars including the unfinished bar. Optional weekly features must be unavailable/neutral while real history accumulates; required shorter-horizon features have independent warm-up gates.
- Bybit WS and REST improve transport continuity but remain one venue. Do not present them as two independent market sources.

## 2026-10-01 Release A implementation
- For every USD-quoted asset the legacy synthetic and Bybit linear formulas are numerically identical (quantity x price move). Only USDJPY differs, so the frozen-model dispatch matters most there, and labeling FX entries as Bybit before their sizing is linear would create 150x mis-sized USDJPY risk.
- Migration that only adds labels and records `migrationAddedFields` is reversible by deletion and lets the original hash be recomputed after migration, which makes idempotency testable.
- Lineage must be migrated per account. A single trade list across accounts can attach one account's legs to another account's position.
- The coverage diagnostic needs a raw live status snapshot; retain one (sanitized of secrets, not of trades) whenever a rerunnable baseline is wanted.
- An end-to-end fixture through the real daemon found defects that 176 unit tests had not: event ordering in the ledger and three misattributed veto codes. Coverage explanations must be tested from the scan's output, not from the helper that produces them.
- A trailing runner ignores the fixed take-profit by design (the trailing stop owns the exit). Tests that cross a target after a partial exit must cross the stop instead.
- `PortfolioManager.getPortfolio` resets an invalid portfolio and `getTrades` rewrites from backups; read-only exports must use raw Redis reads.
- The ledger hash is a plain JSON.stringify of the record, so the pre-upgrade verifier accepts new event types and a code rollback does not require discarding events. New linear non-crypto positions are the real rollback hazard.
- Node's mock timers must be enabled before importing modules that capture `Date.now` at load (the default metadata cache does).

## Release review lessons (2026-10-01)
A release entry freeze must preserve real evaluations and scan advancement or the deployment verifier deadlocks. Missing funding is pending evidence, regardless of age. Changing economics requires a new strategy cohort before old learned rules are reused. Ledger maintenance must verify a fixed hash prefix because live writers can append during compression. Remove dependencies only after proving their execution paths have no callers; keep historical readers. Exclude build cache before copying the builder layer into the production image.

Production restart verification requires a scan from the deployed commit, not merely a Redis key. Preserve scan IDs across restarts and allow the prior five-minute lease to expire safely. Do not delete active write locks to make a deployment check pass.

A degraded candle-quality badge does not mean a disconnected quote feed. Report connection state, quote receipt age, last-trade age and candle quality separately. Bybit derivative ticker cadence is 100 ms, while the shipped pipeline batches Redis and polls the browser at 1000 ms each. Quiet markets and clock offsets prevent interpreting a timestamp as a guaranteed end-to-end latency.

Positive confidence learning can silently increase leverage even when a separate risk multiplier is capped. Strip the positive adjustment from sizing inputs, then verify leverage, margin and stop risk against the unboosted admission result. Complete-position provenance must flow from the opening fill through partial/final exits; setup text is not a strategy configuration identity.
