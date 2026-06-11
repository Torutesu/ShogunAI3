#!/usr/bin/env bash
set -euo pipefail

echo "Stopping SHOGUN dev processes…"
if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  kill "$(lsof -t -iTCP:5173 -sTCP:LISTEN)" 2>/dev/null || true
fi
pkill -f '/ShogunAI3/node_modules/.bin/tauri dev' 2>/dev/null || true
pkill -f 'target/debug/app' 2>/dev/null || true
sleep 1
if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Warning: port 5173 still in use"
  exit 1
fi
echo "Stopped."
