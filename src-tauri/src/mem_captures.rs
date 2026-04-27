//! `mem_captures` table CRUD. Phase 2 Stage 2 (T4) deliverable.
//!
//! This is the new ingestion sink for screen / a11y / future audio captures.
//! `capture_sampler::ingest_app_sample` and the AX path will call `record`
//! instead of `memory_store::ingest`. Extraction (`extraction_jobs`) consumes
//! the rows from here.
//!
//! Spec: `docs/memory-architecture/proposed-schema.sql` §3,
//!       `docs/memory-architecture/migration-plan.md` §Stage 2.1.

#![allow(dead_code)]

use rusqlite::{params, Connection};

/// 14 days in milliseconds — the default TTL for raw capture content.
pub const CAPTURE_RAW_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// All inputs accepted by `record`. Mirrors the table columns minus
/// `id` / `processed_at` / `extraction_*` / `derived_node_ids_json`
/// / `ttl_expires_at` (TTL is computed from `captured_at_ms`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CaptureInput {
  /// `screen_app` | `screen_ax` | `audio_chunk` | `screenshot` | `connector_raw`
  pub kind: String,
  pub raw_text: Option<String>,
  pub raw_path: Option<String>,
  pub app_bundle_id: Option<String>,
  pub window_title: Option<String>,
  pub url: Option<String>,
  pub captured_at_ms: i64,
  pub spatial_context_json: Option<String>,
  pub filter_meta_json: Option<String>,
}

/// Insert one capture. Returns the new `mem_captures.id`. `captured_at_ms`
/// must be > 0; everything else may be NULL. Sets `extraction_status='queued'`
/// and `ttl_expires_at = captured_at_ms + CAPTURE_RAW_TTL_MS`.
pub fn record(input: &CaptureInput, conn: &Connection) -> Result<i64, String> {
  if input.kind.trim().is_empty() {
    return Err("mem_captures::record: kind is required".to_string());
  }
  if input.captured_at_ms <= 0 {
    return Err(format!(
      "mem_captures::record: captured_at_ms must be > 0, got {}",
      input.captured_at_ms,
    ));
  }
  let ttl = input.captured_at_ms + CAPTURE_RAW_TTL_MS;
  conn
    .execute(
      "INSERT INTO mem_captures
         (type, raw_text, raw_path, app_bundle_id, window_title, url,
          captured_at, extraction_status, ttl_expires_at,
          spatial_context, filter_meta_json)
       VALUES
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9, ?10)",
      params![
        input.kind,
        input.raw_text,
        input.raw_path,
        input.app_bundle_id,
        input.window_title,
        input.url,
        input.captured_at_ms,
        ttl,
        input.spatial_context_json,
        input.filter_meta_json,
      ],
    )
    .map_err(|e| format!("mem_captures::record insert: {}", e))?;
  Ok(conn.last_insert_rowid())
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Seed an in-memory DB with the Phase-1 `mem_items` shape and apply the
  /// Phase-2 graph schema additions (creates `mem_captures`, etc.).
  fn open_test_conn() -> Connection {
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
      .expect("seed phase1 mem_items");
    crate::kioku_graph_schema::ensure_kioku_graph_schema(&conn).expect("ensure phase2");
    conn
  }

  fn input_screen_app(ts: i64) -> CaptureInput {
    CaptureInput {
      kind: "screen_app".into(),
      raw_text: Some("app=Slack channel=#shogun-eng".into()),
      raw_path: None,
      app_bundle_id: Some("com.tinyspeck.slackmacgap".into()),
      window_title: Some("Slack | #shogun-eng".into()),
      url: None,
      captured_at_ms: ts,
      spatial_context_json: None,
      filter_meta_json: None,
    }
  }

  #[test]
  fn record_returns_new_row_id_and_inserts_one_row() {
    let conn = open_test_conn();
    let id = record(&input_screen_app(1_000), &conn).expect("record ok");
    assert!(id > 0, "got id {}", id);
    let count: i64 = conn
      .query_row("SELECT COUNT(*) FROM mem_captures", [], |r| r.get(0))
      .expect("count");
    assert_eq!(count, 1);
  }

  #[test]
  fn record_persists_all_provided_fields() {
    let conn = open_test_conn();
    let mut input = input_screen_app(1_000);
    input.spatial_context_json = Some(r#"{"display_id":"main"}"#.into());
    input.filter_meta_json = Some(r#"{"simhash64":"0xa"}"#.into());
    let id = record(&input, &conn).expect("record ok");

    let row: (
      String,
      Option<String>,
      Option<String>,
      Option<String>,
      i64,
      Option<String>,
      Option<String>,
    ) = conn
      .query_row(
        "SELECT type, raw_text, app_bundle_id, window_title, captured_at,
                spatial_context, filter_meta_json
         FROM mem_captures WHERE id = ?1",
        params![id],
        |r| {
          Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
          ))
        },
      )
      .expect("fetch row");
    assert_eq!(row.0, "screen_app");
    assert_eq!(row.1.as_deref(), Some("app=Slack channel=#shogun-eng"));
    assert_eq!(row.2.as_deref(), Some("com.tinyspeck.slackmacgap"));
    assert_eq!(row.3.as_deref(), Some("Slack | #shogun-eng"));
    assert_eq!(row.4, 1_000);
    assert_eq!(row.5.as_deref(), Some(r#"{"display_id":"main"}"#));
    assert_eq!(row.6.as_deref(), Some(r#"{"simhash64":"0xa"}"#));
  }

  #[test]
  fn record_initializes_extraction_status_to_queued() {
    let conn = open_test_conn();
    let id = record(&input_screen_app(1_000), &conn).expect("record ok");
    let status: String = conn
      .query_row(
        "SELECT extraction_status FROM mem_captures WHERE id = ?1",
        params![id],
        |r| r.get(0),
      )
      .expect("fetch");
    assert_eq!(status, "queued");
  }

  #[test]
  fn record_sets_ttl_to_captured_at_plus_14_days() {
    let conn = open_test_conn();
    let id = record(&input_screen_app(1_000), &conn).expect("record ok");
    let ttl: i64 = conn
      .query_row(
        "SELECT ttl_expires_at FROM mem_captures WHERE id = ?1",
        params![id],
        |r| r.get(0),
      )
      .expect("fetch");
    assert_eq!(ttl, 1_000 + CAPTURE_RAW_TTL_MS);
  }

  #[test]
  fn record_rejects_non_positive_captured_at() {
    let conn = open_test_conn();
    let mut input = input_screen_app(0);
    let err = record(&input, &conn).expect_err("zero rejected");
    assert!(err.contains("captured_at"), "got: {}", err);
    input.captured_at_ms = -1;
    let err = record(&input, &conn).expect_err("negative rejected");
    assert!(err.contains("captured_at"), "got: {}", err);
  }

  #[test]
  fn record_rejects_empty_kind() {
    let conn = open_test_conn();
    let mut input = input_screen_app(1_000);
    input.kind.clear();
    let err = record(&input, &conn).expect_err("empty kind rejected");
    assert!(err.to_lowercase().contains("kind"), "got: {}", err);
  }

  #[test]
  fn record_emits_unique_ids_on_repeated_calls() {
    let conn = open_test_conn();
    let a = record(&input_screen_app(1_000), &conn).expect("first");
    let b = record(&input_screen_app(2_000), &conn).expect("second");
    assert_ne!(a, b);
  }
}
