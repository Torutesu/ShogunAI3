#!/usr/bin/env bash
# Reliable macOS dev launcher: project target dir + Swift dylib + port check.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -x node_modules/.bin/vite ]]; then
  echo "node_modules missing — running npm ci…"
  npm ci
fi

unset CARGO_TARGET_DIR

SWIFT_LIB="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx/libswift_Concurrency.dylib"
TARGET="$ROOT/src-tauri/target/debug"
if [[ -f "$SWIFT_LIB" ]]; then
  mkdir -p "$TARGET"
  ln -sf "$SWIFT_LIB" "$TARGET/libswift_Concurrency.dylib"
fi

if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo ""
  echo "Port 5173 is already in use — SHOGUN dev is probably already running."
  echo "  • Check Dock for the SHOGUN window (no need to start again)"
  echo "  • To restart cleanly:"
  echo "      npm run dev:desktop:stop"
  echo "      npm run dev:desktop:mac"
  echo ""
  exit 1
fi

exec npm run dev:desktop
