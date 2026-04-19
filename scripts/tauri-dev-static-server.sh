#!/usr/bin/env bash
# Serve Hi-Fi static files from repo root (paths like hifi/app.jsx are relative to SHOGUN Hi-Fi UI.html).
# Resolves the repo root from this script so `tauri dev` works even if cwd is not the repo root.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
exec python3 -m http.server 4173 --bind 127.0.0.1
