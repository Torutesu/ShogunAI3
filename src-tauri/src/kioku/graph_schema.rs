//! KIOKU graph schema (Phase 2 Stage 1).
//!
//! Adds graph layer columns to `mem_items` and creates the five Phase 2 tables
//! (`mem_edges`, `mem_captures`, `edge_type_proposals`, `extraction_jobs`,
//! `cost_ledger`) without changing existing read or write paths. Idempotent:
//! callers may run `ensure_kioku_graph_schema(conn)` on every connection open
//! per the existing `ensure_*` pattern in `memory_store`.
//!
//! Spec: `docs/memory-architecture/{target-design,proposed-schema.sql,migration-plan.md}`.

use rusqlite::Connection;

/// Map a `(provenance, source)` pair to an initial `node_kind` for backfill.
///
/// Per `docs/memory-architecture/migration-plan.md` §Stage 1.1:
///  - `capture_sampler` / `capture_ax`         → `capture_summary`
///  - `google_calendar`                        → `event`
///  - `gmail`                                  → `note`
///  - meeting* / `meetings*` / `meeting`       → `event`
///  - everything else (incl. NULL provenance)  → `note`
///
/// `provenance` is currently unused in the mapping but kept in the signature so
/// future refinements (e.g. `connector` provenance with non-canonical source)
/// can disambiguate without changing call sites.
pub fn derive_node_kind(_provenance: Option<&str>, source: &str) -> &'static str {
  match source {
    "capture_sampler" | "capture_ax" => "capture_summary",
    "google_calendar" => "event",
    s if s == "meeting" || s.starts_with("meetings") || s.starts_with("meeting_") => "event",
    _ => "note",
  }
}

/// `(name, type)` pairs added to `mem_items` in Phase 2 Stage 1.
/// `confidence` is intentionally absent — it was already added in Phase 1
/// (`memory_store::ensure_context_layer_columns`).
const MEM_ITEMS_PHASE2_COLUMNS: &[(&str, &str)] = &[
  ("valid_from", "INTEGER"),
  ("valid_to", "INTEGER"),
  ("recorded_at", "INTEGER"),
  ("decay_score", "REAL"),
  ("centrality_score", "REAL"),
  ("access_count", "INTEGER NOT NULL DEFAULT 0"),
  ("last_accessed_at", "INTEGER"),
  ("spatial_context", "TEXT"),
  ("source_capture_id", "INTEGER"),
  ("node_kind", "TEXT"),
];

fn existing_column_names(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
  let mut stmt = conn
    .prepare(&format!("PRAGMA table_info({})", table))
    .map_err(|e| e.to_string())?;
  let names: Vec<String> = stmt
    .query_map([], |r| r.get::<_, String>(1))
    .map_err(|e| e.to_string())?
    .filter_map(|x| x.ok())
    .collect();
  Ok(names)
}

fn ensure_mem_items_phase2_columns(conn: &Connection) -> Result<(), String> {
  let existing = existing_column_names(conn, "mem_items")?;
  for (name, ty) in MEM_ITEMS_PHASE2_COLUMNS {
    if !existing.iter().any(|c| c == name) {
      conn
        .execute(
          &format!("ALTER TABLE mem_items ADD COLUMN {} {}", name, ty),
          [],
        )
        .map_err(|e| format!("ALTER mem_items ADD {}: {}", name, e))?;
    }
  }
  Ok(())
}

fn ensure_phase2_tables(conn: &Connection) -> Result<(), String> {
  conn
    .execute_batch(
      r#"
      CREATE TABLE IF NOT EXISTS mem_edges (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        from_node         TEXT    NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,
        to_node           TEXT    NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,
        edge_type         TEXT    NOT NULL,
        weight            REAL    NOT NULL DEFAULT 0.7,
        valid_from        INTEGER NOT NULL,
        valid_to          INTEGER,
        recorded_at       INTEGER NOT NULL,
        source_capture_id INTEGER,
        redaction         TEXT
      );

      CREATE TABLE IF NOT EXISTS mem_captures (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        type                  TEXT    NOT NULL,
        raw_path              TEXT,
        raw_text              TEXT,
        app_bundle_id         TEXT,
        window_title          TEXT,
        url                   TEXT,
        captured_at           INTEGER NOT NULL,
        processed_at          INTEGER,
        extraction_status     TEXT    NOT NULL DEFAULT 'queued',
        extraction_error      TEXT,
        derived_node_ids_json TEXT,
        ttl_expires_at        INTEGER NOT NULL,
        spatial_context       TEXT,
        filter_meta_json      TEXT
      );

      CREATE TABLE IF NOT EXISTS edge_type_proposals (
        edge_type                  TEXT    PRIMARY KEY,
        first_seen_at              INTEGER NOT NULL,
        last_seen_at               INTEGER NOT NULL,
        seen_count                 INTEGER NOT NULL DEFAULT 1,
        example_from_node_ids_json TEXT,
        example_to_node_ids_json   TEXT,
        example_descriptions_json  TEXT,
        reviewed                   INTEGER NOT NULL DEFAULT 0,
        reviewer_note              TEXT
      );

      CREATE TABLE IF NOT EXISTS extraction_jobs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        capture_id      INTEGER REFERENCES mem_captures(id) ON DELETE CASCADE,
        job_kind        TEXT    NOT NULL DEFAULT 'extract',
        status          TEXT    NOT NULL DEFAULT 'queued',
        attempts        INTEGER NOT NULL DEFAULT 0,
        max_attempts    INTEGER NOT NULL DEFAULT 3,
        next_attempt_at INTEGER,
        last_error      TEXT,
        created_at      INTEGER NOT NULL,
        started_at      INTEGER,
        finished_at     INTEGER,
        model           TEXT,
        meta_json       TEXT
      );

      CREATE TABLE IF NOT EXISTS cost_ledger (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at   INTEGER NOT NULL,
        model         TEXT    NOT NULL,
        purpose       TEXT    NOT NULL,
        input_tokens  INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd      REAL    NOT NULL,
        job_id        INTEGER,
        meta_json     TEXT
      );

      CREATE TABLE IF NOT EXISTS lessons (
        id              TEXT PRIMARY KEY,
        category        TEXT NOT NULL,
        trigger_context TEXT NOT NULL,
        attempted       TEXT NOT NULL,
        outcome         TEXT NOT NULL,
        rule            TEXT NOT NULL,
        scope           TEXT NOT NULL DEFAULT 'user',
        source          TEXT NOT NULL,
        embedding       BLOB,
        embedding_dim   INTEGER,
        created_at      INTEGER NOT NULL,
        applies_n       INTEGER NOT NULL DEFAULT 0,
        prevented_n     INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS patterns (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        trigger_json    TEXT NOT NULL,
        action_json     TEXT NOT NULL,
        outcome_json    TEXT,
        confidence      REAL NOT NULL,
        observed_n      INTEGER NOT NULL,
        first_seen_at   INTEGER NOT NULL,
        last_seen_at    INTEGER NOT NULL,
        embedding       BLOB,
        embedding_dim   INTEGER,
        status          TEXT NOT NULL DEFAULT 'active'
      );
      "#,
    )
    .map_err(|e| format!("ensure_phase2_tables: {}", e))
}

fn ensure_phase2_indexes(conn: &Connection) -> Result<(), String> {
  conn
    .execute_batch(
      r#"
      -- mem_items
      CREATE INDEX IF NOT EXISTS idx_mem_items_valid_active
        ON mem_items(valid_to)
        WHERE valid_to IS NULL;
      CREATE INDEX IF NOT EXISTS idx_mem_items_decay
        ON mem_items(decay_score)
        WHERE valid_to IS NULL;
      CREATE INDEX IF NOT EXISTS idx_mem_items_kind
        ON mem_items(node_kind, valid_to);
      CREATE INDEX IF NOT EXISTS idx_mem_items_recent
        ON mem_items(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mem_items_capture
        ON mem_items(source_capture_id)
        WHERE source_capture_id IS NOT NULL;

      -- mem_edges
      CREATE INDEX IF NOT EXISTS idx_mem_edges_from
        ON mem_edges(from_node, edge_type, valid_to);
      CREATE INDEX IF NOT EXISTS idx_mem_edges_to
        ON mem_edges(to_node, edge_type, valid_to);
      CREATE INDEX IF NOT EXISTS idx_mem_edges_active
        ON mem_edges(edge_type, valid_to)
        WHERE valid_to IS NULL;

      -- mem_captures
      CREATE INDEX IF NOT EXISTS idx_mem_captures_status
        ON mem_captures(extraction_status, captured_at);
      CREATE INDEX IF NOT EXISTS idx_mem_captures_ttl
        ON mem_captures(ttl_expires_at)
        WHERE extraction_status = 'done';

      -- edge_type_proposals
      CREATE INDEX IF NOT EXISTS idx_edge_type_proposals_freq
        ON edge_type_proposals(seen_count DESC, last_seen_at DESC);

      -- extraction_jobs
      CREATE INDEX IF NOT EXISTS idx_extraction_jobs_queued
        ON extraction_jobs(status, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_extraction_jobs_capture
        ON extraction_jobs(capture_id);

      -- cost_ledger
      CREATE INDEX IF NOT EXISTS idx_cost_ledger_recorded
        ON cost_ledger(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_cost_ledger_purpose
        ON cost_ledger(purpose, recorded_at);

      -- lessons
      CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);
      CREATE INDEX IF NOT EXISTS idx_lessons_active   ON lessons(status);
      CREATE INDEX IF NOT EXISTS idx_lessons_created  ON lessons(created_at);

      -- patterns
      CREATE INDEX IF NOT EXISTS idx_patterns_kind      ON patterns(kind);
      CREATE INDEX IF NOT EXISTS idx_patterns_active    ON patterns(status);
      CREATE INDEX IF NOT EXISTS idx_patterns_last_seen ON patterns(last_seen_at);
      "#,
    )
    .map_err(|e| format!("ensure_phase2_indexes: {}", e))
}

fn backfill_phase2_columns(conn: &Connection) -> Result<(), String> {
  // bi-temporal: only fill when the column is still NULL so manual overrides
  // and Phase-2-native rows are preserved.
  conn
    .execute(
      "UPDATE mem_items
         SET valid_from = COALESCE(valid_from, created_at),
             recorded_at = COALESCE(recorded_at, created_at),
             last_accessed_at = COALESCE(last_accessed_at, created_at)
       WHERE valid_from IS NULL OR recorded_at IS NULL OR last_accessed_at IS NULL",
      [],
    )
    .map_err(|e| format!("backfill bi-temporal: {}", e))?;

  // node_kind: derive from source for rows that don't have one yet.
  let mut stmt = conn
    .prepare(
      "SELECT id, source FROM mem_items WHERE node_kind IS NULL",
    )
    .map_err(|e| e.to_string())?;
  let rows: Vec<(String, String)> = stmt
    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
    .map_err(|e| e.to_string())?
    .filter_map(|x| x.ok())
    .collect();
  drop(stmt);
  if rows.is_empty() {
    return Ok(());
  }

  let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
  for (id, source) in &rows {
    tx.execute(
      "UPDATE mem_items SET node_kind = ?1 WHERE id = ?2 AND node_kind IS NULL",
      rusqlite::params![derive_node_kind(None, source), id],
    )
    .map_err(|e| format!("backfill node_kind: {}", e))?;
  }
  tx.commit().map_err(|e| e.to_string())?;
  Ok(())
}

/// Apply the Phase 2 Stage 1 schema additions to an existing `memory.db`
/// connection. Safe to call repeatedly; each step feature-detects.
pub fn ensure_kioku_graph_schema(conn: &Connection) -> Result<(), String> {
  ensure_mem_items_phase2_columns(conn)?;
  ensure_phase2_tables(conn)?;
  ensure_phase2_indexes(conn)?;
  backfill_phase2_columns(conn)?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::Connection;

  /// Mirror the `mem_items` shape that `memory_store::init_schema` plus the
  /// existing `ensure_*` helpers produce on a real `memory.db` after Phase 1.
  /// Anything `ensure_kioku_graph_schema` adds must work on top of this.
  fn open_phase1_mem_items() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory");
    conn
      .execute_batch(
        "CREATE TABLE mem_items (
           id TEXT PRIMARY KEY NOT NULL,
           title TEXT NOT NULL,
           snippet TEXT NOT NULL,
           source TEXT NOT NULL,
           kinds_json TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           embedding BLOB,
           provenance TEXT,
           entity_id TEXT,
           confidence REAL,
           redaction TEXT
         );",
      )
      .expect("create phase1 mem_items");
    conn
  }

  fn column_names(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
      .prepare(&format!("PRAGMA table_info({})", table))
      .expect("pragma");
    let cols: Vec<String> = stmt
      .query_map([], |r| r.get::<_, String>(1))
      .expect("query")
      .filter_map(|x| x.ok())
      .collect();
    cols
  }

  #[test]
  fn ensure_adds_phase2_columns_to_mem_items() {
    let conn = open_phase1_mem_items();
    ensure_kioku_graph_schema(&conn).expect("ensure ok");
    let cols = column_names(&conn, "mem_items");
    for expected in [
      "valid_from",
      "valid_to",
      "recorded_at",
      "decay_score",
      "centrality_score",
      "access_count",
      "last_accessed_at",
      "spatial_context",
      "source_capture_id",
      "node_kind",
    ] {
      assert!(
        cols.iter().any(|c| c == expected),
        "missing column {expected}; have: {cols:?}",
      );
    }
  }

  #[test]
  fn ensure_is_idempotent_on_repeated_calls() {
    let conn = open_phase1_mem_items();
    ensure_kioku_graph_schema(&conn).expect("first call");
    // Second call must not error (e.g. duplicate column ALTER).
    ensure_kioku_graph_schema(&conn).expect("second call");
    let cols = column_names(&conn, "mem_items");
    // Spot-check a couple of additions are still present and not duplicated.
    assert_eq!(cols.iter().filter(|c| c.as_str() == "node_kind").count(), 1);
    assert_eq!(cols.iter().filter(|c| c.as_str() == "valid_to").count(), 1);
  }

  fn table_exists(conn: &Connection, name: &str) -> bool {
    let count: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        rusqlite::params![name],
        |r| r.get(0),
      )
      .unwrap_or(0);
    count == 1
  }

  #[test]
  fn ensure_creates_mem_edges_table_with_required_shape() {
    let conn = open_phase1_mem_items();
    ensure_kioku_graph_schema(&conn).expect("ensure ok");
    assert!(table_exists(&conn, "mem_edges"), "mem_edges should exist");
    let cols = column_names(&conn, "mem_edges");
    for expected in [
      "id",
      "from_node",
      "to_node",
      "edge_type",
      "weight",
      "valid_from",
      "valid_to",
      "recorded_at",
      "source_capture_id",
      "redaction",
    ] {
      assert!(
        cols.iter().any(|c| c == expected),
        "mem_edges missing column {expected}; have: {cols:?}",
      );
    }
  }

  #[test]
  fn ensure_creates_mem_captures_table_with_required_shape() {
    let conn = open_phase1_mem_items();
    ensure_kioku_graph_schema(&conn).expect("ensure ok");
    assert!(table_exists(&conn, "mem_captures"), "mem_captures should exist");
    let cols = column_names(&conn, "mem_captures");
    for expected in [
      "id",
      "type",
      "raw_path",
      "raw_text",
      "app_bundle_id",
      "window_title",
      "url",
      "captured_at",
      "processed_at",
      "extraction_status",
      "extraction_error",
      "derived_node_ids_json",
      "ttl_expires_at",
      "spatial_context",
      "filter_meta_json",
    ] {
      assert!(
        cols.iter().any(|c| c == expected),
        "mem_captures missing column {expected}; have: {cols:?}",
      );
    }
  }

  #[test]
  fn ensure_creates_edge_type_proposals_table() {
    let conn = open_phase1_mem_items();
    ensure_kioku_graph_schema(&conn).expect("ensure ok");
    assert!(table_exists(&conn, "edge_type_proposals"));
    let cols = column_names(&conn, "edge_type_proposals");
    for expected in [
      "edge_type",
      "first_seen_at",
      "last_seen_at",
      "seen_count",
      "example_from_node_ids_json",
      "example_to_node_ids_json",
      "example_descriptions_json",
      "reviewed",
      "reviewer_note",
    ] {
      assert!(
        cols.iter().any(|c| c == expected),
        "edge_type_proposals missing column {expected}; have: {cols:?}",
      );
    }
  }

  #[test]
  fn ensure_creates_extraction_jobs_table() {
    let conn = open_phase1_mem_items();
    ensure_kioku_graph_schema(&conn).expect("ensure ok");
    assert!(table_exists(&conn, "extraction_jobs"));
    let cols = column_names(&conn, "extraction_jobs");
    for expected in [
      "id",
      "capture_id",
      "job_kind",
      "status",
      "attempts",
      "max_attempts",
      "next_attempt_at",
      "last_error",
      "created_at",
      "started_at",
      "finished_at",
      "model",
      "meta_json",
    ] {
      assert!(
        cols.iter().any(|c| c == expected),
        "extraction_jobs missing column {expected}; have: {cols:?}",
      );
    }
  }

  #[test]
  fn ensure_creates_cost_ledger_table() {
    let conn = open_phase1_mem_items();
    ensure_kioku_graph_schema(&conn).expect("ensure ok");
    assert!(table_exists(&conn, "cost_ledger"));
    let cols = column_names(&conn, "cost_ledger");
    for expected in [
      "id",
      "recorded_at",
      "model",
      "purpose",
      "input_tokens",
      "output_tokens",
      "cost_usd",
      "job_id",
      "meta_json",
    ] {
      assert!(
        cols.iter().any(|c| c == expected),
        "cost_ledger missing column {expected}; have: {cols:?}",
      );
    }
  }

  #[test]
  fn ensure_new_tables_accept_minimal_insert() {
    // FK references mem_items.id, so seed a row first.
    let conn = open_phase1_mem_items();
    conn
      .execute(
        "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at)
         VALUES ('m_a', 't', 's', 'capture', '[]', 100)",
        [],
      )
      .expect("seed mem_items");
    ensure_kioku_graph_schema(&conn).expect("ensure ok");

    // mem_captures: minimal-fields insert sanity check
    conn
      .execute(
        "INSERT INTO mem_captures (type, captured_at, ttl_expires_at) VALUES ('screen_app', 100, 200)",
        [],
      )
      .expect("insert mem_captures");

    // mem_edges with valid FK
    conn
      .execute(
        "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at)
         VALUES ('m_b', 't', 's', 'capture', '[]', 100)",
        [],
      )
      .expect("seed second node");
    conn
      .execute(
        "INSERT INTO mem_edges (from_node, to_node, edge_type, valid_from, recorded_at)
         VALUES ('m_a', 'm_b', 'mentions', 100, 100)",
        [],
      )
      .expect("insert mem_edges");

    // edge_type_proposals
    conn
      .execute(
        "INSERT INTO edge_type_proposals (edge_type, first_seen_at, last_seen_at)
         VALUES ('mentions', 100, 100)",
        [],
      )
      .expect("insert edge_type_proposals");

    // extraction_jobs
    conn
      .execute(
        "INSERT INTO extraction_jobs (created_at) VALUES (100)",
        [],
      )
      .expect("insert extraction_jobs");

    // cost_ledger
    conn
      .execute(
        "INSERT INTO cost_ledger (recorded_at, model, purpose, input_tokens, output_tokens, cost_usd)
         VALUES (100, 'claude-haiku-4-5', 'extraction', 50, 30, 0.0001)",
        [],
      )
      .expect("insert cost_ledger");
  }

  fn index_exists(conn: &Connection, name: &str) -> bool {
    let count: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
        rusqlite::params![name],
        |r| r.get(0),
      )
      .unwrap_or(0);
    count == 1
  }

  #[test]
  fn ensure_creates_phase2_indexes() {
    let conn = open_phase1_mem_items();
    ensure_kioku_graph_schema(&conn).expect("ensure ok");
    for expected in [
      // mem_items
      "idx_mem_items_valid_active",
      "idx_mem_items_decay",
      "idx_mem_items_kind",
      "idx_mem_items_recent",
      "idx_mem_items_capture",
      // mem_edges
      "idx_mem_edges_from",
      "idx_mem_edges_to",
      "idx_mem_edges_active",
      // mem_captures
      "idx_mem_captures_status",
      "idx_mem_captures_ttl",
      // edge_type_proposals
      "idx_edge_type_proposals_freq",
      // extraction_jobs
      "idx_extraction_jobs_queued",
      "idx_extraction_jobs_capture",
      // cost_ledger
      "idx_cost_ledger_recorded",
      "idx_cost_ledger_purpose",
    ] {
      assert!(
        index_exists(&conn, expected),
        "missing index {expected}",
      );
    }
  }

  /// Helper: insert a Phase 1 row before the migration runs. Only Phase 1
  /// columns are populated; the new Phase 2 columns must be filled by the
  /// backfill step in `ensure_kioku_graph_schema`.
  fn seed_phase1_row(conn: &Connection, id: &str, source: &str, created_at: i64) {
    conn
      .execute(
        "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at)
         VALUES (?1, 't', 's', ?2, '[]', ?3)",
        rusqlite::params![id, source, created_at],
      )
      .expect("seed phase1 row");
  }

  fn read_phase2_fields(
    conn: &Connection,
    id: &str,
  ) -> (Option<String>, Option<i64>, Option<i64>, Option<i64>, i64) {
    conn
      .query_row(
        "SELECT node_kind, valid_from, recorded_at, last_accessed_at, access_count
         FROM mem_items WHERE id = ?1",
        rusqlite::params![id],
        |r| {
          Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, Option<i64>>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, i64>(4)?,
          ))
        },
      )
      .expect("re-read")
  }

  #[test]
  fn backfill_populates_node_kind_from_source() {
    let conn = open_phase1_mem_items();
    seed_phase1_row(&conn, "m_cap", "capture_sampler", 100);
    seed_phase1_row(&conn, "m_ax", "capture_ax", 100);
    seed_phase1_row(&conn, "m_cal", "google_calendar", 100);
    seed_phase1_row(&conn, "m_mail", "gmail", 100);
    seed_phase1_row(&conn, "m_meet", "meeting", 100);
    seed_phase1_row(&conn, "m_other", "home_attachment", 100);

    ensure_kioku_graph_schema(&conn).expect("ensure ok");

    assert_eq!(read_phase2_fields(&conn, "m_cap").0.as_deref(), Some("capture_summary"));
    assert_eq!(read_phase2_fields(&conn, "m_ax").0.as_deref(), Some("capture_summary"));
    assert_eq!(read_phase2_fields(&conn, "m_cal").0.as_deref(), Some("event"));
    assert_eq!(read_phase2_fields(&conn, "m_mail").0.as_deref(), Some("note"));
    assert_eq!(read_phase2_fields(&conn, "m_meet").0.as_deref(), Some("event"));
    assert_eq!(read_phase2_fields(&conn, "m_other").0.as_deref(), Some("note"));
  }

  #[test]
  fn backfill_sets_bi_temporal_columns_to_created_at() {
    let conn = open_phase1_mem_items();
    seed_phase1_row(&conn, "m_1", "capture", 1714000000000);
    ensure_kioku_graph_schema(&conn).expect("ensure ok");
    let (_, valid_from, recorded_at, last_acc, access_count) = read_phase2_fields(&conn, "m_1");
    assert_eq!(valid_from, Some(1714000000000));
    assert_eq!(recorded_at, Some(1714000000000));
    assert_eq!(last_acc, Some(1714000000000));
    assert_eq!(access_count, 0);
  }

  #[test]
  fn backfill_does_not_overwrite_explicit_values() {
    // If a row already has node_kind / valid_from set (e.g. from a partial
    // earlier migration or from a Phase 2 row already inserted), the backfill
    // must not clobber them.
    let conn = open_phase1_mem_items();
    seed_phase1_row(&conn, "m_1", "google_calendar", 100);
    // First run populates the fields.
    ensure_kioku_graph_schema(&conn).expect("first ensure");
    // Manually flip the value to mimic an upstream override.
    conn
      .execute(
        "UPDATE mem_items SET node_kind = 'decision', valid_from = 999 WHERE id = 'm_1'",
        [],
      )
      .expect("override");
    // Second run must leave the override alone.
    ensure_kioku_graph_schema(&conn).expect("second ensure");
    let (kind, valid_from, _, _, _) = read_phase2_fields(&conn, "m_1");
    assert_eq!(kind.as_deref(), Some("decision"));
    assert_eq!(valid_from, Some(999));
  }

  #[test]
  fn backfill_handles_empty_table_without_error() {
    // Fresh install: no rows yet. Backfill is a no-op but must not error.
    let conn = open_phase1_mem_items();
    ensure_kioku_graph_schema(&conn).expect("ensure on empty table");
    let count: i64 = conn
      .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
      .expect("count");
    assert_eq!(count, 0);
  }

  #[test]
  fn ensure_does_not_clobber_phase1_columns() {
    // Pre-existing rows survive the migration without losing data on Phase 1
    // columns (provenance / entity_id / confidence / redaction). A naive
    // table-rebuild would drop these silently; ALTER must preserve them.
    let conn = open_phase1_mem_items();
    conn
      .execute(
        "INSERT INTO mem_items
           (id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction)
         VALUES
           ('m_1', 'T', 'S', 'gmail', '[]', 100, 'connector', 'gm-42', 0.9, 'none')",
        [],
      )
      .expect("seed row");
    ensure_kioku_graph_schema(&conn).expect("ensure ok");

    let row: (String, String, Option<f64>, Option<String>) = conn
      .query_row(
        "SELECT provenance, entity_id, confidence, redaction FROM mem_items WHERE id = 'm_1'",
        [],
        |r| {
          Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<f64>>(2)?,
            r.get::<_, Option<String>>(3)?,
          ))
        },
      )
      .expect("re-read");
    assert_eq!(row.0, "connector");
    assert_eq!(row.1, "gm-42");
    assert_eq!(row.2, Some(0.9));
    assert_eq!(row.3, Some("none".to_string()));
  }

  #[test]
  fn derive_node_kind_capture_sources_become_capture_summary() {
    assert_eq!(derive_node_kind(Some("screen"), "capture_sampler"), "capture_summary");
    assert_eq!(derive_node_kind(Some("screen"), "capture_ax"), "capture_summary");
  }

  #[test]
  fn derive_node_kind_calendar_becomes_event() {
    assert_eq!(derive_node_kind(Some("connector"), "google_calendar"), "event");
  }

  #[test]
  fn derive_node_kind_gmail_becomes_note() {
    // Gmail rows are textual messages, not events. Future extraction may
    // promote individual Gmail items to `event` (calendar invites embedded in
    // mail), but the default backfill keeps them as notes.
    assert_eq!(derive_node_kind(Some("connector"), "gmail"), "note");
  }

  #[test]
  fn derive_node_kind_meeting_family_becomes_event() {
    assert_eq!(derive_node_kind(Some("meeting"), "meeting"), "event");
    assert_eq!(derive_node_kind(Some("meeting"), "meetings_granola"), "event");
    assert_eq!(derive_node_kind(Some("meeting"), "meeting_zoom"), "event");
  }

  #[test]
  fn derive_node_kind_unknown_source_falls_back_to_note() {
    assert_eq!(derive_node_kind(Some("user"), "capture"), "note");
    assert_eq!(derive_node_kind(Some("user"), "home_attachment"), "note");
    assert_eq!(derive_node_kind(Some("user"), "focus_session"), "note");
    assert_eq!(derive_node_kind(Some("user"), "telemetry_chat_context"), "note");
    assert_eq!(derive_node_kind(None, ""), "note");
    assert_eq!(derive_node_kind(None, "totally_unknown_source"), "note");
  }
}
