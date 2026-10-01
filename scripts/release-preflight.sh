#!/usr/bin/env sh
set -eu
umask 077

PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/version-6}"
RELEASE_SHA="${RELEASE_SHA:?RELEASE_SHA is required}"
case "$RELEASE_SHA" in *[!0-9a-f]*|"") echo "Invalid release SHA" >&2; exit 2;; esac
[ "${#RELEASE_SHA}" -eq 40 ] || { echo "Expected a full SHA" >&2; exit 2; }
cd "$PROJECT_DIR"
STAGING="data/release-preflight/$RELEASE_SHA"
mkdir -p "$STAGING/source"
git fetch origin "$RELEASE_SHA"
git archive "$RELEASE_SHA" | tar -x -C "$STAGING/source"

printf 'Previous deployed commit: '
git rev-parse HEAD
df -m .
docker compose ps
docker system df
du -sh data/* 2>/dev/null || true
CONTAINER_SOURCE="/app/$STAGING/source"
CONTAINER_STATE="/app/$STAGING"
docker exec -w "$CONTAINER_SOURCE" quant-dashboard node scripts/export-release-snapshot.mjs --output "$CONTAINER_STATE/live-snapshot.json"
docker exec -w "$CONTAINER_SOURCE" quant-dashboard tsx scripts/migrate-bybit-instruments.ts --input "$CONTAINER_STATE/live-snapshot.json" --output "$CONTAINER_STATE/migration-preview.json"
docker exec -w "$CONTAINER_SOURCE" quant-dashboard node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const a of p.accounts){if(!a.accountLabeling.cashUnchanged)throw Error("Cash changed in preview");if(Object.keys(a.blockedAssets||{}).length)throw Error("Open-position migration conflict: "+a.account);console.log(JSON.stringify({account:a.account,originalHash:a.originalHash,quantityModel:a.quantityModel,historicalConflicts:a.conflicts.length}));}' "$CONTAINER_STATE/migration-preview.json"
docker exec -w "$CONTAINER_SOURCE" quant-dashboard tsx scripts/verify-bybit-public-release.ts --output "$CONTAINER_STATE/public-market-proof.json"
# The extracted code is disposable; retain only snapshot and verification evidence.
docker exec quant-dashboard node -e 'const fs=require("fs");const p=require("path");const root=p.resolve("/app/data/release-preflight");const target=p.resolve(process.argv[1]);if(!target.startsWith(root+"/")||p.basename(target)!=="source")throw Error("Unexpected cleanup path");fs.rmSync(target,{recursive:true,force:true});' "$CONTAINER_SOURCE"
printf 'PASS: private snapshot, open-position migration compatibility, public Bybit paths and reconnects verified for %s\n' "$RELEASE_SHA"
