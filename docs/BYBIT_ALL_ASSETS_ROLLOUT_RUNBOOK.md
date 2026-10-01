# Bybit all-assets rollout runbook

**Status, 2026-10-01:** complete upgrade `c90483d` is deployed and verified,
following Release A `191761f` and its approved XSEC reductions. PR #10 passed
independent review, regressions, CI and live VPS preflight. The exact merged
artifact passed source/image parity, runtime audit and scan advancement, then
entry freeze cleared. Proof: `BYBIT_COMPLETE_UPGRADE_VERIFICATION_2026-10-01.md`.
This operational authorization does not activate unproven range candidates
or release XSEC's historical drawdown restriction.

The complete release preserves balances, old position economics, fills and
ledger records. New strategy and research evidence is version-scoped, and
new ledger event types are additive. Research uses `data/research` with
a 1 GiB default limit; archive-full and missing-evidence states are visible.
The browser stream is display-only; it cannot authorize an entry or exit.

Plan: [2026-10-01-bybit-all-assets-upgrade.md](./superpowers/plans/2026-10-01-bybit-all-assets-upgrade.md), Task 12.
Audit: [STRATEGY_COVERAGE_AUDIT_2026-10-01.md](./STRATEGY_COVERAGE_AUDIT_2026-10-01.md).
Market evidence: [BYBIT_ALL_ASSETS_MARKET_EVIDENCE_2026-10-01.json](./BYBIT_ALL_ASSETS_MARKET_EVIDENCE_2026-10-01.json).

## 1. What changes in live state

Release A only adds. It never resets an account, rewrites a fill, removes a
ledger event or raises a risk limit.

| Area | Change on first run |
|---|---|
| Swing positions opened before the upgrade | Read as `LEGACY_SYNTHETIC_V1` (AI) or `LEGACY_PAPER_V1` (manual) without any migration. P&L keeps the formula they were opened with. They are never scaled into. |
| New swing positions | Freeze `BYBIT_LINEAR_USDT_V1:<symbol>`, a `positionId`, initial risk, fee schedule and fill-capacity snapshot. |
| Funding | Booked from Bybit's settlement history at each boundary, once per position and boundary. Pre-upgrade XSEC positions start counting at the upgrade time. |
| Outcomes | Each completed position writes one outcome to `ai:positionOutcomes` and one `POSITION_COMPLETED` ledger event. |
| Ledger | New event types `FUNDING_SETTLED` and `POSITION_COMPLETED`. Existing events are untouched; the hash rule is unchanged. |
| Coverage | Per-asset daily funnels under `coverage:funnel:v1:<asset>`; status API returns `assetCoverage`. |
| XSEC book | Records a risk state before acting (`ACTIVE`, `ENTRY_HALT`, `REDUCE_ONLY`, `SHADOW`) and keeps a capital-free shadow book under `xsec:shadow:*`. |

### Consequence that needs the owner's explicit acceptance

At the 2026-10-01 audit the live XSEC book had a **28.15% lifetime drawdown and
24 open positions**. The policy never clears a breach past 25% automatically. On
the first one-minute sweep after deploy the book enters `REDUCE_ONLY` and starts
unwinding in stages capped at 1% of each symbol's 24h turnover per minute. When
flat it becomes `SHADOW`. Returning to `ACTIVE` needs an owner record in
`xsec:riskRelease` plus promotion evidence. This realizes the open book's P&L.
It is the policy working as written, not a fault. Do not deploy until Tejas has
accepted it, or held the release.

## 2. Preconditions

All of these, on the exact commit to be released:

1. Written release authorization from Tejas. The deployment must record the exact verified commit SHA.
2. Owner acceptance of the XSEC unwind above.
3. Local offline checks pass (section 8 lists the last recorded run):
   `npm run test:upgrade`, `npm run audit:strategy`,
   `npm run research:audit -- --input tests/fixtures/upgrade/trades.json`,
   `npm run ledger:verify -- --directory tests/fixtures/upgrade/ledger`,
   `npx tsc --noEmit --incremental false`, `npm run lint`, `npm run build`,
   `git diff --check`.
4. CI passes the same commit. CI runs `test:upgrade` before the strategy audit.
5. A migration preview of a current live snapshot (section 4) has been reviewed,
   including every conflict line.

## 3. Freeze new swing entries, keep exits running

Release A adds an operator freeze. While `swing:entryFreeze` exists the entry
scan does nothing; the exit watchdog (every 5 seconds) keeps managing stops,
targets, funding and outcomes. The pre-upgrade code ignores this key, so setting
it before the deploy is harmless and makes the new code start frozen.

```bash
docker compose exec -T redis redis-cli SET swing:entryFreeze '{"reason":"Release A rollout","setBy":"<operator>"}'
```

Lift it only after section 6 passes:

```bash
docker compose exec -T redis redis-cli DEL swing:entryFreeze
```

The XSEC book has no freeze key. Under Release A its risk state already refuses
new risk while the breach stands.

## 4. Snapshot, hashes and migration preview

1. Let the existing deploy snapshot run (commit, worktree patch, runtime tarball,
   Redis dump). Do not restore any snapshot as part of a normal release.
2. Record the ledger head and source manifest:

   ```bash
   docker compose exec -T quant-dashboard npm run ledger:verify
   docker compose exec -T quant-dashboard node scripts/source-manifest.mjs
   ```

3. Export a read-only account snapshot. This uses raw Redis reads on purpose:
   `PortfolioManager.getPortfolio` can rewrite an invalid portfolio, which an
   export must never do. The file holds account data: keep it outside the
   repository and never commit it.

   ```bash
   docker compose exec -T quant-dashboard node -e '
   const Redis = require("ioredis");
   const r = new Redis(process.env.REDIS_URL);
   (async () => {
     const accounts = [];
     for (const name of ["ai", "user"]) {
       const portfolio = JSON.parse(await r.get(`${name}:portfolio`));
       const trades = (await r.lrange(`${name}:trades`, 0, -1)).map((row) => JSON.parse(row));
       accounts.push({ name, portfolio, trades });
     }
     console.log(JSON.stringify({ schemaVersion: 1, accounts }));
     r.disconnect();
   })().catch((error) => { console.error(error); r.disconnect(); process.exit(1); });' > ~/release-a/live-snapshot.json
   sha256sum ~/release-a/live-snapshot.json
   ```

4. Preview the migration offline from a checkout of the release commit:

   ```bash
   npx tsx scripts/migrate-bybit-instruments.ts --input ~/release-a/live-snapshot.json --output ~/release-a/migration-preview.json
   ```

   The tool reads one file and writes another. It never connects to Redis or the
   ledger, and it refuses `--apply`. Review each account's `originalHash`,
   `accountLabeling` (the USD_PROXY to USDT relabel is an assumption with no
   conversion), `quantityModel`, `conflicts` and `journal`.

**Applying the migration is not part of Release A.** No apply tool exists, by
design. Release A does not need one: unlabeled records are read with their
legacy model, and outcomes group legacy legs by the same deterministic lineage
the preview uses. Writing the labels to live state is a separate authorized
operation for a later release.

The committed fixture preview,
[BYBIT_MIGRATION_PREVIEW_FIXTURE_2026-10-01.json](./BYBIT_MIGRATION_PREVIEW_FIXTURE_2026-10-01.json),
shows the format on synthetic data: account `ai` has 2 open legacy synthetic
positions, 5 trades given an inferred position id, 6 left without one and 2
lineage conflicts left unassigned for review; account `user` has 1 legacy paper
position and no conflicts. It is not evidence about the live accounts.

## 5. Deploy and verify inside the containers

Deploy the reviewed commit through the normal pipeline only after authorization.
Then, on the VPS:

```bash
sh scripts/vps-deploy-check.sh --expected-commit <sha>
```

Besides health, source parity, image revision and the ledger, the script now
prints each asset's Bybit instrument and fee-schedule status from inside the
swing-daemon image, with no network or Redis access. Expect nine rows, with the
three FX contracts marked `UNVERIFIED_STRESS_RATE`.

The daemons start their loops only when run as the entry point
(`npm run daemon:swing`, `npm run daemon:xsec`). Importing them, as the offline
test does, starts nothing. This guard was checked under the image's pinned
`tsx@4.19.1`.

## 6. Observe before lifting the freeze

Check against live data, not open sockets:

- Fresh ticks: `/api/health/feeds` shows a recent quote event time for all nine
  instruments and `dataReadyNow` where history allows.
- Closed bars: no instrument reports `WARMING_UP` for longer than its missing
  history explains.
- Funding: the exit watchdog logs `booked N funding settlement(s)` at the next
  boundary, with no `PENDING_RECONCILIATION` that persists past a day.
- Old positions: legacy positions still mark and exit with their original model.
- XSEC: `/api/book` shows the risk state and reasons; during `REDUCE_ONLY` the
  position count only falls.
- Coverage: the dashboard's nine "Can each asset trade?" rows each name a
  current veto or readiness. A market without a genuine setup does not need to
  fill. Never force a production paper trade to prove the path; the offline
  fixture proves capability.

Then lift the freeze (section 3).

## 7. Rollback

Roll back code with the recorded previous artifact if verification fails. The
pre-upgrade code reads the new state safely in these respects, checked on
2026-10-01:

- **Ledger:** `main`'s verifier accepts `FUNDING_SETTLED` and
  `POSITION_COMPLETED` events (it validated the fixture ledger, 8 events, with
  both types). No event needs to be discarded.
- **Extra fields:** new position, trade and portfolio fields are additive JSON
  that the old code ignores. Pending funding ledger events left in a portfolio
  are drained idempotently by id when Release A returns.

Hazards, in order of severity:

1. **New linear positions under old code.** Positions opened by Release A in
   USDJPY, the other FX pairs or the commodities are sized for the linear
   contract. The old code would price them with its legacy formulas and charge
   modeled carry on top of booked funding. Before rolling back, list open AI
   positions and their `economicsModel`. If any `BYBIT_LINEAR_USDT_V1` position
   is open outside BTC, ETH and SOL, do not roll back: keep Release A running
   with `swing:entryFreeze` set, so exits continue, and fix forward.
2. **No entry freeze in old code.** The old code has no new-entry switch. The
   only way to stop its entries is `docker compose stop swing-daemon`, which
   also stops exit monitoring. Prefer the Release A freeze above.
3. **XSEC under old code.** The old daemon applies its own 25% breaker and adds
   no new risk, but it does not continue the staged unwind or the shadow book.

Restore a state snapshot only under a separately approved recovery action, after
accounting for every trade, funding event and outcome written since the
snapshot. Blindly restoring an old Redis dump erases them.

## 8. Recorded offline verification

Last local run on the branch, 2026-10-01, Windows, Node v26.2.0. CI uses Node 20,
which was not run locally.

| Check | Result |
|---|---|
| `npm run test:upgrade` | 194 tests, 194 pass, 0 fail (about 21 s) |
| `npm run audit:strategy` | 155 passed, 1 warning, 0 failed. The warning is the existing replay research-quality gate (8 replay trades, below the 30 needed). |
| `npm run research:audit -- --input tests/fixtures/upgrade/trades.json` | Exit 0. 2 completed positions; readiness not passed (30 required). |
| `npm run ledger:verify -- --directory tests/fixtures/upgrade/ledger` | Valid, 1 file, 8 events. |
| `npx tsc --noEmit --incremental false` | Exit 0, no errors. |
| `npm run lint` | No ESLint warnings or errors. |
| `npm run build` | Compiled successfully. |
| `git diff --check` | Exit 0 (line-ending notices only). |

The integration test (`tests/bybit-upgrade.integration.test.ts`) drives the real
swing scan and exit watchdog against a fake Bybit behind `fetch`, an in-memory
Redis and a temporary ledger. Each of the nine assets enters, books one funding
boundary, exits and completes once with a valid hash chain. Every asset is
refused for a wrong contract's metadata, a stale quote, a thin book and short
history. Restarts, a repeated migration preview and a venue outage duplicate
nothing, and an exit waits for fresh data.

## 9. Evidence limits

- **FX fee schedule unverified.** Bybit has not confirmed fees for
  `EURUSDUSDT`, `GBPUSDUSDT` and `USDJPYUSDT`; a stress rate is used and their
  results cannot be promoted.
- **Short FX history.** All three FX contracts launched on 2026-09-08 (venue
  `launchTime` in the market evidence), so they have only a few completed weeks:
  the weekly feature (8 weeks) contributes nothing yet, and research samples are
  short. Gold and silver launched 2026-03-09 and WTI 2026-03-24.
- **Single venue.** No second venue cross-checks a bad Bybit print.
- **Fixture, not market.** The end-to-end proof uses a synthetic causal fixture.
  It proves the path works, not that the strategy has an edge.
- **Not exercised against the network:** live funding history and mark-price
  fetches, and the stream under real reconnects.
- **Not done:** rendered browser review of the new dashboard cards (needs live
  data and an authenticated session); a Node 20 local run.

## 2026-10-01 reviewed release checkpoint

Tejas authorized push and deployment of the verified result and explicitly approved planned XSEC risk reductions. The manual BTC position retains its legacy accounting and exit rules. Historical fills and accounts are not reset or relabeled. Release A is implemented; strategy-family expansion and full cohort/research promotion in plan Tasks 8-10 remain future Release B work.

Independent review fixes:
- Missing funding boundaries remain pending until settlement evidence arrives, including boundaries older than one day.
- New data and cost economics use swing-v4.3.0-2026-10-01, preserving previous Redis learning, journal and review cohorts.
- Operator freeze allows actual nine-asset evaluations and advancing scan snapshots while refusing entries.
- Automated daily maintenance compresses ledger days older than seven days with byte-identical round-trip checks. Prefix verification tolerates concurrent live appends.
- One shared production image serves all three application containers. Build cache is excluded; unused Docker artifacts are removed after a verified deployment and during scheduled maintenance. Redis volumes, account state, learning evidence, trade history and recovery backups are retained.
- Removed unused PaperExchange/LiveExchange and Supabase writer paths plus ccxt and @supabase/supabase-js dependencies. Source searches found no execution callers. TradeLedger retains its historical Redis reader.
- Compatible dependency updates resolve the npm advisory findings: Next 15.5.27, sharp 0.35.5 and PostCSS 8.5.28; npm audit reports zero vulnerabilities.

Fresh local checks: Node 20 upgrade suite 197/197; TypeScript clean; lint clean; offline strategy audit 155 pass, one insufficient-research warning, zero failures; ledger fixture valid with eight events; full-position research fixture two positions and 22 USDT, insufficient for promotion. YAML parsed and shell syntax checked. The production build and cloud preflight results are recorded in the deployment checkpoint when complete.

A spectator snapshot migration preview leaves the manual BTC position under LEGACY_PAPER_V1. Three ambiguous historical AI scale-in groups are flagged and left unchanged; no currently open swing position is blocked. The pull-request preflight exports raw Redis privately on the VPS and checks open-position compatibility without applying a migration. It also exercises all nine public Bybit metadata, closed-bar, quote, depth and funding paths plus two independent WebSocket sessions from the actual VPS.
