# Complete Bybit upgrade verification, 1 October 2026

Release branch: `codex/bybit-complete-upgrade`. Previous deployed release:
`191761f3d075535499d565b68070afcbecda7c2a`. Deployment remains pending until
the exact merged artifact passes the cloud gate and continuity checks.

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

Pending PR CI, private VPS preflight, exact-commit deployment, source/image
parity, advancing scans, all-nine quotes/bars, account/fill continuity, XSEC
flat-state confirmation and deployed browser verification. The private
pre-release account snapshot stays on the VPS and is never committed.
