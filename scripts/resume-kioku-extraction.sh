#!/usr/bin/env bash
# Print local extraction queue status and the resume checklist after LLM quota returns.
set -euo pipefail

DB="${SHOGUN_MEMORY_DB:-$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db}"

if [[ ! -f "$DB" ]]; then
  echo "No local memory.db at:"
  echo "  $DB"
  echo "Start the desktop app once to create it."
  exit 1
fi

echo "=== KIOKU extraction queue ($(basename "$DB")) ==="
sqlite3 "$DB" <<'SQL'
.headers on
.mode column
SELECT status, COUNT(*) AS jobs FROM extraction_jobs GROUP BY status ORDER BY jobs DESC;
SELECT 'edges_active' AS metric, COUNT(*) AS value FROM mem_edges WHERE valid_to IS NULL;
SELECT 'failed_billing' AS metric, COUNT(*) AS value FROM extraction_jobs
  WHERE status = 'failed'
    AND (last_error LIKE '%credit balance%' OR last_error LIKE '%billing_blocked%');
SQL

cat <<'EOF'

=== Resume checklist ===
1. Save a Gemini API key in SHOGUN → Settings → Model & API (AIza…).
2. SHOGUN → Settings → KIOKU Graph → turn **Worker enabled** ON.
3. Click **Resume extraction** (re-queues billing-failed jobs + enables worker).
4. Watch **Queued** count drop and **edges_active** rise in pipeline status.

EOF
