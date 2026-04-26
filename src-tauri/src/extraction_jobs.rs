//! `extraction_jobs` queue table CRUD. Phase 2 Stage 2 (T4) deliverable.
//!
//! Stage 2 ships only the enqueue side. The worker that pulls `status='queued'`
//! and calls the BYOK extraction model lands in T5.
//!
//! Spec: `docs/memory-architecture/proposed-schema.sql` §5,
//!       `docs/memory-architecture/migration-plan.md` §Stage 2.4.

#![allow(dead_code)]

use rusqlite::{params, Connection};

/// `extraction_jobs.job_kind` taxonomy.
pub const JOB_KIND_EXTRACT: &str = "extract";
pub const JOB_KIND_EDGE_LINK: &str = "edge_link";
pub const JOB_KIND_SUMMARIZE: &str = "summarize";

/// Default retry budget per job. Worker increments `attempts` on each failure.
pub const DEFAULT_MAX_ATTEMPTS: i64 = 3;

/// Insert a new job in `status='queued'`. Returns the new id. `created_at_ms`
/// must be > 0. `capture_id` is required for `JOB_KIND_EXTRACT`; other kinds
/// may pass `None` (e.g. `summarize` operates on an existing `mem_items.id`
/// passed via `meta_json`).
pub fn enqueue(
  capture_id: Option<i64>,
  job_kind: &str,
  created_at_ms: i64,
  meta_json: Option<&str>,
  conn: &Connection,
) -> Result<i64, String> {
  if job_kind.trim().is_empty() {
    return Err("extraction_jobs::enqueue: job_kind is required".to_string());
  }
  if created_at_ms <= 0 {
    return Err(format!(
      "extraction_jobs::enqueue: created_at_ms must be > 0, got {}",
      created_at_ms,
    ));
  }
  if job_kind == JOB_KIND_EXTRACT && capture_id.is_none() {
    return Err("extraction_jobs::enqueue: capture_id is required for extract jobs".to_string());
  }
  conn
    .execute(
      "INSERT INTO extraction_jobs
         (capture_id, job_kind, status, attempts, max_attempts, created_at, meta_json)
       VALUES
         (?1, ?2, 'queued', 0, ?3, ?4, ?5)",
      params![
        capture_id,
        job_kind,
        DEFAULT_MAX_ATTEMPTS,
        created_at_ms,
        meta_json,
      ],
    )
    .map_err(|e| format!("extraction_jobs::enqueue insert: {}", e))?;
  Ok(conn.last_insert_rowid())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::mem_captures::{record, CaptureInput};

  fn open_test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory");
    // Mirror production: foreign_keys ON so the FK violation test is
    // actually enforced.
    conn
      .execute_batch("PRAGMA foreign_keys=ON;")
      .expect("enable FK");
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
      .expect("seed phase1");
    crate::kioku_graph_schema::ensure_kioku_graph_schema(&conn).expect("ensure phase2");
    conn
  }

  fn seed_capture(conn: &Connection, ts: i64) -> i64 {
    record(
      &CaptureInput {
        kind: "screen_app".into(),
        captured_at_ms: ts,
        ..Default::default()
      },
      conn,
    )
    .expect("seed capture")
  }

  #[test]
  fn enqueue_returns_new_id_and_inserts_one_row() {
    let conn = open_test_conn();
    let cap = seed_capture(&conn, 1_000);
    let id = enqueue(Some(cap), JOB_KIND_EXTRACT, 2_000, None, &conn).expect("ok");
    assert!(id > 0);
    let count: i64 = conn
      .query_row("SELECT COUNT(*) FROM extraction_jobs", [], |r| r.get(0))
      .expect("count");
    assert_eq!(count, 1);
  }

  #[test]
  fn enqueue_persists_payload_fields() {
    let conn = open_test_conn();
    let cap = seed_capture(&conn, 1_000);
    let id = enqueue(
      Some(cap),
      JOB_KIND_EXTRACT,
      2_000,
      Some(r#"{"batched_capture_ids":[1,2]}"#),
      &conn,
    )
    .expect("ok");
    let row: (Option<i64>, String, String, i64, i64, i64, Option<String>) = conn
      .query_row(
        "SELECT capture_id, job_kind, status, attempts, max_attempts, created_at, meta_json
         FROM extraction_jobs WHERE id = ?1",
        params![id],
        |r| {
          Ok((
            r.get::<_, Option<i64>>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, Option<String>>(6)?,
          ))
        },
      )
      .expect("fetch");
    assert_eq!(row.0, Some(cap));
    assert_eq!(row.1, "extract");
    assert_eq!(row.2, "queued");
    assert_eq!(row.3, 0);
    assert_eq!(row.4, DEFAULT_MAX_ATTEMPTS);
    assert_eq!(row.5, 2_000);
    assert_eq!(row.6.as_deref(), Some(r#"{"batched_capture_ids":[1,2]}"#));
  }

  #[test]
  fn enqueue_rejects_empty_job_kind() {
    let conn = open_test_conn();
    let cap = seed_capture(&conn, 1_000);
    let err = enqueue(Some(cap), "", 2_000, None, &conn).expect_err("empty rejected");
    assert!(err.to_lowercase().contains("kind"), "got: {}", err);
  }

  #[test]
  fn enqueue_rejects_non_positive_created_at() {
    let conn = open_test_conn();
    let cap = seed_capture(&conn, 1_000);
    let err = enqueue(Some(cap), JOB_KIND_EXTRACT, 0, None, &conn).expect_err("zero rejected");
    assert!(err.contains("created_at"), "got: {}", err);
  }

  #[test]
  fn enqueue_extract_requires_capture_id() {
    let conn = open_test_conn();
    let err = enqueue(None, JOB_KIND_EXTRACT, 2_000, None, &conn).expect_err("None rejected for extract");
    assert!(err.contains("capture_id"), "got: {}", err);
  }

  #[test]
  fn enqueue_summarize_allows_no_capture() {
    let conn = open_test_conn();
    let id = enqueue(None, JOB_KIND_SUMMARIZE, 2_000, Some(r#"{"target_id":"m_1"}"#), &conn)
      .expect("summarize allowed");
    assert!(id > 0);
  }

  #[test]
  fn enqueue_invalid_capture_id_returns_fk_error() {
    let conn = open_test_conn();
    // capture_id 9_999 doesn't exist; FK violation surfaces as Err.
    let err = enqueue(Some(9_999), JOB_KIND_EXTRACT, 2_000, None, &conn)
      .expect_err("FK violation");
    let lower = err.to_lowercase();
    assert!(
      lower.contains("foreign") || lower.contains("constraint"),
      "expected FK error, got: {}",
      err,
    );
  }
}
