#!/usr/bin/env sh
set -eu

PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/version-6}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"
STATUS_URL="${STATUS_URL:-}"
STATUS_AUTH_TOKEN="${STATUS_AUTH_TOKEN:-}"
WAIT_SECONDS="${WAIT_SECONDS:-70}"
MIN_FREE_MB="${MIN_FREE_MB:-1024}"

usage() {
  cat <<'EOF'
VPS deployment verification for AI Quant Trader.

Usage:
  sh scripts/vps-deploy-check.sh [--project-dir PATH] [--expected-commit SHA]

Environment:
  STATUS_URL          Optional live dashboard status API URL.
  STATUS_AUTH_TOKEN   Optional bearer token for STATUS_URL.
  WAIT_SECONDS        Seconds to wait when checking scan advancement. Default: 70.
  MIN_FREE_MB         Minimum free disk space required in project filesystem. Default: 1024.

This script is read-only. It does not restart containers, prune Docker, delete
data, or mutate Redis.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-dir)
      shift
      if [ "$#" -eq 0 ]; then
        echo "Missing path after --project-dir" >&2
        exit 2
      fi
      PROJECT_DIR="$1"
      ;;
    --expected-commit)
      shift
      if [ "$#" -eq 0 ]; then
        echo "Missing SHA after --expected-commit" >&2
        exit 2
      fi
      EXPECTED_COMMIT="$1"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
  shift
done

section() {
  printf '\n== %s ==\n' "$1"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found."
}

read_scan_id() {
  node -e "const url=process.env.STATUS_URL; const token=process.env.STATUS_AUTH_TOKEN; if (!url) process.exit(2); fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }).then(async (r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((j) => { const id = Number(j && j.swingScan && j.swingScan.scanId); if (!Number.isFinite(id) || id <= 0) throw new Error('missing swingScan.scanId'); console.log(id); }).catch((err) => { console.error(err.message || err); process.exit(1); });"
}

require_cmd git
require_cmd docker
require_cmd node
export STATUS_URL STATUS_AUTH_TOKEN

if [ ! -d "$PROJECT_DIR" ]; then
  fail "Project directory does not exist: $PROJECT_DIR"
fi

cd "$PROJECT_DIR"

if [ ! -f "docker-compose.yml" ]; then
  fail "docker-compose.yml was not found in $PROJECT_DIR"
fi

section "Commit"
CURRENT_COMMIT="$(git rev-parse --short HEAD)"
echo "Current commit: $CURRENT_COMMIT"
if [ -n "$EXPECTED_COMMIT" ]; then
  case "$CURRENT_COMMIT" in
    "$EXPECTED_COMMIT"*) echo "Expected commit matched: $EXPECTED_COMMIT" ;;
    *) fail "Expected commit $EXPECTED_COMMIT but found $CURRENT_COMMIT" ;;
  esac
fi

section "Disk"
df -h .
FREE_KB="$(df -Pk . | awk 'NR==2 {print $4}')"
MIN_FREE_KB=$((MIN_FREE_MB * 1024))
if [ "$FREE_KB" -lt "$MIN_FREE_KB" ]; then
  fail "Free disk is below ${MIN_FREE_MB}MB."
fi
echo "Free disk is above ${MIN_FREE_MB}MB."

section "Docker Storage"
docker system df

section "Compose Services"
docker compose ps
RUNNING_SERVICES="$(docker compose ps --services --status running 2>/dev/null || true)"
for service in quant-dashboard swing-daemon redis; do
  echo "$RUNNING_SERVICES" | grep -qx "$service" || fail "Compose service is not running: $service"
done
echo "Required services are running."

for container in quant-redis quant-dashboard quant-swing-daemon; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$container" 2>/dev/null || true)"
  echo "$container health: $health"
  [ "$health" = "healthy" ] || fail "Container is not healthy: $container ($health)"
done
echo "Healthchecks passed for Redis, dashboard, and swing daemon."

if [ -n "$STATUS_URL" ]; then
  section "Live Strategy Audit"
  docker compose exec -T \
    -e STATUS_URL="$STATUS_URL" \
    -e STATUS_AUTH_TOKEN="$STATUS_AUTH_TOKEN" \
    quant-dashboard npm run audit:strategy

  section "Scan Advancement"
  BEFORE_SCAN="$(read_scan_id)"
  echo "Scan before wait: $BEFORE_SCAN"
  sleep "$WAIT_SECONDS"
  AFTER_SCAN="$(read_scan_id)"
  echo "Scan after wait: $AFTER_SCAN"
  if [ "$AFTER_SCAN" -le "$BEFORE_SCAN" ]; then
    fail "Scan id did not advance after ${WAIT_SECONDS}s."
  fi
else
  section "Live Strategy Audit"
  echo "Skipped. Set STATUS_URL and STATUS_AUTH_TOKEN to verify dashboard API and scan advancement."
fi

section "Daemon Logs"
docker compose logs --tail 80 swing-daemon

echo ""
echo "Deployment verification passed."
