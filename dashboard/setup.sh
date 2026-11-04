#!/bin/sh
# =============================================================================
# Braivex Vaani. One command setup.
#
#   sh setup.sh
#
# Checks Node 18+, creates .env from the template on first run, and installs
# the single runtime dependency (pg). Supabase is the only database.
# =============================================================================

set -e

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

PORT_DEFAULT=8787

if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); G=$(printf '\033[32m')
  Y=$(printf '\033[33m'); R=$(printf '\033[31m'); C=$(printf '\033[36m'); X=$(printf '\033[0m')
else
  B=''; DIM=''; G=''; Y=''; R=''; C=''; X=''
fi

say()  { printf '%s\n' "$1"; }
ok()   { printf '%s  ok  %s%s\n' "$G" "$X" "$1"; }
warn() { printf '%s warn %s%s\n' "$Y" "$X" "$1"; }
die()  { printf '%s fail %s%s\n' "$R" "$X" "$1"; exit 1; }

say ""
say "${B}${C}Braivex Vaani${X}  setup"
say "${DIM}Supabase-backed AI voice CRM${X}"
say ""

# ---- 1. Node 18 or newer ----------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed. Install Node 18 or newer from https://nodejs.org then run this again."
fi

NODE_RAW=$(node -v)
NODE_MAJOR=$(printf '%s' "$NODE_RAW" | sed 's/^v//' | cut -d. -f1)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "Could not read your Node version ($NODE_RAW). Please install Node 18 or newer." ;;
esac
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node $NODE_RAW found, but Braivex Vaani needs Node 18 or newer. Please upgrade."
fi
ok "Node $NODE_RAW detected"

# ---- 2. .env ----------------------------------------------------------------
if [ -f .env ]; then
  ok ".env already present, leaving it untouched"
else
  if [ -f .env.example ]; then
    cp .env.example .env
    ok "created .env from .env.example"
  else
    warn "no .env and no .env.example found, create .env by hand"
  fi
fi

# ---- 3. dependencies --------------------------------------------------------
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --prod
elif command -v npm >/dev/null 2>&1; then
  npm install --omit=dev
else
  warn "no pnpm or npm found, install pg manually"
fi
ok "dependencies installed"

# ---- 4. port hint -----------------------------------------------------------
PORT="$PORT_DEFAULT"
if [ -f .env ]; then
  ENV_PORT=$(grep -E '^[[:space:]]*PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d '[:space:]')
  [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
fi

say ""
say "${G}Setup complete.${X}"
say ""
say "Fill in Supabase values in ${B}.env${X}:"
say "  ${B}SUPABASE_URL${X}"
say "  ${B}SUPABASE_ANON_KEY${X}"
say "  ${B}VAANI_DATABASE_URL${X}"
say "  ${B}VAANI_INGESTION_SECRET${X}"
say ""
say "Start the server:"
say "  ${B}node server.js${X}"
say ""
say "Open:"
say "  ${B}${C}http://localhost:${PORT}${X}"
