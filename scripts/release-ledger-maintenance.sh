#!/bin/sh
set -eu
# Usage: sh scripts/release-ledger-maintenance.sh <deploy backup directory>
BACKUP_DIR="${1:?usage: release-ledger-maintenance.sh <backup directory>}"

# Every application service can append financial events, including manual
# orders through the dashboard. A failed stop must prevent destructive work.
docker compose stop quant-dashboard swing-daemon xsec-daemon

# Dry run first: compaction only acts when enough old scan telemetry exists.
PLAN="$(docker compose run --rm --no-deps -T swing-daemon tsx scripts/ledger-compact.ts)"
echo "$PLAN"

if echo "$PLAN" | grep -q '"status": "WOULD_COMPACT"'; then
  # Owner-approved removal is permanent, so keep one verified full copy of the
  # ledger in this deploy's backup first. Deploy backups keep the newest 3.
  echo "Copying the full ledger to $BACKUP_DIR/execution-ledger before compaction..."
  rm -rf "$BACKUP_DIR/execution-ledger"
  cp -R data/execution-ledger "$BACKUP_DIR/execution-ledger"
  docker compose run --rm --no-deps -T swing-daemon tsx scripts/verify-execution-ledger.ts --directory "$BACKUP_DIR/execution-ledger"
  docker compose run --rm --no-deps -T swing-daemon tsx scripts/ledger-compact.ts --apply
fi

docker compose run --rm --no-deps -T swing-daemon tsx scripts/verify-execution-ledger.ts
