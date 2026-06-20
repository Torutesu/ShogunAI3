#!/usr/bin/env bash
# Reliable macOS dev launcher: project target dir cleanup + port/process checks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -x node_modules/.bin/vite ]]; then
  echo "node_modules missing — running npm ci…"
  npm ci
fi

unset CARGO_TARGET_DIR

TARGET="$ROOT/src-tauri/target/debug"
if [[ -e "$TARGET/libswift_Concurrency.dylib" ]]; then
  rm -f "$TARGET/libswift_Concurrency.dylib"
fi

if pgrep -f "$ROOT/src-tauri/target/debug/app" >/dev/null 2>&1; then
  echo ""
  echo "A SHOGUN desktop process is already running."
  echo "  npm run dev:desktop:stop"
  echo "  npm run dev:desktop"
  echo ""
  exit 1
fi

if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo ""
  echo "Port 5173 is already in use — SHOGUN dev is probably already running."
  echo "  • Check Dock for the SHOGUN window (no need to start again)"
  echo "  • To restart cleanly:"
  echo "      npm run dev:desktop:stop"
  echo "      npm run dev:desktop"
  echo ""
  exit 1
fi

exec npm run dev:desktop:raw
