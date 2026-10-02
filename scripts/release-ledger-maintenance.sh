#!/bin/sh
set -eu
# Every application service can append financial events, including manual
# orders through the dashboard. A failed stop must prevent destructive work.
docker compose stop quant-dashboard swing-daemon xsec-daemon
docker compose run --rm --no-deps -T swing-daemon tsx scripts/ledger-compact.ts --apply
docker compose run --rm --no-deps -T swing-daemon tsx scripts/verify-execution-ledger.ts
