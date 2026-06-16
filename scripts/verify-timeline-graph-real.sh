#!/usr/bin/env bash
# Smoke-test timeline graph retrieval against the local Tauri app data dir
# (~/Library/Application Support/ai.Shogun.ShogunAI3/memory.db).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

unset CARGO_TARGET_DIR

SWIFT_LIB="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx/libswift_Concurrency.dylib"
TARGET="$ROOT/src-tauri/target/debug"
if [[ -f "$SWIFT_LIB" ]]; then
  mkdir -p "$TARGET"
  ln -sf "$SWIFT_LIB" "$TARGET/libswift_Concurrency.dylib"
fi

DB="$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db"
if [[ ! -f "$DB" ]]; then
  echo "No local memory.db at:"
  echo "  $DB"
  echo "Start the desktop app once (npm run dev:desktop:mac) to create it."
  exit 1
fi

echo "=== Local DB snapshot ==="
sqlite3 "$DB" <<'SQL'
.headers on
SELECT 'mem_items_active' AS metric, COUNT(*) AS value FROM mem_items WHERE valid_to IS NULL;
SELECT 'edges_active' AS metric, COUNT(*) AS value FROM mem_edges WHERE valid_to IS NULL;
SELECT 'node_kind' AS metric, COALESCE(node_kind,'(unset)') AS value, COUNT(*) AS count
  FROM mem_items WHERE valid_to IS NULL GROUP BY node_kind ORDER BY count DESC LIMIT 5;
SQL

echo ""
echo "=== Rust smoke (graph timeline vs legacy timeline) ==="
cargo test --manifest-path src-tauri/Cargo.toml timeline_graph_real_db_smoke -- --ignored --nocapture
