# Bybit All-Asset Trading and Learning Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Claude Code can follow the same ordered test, implementation, and review steps directly.

**Goal:** Give every configured asset a correctly modeled Bybit paper-trading path, explain every entry veto, and improve strategies through measured, cost-aware research without a mandatory LLM or paid service.

**Architecture:** Keep the existing Next.js dashboard, Node daemons, Redis storage, paper accounts, and execution ledger. One instrument registry and one public Bybit client provide identity, metadata, and provenance for both execution and research. Complete-position outcomes feed bounded learning and shadow candidates; independent risk controls keep working when entries are halted.

**Tech Stack:** Existing TypeScript, Node 20, Next.js 15, Redis/ioredis, ws, zod, tsx, and node:test. Bybit V5 public REST and public linear WebSocket. No new framework, exchange SDK, Python service, database, or model API is required.

**Spec:** [Verified strategy audit](../../STRATEGY_COVERAGE_AUDIT_2026-10-01.md), [actual-code diagnostic evidence](../../STRATEGY_COVERAGE_EVIDENCE_2026-10-01.json), [runtime snapshot](../../STRATEGY_RUNTIME_EVIDENCE_2026-10-01.json), and [new public Bybit verification](../../BYBIT_ALL_ASSETS_MARKET_EVIDENCE_2026-10-01.json). The user's latest instruction chooses Bybit for all configured assets; this supersedes the audit's earlier alternatives for Kraken/Yahoo forex routing.

**Status:** Ready for implementation review. This document describes proposed behavior. No trading source or deployed account has been changed by writing it.

## Global Constraints

- Configured universe: BTC, ETH, SOL, EURUSD, GBPUSD, USDJPY, GOLD, OIL, SILVER. Preserve these public asset keys and their crypto/forex/commodity risk classes.
- New autonomous entries use Bybit USDT linear perpetuals. OIL means WTI `CLUSDT`, not Brent. FX perpetuals are distinct from MT5 CFDs and spot forex.
- Active price, candle, depth, trade-flow, open-interest, funding, and instrument-metadata connections use Bybit. Disable Kraken, Yahoo, Binance, and CoinGecko fallback/comparison requests on active trading paths. Old data-source types remain readable for historical records.
- Use public market endpoints without an API key. Paper trading remains the default and the only execution mode covered here. No authenticated order endpoint or live-money enablement belongs in this upgrade.
- Preserve all existing portfolios, manual positions, history, equity curves, ledger files, and learning evidence. No account reset, historical re-pricing, deleted Redis keys, or automatic conversion of legacy quantity units.
- Preserve current class leverage ceilings of 5x crypto, 5x forex, and 3x commodities, the 10% per-position margin cap, and the $50 minimum margin policy. The venue's higher leverage limits do not increase these policies. Reject orders that cannot satisfy venue minimums within the risk budget.
- No mandatory LLM, paid market data, hosted vector store, additional VPS, or new recurring subscription. Existing compute/storage still have operating costs and provider availability limits; no service's free tier is guaranteed forever.
- Do not loosen an admission threshold just to make every asset trade. Coverage means every asset can be evaluated and can enter when data, setup, costs, and risk permit it.
- Use ASCII hyphens and follow the project's AGENTS.md and Memory Quad. Never read, stage, log, or commit secrets, live databases, `.env` files, or SSH keys.
- Work on a feature branch or authorized worktree. A push to `main` currently deploys production. This plan authorizes no push to `main`, merge, deployment, live state migration, or external publication.
- Refresh the runtime snapshot before implementation. The 1 October balances, positions, fees, instrument status, and metadata are observations, not permanent constants.

## Review Focus

1. A supported asset with the wrong symbol, missing metadata, or a stale/future quote must fail entry admission even if a socket is connected. Tests: Tasks 1, 3, and 4.
2. A legacy USDJPY position or a position with partial exits must retain its own economic model and learn from one complete net outcome. Tests: Tasks 2, 5, and 6.
3. A quiet TradFi book, unfinished higher-timeframe bar, or short listing history must produce explicit liquidity/warm-up restrictions without fake candles or another venue's fallback. Tests: Tasks 3, 4, and 8.
4. A drawdown breach, feed outage, restart, or interrupted funding/migration write must block additional risk while preserving state and retryable risk-reducing operations. Tests: Tasks 2, 5, 7, and 12.
5. Overlapping opportunities, repeated tuning on a holdout, and a negative shadow candidate must never become misleading evidence of learning or trigger an unsafe promotion. Tests: Tasks 9 and 10.

---

## 1. Verified venue decision and migration implications

On 1 October 2026, all nine symbols returned `retCode=0`, `status=Trading`, `contractType=LinearPerpetual`, `quoteCoin=USDT`, and `settleCoin=USDT` from the public instruments endpoint. REST candles succeeded for all nine at intervals `15`, `60`, `240`, and `W`. A 25-second public WebSocket probe received a ticker snapshot and subsequent deltas for every symbol. Evidence is saved in the linked JSON; this proves public data availability, not an account's authorization to trade.

| Asset key | Risk class | Bybit symbol | Observed funding interval | Weekly bars returned, including current bar |
|---|---|---|---|---:|
| BTC | crypto | BTCUSDT | 480 minutes | 200 |
| ETH | crypto | ETHUSDT | 480 minutes | 200 |
| SOL | crypto | SOLUSDT | 480 minutes | 200 |
| EURUSD | forex | EURUSDUSDT | 480 minutes | 4 |
| GBPUSD | forex | GBPUSDUSDT | 480 minutes | 4 |
| USDJPY | forex | USDJPYUSDT | 480 minutes | 4 |
| GOLD | commodity | XAUUSDT | 240 minutes | 30 |
| OIL | commodity | CLUSDT | 480 minutes | 28 |
| SILVER | commodity | XAGUSDT | 240 minutes | 30 |

The funding values are metadata observations and must be refreshed, not hardcoded by class. Bar counts come from a `limit=200` request, not a complete historical archive. The FX contracts currently have only three completed weekly bars; a weekly feature requiring 20 bars must be unavailable, with neutral contribution, until enough real history exists. Required 15m/1h/4h features still have their own warm-up requirements.

USDJPY is the highest-risk migration detail. The old synthetic model treats its quantity as USD exposure and divides JPY profit by the exit price. A new `USDJPYUSDT` linear contract uses contract quantity times price change, settled in USDT. For a new long of quantity 10 at 150, closed at 151, gross P&L is 10 USDT and entry notional is 1,500 USDT. These formulas must never be applied retroactively to old synthetic quantities.

Snapshot forex turnover was roughly 94,000 to 131,000 USDT over 24 hours, with EURUSD and USDJPY spreads around 4.33 and 6.65 bps. These are single observations, not fixed cost assumptions. A functioning connection alone does not establish executable depth or a profitable strategy. Gate size from live depth, measured spread, and participation limits.

Official references for the executor:

- [FX perpetual product and symbol overview](https://www.bybit.com/en/learn/bybit-tradfi/what-are-fx-perpetual-contracts-bybit).
- [Instrument metadata](https://bybit-exchange.github.io/docs/v5/market/instrument), [public ticker snapshot/delta semantics](https://bybit-exchange.github.io/docs/v5/websocket/public/ticker), and [funding history](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate).
- [USDT linear contract P&L](https://www.bybit.com/en/help-center/article/Profit-Loss-calculations-USDT-Contract).
- [Published fee structure](https://www.bybit.com/en/help-center/article/Trading-Fee-Structure) and [commodity TradFi fee announcement](https://announcements.bybit.com/en/article/tradfi-perpetuals-lower-fees-across-all-tiers-bltb196506dada4be39/).

Fee policy: record a versioned public VIP0 baseline, not a claim about an authenticated account. Crypto baseline is maker 0.0002/taker 0.00055. The cited commodity schedule supports maker 0/taker 0.000275 for XAU/XAG/CL. Its June scope does not explicitly establish the September FX contracts' fee group. Until an official current source confirms each FX symbol's fee schedule, use maker 0.0002/taker 0.00055 as a labeled `UNVERIFIED_STRESS_RATE` for paper/shadow calculations and block strategy promotion for that cost cohort. Do not assume zero FX fees or silently apply a promotional rate. Public fee assumptions and their effective dates must be visible and replaceable without rewriting historical fills.

## 2. Deliverables, file boundaries, and release order

This is one coordinated plan with three independently reviewable releases:

| Release | Deliverable | Required tasks | Release condition |
|---|---|---|---|
| A | All nine Bybit paper paths, correct settlement, position outcomes, continuing risk management, and truthful health | 1-7, 11, relevant checks in 12 | Offline integration and migration fixtures pass; owner reviews release artifact |
| B | Two bounded strategy families and instrument-scoped learning | 8-9, 11, relevant checks in 12 | Shadow results and veto funnels exist for all nine; no unsupported risk increase |
| C | Reproducible research and evidence-gated promotion | 10-12 | Purged evaluation, complete trial registry, cost stress, and rollback checks pass |

Implement in numeric order by default. Release A can be reviewed before Tasks 8-10 are deployed. A code checkpoint is not permission to deploy an incomplete dependency chain. Local commits, if appropriate under repository instructions, include only each task's listed files. Never use `git add .`.

Keep existing modules. Add only these focused runtime boundaries:

| New module | Responsibility |
|---|---|
| `src/lib/trading/instrumentRegistry.ts` | Configured symbols, verified metadata, instrument/economic identity |
| `src/lib/data/bybitPublic.ts` | Public REST transport, bounded retry, endpoint validation |
| `src/lib/trading/entryEligibility.ts` | Shared provenance and data eligibility decision |
| `src/lib/trading/positionOutcomes.ts` | Reconcile legs to one complete economic outcome |
| `src/lib/execution/bookRiskPolicy.ts` | Pure cross-sectional book risk-state decisions |
| `src/lib/research/candidateRegistry.ts` | Bounded experiment definitions, trial identity, promotion verdict |

Prefer extending the existing market service, execution cost model, opportunity journal, local learning, replay engine, and walk-forward modules to adding parallel replacements. Test files below are new. Use `node:test` plus `node:assert/strict`, invoked with existing `tsx`. Extract pure decisions from daemon loops so importing a unit test does not start a daemon or touch Redis.

## 3. Shared contract definitions

These names are proposed interfaces, not claims that the functions already exist. Define each type in the owning module indicated below and use type-only imports to avoid cycles. Existing API fields remain backward compatible while new fields carry explicit units.

```ts
// instrumentRegistry.ts
type ConfiguredAsset = "BTC" | "ETH" | "SOL" | "EURUSD" | "GBPUSD" |
  "USDJPY" | "GOLD" | "OIL" | "SILVER";
type EconomicsModel = "BYBIT_LINEAR_USDT_V1" | "LEGACY_SYNTHETIC_V1" |
  "LEGACY_PAPER_V1";
type InstrumentRef = {
  asset: ConfiguredAsset; symbol: string; venue: "BYBIT" | "LEGACY";
  economicsModel: EconomicsModel; instrumentVersion: string;
  settlementCurrency: "USDT" | "USD_PROXY";
};
type BybitInstrumentMetadata = {
  symbol: string; status: string; contractType: string;
  baseCoin: string; quoteCoin: string; settleCoin: string;
  launchTimeMs: number; fundingIntervalMinutes: number;
  tickSize: string; qtyStep: string; minOrderQty: string;
  maxMarketOrderQty: string; minNotional: string; maxLeverage: number;
  symbolType: string; verifiedAtMs: number; metadataVersion: string;
};

// entryEligibility.ts
type EntryEligibility = {
  allowed: boolean;
  state: "READY" | "BLOCKED_DATA" | "WARMING_UP" | "BLOCKED_LIQUIDITY";
  reasons: string[]; instrumentVersion: string;
};

// positionOutcomes.ts
type CompletedPositionOutcome = {
  positionId: string; asset: ConfiguredAsset; instrument: InstrumentRef;
  direction: "LONG" | "SHORT"; openedAtMs: number; closedAtMs: number;
  strategyVersion: string; setupFamily: string; regime: string;
  configHash: string; dataSchemaVersion: string;
  costModelVersion: string; riskPolicyVersion: string; setupTags: string[];
  grossPnlUsdt: number; feesUsdt: number; fundingCashflowUsdt: number;
  netPnlUsdt: number; initialRiskUsdt: number; netR: number | null;
  returnOnInitialMargin: number; legIds: string[];
};
```

Retain the existing `usd`/`pnl` API aliases for compatibility. Add `accountingCurrency` to accounts and expose USDT values explicitly. Existing account capital is a historical nominal USD proxy; migrate it with a labeled 1 USD_PROXY = 1 USDT paper-account assumption and a migration marker, not a claim of an executed currency conversion. Store original historical currency/model. Cross-account research must disclose this assumption. No result claims real USD valuation unless a separately specified USDT/USD conversion source exists.

Instrument/cohort versions describe a mapping and economic/data definition, not the latest fetch time. Derive a stable instrument version from symbol plus economic definition; a six-hour metadata refresh alone does not create a new learning cohort. Metadata filter changes get their own deterministic content hash excluding `verifiedAtMs`. Strategy configuration, data-schema, fee, and risk-policy revisions have separate version/hash fields.

## Task 1: Authoritative registry and public Bybit metadata client

**Files:**
- Create: `src/lib/trading/instrumentRegistry.ts`, `src/lib/data/bybitPublic.ts`.
- Modify: `src/lib/market.ts` asset configuration and provider/cache-key helpers; `src/lib/data/perpUniverse.ts` public transport.
- Test: `tests/bybit-registry.test.ts`, `tests/bybit-public.test.ts`.

**Interfaces:**
- Produces: `getConfiguredInstrument(asset: string): InstrumentRef`, `validateBybitMetadata(expectedSymbol: string, raw: unknown, nowMs: number): BybitInstrumentMetadata`, `isMetadataUsable(metadata: BybitInstrumentMetadata, nowMs: number): boolean`. Symbol-based validation also supports the existing broader crypto XSEC universe without pretending those symbols are configured swing assets.
- Produces: `bybitPublicGet<T>(path: string, options?: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; nowMs?: () => number; sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void> }): Promise<{ result: T; serverTimeMs: number }>` and `getBybitInstrumentMetadata(symbol: string): Promise<BybitInstrumentMetadata>`.
- Produces the shared registry types. Keep `SUPPORTED_ASSETS` as a compatible exported view derived from this registry, with category unchanged.

- [ ] Write `registry_covers_exactly_nine_symbols` with the table in Section 1. Assert every active reference uses `BYBIT_LINEAR_USDT_V1`, every quote/settlement is USDT, OIL is CLUSDT, and `getConfiguredInstrument("UNKNOWN")` throws rather than returning BTC. `metadata_rejects_wrong_or_untradeable_contract` asserts wrong symbol, non-Trading status, inverse contract, missing lot filter, nonpositive step, or non-USDT settlement is rejected. Metadata with age over 24 hours is unusable for new entries; a last valid copy may still describe existing positions.
- [ ] Write `public_client_retries_boundedly_and_rejects_bad_payloads`: injected fetch returns HTTP 429, then 200/retCode 0; succeeds in at most three total attempts. Permanent 403 and nonzero retCode reject. Set per-attempt timeout 8 seconds, jittered backoff between 250 and 2,000ms, a total 30-second budget, and honor abort. Tests use an injected clock/scheduler internally, with no real sleeps/network.
- [ ] Run `npx tsx --test tests/bybit-registry.test.ts tests/bybit-public.test.ts`; expect failure because the new interfaces are absent.
- [ ] Implement the registry/client and derive the nine mappings. Validate responses with existing zod. Cache metadata for six hours and revalidate before admitting an entry when cache age exceeds six hours; fail closed if refresh fails and age exceeds 24 hours. Keep last valid metadata for exit sizing. Page the instruments list when screening the broader XSEC universe; a single default page is not the whole linear market.
- [ ] Run the same tests and `npx tsc --noEmit --incremental false`; expect pass. Review decimal strings without silently converting missing values to zero. Checkpoint only the listed files with message `feat: centralize Bybit instrument metadata`.

## Task 2: Immutable position economics and reversible state migration

**Files:**
- Modify: `src/lib/types.ts` OpenPosition/Trade/Portfolio; `src/lib/trading/assetSpecs.ts`; `src/lib/portfolio.ts`; `src/lib/trading/executionLedger.ts`; `src/daemon/swingDaemon.ts` position creation; `src/lib/execution/swingLifecycle.ts`; `src/lib/execution/paperExchange.ts` compatibility.
- Create: `scripts/migrate-bybit-instruments.ts`.
- Test: `tests/instrument-migration.test.ts`.

**Interfaces:**
- Consumes Task 1's `InstrumentRef` and `getConfiguredInstrument`.
- Produces mandatory `positionId`, `instrument`, `economicsModel`, `initialRiskUsdt`, `costModelVersion`, and `riskPolicyVersion` on new autonomous positions and their legs.
- Produces `planInstrumentMigration(input: { portfolios: Portfolio[]; trades: Trade[]; nowMs: number }): { migratedPortfolios: Portfolio[]; migratedTrades: Trade[]; conflicts: string[]; originalHash: string; migrationVersion: string }`. Keep it pure and exported from the migration script without running its CLI on import.
- CLI: `npx tsx scripts/migrate-bybit-instruments.ts --input <snapshot.json> --output <preview.json>` defaults to offline preview. A live apply mode is an explicit separate operation after release approval; never make the default touch production Redis.

- [ ] Write `legacy_usdjpy_model_survives_new_registry`: a legacy USDJPY long, entry 150/exit 151/quantity 10, still calculates `10 / 151` in its historical model; a new Bybit reference is not written onto it. Unknown legacy provenance appears in `conflicts` and blocks that asset's new entries until resolved. Manual paper positions retain their execution model.
- [ ] Write `migration_is_idempotent_and_preserves_history`: applying the pure migration twice gives identical position IDs, balance, equity curve, original leg P&L, and original hashes. Assert +15 partial/-5 final legs are assigned the same inferred historical position only when asset/direction/entry-time lineage is unambiguous. Scale-in ambiguity and conflicting entry metadata are reported, not guessed.
- [ ] Run `npx tsx --test tests/instrument-migration.test.ts`; expect failure for missing migration/economic identity.
- [ ] Implement a schema version and migration journal. New positions use a UUID once, propagated to scale-ins and exits. Old records are read through a compatibility adapter; originals are preserved and never appended to the hash ledger as rewritten old events. Store deterministic historical identity only after validating actual entry/scale/exit lineage. Preview account unit labeling and quantity-model changes independently. During deployment, pause entry writers for the brief migration window, use a backup plus version check, and prevent partial migration from being treated as complete. Re-running resumes or safely rejects by migration marker.
- [ ] Run the tests and TypeScript check. Produce a migration preview from a sanitized fixture, not current live state. Checkpoint listed files with message `feat: version position identity and contract economics`.

## Task 3: Bybit-only quotes, all candle intervals, sensors, and feed health

**Files:**
- Modify: `src/daemon/websocketDataMesh.ts`; `src/lib/market.ts`; `src/lib/data/freeDataMesh.ts`; `src/lib/data/feedHealth.ts`; `src/lib/data/feedHealthSummary.ts`; `src/lib/data/sourceAgreement.ts`; `src/lib/trading/marketSession.ts`; `src/lib/data/perpUniverse.ts`; `src/lib/types.ts` market-frame/provenance fields.
- Test: `tests/bybit-market-data.test.ts`, `tests/bybit-websocket.test.ts`.

**Interfaces:**
- Consumes Task 1's registry/client/metadata.
- Produces extended `MarketPriceSnapshot` with `instrumentVersion`, `eventTimeMs`, `receivedAtMs`, `transport: "WS" | "REST"`, bid/ask, mark/index, and per-field quote freshness.
- Produces `mergeBybitTicker(previous: BybitTickerState | null, message: unknown, receivedAtMs: number): BybitTickerState | null` as a pure exported function in `websocketDataMesh.ts` or the shared data module if importing the daemon starts loops.
- Produces `closedCandles(candles: Candle[], timeframe: Timeframe | "1w", serverTimeMs: number): Candle[]` in `market.ts` and `MarketService.getInstrumentMetadata(assetKey: string): Promise<BybitInstrumentMetadata>`.
- Preserve `MarketService.getCandles`, `getCurrentPrice`, `getWeeklyCandles`, and `getDeepSensors` call signatures. All nine execute their Bybit branches.

- [ ] Write `all_assets_use_bybit_for_all_market_paths` with an injected/mock transport. For all nine, assert 1m/5m/15m/30m/1h/4h/W, ticker, depth, funding, and OI requests use the expected symbol. Make mocked Yahoo/Kraken/Binance/CoinGecko requests throw; none may occur. Unknown assets fail explicitly. The weekly path must no longer branch on `category === "crypto"`.
- [ ] Write `ticker_snapshot_delta_reconnect_and_quiet_price`: a snapshot initializes state; funding-only deltas do not refresh bid/ask or last-price timestamps; an older delta is ignored; a reconnect invalidates prior-session state until a new snapshot. A ping/pong or successful subscription does not count as a fresh quote. A valid REST bid/ask snapshot can refresh a quiet market without pretending it came from WS.
- [ ] Write `higher_timeframe_features_are_causal`: current 4h/W bars are excluded using exchange server time. A prefix of input history produces the same already-closed bars/features when later bars are appended. Missing bars are flagged; remove normalization that repairs a historical bar using the next bar's open. Never manufacture OHLC/volume or splice spot/futures proxy history into a perpetual series.
- [ ] Run `npx tsx --test tests/bybit-market-data.test.ts tests/bybit-websocket.test.ts`; expect routing/delta/closed-bar failures.
- [ ] Implement Bybit subscriptions for all configured symbols, clear session state on reconnect, and store event time separately from receipt time. Use Bybit REST for transport recovery with original instrument provenance. Cache keys include symbol, instrument/data schema version, interval, and bar cutoff. Remove active legacy quote caches from selection without deleting historical keys. Fetch funding/OI/depth for every mapped instrument, independent of strategy speed. Missing sensors are unavailable, not zero or a bullish/neutral observation.
- [ ] Replace the two-independent-WS-source policy with an explicit single-venue policy: WS and REST are two transports from one venue, with `independentVenues=1`. Report transport consistency, not fabricated multi-venue agreement. Live last/mark/index/bid/ask differences have different meanings and are not identical-price assertions. Standard swing entries may use valid fresh REST quotes; any faster entry branch still requires a fresh WS quote plus valid spread/depth. Do not add a scalp mode. The existing sentiment/news modules can remain optional context but cannot supply price fallback, gate execution, or become a required external connection; default `includeSentiment=false` on automated paths.
- [ ] Make contract session status 24/7 while retaining separate underlying-liquidity windows and weekend/holiday warnings for TradFi. Stop labeling a gold/FX perpetual "Crypto market is open" or treating every hour as peak liquidity. Keep risk class unchanged.
- [ ] Run both tests and TypeScript check. Checkpoint listed files with message `fix: route every configured market path through Bybit`.

## Task 4: Shared provenance, warm-up, and executable-data gate

**Files:**
- Create: `src/lib/trading/entryEligibility.ts`.
- Modify: `src/daemon/swingDaemon.ts` legacy gate at the quote/admission boundary; `src/lib/trading/tradeAdmission.ts`; `src/lib/swingEngine.ts`; `src/lib/data/feedHealthSummary.ts`; `src/app/api/health/feeds/route.ts`; `scripts/coverage-learning-audit.ts`.
- Test: `tests/entry-eligibility.test.ts`.

**Interfaces:**
- Consumes registry metadata and Task 3's actual snapshots/closed bars.
- Produces `evaluateEntryEligibility(input: { instrument: InstrumentRef; metadata: BybitInstrumentMetadata | null; quote: MarketPriceSnapshot | null; closedBarCounts: { m15: number; h1: number; h4: number; w1: number }; nowMs: number; fastExecution: boolean; depthAvailable: boolean }): EntryEligibility`.
- Produces one data eligibility object reused by daemon, admission, and health API. Cost/risk/strategy eligibility are additional facets, not collapsed into this object's `allowed`.

- [ ] Write `nine_correct_symbols_pass_data_gate` using fresh Trading metadata, positive uncrossed bid/ask, and 100 completed 15m/1h/4h bars. For each asset, allowed is true. Set weekly bars to three for FX: allowed remains true, with `WEEKLY_FEATURE_UNAVAILABLE` in reasons and zero weekly feature contribution. Intraday counts below 100 return `WARMING_UP`; additional required 1m/5m feature warm-up stays explicit in the engine if that branch uses it.
- [ ] Write table negatives for every asset: wrong provider/symbol/version, NaN or nonpositive price, crossed bid/ask, missing quote timestamp, stale quote older than 10 seconds, future quote over two seconds, or unusable metadata all block. Funding-only WS delta and a candle-close price fallback cannot satisfy execution quote freshness. A fresh REST quote passes standard swing but cannot authorize a branch requiring fresh WS.
- [ ] Run `npx tsx --test tests/entry-eligibility.test.ts`; expect missing helper or legacy category-gate failures.
- [ ] Implement the pure helper and replace the crypto/non-crypto provenance branch. Use per-field quote timestamps and exchange-clock offset; reject excessive clock uncertainty instead of extending freshness globally. Exits call their own risk-reducing quote validation and must not depend on entry warm-up/learning vetoes. Preserve feed-quality thresholds unless a separately named test establishes a justified replacement.
- [ ] Run the test and TypeScript check. Modify `scripts/coverage-learning-audit.ts` to expect nine correct fresh paths to pass and all forged/stale paths to fail, replacing its intentionally diagnostic old-bug expectation. Checkpoint listed files plus that script with message `fix: share instrument-based entry eligibility`.

## Task 5: Linear settlement, venue lot rules, fees, liquidity, and funding

**Files:**
- Modify: `src/lib/trading/assetSpecs.ts`; `src/lib/trading/executionCostModel.ts`; `src/lib/execution/liquidityCost.ts`; `src/lib/execution/swingLifecycle.ts`; `src/daemon/swingDaemon.ts`; `src/lib/execution/bookRebalancer.ts`; `src/daemon/crossSectionalDaemon.ts`; `src/lib/types.ts`; `src/lib/trading/executionLedger.ts`.
- Test: `tests/bybit-contract-costs.test.ts`, `tests/bybit-funding.test.ts`.

**Interfaces:**
- Consumes `InstrumentRef`, frozen position economics, and venue metadata.
- Produces `calculateInstrumentPnl(input: { instrument: InstrumentRef; entryPrice: number; exitPrice: number; quantity: number; direction: "LONG" | "SHORT" }): number` in `assetSpecs.ts`; legacy wrappers delegate using the position's model, not today's asset registry.
- Produces `floorOrderQty(desiredQty: string, metadata: BybitInstrumentMetadata): string` and `validateOrderSize(input: { quantity: string; price: number; metadata: BybitInstrumentMetadata; maxNotionalUsdt: number }): { allowed: boolean; reasons: string[] }` in `assetSpecs.ts`.
- Produces `FundingSettlement = { symbol: string; settlementTimeMs: number; rate: number; markPrice: number }` and `fundingCashflow(input: { direction: "LONG" | "SHORT"; quantity: number; settlement: FundingSettlement }): number` in `executionCostModel.ts`. Positive result is received cash; negative is paid cash.
- Produces versioned `FeeSchedule` records with maker/taker rates, effective date, source URL, and status `PUBLIC_BASELINE` or `UNVERIFIED_STRESS_RATE`.

- [ ] Write `linear_usdjpy_long_short_and_notional`: new long quantity 10, entry 150, exit 151 returns +10; short returns -10; entry notional is 1,500. Test EURUSD, XAU, CL, XAG with the same linear formula and retain Task 2's legacy example. Every new fee is notional times the selected maker/taker rate; maker status is earned only by a resting-fill simulation, never inferred just because an order is a limit.
- [ ] Write `venue_rounding_never_expands_risk`: desired `0.01299`, step `0.001` becomes `0.012`; desired size below venue minQty/minNotional is rejected, not rounded up. Cover 0.01 and 0.1 steps, floating decimal boundaries, unsafe magnitude, market-order maxQty, tick alignment, and a venue min order whose stop risk exceeds the internal budget. Use exact decimal/integer-step logic at the boundary with safe-range checks and existing dependencies.
- [ ] Write `funding_is_signed_boundary_based_and_once_only`: at notional 1,000 and rate 0.0001, two actual four-hour settlements produce -0.20 for a long/+0.20 for a short; a negative rate reverses signs. Entry after a boundary owes nothing for that past boundary; exit before the next owes nothing for it. Restart/replay of the same `(positionId, symbol, settlementTimeMs)` does not charge twice. A partial exit changes only quantity held at subsequent boundaries; scale-ins and closes at a boundary use a documented, deterministic event order.
- [ ] Run `npx tsx --test tests/bybit-contract-costs.test.ts tests/bybit-funding.test.ts`; expect old synthetic/FUNDING_INTERVAL failures.
- [ ] Implement new linear economics and use runtime metadata for sizing. Replace static synthetic FX zero fees and commodity rates with Section 1's versioned baseline policy. Freeze cost assumptions on a fill. Estimate projected carry for admission with a clearly labeled conservative assumption, then book realized funding using published settlement history and the quantity actually held at each timestamp. Read `nextFundingTime` and metadata interval rather than one global eight-hour scheduler. Catch up missed settlements after a restart; missing settlement data produces `PENDING_RECONCILIATION`, never invented zero cost. Keep safe exit management available.
- [ ] Give each fill an observed spread/depth snapshot. Reject a proposed fill when notional exceeds 1% of 24h turnover, exceeds 10% of available opposing depth within 10 bps, or the measured one-way spread plus estimated impact exceeds 10% of planned stop distance. These are initial conservative capacity limits, not claims of optimal parameters; register them as a risk-policy version. A market-data outage cannot yield bid=ask=last or a fabricated free fill. Price stops/targets from executable side and record any modeled gap.
- [ ] Make cash, fee, and funding writes idempotent using the existing Redis lock/transaction patterns and an event ID. Atomically persist the balance/position changes, processed settlement IDs, and a pending ledger event in the same Redis transaction. Drain pending ledger events with their immutable ID/payload through one writer, checking already-recorded IDs after a crash; a restart between cash booking and ledger append must neither lose evidence nor charge again. Keep pending reconciliation visible. Closed P&L reports allocate already-booked funding rather than debiting it again at exit. Apply the same principle to XSEC funding, including variable intervals for its crypto universe. Keep the legacy synthetic carry path exclusively for identified legacy positions.
- [ ] Run both tests and TypeScript check; reconcile fee/funding/cash conservation on a complete lifecycle fixture. Checkpoint listed files with message `fix: model Bybit quantity fees and funding accurately`.

## Task 6: Full-position outcomes shared by learning and reporting

**Files:**
- Create: `src/lib/trading/positionOutcomes.ts`.
- Create: `tests/fixtures/upgrade/trades.json`, `tests/fixtures/upgrade/ledger/2026-10-01.jsonl`, containing synthetic sanitized lifecycle records and a valid ledger chain generated with the actual ledger hash function.
- Modify: `src/lib/trading/setupPerformance.ts`; `src/lib/trading/tradeReviewJournal.ts`; `src/lib/research/walkForward.ts`; `src/lib/portfolio.ts`; `src/lib/execution/swingLifecycle.ts`; `src/lib/trading/executionLedger.ts`; `scripts/coverage-learning-audit.ts`; `scripts/verify-execution-ledger.ts`.
- Test: `tests/position-outcomes.test.ts`.

**Interfaces:**
- Consumes Task 2's position identity and Task 5's net leg/funding accounting.
- Produces `buildPositionOutcomes(input: { trades: Trade[]; openPositions: OpenPosition[] }): { completed: CompletedPositionOutcome[]; incompletePositionIds: string[]; conflicts: string[] }` and `positionOutcomeCohortKey(outcome: CompletedPositionOutcome): string`.
- Produces one shared outcome input for SetupPerformance, trade-review classification, walk-forward samples, and position-level dashboard statistics. Realized-cash views may still count exit legs if clearly labeled.
- Extend `verify-execution-ledger.ts` with `--directory <path>` so fixture verification does not inspect a user's live ledger. The trades fixture schema is `{ schemaVersion: 1, trades: Trade[], openPositions: OpenPosition[] }`.

- [ ] Write `partial_profit_then_final_loss_is_one_winning_position`: +15 partial and -5 final for one ID yield exactly one completed outcome, net +10 and `netR=1` when initial risk is 10. All four consumers report that same result. An open remainder is incomplete and is excluded from completed-position win rate/learning while its realized cash remains visible.
- [ ] Write `scale_ins_duplicate_events_and_cost_allocation`: two entry fills, multiple partials, one final, and a replayed leg ID yield one outcome with unique leg IDs and costs counted once. Reject multiple finals, missing lineage, negative remaining quantity, inconsistent instrument versions, and insufficient initial-risk provenance. Unavailable risk yields `netR=null`, not a fabricated R or automatic sample eligibility.
- [ ] Run `npx tsx --test tests/position-outcomes.test.ts`; expect the old final-leg-only result to fail.
- [ ] Implement outcome construction over the preserved ledger/trade evidence. Keep `Trade.pnl` compatibility semantics documented. Where ledger events are complete, reconcile exit-leg net totals to gross minus uniquely allocated fees plus funding cashflows; do not subtract fees from already-net historical `pnl` again. Emit a completion event once when quantity reaches zero. Persist outcomes separately with schema version and a source-event hash.
- [ ] Replace filters that discard partials before aggregation in all consumers. Remove fill counts from labels claiming independent trades. Rebuild derived learning summaries from preserved outcomes, not by clearing history. Update the diagnostic's +15/-5 and current snapshot expectations to assert corrected economics; current balances must never be hardcoded as permanent test truth.
- [ ] Run the test, `npx tsx scripts/coverage-learning-audit.ts`, TypeScript check, and `npm run ledger:verify -- --directory tests/fixtures/upgrade/ledger`. Expect conservation and one sample per completed position. Checkpoint listed files with message `fix: learn from complete position outcomes`.

## Task 7: Risk halt that continues exits, funding, and research

**Files:**
- Create: `src/lib/execution/bookRiskPolicy.ts`.
- Modify: `src/daemon/crossSectionalDaemon.ts`; `src/lib/execution/bookRebalancer.ts`; `src/lib/research/edgeDecay.ts`; `src/lib/trading/portfolioRiskBudget.ts`; `src/lib/trading/portfolioGuards.ts`; `src/lib/strategy/crossSectionalMomentum.ts`; `src/lib/data/perpUniverse.ts`.
- Test: `tests/book-risk-policy.test.ts`, `tests/portfolio-risk-factors.test.ts`.

**Interfaces:**
- Produces `BookRiskState = "ACTIVE" | "ENTRY_HALT" | "REDUCE_ONLY" | "SHADOW"` and `evaluateBookRisk(input: { previous: BookRiskState; lifetimeMaxDrawdownPercent: number; currentDrawdownPercent: number; hasOpenPositions: boolean; entryDataReady: boolean; exitDataReady: boolean; edgeVerdict: string; releaseAuthorized: boolean }): { state: BookRiskState; allowEntries: boolean; allowReductions: boolean; reasons: string[] }`.
- Produces `makeReduceOnlyPlan(input: { positions: BookPosition[]; prices: Map<string, PerpTicker>; maxParticipation: number }): BookPlan`, adapting the existing BookPlan rather than a second order system.
- Extend existing portfolio-risk results with named class/currency/factor exposure and reasons.

- [ ] Write `drawdown_breach_does_not_freeze_existing_risk`: lifetime max drawdown 28.152% and open positions gives REDUCE_ONLY, entries false, valid risk-reducing closes true. Recovered current equity does not erase the historical breach or automatically restore ACTIVE. If exit data is unavailable, reductions wait with a reason, positions stay recorded, and research/funding/marking still run. A final close transitions the halted book to SHADOW.
- [ ] Write `reduce_only_cannot_increase_or_flip_a_position`: plan deltas can only reduce absolute quantity toward zero, cannot open a new symbol or cross through zero, and persist after restart. Plan a staged unwind on every one-minute risk sweep using Task 5's capacity limits; do not wait another 12 hours or hold indefinitely. If safe price/depth is unavailable, record the blocked unwind and retry when valid data returns. No fabricated fill to claim a flat book.
- [ ] Write `all_asset_risk_factors_are_counted`: EURUSD/GBPUSD long and USDJPY short share a short-USD factor; gold/silver share a metals factor; BTC/ETH/SOL share crypto exposure. Group tags do not mechanically assume fixed correlation. Initial correlated-cluster cap is the existing portfolio stop-risk cap, with a total gross-notional ceiling no greater than existing policy; every class uses true USDT notional. XSEC still rejects FX/metals/oil from its crypto ranking universe, including all three new FX symbols. Use verified `symbolType` (`forex`/`commodity` in the new evidence) plus the current deny-list defense; reject other identified non-crypto groups instead of allowing any name ending in USDT.
- [ ] Run `npx tsx --test tests/book-risk-policy.test.ts tests/portfolio-risk-factors.test.ts`; expect current early-return/factor omissions to fail.
- [ ] Implement the state machine around the existing book. Always run mark, funding, watchdog, and a fresh scheduled edge review independently of the entry/rebalance decision. A negative edge verdict without a hard drawdown breach goes ENTRY_HALT with ongoing risk management and a shadow book for unbiased forward evidence. A breached book defaults to REDUCE_ONLY, then SHADOW. Record state/version/reasons before any action; do not reset the equity peak, initial capital, or lifetime max drawdown.
- [ ] Require both a documented release authorization and Task 10's evidence before increasing risk from SHADOW. The code can record `ELIGIBLE_FOR_REVIEW`; it cannot silently clear this incident. Preserve separate swing/XSEC accounts and add a combined exposure summary without double-counting capital.
- [ ] Run both tests and TypeScript check. Confirm daemon imports do not start loops in tests. Checkpoint listed files with message `fix: preserve risk management during entry halts`.

## Task 8: Two class-aware strategy families, evaluated across all nine

**Files:**
- Modify: `src/lib/swingEngine.ts`; `src/lib/signals.ts`; `src/lib/trading/marketSession.ts`; `src/lib/trading/opportunityJournal.ts`; `src/lib/trading/tradeAdmission.ts`; `src/lib/backtest/replayEngine.ts`; `src/lib/trading/executionLedger.ts` strategy version.
- Test: `tests/strategy-family-routing.test.ts`.

**Interfaces:**
- Produces `StrategyFamily = "TREND_PULLBACK" | "RANGE_REVERSION"` and `StrategyCandidate = { candidateId: string; asset: ConfiguredAsset; family: StrategyFamily; regime: string; direction: "LONG" | "SHORT"; entryPrice: number; stopPrice: number; targetPrice: number; initialRiskUsdt: number; featureCutoffMs: number; configHash: string; reasons: string[] }` in `swingEngine.ts`.
- Produces `evaluateStrategyFamilies(input: { instrument: InstrumentRef; candles15m: Candle[]; candles1h: Candle[]; candles4h: Candle[]; weeklyCandles: Candle[]; quote: MarketPriceSnapshot; nowMs: number }): StrategyCandidate[]` and the same evaluator for live shadow and replay.
- Preserve the existing SwingSignal response using an adapter; strategy family/regime/candidate/version become explicit fields.

- [ ] Write `families_evaluate_every_instrument_without_crypto_assumptions`: deterministic trend and range fixtures are parameterized across all nine. A trend fixture can produce a TREND_PULLBACK candidate; a range fixture can produce RANGE_REVERSION; an ambiguous regime produces no candidate. Missing weekly history contributes zero and cannot switch an otherwise valid direction. No external quote is requested by pure evaluation.
- [ ] Write `missing_flow_and_high_cost_do_not_create_false_opportunities`: absent orderbook/trade-flow stays unavailable, spot volume is never substituted, and a thin TradFi fixture fails cost/capacity admission. A weekend TradFi fixture remains contract-open but receives an underlying-liquidity warning and must pass measured depth/spread checks. The opportunity journal records its precise veto.
- [ ] Run `npx tsx --test tests/strategy-family-routing.test.ts`; expect missing family routing/short-history handling to fail.
- [ ] Keep the existing trend/pullback logic as the first family's baseline, with a fresh strategy version after source/economics changes. Separate transport readiness from strategy speed and class risk. FX/commodities do not become crypto-style fast strategies merely because they now have WS data. Add range reversion only as a shadow family initially: 4h ADX(14) < 20, 1h Bollinger(20,2) outer-band touch then completed 15m close back inside, target 1h band midline, stop beyond the setup extreme by 0.5*1h ATR(14). Reject net reward/risk below the current admission minimum. ADX 20-25 is neutral; trend qualification uses ADX >=25 plus existing directional/structure rules. These are preregistered hypotheses, not tuned profit claims.
- [ ] Use actual Bybit turnover, completed candle volume, session context, spread and funding as inputs. Keep immutable class profiles for risk/session interpretation; any parameter changes receive a config hash. Journal both families for all nine on completed 15m bars, deduplicate repeated evaluations of the same setup/bar, and allow at most one live strategy decision per instrument at a time. Existing proven guards remain in admission and risk.
- [ ] Run the test and replay fixtures. No real-data range strategy is promoted in this task. Checkpoint listed files with message `feat: evaluate bounded strategy families across all assets`.

## Task 9: Instrument-scoped learning with explicit sample units

**Files:**
- Modify: `src/lib/trading/localLearning.ts`; `src/lib/trading/setupPerformance.ts`; `src/lib/trading/opportunityJournal.ts`; `src/lib/trading/tradeReviewJournal.ts`; `src/lib/swingEngine.ts` adjustment input.
- Test: `tests/learning-cohorts.test.ts`, `tests/opportunity-independence.test.ts`.

**Interfaces:**
- Consumes `CompletedPositionOutcome` and candidate family/version metadata.
- Produces `LearningCohort = { instrumentVersion: string; dataSchemaVersion: string; assetClass: string; family: string; regime: string; direction: "LONG" | "SHORT"; strategyVersion: string; configHash: string; costModelVersion: string; riskPolicyVersion: string }` and `learningCohortKey(cohort: LearningCohort): string` in `localLearning.ts`.
- Extend existing rules with `sampleUnit: "COMPLETED_POSITION" | "SHADOW_SETUP"`, `distinctSampleCount`, `netReturnFraction`, `netR`, `createdAt`, `expiresAt`, and cohort identity. Deprecate ambiguous `avgMove`; do not compare dollar means to percentage thresholds.
- Produces `selectIndependentSetups(input: { opportunities: OpportunityRecord[]; horizonMs: number }): OpportunityRecord[]` alongside the existing opportunity selector.

- [ ] Write `old_yahoo_gold_does_not_quarantine_new_bybit_gold`: no match between legacy Yahoo gold and the new instrument cohort. Crypto setup tags do not become a global forex veto. With zero or two completed positions and many correlated watch records, adjustment is zero and verdict is INSUFFICIENT_EVIDENCE, not WATCH_ONLY or BOOST.
- [ ] Write `reduce_rule_does_not_secretly_become_watch_only`: action REDUCE with explicit zero watch-only evidence never produces `watchOnly=true`. Test currency-unit mismatch rejection, cohort TTL expiry, and normalized R versus raw dollars. Default minimum remains at least 15 distinct completed positions; remove paths bypassing that requirement via watch sample count.
- [ ] Write `overlapping_opportunities_count_once`: ten same-instrument/same-family observations with overlapping feature-to-label intervals count as one independent setup. Multiple horizons on one candidate count as one chosen preregistered label. Use 24h for these 1h/4h swing families; do not prefer a one-hour label just because it matured first. Store other horizons for diagnostics without additional sample weight.
- [ ] Run `npx tsx --test tests/learning-cohorts.test.ts tests/opportunity-independence.test.ts`; expect existing cohort/watch shortcuts to fail.
- [ ] Implement cohort filtering, distinct sample counting, units, TTL, and bounded adjustments. Keep a cap of +/-4 confidence points and [0.5, 1.0] risk multiplier for this release; learning cannot increase leverage, position risk limits, or enable a disabled candidate. Completed-position learning requires initial-risk provenance; shadow labels are clearly separate and cannot masquerade as realized P&L.
- [ ] Publish class/family pooled evidence descriptively where per-instrument samples are sparse; no pooled result silently quarantines an untouched instrument. More complex shrinkage can be a later registered experiment. Turn an explicit quarantine into continued shadow collection with a reason and re-review status, not deleted evidence or indefinitely blocked data gathering.
- [ ] Run both tests and TypeScript check. Rebuild derived rule summaries with a new version while preserving old rules as historical evidence. Checkpoint listed files with message `fix: scope learning to independent economic cohorts`.

## Task 10: Reproducible research and bounded candidate promotion

**Files:**
- Create: `src/lib/research/candidateRegistry.ts`, `scripts/capture-bybit-evidence.ts`.
- Modify: `src/lib/research/walkForward.ts`; `src/lib/research/deflatedSharpe.ts`; `src/lib/research/regimeConditioning.ts`; `src/lib/research/sleeveCorrelation.ts`; `src/lib/backtest/replayEngine.ts`; `src/lib/execution/costModelReconciliation.ts`; `scripts/research-audit.ts`; `scripts/replay-strategy.ts`; `scripts/replay-xsec.ts`; `scripts/redis-housekeeping.ts`.
- Test: `tests/research-promotion.test.ts`, `tests/research-data.test.ts`.

**Interfaces:**
- Produces `CandidateDefinition = { candidateId: string; configHash: string; strategyVersion: string; instrumentVersions: string[]; costModelVersion: string; riskPolicyVersion: string; registeredAtMs: number; labelHorizonMs: number; holdoutId: string; mode: "SHADOW" | "REVIEW_ELIGIBLE" | "PAPER_ACTIVE" | "REJECTED" }`.
- Produces `registerCandidate(definition: CandidateDefinition): Promise<void>` and `evaluatePromotion(input: { definition: CandidateDefinition; outcomes: CompletedPositionOutcome[]; trials: CandidateDefinition[]; holdoutConsumed: boolean; feesVerified: boolean }): { eligible: boolean; reasons: string[]; reportHash: string }`.
- Capture CLI: `npx tsx scripts/capture-bybit-evidence.ts --assets all --intervals 15m,1h,4h,1w --output <local-directory>` writes timestamped public raw/normalized fixtures and metadata hashes; no API key, no Redis mutation. Reuse the client, not nine parallel uncapped crawlers.
- Add `research-audit.ts --input <fixture.json>` with Task 6's fixture schema. This mode reads only the file and calls pure report builders, never PortfolioManager/Redis. Leave existing authenticated/local research mode available and explicitly separate it from offline CI.

- [ ] Write `insufficient_history_and_purging_are_explicit`: 51 independent completed positions cannot produce the first existing 30-train/10-validation/10-test fold with two one-position embargoes; 52 can only if label intervals also permit it. Purge any sample whose feature/holding/label interval overlaps a later partition; use a time embargo at least the registered label horizon, not only one row. Short FX listing history cannot become a fabricated two-year Bybit test.
- [ ] Write `candidate_search_is_counted_and_holdout_is_one_use`: changing any strategy/cost/risk configuration creates a new trial/config hash even under the same display version. Five registered variants mean five trials, not one. Tuning after seeing the test result marks that holdout consumed for the next variant. Seeded replay is deterministic, and a funding/spread/fee stress failure blocks promotion.
- [ ] Write `no_edge_no_fee_proof_no_promotion`: negative net expectancy, fewer than 15 forward independent completed shadow positions, unverified FX fees, unavailable critical historical cost data, or a reused holdout returns eligible=false with a reason. A positive gross curve with negative net return fails. Blending a sleeve that worsens net risk-adjusted performance is not justified solely by low correlation.
- [ ] Run `npx tsx --test tests/research-promotion.test.ts tests/research-data.test.ts`; expect missing registry/purging/cost checks to fail.
- [ ] Implement immutable preregistration and append-only trial results using existing ledger/file/Redis patterns. Start with exactly the two Task 8 family baselines, at most one preregistered alternate configuration per family in a research cycle; every attempted alternate counts. No unlimited mutation/search loop. Training may propose bounded thresholds only inside declared ranges; a fresh untouched holdout and forward shadow period are needed for each revision.
- [ ] Extend replay to use closed Bybit candles, linear quantities, versioned fees, actual historical funding settlements where available, and spread/depth scenarios. For old periods without historical depth, disclose that modeled fill costs are assumptions and run at least 1x/2x observed-or-conservative spread/impact plus a nonzero latency scenario. Never treat one-minute adverse price movement as measured realized slippage. Use the same admission and exit logic as paper trading.
- [ ] Initial review eligibility requires: sufficient valid chronological folds; lower 95% block-bootstrap confidence bound of net expectancy above zero; deflated-Sharpe probability >=0.95 with the full trial count and documented implementation; no breach of existing portfolio risk limits; nonnegative aggregate net expectancy under 2x spread/impact stress; at least 15 independent forward shadow completions across at least 14 calendar days; verified cost schedule. This is a conservative review policy, not a guarantee of profitability. Lack of samples returns INSUFFICIENT_EVIDENCE and keeps collecting. Require human release authorization for PAPER_ACTIVE initially; the research loop can automatically stop/quarantine risk but cannot silently promote it.
- [ ] Add a bounded history archive: compressed closed 15m/1h/4h/W bars plus periodic spread/depth/funding summaries; retain hot Redis data by existing TTL/trim conventions. No unbounded tick/depth archive. Set a 1 GiB configurable research-archive budget, preserve raw evidence/manifests, and stop capture with a visible storage reason when full rather than silently deleting account/ledger evidence. Inventory capture cadence and disk use before adding another process; reuse daemon bar-close work where practical.
- [ ] Run both tests, `npm run research:audit -- --input tests/fixtures/upgrade/trades.json`, fixture replays, and TypeScript check. Real-history runs must record exact date ranges, covered instruments, cost assumptions, data/report hashes, sample counts, failures, and limitations. A historical positive percentage alone is not an acceptance gate. Checkpoint listed files with message `feat: gate strategy changes on reproducible research`.

## Task 11: Dashboard and API explain coverage, risk, and learning

**Files:**
- Modify: `src/app/api/health/feeds/route.ts`; `src/app/api/live-prices/route.ts`; `src/app/api/user/status/route.ts`; `src/components/Dashboard.tsx`; `src/components/CrossSectionalBook.tsx`; `src/daemon/swingDaemon.ts` scan summaries; `src/lib/types.ts`; `scripts/agent-status.ts`; `scripts/explain-latest-scan.ts`.
- Test: `tests/coverage-status.test.ts`.

**Interfaces:**
- Consumes entry data decisions, costs, risk state, candidate verdicts, and full-position outcomes from preceding tasks.
- Produces `AssetCoverageStatus = { asset: ConfiguredAsset; symbol: string; dataReady: boolean; strategyReady: boolean; entryPathReady: boolean; costReady: boolean; riskAllowed: boolean; learningStatus: string; primaryVeto: string | null; quoteAgeMs: number | null; lastEvaluatedAt: string | null; lastFillAt: string | null; completedPositions: number; funnel7d: Record<string, number>; funnel30d: Record<string, number> }` through the status API.
- Keep spectator endpoints sanitized and read-only. Detailed private execution records use existing authentication; no token/config values enter public output.

- [ ] Write `healthy_feed_does_not_claim_asset_can_trade`: a valid OIL quote with a learning/risk veto has dataReady=true, riskAllowed=false, primaryVeto set. A warming EURUSD has the weekly limitation described separately from required intraday warm-up. A snapshot emits all nine rows even when one provider request fails.
- [ ] Write `cash_legs_completed_positions_and_shadow_stats_are_distinct`: +15/-5 legs show realized cash +10 and one completed position. Active shadow hypotheses are labeled with sample counts and costs; they do not appear as live profit. A REDUCE_ONLY XSEC displays outstanding exposure, last exit attempt/blocker, current drawdown, lifetime maximum drawdown, and refreshed edge-review time.
- [ ] Run `npx tsx --test tests/coverage-status.test.ts`; expect current health/tradeability conflation to fail.
- [ ] Implement per-asset funnels: closed bars -> evaluations -> candidates -> provenance pass -> cost pass -> risk pass -> fills -> completed positions. Increment counters once per candidate/decision ID, not per dashboard request. Record explicit veto enums with explanatory text and show the first binding veto plus secondary reasons. Explain USDT settlement, WTI exposure, fee assumption status, funding interval, data cutoffs, single-venue risk, and insufficient research without implementation jargon in the main trading flow.
- [ ] Run the test, TypeScript check, and build. Review rendered dashboard at desktop and mobile widths using the existing project/browser tooling, inspect scroll/overflow/console errors, and exercise one stale-feed, warm-up, learning-veto, and reduction fixture. Checkpoint listed files with message `feat: explain per-asset coverage and entry vetoes`.

## Task 12: Integration audit, deployment package, and state-safe rollout

**Files:**
- Modify: `scripts/strategy-audit.ts`; `scripts/vps-deploy-check.sh`; `scripts/source-manifest.mjs`; `Dockerfile`; `.github/workflows/deploy.yml`; `package.json`; `docs/ARCHITECTURE.md`; `docs/README.md`; root `ARCHITECTURE.md`, `task.md`, `AUDIT_LOG.md`, `LEARNINGS.md`.
- Create: `scripts/run-upgrade-tests.mjs`, `tests/bybit-upgrade.integration.test.ts`, `docs/BYBIT_ALL_ASSETS_ROLLOUT_RUNBOOK.md`.
- Use isolated temporary fixtures, never a live-account reset or replay script against production.

**Interfaces:**
- Produces `npm run test:upgrade`, implemented as `node scripts/run-upgrade-tests.mjs`; enumerate sorted `tests/**/*.test.ts` files with native fs and invoke `node --import tsx --test <explicit files>` without shell glob expansion. This must work on Windows and Linux.
- Produces an integration fixture using the real registry -> market parser -> eligibility -> engine/admission -> cost/risk -> paper lifecycle -> complete outcome -> learning/status pipeline, with injected public data, fake clock, and isolated state storage.
- Produces rollout evidence containing commit SHA, source-manifest hash, schema/migration versions, data metadata versions, account snapshot hashes, and verification timestamps.

- [ ] Write `every_asset_reaches_fill_with_valid_fixture`: each of the nine receives a genuine entry candidate on a favorable causal fixture, passes all actual entry-path checks, fills within venue/risk limits, exits, and produces one reconciled outcome. Also test each asset with wrong symbol, stale quote, shallow depth, unverified promotion costs, and insufficient required bars. A harness that only calls the new helper or asserts source-code strings is insufficient.
- [ ] Write `restart_migration_and_halt_conserve_state`: restart after entry, partial exit, and funding write; no duplicate cash/trade/funding event; position model/ID unchanged. Repeating migration doesn't rewrite the old ledger. XSEC reduction remains available during entry halt; shadow evidence continues when the live book is flat. Simulated Bybit REST+WS outage blocks entries, preserves known positions, shows stale marking, and waits for valid data before pricing any exit.
- [ ] Run `npx tsx --test tests/bybit-upgrade.integration.test.ts`; expect integration failures until preceding tasks are connected.
- [ ] Add the cross-platform runner and integrate `test:upgrade` into CI before deployment. Extend the existing strategy audit with actual execution/economic fixtures and update intentional old-bug diagnostics. Include required runtime fixture files in Docker and source-manifest roots, or keep tests entirely in the builder/CI if no runtime audit needs them. Do not introduce a runtime audit that references files absent from the runner image. Preserve existing auth/spectator checks.
- [ ] Run: `npm run test:upgrade`, `npm run audit:strategy`, `npm run research:audit -- --input tests/fixtures/upgrade/trades.json`, `npm run ledger:verify -- --directory tests/fixtures/upgrade/ledger`, `npx tsc --noEmit --incremental false`, `npm run lint`, `npm run build`, and `git diff --check`. Offline checks must not call production or require credentials; an explicitly supplied spectator STATUS_URL is a separate read-only runtime check. Treat any baseline warning/failure explicitly; do not add brittle tests that merely mirror the implementation. Run full real-history replay only when datasets are complete enough, and identify skipped instruments/horizons.
- [ ] Write the rollout runbook and refresh canonical architecture to describe implemented behavior. Record unresolved evidence limits, especially short FX history and any unverified fee schedule. Attach local test results and migration preview to the review artifact. The present plan is not a deployment authorization.
- [ ] After separate release authorization, freeze entry writers, take the existing Redis/runtime backup, capture current account/position/ledger hashes, and apply the previewed schema migration. Deploy the reviewed exact commit and validate inside the actual containers: source manifest, package/fixture presence, upgrade audit, and daemon startup. Do not rely only on a reported commit SHA or a locally passing build.
- [ ] Observe new scans, actual quote messages and closed bars for every configured instrument. Check all nine status rows, actual funding scheduler, admission reasons, old-position compatibility, and XSEC risk state. Verify fresh ticks rather than open sockets. A market lacking a genuine setup need not fill; the offline full-pipeline fixture proves capability, while live veto reasons explain present inactivity. Use a controlled synthetic fixture only in the isolated test harness, never a forced production paper trade.
- [ ] Roll back code using the recorded previous artifact if verification fails. Keep a compatibility reader for the new schema so rollback does not require discarding events. Restore a state snapshot only under an approved recovery action after accounting for events created since the snapshot; blindly restoring an old Redis dump can erase trades and funding. Document exactly which metadata/new-entry flag is disabled during rollback, with exit monitoring still running.
- [ ] Checkpoint reviewed files with message `test: verify Bybit coverage and state-safe rollout`. Update Memory Quad after every released slice with checks, hashes, current limitations, and the next task.

## 4. Free operation and optional LLM boundary

Default operation is deterministic and requires no LLM: public Bybit data -> class-aware strategy candidates -> measured execution costs -> portfolio risk -> paper fills -> complete outcomes -> bounded research. The learning loop improves only when enough independent outcomes support a new hypothesis. It must be able to report no established improvement rather than produce automatic favorable tuning.

Use one shared all-linear ticker cache, one public WS connection with bounded subscriptions, metadata refresh every six hours, higher-timeframe fetches at bar close, and cached OI/depth only when evaluating or managing a position. Cap REST concurrency at three, stagger scans, respect 429/backoff, and publish request counts/errors. Reuse the existing Oracle VPS/Redis setup. Do not run a large local model on the VPS as a requirement for trading.

An optional later LLM may summarize sanitized research reports, classify proposed hypotheses for a human, or explain vetoes. Its output is commentary, not an order, price, position size, risk exception, or promotion decision. A local open-weight model avoids per-call API charges but still uses hardware/electricity; a hosted free quota is not permanent infrastructure. Leave this feature disabled by default. No model integration work is necessary to complete this plan.

## 5. Acceptance checklist for the whole upgrade

- [ ] All nine live mappings are Bybit linear USDT contracts and class labels remain correct.
- [ ] Price, all candle horizons including W, OI, orderbook/trade-flow, and funding use actual Bybit identity; active requests do not fall back to another venue.
- [ ] Genuine fresh nine-asset fixtures enter through the real path; wrong, stale, future, unknown, shallow, or warming inputs fail for a named reason.
- [ ] New USDJPY and commodity P&L, quantity rounding, fees, funding boundaries, and cash conservation pass numeric fixtures; legacy positions keep their original model.
- [ ] One completed position produces one net outcome across learning, review, research, and dashboard; partial cash remains visible and costs are counted once.
- [ ] Halted books retain active exit/risk management and fresh research. Lifetime drawdown history and account evidence remain intact.
- [ ] Every asset participates in evaluated strategy/shadow funnels. Short FX history and costs can legitimately restrict promotion or entry; no forced fills are required.
- [ ] Candidate registry, cohort independence, trial count, purging, untouched holdout, cost stress, and forward shadow evidence prevent unsupported promotion.
- [ ] No model/API-key dependency, new paid service, unbounded data archive, higher risk limit, or live-money path was introduced.
- [ ] CI and packaged runtime checks pass; review artifact and migration/rollback runbook exist. Production release still requires separate authorization.

## 6. Executor handoff

Copy this instruction into Claude Code or continue here:

> Read the applicable `../AGENTS.md` (Code Projects), project Memory Quad, and `docs/superpowers/plans/2026-10-01-bybit-all-assets-upgrade.md`, including its linked audit and public market evidence. Implement the plan in order, starting with Release A. Use the existing packages, preserve all account/history/ledger evidence, and write the listed failing behavior tests before each fix. Track checked tasks and verification in the Memory Quad. Do not reset accounts, rewrite old fills, raise risk limits, add a mandatory LLM, push to main, or deploy without separate authorization. Report the implemented slice, exact test results, migration preview, remaining evidence limits, and reviewable diff.
