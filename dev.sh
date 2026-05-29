#!/usr/bin/env bash
#
# Local dev bootstrap + start.
#
# What it does (idempotent — safe to re-run):
#   1. Check Docker is running and the postgres + minio containers are up.
#   2. Check apps/api/.env exists with non-empty ANTHROPIC_API_KEY +
#      BRAVE_SEARCH_API_KEY (Researcher / SDR Drafter won't work otherwise).
#   3. Check apps/web/.env.local exists.
#   4. Create the `getbeyond` database if it doesn't exist.
#   5. Run `prisma migrate deploy` so the schema is current.
#   6. `pnpm dev` — turbo starts API (:3000) + Web (:3001) in parallel.
#
# Stop both servers with Ctrl+C.
#
# Usage:
#   ./dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ─── Colours ──────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_GREEN=$'\033[0;32m'
  C_RED=$'\033[0;31m'
  C_YELLOW=$'\033[0;33m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_GREEN='' C_RED='' C_YELLOW='' C_DIM='' C_RESET=''
fi

ok()   { printf "%s✓%s %s\n" "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf "%s!%s %s\n" "$C_YELLOW" "$C_RESET" "$1"; }
fail() { printf "%s✗%s %s\n" "$C_RED" "$C_RESET" "$1" >&2; exit 1; }
dim()  { printf "%s%s%s\n" "$C_DIM" "$1" "$C_RESET"; }

# ─── 1. Docker + containers ───────────────────────────────────────────────
docker info >/dev/null 2>&1 || fail "Docker isn't running. Start Docker Desktop and re-run."

PG_CONTAINER="$(docker ps --filter "ancestor=postgres:16-alpine" --format '{{.Names}}' | head -n1)"
if [ -z "$PG_CONTAINER" ]; then
  # Fall back: any container exposing :5432
  PG_CONTAINER="$(docker ps --format '{{.Names}}\t{{.Ports}}' | awk -F'\t' '$2 ~ /:5432->/ {print $1; exit}')"
fi
[ -n "$PG_CONTAINER" ] || fail "No Postgres container found. Run: docker compose up -d postgres"
ok "Postgres container: $PG_CONTAINER"

MINIO_CONTAINER="$(docker ps --format '{{.Names}}\t{{.Image}}' | awk -F'\t' '$2 ~ /minio\/minio/ {print $1; exit}')"
if [ -z "$MINIO_CONTAINER" ]; then
  warn "MinIO container not running — CSV imports over 1 MB will fail."
  warn "  Run: docker compose up -d minio minio-init"
else
  ok "MinIO container: $MINIO_CONTAINER"
fi

# ─── 2. Env files ─────────────────────────────────────────────────────────
API_ENV="apps/api/.env"
WEB_ENV="apps/web/.env.local"

[ -f "$API_ENV" ] || fail "$API_ENV is missing. Re-run \`claude\` to regenerate or copy from a teammate."
[ -f "$WEB_ENV" ] || fail "$WEB_ENV is missing."

check_key() {
  local key="$1"
  local value
  value="$(grep -E "^$key=" "$API_ENV" | head -n1 | cut -d= -f2-)"
  if [ -z "$value" ]; then
    warn "$key is empty in $API_ENV — Researcher / SDR Drafter will fail at runtime."
  else
    ok "$key set"
  fi
}
check_key ANTHROPIC_API_KEY
check_key BRAVE_SEARCH_API_KEY

# ─── 3. Database ──────────────────────────────────────────────────────────
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$API_ENV" | head -n1 | cut -d= -f2-)"
[ -n "$DATABASE_URL" ] || fail "DATABASE_URL is missing from $API_ENV."

# Parse db name out of the URL (postgresql://user:pass@host:port/dbname?...)
DB_NAME="$(echo "$DATABASE_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"

if PGPASSWORD=postgres psql -h localhost -U postgres -lqt 2>/dev/null \
     | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
  ok "Database '$DB_NAME' exists"
else
  warn "Database '$DB_NAME' does not exist — creating it"
  PGPASSWORD=postgres createdb -h localhost -U postgres "$DB_NAME" \
    || fail "Could not create database '$DB_NAME'."
  ok "Database '$DB_NAME' created"
fi

# ─── 4. Migrations ────────────────────────────────────────────────────────
dim "Running prisma migrate deploy…"
(
  cd apps/api
  DATABASE_URL="$DATABASE_URL" pnpm prisma migrate deploy >/dev/null
)
ok "Migrations applied"

# ─── 5. Start servers ─────────────────────────────────────────────────────
echo
ok "Bootstrap done. Starting dev servers."
dim "  API → http://localhost:3000"
dim "  Web → http://localhost:3001"
dim "  (Ctrl+C stops both.)"
echo

exec pnpm dev
