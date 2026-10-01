# Complete Bybit upgrade verification, 1 October 2026

Deployed release: `c90483d4aa8418ad8567379639f9cfecbe4bd3ee`, strategy
`swing-v5.0.0-2026-10-01`. Previous release: `191761f`. PR #10 and deployment
are successful. Final continuity verification: 1 October 2026, 22:31:54 IST.

Tasks 8-11 implement closed-bar trend/range families across all nine assets,
full-position provenance, scoped independent learning, bounded research and
compressed capture, cost/funding stress, human promotion gates, direct browser
quotes with reconnect/recovery, and explicit evidence status. Range remains
SHADOW; XSEC risk history and restrictions persist. No paid data service,
mandatory LLM, additional daemon or live-money path was added.

Four Important review regressions failed with original behavior, then passed:

- 900 all-asset observations lost their oldest unfinished labels at a 500-row
  trim. Pending labels now have a separate fenced 4,096-row bound and visible
  rejected intake, with exact historical-window evaluation.
- 4,200 overlapping rows evicted a 15-sample independent cohort. Review reads
  separate bounded independent evidence by immutable identity and origin.
  Restart-style rereading preserves all 15 samples.
- Cooldown, active positions and event blackouts suppressed shadow collection.
  Collection now precedes entry-only vetoes. Real-daemon fixtures verify each
  restriction still prevents an additional order.
- Renamed consumed holdouts recycled evidence. Definitions freeze manifest
  and interval; consumed content or overlapping instrument intervals remain
  consumed. Disjoint fresh evidence can still qualify.

Capture failures were regraded as operationally Important: the dashboard
shows failed assets and last successful captures. Its regression failed then
passed. The runbook now names actual `data/research`. One deferred minor: the
connection summary counts stale REST as a recovery connection; per-asset
freshness and execution gates remain authoritative.

Node 20 validation: 238/238 tests, TypeScript clean, lint clean, production
build successful, strategy audit 155 passes/1 warning/0 failures, dependency
audit zero vulnerabilities, fixture ledger eight valid events and intact hash.
The warning remains: eight legacy descriptive replay trades lose 4.44% net
with profit factor 0.37. This is adverse, insufficient research and does not
establish upgraded-strategy profitability. Fixture research readiness is false.
Public research capture is documented in `BYBIT_RESEARCH_CAPTURE_2026-10-01.json`.

Limits: short FX history; unverified FX fees; incomplete historical depth,
fee and funding evidence; bar replay lacks intrabar, scale-in and reversal
parity. Critical cost gates fail closed. The 400-hour feature window requires
slow independent collection; 14 days is a minimum, not a promotion date.
Manifest hashes describe preregistered collection windows/protocols; actual
archive records have their own content hashes. Neither proves execution costs.

## Runtime release proof

- Reviewed PR: https://github.com/tejashendre/AI-paper-trading-agent/pull/10.
  Exact-head CI and private VPS/public-market preflight passed. The preview
  retains three existing historical AI lineage conflicts and zero manual
  conflicts; no accounting migration or historical fill rewrite was applied.
- Deployment: https://github.com/tejashendre/AI-paper-trading-agent/actions/runs/36894427081,
  completed at 22:23:01 IST. Redis, dashboard, swing and XSEC are healthy.
  All three apps share `quant-trader:c90483d4aa8418ad8567379639f9cfecbe4bd3ee`.
- Host and all three containers share the 126-file, 1,883,955-byte manifest:
  `ad09b46901bf1d167a5531d1b87c395ee98e94df498a2ab0ef3ef5d181b54b9b`.
  The deployed source tree matches Git. Windows CRLF byte manifests differ
  from Linux; the cloud comparison is byte-for-byte on Linux.
- Deployment gate observed scan advancement 353 to 355, then cleared entry
  freeze. Final normal scan 365 at 22:31:51 IST took 4.336 seconds, evaluated
  all nine and recorded nine NO_SETUP holds. No current setup was forced.
  Entry cadence is 60 seconds; exit watchdog cadence is five seconds. No new
  AI position required a live funding settlement during this observation;
  all-nine funding booking/restart behavior is verified by isolated fixtures.
- All nine report dataReady=true with no required intraday warm-up missing.
  FX has three of eight optional completed weeks, so weekly bias contributes
  zero. Zero-volume FX candles remain visible quality limitations. All nine
  public ticker topics delivered real browser messages; backend quotes were
  fresh through WebSocket or explicit REST recovery, without another venue.
- All 86 old AI and 17 manual fills are present and unchanged across immutable
  ID/action/price/quantity/P&L/time/fee/instrument/version fields. AI hash:
  `ebcd04a5212959d50156024421c514aa0d193036a735c183e4edf4ad847c2872`.
  Manual hash: `1181003ed4e6f32cfe3ea1ac37cb71c8cae11eaae1e2f443fd5707d665f99c0e`.
  Manual BTC continues with frozen opening fields and reconciled quantity.
  XSEC is flat in SHADOW, retaining lifetime drawdown 28.15214287274697%.
- Research has 18 SHADOW configurations and visible insufficient evidence.
  All nine captured compressed evidence; first capture totaled about 63 KB
  under the 1 GiB bound. Final pending queue: 42/4,096, zero rejected intake.
  Independent review remains hourly and never automatically activates a family.
- Runtime ledger verified 119,779 events. Maintenance retained its chain and
  reclaimed 104.7 MB of unused Docker artifacts. About 37 GB of 49 GB remains
  free, with no unused image or reclaimable build cache. Financial history,
  recovery snapshots and Docker data volumes were preserved. Daily maintenance
  and restart-unless-stopped behavior remain configured.
- Deployed browser: 1,394 real topic frames, all nine ticker topics, zero page
  errors, widths 1440/1440 and 390/390 (viewport/document), research and
  insufficient-evidence panels visible. The health modal contains all nine
  quality cards and entry-coverage rows. Screenshots stay private, outside Git.
- Isolated 30-second browser measurement: 59 coalesced BTC price changes,
  receipt-to-matching-DOM median 73.1 ms, p95 124.8 ms, maximum 343 ms. This is
  a small local observation excluding exchange/network latency, not a service
  guarantee. The probe follows both accepted ticker and trade updates; the
  earlier ticker-only and reused-page probes were excluded as confounded.
- In-container live audit: 173 passes, two warnings, zero failures. Warnings
  retain the adverse eight-trade descriptive replay and insufficient setup
  samples. CI also emits lifecycle/deprecation notices, without a check failure.

Private account snapshots remain on the VPS and are never committed. The
primary local checkout now contains the complete reviewed source. Runtime
proof documentation is checkpointed separately from the deployed code artifact.

## Rulings and deferred review findings

The complete executor ruling list follows in ledger order; each includes its
cost if wrong. The one deferred minor follows the rulings. These are retained
before deleting the ignored plan workspace and temporary build checkout.
Ruling: Native worktree tool failed against stale app path, so use normal Git worktree in private TEMP. No secrets or live state copied. Cost if wrong: worktree UI registration is unavailable; Git history and project Memory Quad remain authoritative.
Ruling: User's current end-to-end upgrade request continues prior push/deploy authorization, overriding the planning-only no-deploy text. New unproven families and XSEC risk increase still require evidence and explicit activation. Cost if wrong: a code release could be confused with strategy promotion, so expose the distinction in status and gates.
Ruling: Keep the same plan workspace under its existing self-ignoring directory and use ASCII ledger labels. Exclude .superpowers from Docker context before building. Cost if wrong: development artifacts could otherwise inflate the image.
Task 10: Ruling: Preserve legacy replay and pooled reports as descriptive tools; only preregistered reviews govern promotion. New bar replay shares admission and R/partial thresholds but lacks intrabar watchdog, scale-in and reversal parity. Cost if wrong: its performance estimates can differ from production; critical cost evidence and human activation remain binding.
Ruling: Regrade hidden CAPTURE_ERROR and the wrong archive path as operationally Important for unattended operation. Fix visible failure/last-success status and the runbook path. Cost if wrong: extra small UI/documentation scope; tested behavior limits the change.
Ruling: Preserve conservative 400-hour feature-window independence and bind immutable collection manifests to five-year windows. Cost if wrong: promotion can take years, explicitly documented; no promise of quick self-improvement or fabricated samples.
Ruling: Decline profitability claims, automatic range activation and XSEC risk release. Cost if wrong: useful strategies may remain shadow longer; evidence and owner activation remain required.
Ruling: Accept descriptive bar replay without watchdog, scale-in and reversal parity. Cost if wrong: modeled returns may differ from production, so they cannot establish a production edge.
Ruling: Keep unavailable historical depth/fee/funding evidence fail-closed. Cost if wrong: no promotion until evidence exists; inventing it would admit unsupported risk.
Ruling: Reviewer did not independently rerun VPS, balances, funding or network behavior. Executor will verify the exact deployed artifact and continuity before completion. Cost if wrong: a passing code review could conceal a failed rollout.
Ruling: Reviewer accepted recorded build/test evidence rather than duplicating the full suite. Executor reran the full suite after fixes and will use exact-head CI. Cost if wrong: stale proof could miss regressions.
minor (deferred): browser connection summary counts stale REST as recovered; per-row freshness and execution remain accurate. Cost if wrong: overview wording can overstate recovery, not order eligibility.
