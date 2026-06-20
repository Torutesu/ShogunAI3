#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ensure_node_modules() {
  local dir="$1"
  if [[ ! -d "$dir/node_modules" ]]; then
    echo "Installing dependencies for $dir..."
    npm ci --prefix "$dir"
  fi
}

npm run typecheck
npm run lint
npm run cycles
npm run knip
npm run check:actions
npm run test:unit
npm run check:rust
npm run test:rust
npm run test:e2e

ensure_node_modules web
npm run check:web

ensure_node_modules tools/amc-pipeline
npm run check:amc

npm run check:mirror
