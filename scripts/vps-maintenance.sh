#!/usr/bin/env sh
set -eu

PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/version-6}"
DRY_RUN=1
RESTART=0
PRUNE_UNTIL="${PRUNE_UNTIL:-24h}"

usage() {
  cat <<'EOF'
Safe VPS maintenance for AI Quant Trader.

Usage:
  scripts/vps-maintenance.sh [--dry-run] [--apply] [--restart] [--project-dir PATH]

Default mode is --dry-run. The script never prunes Docker volumes and never
deletes project data. It only targets unused Docker build cache, dangling/unused
images, and stopped containers when --apply is explicitly provided.

Options:
  --dry-run          Show what would be checked and cleaned. Default.
  --apply            Actually run safe Docker cleanup commands.
  --restart          After cleanup, restart the current Docker Compose stack.
  --project-dir PATH Project directory on the VPS. Default: /home/ubuntu/version-6.
  --help             Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --apply)
      DRY_RUN=0
      ;;
    --restart)
      RESTART=1
      ;;
    --project-dir)
      shift
      if [ "$#" -eq 0 ]; then
        echo "Missing path after --project-dir" >&2
        exit 2
      fi
      PROJECT_DIR="$1"
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

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    printf '[run] %s\n' "$*"
    "$@"
  fi
}

section() {
  printf '\n== %s ==\n' "$1"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not available in PATH." >&2
  exit 1
fi

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project directory does not exist: $PROJECT_DIR" >&2
  exit 1
fi

cd "$PROJECT_DIR"

if [ ! -f "docker-compose.yml" ]; then
  echo "Refusing to run: docker-compose.yml was not found in $PROJECT_DIR" >&2
  exit 1
fi

section "Mode"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run only. No cleanup will be applied."
else
  echo "Apply mode. Safe cleanup commands will run."
fi
echo "Project: $PROJECT_DIR"
echo "Build-cache prune threshold: unused for at least $PRUNE_UNTIL"

section "Disk Before"
df -h .

section "Docker Compose Services"
docker compose ps

section "Docker Storage Before"
docker system df

section "Protected Runtime State"
echo "Protected Docker volume: redis_data"
echo "Protected project data directory: $PROJECT_DIR/data"
if [ -d "$PROJECT_DIR/data" ]; then
  du -sh "$PROJECT_DIR/data" || true
else
  echo "No project data directory found yet."
fi

section "Cleanup Plan"
echo "Will prune stopped containers only."
echo "Will prune unused images only."
echo "Will prune unused Docker build cache older than $PRUNE_UNTIL."
echo "Will NOT run docker volume prune."
echo "Will NOT delete Redis data."
echo "Will NOT delete $PROJECT_DIR/data."

run docker container prune -f
run docker image prune -af
run docker builder prune -af --filter "until=$PRUNE_UNTIL"

if [ "$RESTART" -eq 1 ]; then
  section "Compose Restart"
  export APP_COMMIT_SHA="$(git rev-parse HEAD)"
  export APP_DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  run docker compose up -d --remove-orphans
fi

section "Docker Storage After"
docker system df

section "Disk After"
df -h .

section "Final Service Status"
docker compose ps

echo ""
echo "Maintenance complete."
