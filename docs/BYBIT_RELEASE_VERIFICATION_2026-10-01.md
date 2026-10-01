# Bybit Release A: deployment verification (2026-10-01)

Deployed commit: `191761f3d075535499d565b68070afcbecda7c2a`.
Runtime: https://trader.tejashendre.com
Final deployment: https://github.com/tejashendre/AI-paper-trading-agent/actions/runs/36854097722
Merged changes: PR #8 and PR #9. The first deployment's scan gate failed safely; PR #9 repaired restart scan numbering and current-commit health readiness. The final deployment passed.

## Verified result

- Node 20 upgrade suite: 197/197 passing. Build, TypeScript and lint pass. Offline strategy audit: 155 pass, one insufficient-research warning, zero fail. npm audit: zero reported vulnerabilities.
- Actual VPS preflights verified raw Redis compatibility privately without applying a migration, all nine Bybit metadata/closed-candle/quote/depth/funding paths, and two independent nine-symbol WebSocket sessions.
- All three application containers use one shared image with the deployed commit. Container health and source manifests match the host checkout. Redis remains healthy and its volume is preserved.
- Deployment scan IDs advanced from 20 to 22 during the 75-second gate. The release freeze was then cleared. Final normal scan #34 at 11:31:33 UTC carried the deployed runtime commit and nine NO_SETUP decisions, with no operator freeze or scan errors. Data readiness passed for nine of nine assets. This confirms operation, not that a trade should always be entered.
- Manual BTC remains open with unchanged amount, entry price/time, stop, target, invested amount and direction. All 17 manual and 86 AI trade IDs from the before-deployment snapshot remain visible. Comparing immutable fill fields across all 103 historical trades found zero changes to identifiers, instrument/action, price, amount, invested amount, PnL, timestamp, fees or strategy version. No account reset, fill rewrite or migration apply occurred.
- Owner-approved XSEC reduction closed all 24 existing positions. Gross exposure is zero and the book is SHADOW. Lifetime maximum drawdown remains 28.15%; it was not erased. Reactivation still requires documented authorization and promotion evidence.
- Initial maintenance compressed 67 ledger day files: 2133.9 MB to 351.7 MB, reclaiming 1782.2 MB (83.5%). All 119,385 events present at the compression checkpoint retained the same valid hash chain. Later live events continue appending. Recovery backups remain available.
- Unused Docker images/build artifacts were pruned. The final disk report shows about 37 GB available on the 49 GB filesystem. Non-reclaimable layers needed by running images remain. Docker logs already rotate at 10 MB times three files per service; market caches expire. Daily maintenance now runs through the existing GitHub workflow, compressing old ledger days and reclaiming unused Docker artifacts. Running containers restart after process failure or host reboot under the existing Compose policy.
- Removed unused live-exchange and Supabase writer source paths and their ccxt/Supabase dependency chains. Production excludes docs, history, account data and build cache from the image. Trade history and historical learning evidence are retained.
- Browser review: spectator dashboard rendered without browser errors; market-health modal contains nine coverage cards; desktop 1440 px and mobile 390 px had no horizontal overflow. Mobile/desktop screenshots remain private local verification artifacts rather than production image content.

## Current limits

Release A covers data consistency, execution economics, outcomes, risk and visibility. The later strategy-family, scoped learning and promotion tasks in Release B are still pending. The current research sample is insufficient to establish an edge. No mandatory LLM or paid market-data service was added.

The three FX quality warnings concern zero-volume candles, not failed API connections. Closed-candle age and live-quote age describe different things. Low participation, quiet markets and exchange interruptions cannot be fixed by hiding warnings.

## Free subsecond quotes: next implementation slice

Bybit's derivative ticker cadence is 100 ms: https://bybit-exchange.github.io/docs/v5/websocket/public/ticker. It is an upstream publishing interval, not a zero-latency or continuous-price-change guarantee. Current code batches Redis writes every 1000 ms in `src/daemon/websocketDataMesh.ts`; `src/components/Dashboard.tsx` polls `/api/live-prices` every 1000 ms. Swing scans run every 60 seconds and the exit watchdog every five seconds. This system is not executing decisions at millisecond frequency.

A lean next slice can provide subsecond display updates without adding a paid dependency:

1. Use one public Bybit WebSocket per browser for all nine ticker topics, with the validated snapshot/delta merge semantics. Render at no more than 10 updates/second and hold only the latest state. Keep all trading decisions on the existing backend feed and risk gates.
2. Keep the current authenticated live-price endpoint as a fallback when the browser stream disconnects. Back off reconnects and avoid aggressive REST polling; rate limits are documented at https://bybit-exchange.github.io/docs/v5/rate-limit.
3. Show connection/transport state, latest quote receipt age, last-trade age and candle/liquidity quality separately in the market-health panel. Rename the existing candle age label so it is not read as a price-delivery delay. Do not turn quality warnings green without supporting evidence.
4. Measure receipt-to-render latency with a monotonic browser clock and transport age separately. Exchange timestamps require clock-offset handling; the current REST sample showed roughly 330 ms of clock offset, so a negative computed exchange age is not evidence of zero delay.
5. Verify all nine symbols, snapshot/delta merging, unchanged fields, reconnect reset, quiet-market handling and REST fallback. Test rendering load and reconnect behavior at desktop/mobile sizes. Record p50/p95 under actual VPS/browser conditions; use a subsecond target, not a promised one-millisecond ceiling.
6. Do not persist each tick in the ledger, lower strategy decision intervals, or change exit/entry risk policy as a side effect of display work. Faster bot execution requires a separate evidence-backed scope.

This faster-display slice is specified, not implemented in the shipped release.
