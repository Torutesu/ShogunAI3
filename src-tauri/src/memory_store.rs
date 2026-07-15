//! Memory index: SQLite + **FTS5** full-text search (`memory.db` under app data).
//!
//! **Local-first:** Data stays on device; no SHOGUN cloud sync for this index.
//! Migrations: legacy `memory_items.json` is imported once when the DB is empty, then renamed to
//! `memory_items.json.migrated`.

use crate::{embeddings, paths, secrets};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const MEMORY_DB: &str = "memory.db";
const LEGACY_JSON: &str = "memory_items.json";

/// Map a `source` string to a `provenance` tag per `docs/context-layer-phase-0-1.md` §0.
/// Used at ingest time to populate the row and at search time as a fallback when the
/// persisted `provenance` column is absent (pre-migration rows, in-memory fixtures).
pub fn derive_provenance(source: &str) -> &'static str {
    match source {
        "capture_sampler" | "capture_ax" => "screen",
        "google_calendar" | "gmail" => "connector",
        s if s == "meeting" || s.starts_with("meetings") || s.starts_with("meeting_") => "meeting",
        _ => "user",
    }
}

pub(crate) fn db_path() -> Result<std::path::PathBuf, String> {
    #[cfg(test)]
    {
        if let Some(p) = test_db_path_override() {
            return Ok(p);
        }
    }
    Ok(paths::app_data_dir()?.join(MEMORY_DB))
}

#[cfg(test)]
thread_local! {
  static TEST_DB_PATH: std::cell::RefCell<Option<std::path::PathBuf>> =
    const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn test_db_path_override() -> Option<std::path::PathBuf> {
    TEST_DB_PATH.with(|c| c.borrow().clone())
}

#[cfg(test)]
pub(crate) fn set_test_db_path(p: std::path::PathBuf) {
    TEST_DB_PATH.with(|c| *c.borrow_mut() = Some(p));
}

#[cfg(test)]
pub(crate) fn clear_test_db_path() {
    TEST_DB_PATH.with(|c| *c.borrow_mut() = None);
}

/// Cross-module test support. Command-level characterization tests (in
/// `commands.rs`, `meeting_commands.rs`, …) need the same "point `memory.db`
/// at a throwaway temp file" seam that `memory_store`'s own tests use, so the
/// RAII guard lives here as `pub(crate)` instead of being re-implemented in
/// every test module. The override is a `thread_local`, which is safe because
/// the test harness runs each `#[test]` / `#[tokio::test]` body on its own
/// thread (tokio's default test flavor is `current_thread`).
#[cfg(test)]
pub(crate) mod testkit {
    /// RAII guard that points `db_path()` at a fresh temp file for the lifetime
    /// of the test, then removes the file and clears the override on drop.
    pub(crate) struct TestDbGuard {
        path: std::path::PathBuf,
    }

    impl TestDbGuard {
        pub(crate) fn new(name: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static UNIQ: AtomicU64 = AtomicU64::new(0);
            let n = UNIQ.fetch_add(1, Ordering::Relaxed);
            let mut p = std::env::temp_dir();
            p.push(format!(
                "shogun-cmd-test-{}-{}-{}-memory.db",
                std::process::id(),
                n,
                name
            ));
            // Best-effort cleanup of any leftover from a prior crashed test run.
            let _ = std::fs::remove_file(&p);
            let _ = std::fs::remove_file(format!("{}-wal", p.display()));
            let _ = std::fs::remove_file(format!("{}-shm", p.display()));

            super::set_test_db_path(p.clone());
            TestDbGuard { path: p }
        }
    }

    impl Drop for TestDbGuard {
        fn drop(&mut self) {
            super::clear_test_db_path();
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
            let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
        }
    }
}

pub(crate) fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn open_conn() -> Result<Connection, String> {
    let path = db_path()?;
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| e.to_string())?;
    init_schema(&conn)?;
    ensure_embedding_column(&conn)?;
    ensure_context_layer_columns(&conn)?;
    ensure_redaction_nullable(&conn)?;
    migrate_json_if_needed(&conn)?;
    // Phase 2 Stage 1: KIOKU graph layer columns + new tables + backfill.
    // Must run after the Phase 1 ensures so the redaction-nullable table
    // rebuild does not strip Phase 2 columns out from under us.
    crate::kioku_graph_schema::ensure_kioku_graph_schema(&conn)?;
    Ok(conn)
}

/// Interpret a SQLite `PRAGMA quick_check` result. `"ok"` means healthy; any
/// other value is a corruption report. Pure so it is unit-tested.
pub(crate) fn interpret_quick_check(result: &str) -> Result<(), String> {
    if result.trim() == "ok" {
        Ok(())
    } else {
        Err(format!("integrity check failed: {}", result.trim()))
    }
}

/// Run a fast integrity + writability check on a connection.
pub(crate) fn health_check_conn(conn: &Connection) -> Result<(), String> {
    let result: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    interpret_quick_check(&result)
}

/// Boot-time DB health check (audit F-14). Opening the connection also exercises
/// every schema migration and proves the file is writable (WAL journal), so a
/// corrupt / unwritable / disk-full store surfaces a clear error at startup
/// instead of silently dropping captures later. Never panics.
pub fn health_check() -> Result<(), String> {
    let conn = open_conn()?;
    health_check_conn(&conn)
}

pub(crate) fn ensure_embedding_column(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(mem_items)")
        .map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(|x| x.ok())
        .collect();
    if !names.iter().any(|n| n == "embedding") {
        conn.execute("ALTER TABLE mem_items ADD COLUMN embedding BLOB", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Phase-1 columns from `docs/context-layer-phase-0-1.md` §1. Added via ALTER
/// TABLE on first run; `provenance` is backfilled from `source` once so that
/// downstream code can rely on it being populated.
pub(crate) fn ensure_context_layer_columns(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(mem_items)")
        .map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(|x| x.ok())
        .collect();
    drop(stmt);

    let needs_provenance = !names.iter().any(|n| n == "provenance");
    if needs_provenance {
        conn.execute("ALTER TABLE mem_items ADD COLUMN provenance TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    if !names.iter().any(|n| n == "entity_id") {
        conn.execute("ALTER TABLE mem_items ADD COLUMN entity_id TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    if !names.iter().any(|n| n == "confidence") {
        conn.execute("ALTER TABLE mem_items ADD COLUMN confidence REAL", [])
            .map_err(|e| e.to_string())?;
    }
    if !names.iter().any(|n| n == "redaction") {
        conn.execute("ALTER TABLE mem_items ADD COLUMN redaction TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    if !names.iter().any(|n| n == "meeting_id") {
        conn.execute("ALTER TABLE mem_items ADD COLUMN meeting_id TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    if !names.iter().any(|n| n == "meeting_offset_ms") {
        conn.execute(
            "ALTER TABLE mem_items ADD COLUMN meeting_offset_ms INTEGER",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    conn
    .execute(
      "CREATE INDEX IF NOT EXISTS idx_mem_items_meeting_id ON mem_items(meeting_id) WHERE meeting_id IS NOT NULL",
      [],
    )
    .map_err(|e| e.to_string())?;

    if needs_provenance {
        backfill_provenance_from_source(conn)?;
    }

    // Partial UNIQUE index to dedupe historical-sync ingestion keyed by
    // (source, entity_id). Skipped for rows without an entity_id (e.g. screen
    // captures, free-form notes) so those remain append-only.
    //
    // Lives here rather than in `init_schema` because it references
    // `entity_id`, which is created above. Putting it in `init_schema` would
    // crash any fresh DB whose `CREATE TABLE IF NOT EXISTS` ran before the
    // column was added by ALTER.
    //
    // Pre-existing databases may already contain duplicates from prior
    // calendar / gmail re-runs, so compress dupes (keep the oldest rowid per
    // (source, entity_id)) before the index creation, otherwise the unique
    // index would abort on duplicate keys.
    conn.execute(
        "DELETE FROM mem_items \
       WHERE entity_id IS NOT NULL AND entity_id != '' \
         AND rowid NOT IN ( \
           SELECT MIN(rowid) FROM mem_items \
           WHERE entity_id IS NOT NULL AND entity_id != '' \
           GROUP BY source, entity_id \
         )",
        [],
    )
    .map_err(|e| format!("mem_items dedupe pre-index: {}", e))?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_items_entity_unique \
       ON mem_items(source, entity_id) \
       WHERE entity_id IS NOT NULL AND entity_id != ''",
        [],
    )
    .map_err(|e| format!("mem_items entity unique index: {}", e))?;

    Ok(())
}

/// Relax a legacy NOT NULL constraint on `mem_items.redaction`. Old dev DBs were
/// created with `redaction TEXT NOT NULL`, which blocks ingest from sources that
/// don't produce a whitelisted redaction tag (e.g. `capture_ax`). SQLite can't
/// drop a column constraint in place, so rebuild the table when detected.
fn ensure_redaction_nullable(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(mem_items)")
        .map_err(|e| e.to_string())?;
    let mut is_notnull = false;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(3)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (name, notnull) = row.map_err(|e| e.to_string())?;
        if name == "redaction" && notnull == 1 {
            is_notnull = true;
            break;
        }
    }
    drop(stmt);
    if !is_notnull {
        return Ok(());
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
    r#"
      DROP TRIGGER IF EXISTS mem_items_ai;
      DROP TRIGGER IF EXISTS mem_items_ad;
      DROP TRIGGER IF EXISTS mem_items_au;

      CREATE TABLE mem_items_new (
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
      );

      INSERT INTO mem_items_new
        (id, title, snippet, source, kinds_json, created_at, embedding, provenance, entity_id, confidence, redaction)
        SELECT id, title, snippet, source, kinds_json, created_at, embedding, provenance, entity_id, confidence, redaction
        FROM mem_items;

      DROP TABLE mem_items;
      ALTER TABLE mem_items_new RENAME TO mem_items;

      CREATE TRIGGER mem_items_ai AFTER INSERT ON mem_items BEGIN
        INSERT INTO mem_items_fts(rowid, title, snippet, source)
        VALUES (new.rowid, new.title, new.snippet, new.source);
      END;
      CREATE TRIGGER mem_items_ad AFTER DELETE ON mem_items BEGIN
        INSERT INTO mem_items_fts(mem_items_fts, rowid, title, snippet, source)
        VALUES('delete', old.rowid, old.title, old.snippet, old.source);
      END;
      CREATE TRIGGER mem_items_au AFTER UPDATE ON mem_items BEGIN
        INSERT INTO mem_items_fts(mem_items_fts, rowid, title, snippet, source)
        VALUES('delete', old.rowid, old.title, old.snippet, old.source);
        INSERT INTO mem_items_fts(rowid, title, snippet, source)
        VALUES (new.rowid, new.title, new.snippet, new.source);
      END;

      INSERT INTO mem_items_fts(mem_items_fts) VALUES('rebuild');
    "#,
  )
  .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    log::info!("memory_store: rebuilt mem_items to relax redaction NOT NULL");
    Ok(())
}

/// One-shot: populate `provenance` for rows that never had it. Called only when
/// the column has just been added; the `WHERE provenance IS NULL` clause makes
/// it safe to re-run but it should only fire once in practice.
fn backfill_provenance_from_source(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, source FROM mem_items WHERE provenance IS NULL")
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
            "UPDATE mem_items SET provenance = ?1 WHERE id = ?2",
            params![derive_provenance(source), id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    log::info!(
        "memory_store: backfilled provenance on {} row(s)",
        rows.len()
    );
    Ok(())
}

fn encode_embedding_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn decode_embedding_blob(b: &[u8]) -> Option<Vec<f32>> {
    if b.len() % 4 != 0 {
        return None;
    }
    Some(
        b.chunks_exact(4)
            .filter_map(|c| c.try_into().ok().map(f32::from_le_bytes))
            .collect(),
    )
}

fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn count_missing_embeddings() -> Result<u64, String> {
    let conn = open_conn()?;
    let n: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM mem_items WHERE embedding IS NULL AND source NOT IN ('capture_sampler', 'capture_ax')",
      [],
      |r| r.get(0),
    )
    .map_err(|e| e.to_string())?;
    Ok(n as u64)
}

fn truncate_api_error(s: String) -> String {
    let t = s.trim();
    const MAX: usize = 220;
    if t.chars().count() > MAX {
        let take = t.chars().take(MAX).collect::<String>();
        format!("{take}…")
    } else {
        t.to_string()
    }
}

async fn embed_row_by_id(id: &str) -> Result<(), String> {
    let conn = open_conn()?;
    let (title, snippet): (String, String) = conn
        .query_row(
            "SELECT title, snippet FROM mem_items WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let text: String = format!("{}\n{}", title, snippet)
        .chars()
        .take(8000)
        .collect();
    let vec = embeddings::embed_one(&text).await?;
    let blob = encode_embedding_blob(&vec);
    conn.execute(
        "UPDATE mem_items SET embedding = ?1 WHERE id = ?2",
        params![blob, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Optional Tauri app (progress events) and cancel flag checked between rows.
pub struct BackfillEmitContext<'a> {
    pub app: Option<AppHandle>,
    pub cancel: Option<&'a AtomicBool>,
}

fn is_transient_embed_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    if m.contains("api key is not set")
        || m.contains("empty text for embedding")
        || m.contains("unexpected embeddings response")
        || m.contains("embedding entry not numeric")
        || m.contains("invalid embeddings json")
    {
        return false;
    }
    m.contains("embeddings api error")
        || m.contains("embeddings network error")
        || m.contains("error sending request")
        || m.contains("timed out")
        || m.contains("timeout")
        || m.contains("connection closed")
        || m.contains("connection reset")
}

async fn embed_row_by_id_with_retries(id: &str) -> Result<(), String> {
    const MAX_ATTEMPTS: u32 = 5;
    for attempt in 0..MAX_ATTEMPTS {
        match embed_row_by_id(id).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                if attempt + 1 >= MAX_ATTEMPTS || !is_transient_embed_error(&e) {
                    return Err(e);
                }
                let backoff_ms = (500u64 * (1u64 << attempt)).min(8000);
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            }
        }
    }
    Err("embedding retries exhausted".to_string())
}

fn emit_backfill_progress(app: &AppHandle, index: u64, total: u64, embedded: u64, failed: u64) {
    let _ = app.emit(
        "memory-embed-backfill-progress",
        json!({
          "index": index,
          "total": total,
          "embedded": embedded,
          "failed": failed,
        }),
    );
}

/// Idempotent migration: add `sync_status` / `sync_excluded_reason` columns
/// to `mem_items` if they don't yet exist. Safe to call on any schema
/// version, including those that already have the columns. Uses
/// `PRAGMA table_info` so we don't need a separate version table.
fn migrate_sync_status_columns(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(mem_items)")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut has_status = false;
    let mut has_reason = false;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let name: String = row.get(1).map_err(|e| e.to_string())?;
        if name == "sync_status" {
            has_status = true;
        }
        if name == "sync_excluded_reason" {
            has_reason = true;
        }
    }
    drop(rows);
    drop(stmt);

    if !has_status {
        conn.execute(
            "ALTER TABLE mem_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local_only'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    if !has_reason {
        conn.execute(
            "ALTER TABLE mem_items ADD COLUMN sync_excluded_reason TEXT",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Idempotent migration: add `cloud_index_id` / `encrypted_at` / `sync_attempt_count`
/// columns (Phase 2.1.2).
///
/// - `cloud_index_id TEXT` — server-assigned blob_id, NULL until uploaded
/// - `encrypted_at INTEGER` — Unix ms when uploaded, NULL until uploaded
/// - `sync_attempt_count INTEGER NOT NULL DEFAULT 0` — per-row upload attempt
///   counter so the S4 retry-and-stuck guard survives app restarts. Increments
///   on transient failure; rows reaching `max_attempts` (6) are marked
///   `sync_status='excluded'` with `sync_excluded_reason='stuck'`.
fn migrate_mirror_columns(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(mem_items)")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut has_cloud_index_id = false;
    let mut has_encrypted_at = false;
    let mut has_sync_attempt_count = false;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let name: String = row.get(1).map_err(|e| e.to_string())?;
        if name == "cloud_index_id" {
            has_cloud_index_id = true;
        }
        if name == "encrypted_at" {
            has_encrypted_at = true;
        }
        if name == "sync_attempt_count" {
            has_sync_attempt_count = true;
        }
    }
    drop(rows);
    drop(stmt);

    if !has_cloud_index_id {
        conn.execute("ALTER TABLE mem_items ADD COLUMN cloud_index_id TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    if !has_encrypted_at {
        conn.execute("ALTER TABLE mem_items ADD COLUMN encrypted_at INTEGER", [])
            .map_err(|e| e.to_string())?;
    }
    if !has_sync_attempt_count {
        conn.execute(
            "ALTER TABLE mem_items ADD COLUMN sync_attempt_count INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
      CREATE TABLE IF NOT EXISTS mem_items (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        snippet TEXT NOT NULL,
        source TEXT NOT NULL,
        kinds_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'local_only',
        sync_excluded_reason TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS mem_items_fts USING fts5(
        title,
        snippet,
        source,
        tokenize = 'unicode61',
        content='mem_items',
        content_rowid='rowid'
      );
    "#,
    )
    .map_err(|e| e.to_string())?;

    migrate_sync_status_columns(conn)?;
    migrate_mirror_columns(conn)?;

    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='mem_items_ai'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if n == 0 {
        conn.execute_batch(
            r#"
      CREATE TRIGGER mem_items_ai AFTER INSERT ON mem_items BEGIN
        INSERT INTO mem_items_fts(rowid, title, snippet, source)
        VALUES (new.rowid, new.title, new.snippet, new.source);
      END;
      CREATE TRIGGER mem_items_ad AFTER DELETE ON mem_items BEGIN
        INSERT INTO mem_items_fts(mem_items_fts, rowid, title, snippet, source)
        VALUES('delete', old.rowid, old.title, old.snippet, old.source);
      END;
      CREATE TRIGGER mem_items_au AFTER UPDATE ON mem_items BEGIN
        INSERT INTO mem_items_fts(mem_items_fts, rowid, title, snippet, source)
        VALUES('delete', old.rowid, old.title, old.snippet, old.source);
        INSERT INTO mem_items_fts(rowid, title, snippet, source)
        VALUES (new.rowid, new.title, new.snippet, new.source);
      END;
    "#,
        )
        .map_err(|e| e.to_string())?;
    }
    // Memory Digest (Phase 1): per-item summary cache.
    // target_kind: 'item' | 'session' | 'week_rollup' (Phase 1 uses 'item' only)
    // target_id: item.id / session.id / ISO week
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mem_summaries (
      target_kind    TEXT    NOT NULL,
      target_id      TEXT    NOT NULL,
      title          TEXT    NOT NULL,
      key_points     TEXT    NOT NULL,
      source_type    TEXT    NOT NULL,
      priority       TEXT    NOT NULL,
      reason         TEXT,
      model          TEXT    NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      generated_at   INTEGER NOT NULL,
      raw_json       TEXT    NOT NULL,
      lang           TEXT    NOT NULL DEFAULT 'en',
      PRIMARY KEY (target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mem_summaries_generated_at
      ON mem_summaries(generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_summaries_priority
      ON mem_summaries(priority, generated_at DESC);",
    )
    .map_err(|e| format!("mem_summaries DDL: {}", e))?;
    // Migration: add lang column to pre-existing tables (idempotent).
    let has_lang = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('mem_summaries') WHERE name = 'lang'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0);
    if has_lang == 0 {
        conn.execute(
            "ALTER TABLE mem_summaries ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'",
            [],
        )
        .map_err(|e| format!("mem_summaries add lang: {}", e))?;
    }
    // Migration: user_priority override ('high'|'medium'|'low' or NULL).
    // When non-NULL, UI uses it instead of the LLM-assigned priority.
    // Added 2026-04-24 for the manual-override UX.
    let has_user_priority = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('mem_summaries') WHERE name = 'user_priority'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0);
    if has_user_priority == 0 {
        conn.execute(
            "ALTER TABLE mem_summaries ADD COLUMN user_priority TEXT",
            [],
        )
        .map_err(|e| format!("mem_summaries add user_priority: {}", e))?;
    }
    // Migration: acknowledged_at (ms) for "mark as read" UX. NULL = unread.
    // Reset to NULL when the summary is invalidated/regenerated so a refreshed
    // HIGH item resurfaces in the unread badge.
    let has_acknowledged_at = conn.query_row(
    "SELECT COUNT(*) FROM pragma_table_info('mem_summaries') WHERE name = 'acknowledged_at'",
    [],
    |r| r.get::<_, i64>(0),
  ).unwrap_or(0);
    if has_acknowledged_at == 0 {
        conn.execute(
            "ALTER TABLE mem_summaries ADD COLUMN acknowledged_at INTEGER",
            [],
        )
        .map_err(|e| format!("mem_summaries add acknowledged_at: {}", e))?;
    }
    // Migration: snooze_until (ms) lets the user defer an item to "look at
    // later" without acknowledging it. Hidden from highlights while
    // snooze_until > now_ms; re-surfaces automatically when the deadline
    // passes. Reset (= NULL) when the summary is invalidated/regenerated.
    let has_snooze_until = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('mem_summaries') WHERE name = 'snooze_until'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0);
    if has_snooze_until == 0 {
        conn.execute(
            "ALTER TABLE mem_summaries ADD COLUMN snooze_until INTEGER",
            [],
        )
        .map_err(|e| format!("mem_summaries add snooze_until: {}", e))?;
    }

    crate::meeting_store::ensure_meeting_schema(conn)?;
    Ok(())
}

fn migrate_json_if_needed(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count > 0 {
        return Ok(());
    }
    let json_path = paths::app_data_dir()?.join(LEGACY_JSON);
    if !json_path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&json_path).map_err(|e| e.to_string())?;
    let doc: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let items = doc
        .get("items")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for it in items {
        let id = it
            .get("id")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("m_{}", now_ms()));
        let title = it
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let snippet = it
            .get("snippet")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let source = it
            .get("source")
            .and_then(|t| t.as_str())
            .unwrap_or("capture")
            .to_string();
        let kinds = it
            .get("kinds")
            .cloned()
            .unwrap_or_else(|| json!(["screen"]));
        let kinds_json = serde_json::to_string(&kinds).map_err(|e| e.to_string())?;
        let created_at = it
            .get("created_at")
            .and_then(|x| x.as_u64())
            .unwrap_or_else(|| now_ms()) as i64;
        let provenance = derive_provenance(&source).to_string();
        tx.execute(
      "INSERT OR REPLACE INTO mem_items (id, title, snippet, source, kinds_json, created_at, provenance) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      params![id, title, snippet, source, kinds_json, created_at, provenance],
    )
    .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    let bak = json_path.with_extension("json.migrated");
    let _ = fs::rename(&json_path, bak);
    Ok(())
}

fn kinds_json_to_value(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|_| json!([]))
}

/// Parse stored `kinds_json` for API responses (graph timeline hits).
pub fn kinds_json_to_value_pub(s: &str) -> Value {
    kinds_json_to_value(s)
}

/// Attach FTS5 `highlight()` / `snippet()` output to a memory item row when
/// the marker characters are actually present — i.e. the match was in that
/// column. The frontend later splits on the markers to wrap each span in
/// `<mark>`; sentinels outside `\x02` / `\x03` keep the contract HTML-safe
/// (no escaping needed).
fn attach_fts_highlights(item: &mut Value, title_hl: Option<String>, snippet_hl: Option<String>) {
    let Some(obj) = item.as_object_mut() else {
        return;
    };
    if let Some(t) = title_hl.filter(|s| s.contains(HL_START)) {
        obj.insert("title_highlight".to_string(), json!(t));
    }
    if let Some(s) = snippet_hl.filter(|s| s.contains(HL_START)) {
        obj.insert("snippet_highlight".to_string(), json!(s));
    }
}

fn row_to_item(
    id: String,
    title: String,
    snippet: String,
    source: String,
    kinds_json: String,
    created_at: i64,
    provenance: Option<String>,
    entity_id: Option<String>,
    confidence: Option<f64>,
    redaction: Option<String>,
    sync_status: Option<String>,
    sync_excluded_reason: Option<String>,
    cloud_index_id: Option<String>,
    encrypted_at: Option<i64>,
) -> Value {
    let prov = provenance
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| derive_provenance(&source).to_string());
    let ss = sync_status.unwrap_or_else(|| "local_only".to_string());
    let mut obj = json!({
      "id": id,
      "title": title,
      "snippet": snippet,
      "source": source,
      "kinds": kinds_json_to_value(&kinds_json),
      "created_at": created_at.max(0) as u64,
      "provenance": prov,
      "syncStatus": ss,
    });
    if let Some(map) = obj.as_object_mut() {
        if let Some(e) = entity_id.filter(|s| !s.is_empty()) {
            map.insert("entity_id".to_string(), json!(e));
        }
        if let Some(c) = confidence.filter(|c| c.is_finite()) {
            map.insert("confidence".to_string(), json!(c));
        }
        if let Some(r) = redaction.filter(|s| !s.is_empty()) {
            map.insert("redaction".to_string(), json!(r));
        }
        if let Some(reason) = sync_excluded_reason.filter(|s| !s.is_empty()) {
            map.insert("syncExcludedReason".to_string(), json!(reason));
        }
        if let Some(cid) = cloud_index_id.filter(|s| !s.is_empty()) {
            map.insert("cloudIndexId".to_string(), json!(cid));
        }
        if let Some(ea) = encrypted_at {
            map.insert("encryptedAt".to_string(), json!(ea));
        }
    }
    obj
}

/// Whitelist per `docs/context-layer-phase-0-1.md` §1. Unrecognized values are
/// dropped at ingest and the source-derived fallback is used instead.
fn is_valid_provenance(s: &str) -> bool {
    matches!(s, "screen" | "connector" | "meeting" | "user")
}

/// Whitelist per spec §1. Invalid / missing redaction is stored as NULL,
/// which downstream readers interpret as "none" (the current default).
fn is_valid_redaction(s: &str) -> bool {
    matches!(s, "none" | "summary_only" | "redacted")
}

fn item_kinds_from_json(kinds_json: &str) -> Vec<String> {
    kinds_json_to_value(kinds_json)
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn matches_kinds_filter(kinds_json: &str, want: &[String]) -> bool {
    if want.is_empty() {
        return true;
    }
    let have = item_kinds_from_json(kinds_json);
    want.iter().any(|w| have.iter().any(|h| h == w))
}

/// Public wrapper for post-graph kinds filtering (timeline / memory.search).
pub fn item_matches_kinds_filter(kinds_json: &str, want: &[String]) -> bool {
    matches_kinds_filter(kinds_json, want)
}

/// Batch-load `kinds_json` for timeline / graph post-filters.
pub fn kinds_json_for_ids(
    conn: &Connection,
    ids: &[String],
) -> Result<std::collections::HashMap<String, String>, String> {
    use std::collections::HashMap;
    let mut out = HashMap::new();
    for id in ids {
        let kj: String = conn
            .query_row(
                "SELECT kinds_json FROM mem_items WHERE id = ?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "[]".to_string());
        out.insert(id.clone(), kj);
    }
    Ok(out)
}

/// Build FTS5 `MATCH` query: token AND token, with minimal escaping.
fn fts_match_query(user: &str) -> Option<String> {
    let tokens: Vec<String> = user
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .filter_map(|t| {
            let cleaned: String = t
                .chars()
                .filter(|c| !matches!(c, '*' | '^' | '"' | ':' | '(' | ')' | '{' | '}' | '[' | ']'))
                .collect();
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        })
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(
        tokens
            .into_iter()
            .map(|t| format!("\"{}\"", t.replace('\"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

/// ASCII STX used to wrap each matched span in FTS highlight output so the
/// frontend can split and render `<mark>` tags safely (no HTML injection).
/// Production code uses this to detect whether a column actually carried a
/// match (see `attach_fts_highlights`); the SQL binds the sentinel via
/// `char(2)`.
pub(crate) const HL_START: &str = "\u{0002}";
/// ASCII ETX terminator, paired with `HL_START`. Only the test helpers
/// synthesize marked strings; production code looks for the start sentinel
/// alone, and the SQL emits both via `char(2)` / `char(3)`.
#[cfg(test)]
pub(crate) const HL_END: &str = "\u{0003}";

fn search_fts(
    conn: &Connection,
    fts_q: &str,
    kinds_want: &[String],
    limit: usize,
) -> Result<(Vec<Value>, usize), String> {
    let cap = (limit.saturating_mul(12)).max(limit).min(400);
    let mut stmt = conn
        .prepare(
            r#"
      SELECT m.id, m.title, m.snippet, m.source, m.kinds_json, m.created_at,
             m.provenance, m.entity_id, m.confidence, m.redaction,
             m.sync_status, m.sync_excluded_reason,
             m.cloud_index_id, m.encrypted_at,
             highlight(fts, 0, char(2), char(3)) AS title_hl,
             snippet(fts, 1, char(2), char(3), '…', 32) AS snippet_hl
      FROM mem_items_fts AS fts
      JOIN mem_items AS m ON m.rowid = fts.rowid
      WHERE fts MATCH ?1
      ORDER BY bm25(fts)
      LIMIT ?2
    "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![fts_q, cap as i64], |r| {
            let title_hl: Option<String> = r.get(14).ok();
            let snippet_hl: Option<String> = r.get(15).ok();
            let mut item = row_to_item(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10).ok(),
                r.get(11).ok(),
                r.get(12).ok(),
                r.get(13).ok(),
            );
            attach_fts_highlights(&mut item, title_hl, snippet_hl);
            Ok(item)
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    let mut total = 0usize;
    for row in rows {
        let item = row.map_err(|e| e.to_string())?;
        let kj = item
            .get("kinds")
            .and_then(|k| serde_json::to_string(k).ok())
            .unwrap_or_else(|| "[]".to_string());
        if matches_kinds_filter(&kj, kinds_want) {
            total += 1;
            if out.len() < limit {
                out.push(item);
            }
        }
    }
    Ok((out, total))
}

fn search_fallback_like(
    conn: &Connection,
    query_lc: &str,
    kinds_want: &[String],
    limit: usize,
) -> Result<(Vec<Value>, usize), String> {
    let mut stmt = conn
    .prepare(
      "SELECT id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction, sync_status, sync_excluded_reason, cloud_index_id, encrypted_at FROM mem_items ORDER BY created_at DESC",
    )
    .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(row_to_item(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10).ok(),
                r.get(11).ok(),
                r.get(12).ok(),
                r.get(13).ok(),
            ))
        })
        .map_err(|e| e.to_string())?;

    let tokens: Vec<&str> = query_lc
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .collect();
    let mut matched = Vec::new();
    let mut total = 0usize;
    for row in rows {
        let item = row.map_err(|e| e.to_string())?;
        let title = item
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();
        let snippet = item
            .get("snippet")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();
        let source = item
            .get("source")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();
        let hay = format!("{} {} {}", title, snippet, source);
        let ok = if tokens.is_empty() {
            hay.contains(query_lc)
        } else {
            tokens.iter().all(|t| hay.contains(t))
        };
        if !ok {
            continue;
        }
        let kj = item
            .get("kinds")
            .and_then(|k| serde_json::to_string(k).ok())
            .unwrap_or_else(|| "[]".to_string());
        if !matches_kinds_filter(&kj, kinds_want) {
            continue;
        }
        total += 1;
        if matched.len() < limit {
            matched.push(item);
        }
    }
    Ok((matched, total))
}

fn search_recent(
    conn: &Connection,
    kinds_want: &[String],
    limit: usize,
) -> Result<(Vec<Value>, usize), String> {
    let mut stmt = conn
    .prepare(
      "SELECT id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction, sync_status, sync_excluded_reason, cloud_index_id, encrypted_at FROM mem_items ORDER BY created_at DESC",
    )
    .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(row_to_item(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10).ok(),
                r.get(11).ok(),
                r.get(12).ok(),
                r.get(13).ok(),
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    let mut total = 0usize;
    for row in rows {
        let item = row.map_err(|e| e.to_string())?;
        let kj = item
            .get("kinds")
            .and_then(|k| serde_json::to_string(k).ok())
            .unwrap_or_else(|| "[]".to_string());
        if matches_kinds_filter(&kj, kinds_want) {
            total += 1;
            if out.len() < limit {
                out.push(item);
            }
        }
    }
    Ok((out, total))
}

/// Append a memory item. Payload: `{ title, snippet?, kinds?, source?, provenance?, entity_id?, confidence?, redaction? }` (WRITE).
pub fn ingest(payload: &Value) -> Result<Value, String> {
    let conn = open_conn()?;
    let title = payload
        .get("title")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "title is required".to_string())?;
    let snippet = payload
        .get("snippet")
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let source = payload
        .get("source")
        .and_then(|t| t.as_str())
        .unwrap_or("capture");
    let kinds = payload
        .get("kinds")
        .cloned()
        .unwrap_or_else(|| json!(["screen"]));
    let kinds_json = serde_json::to_string(&kinds).map_err(|e| e.to_string())?;

    let provenance = payload
        .get("provenance")
        .and_then(|v| v.as_str())
        .filter(|s| is_valid_provenance(s))
        .map(String::from)
        .unwrap_or_else(|| derive_provenance(source).to_string());
    let entity_id: Option<String> = payload
        .get("entity_id")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let confidence: Option<f64> = payload
        .get("confidence")
        .and_then(|v| v.as_f64())
        .filter(|c| c.is_finite())
        .map(|c| c.clamp(0.0, 1.0));
    let redaction: Option<String> = payload
        .get("redaction")
        .and_then(|v| v.as_str())
        .filter(|s| is_valid_redaction(s))
        .map(String::from);

    static INGEST_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = INGEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let id = format!("m_{}_{}", now_ms(), seq);
    let created = now_ms() as i64;

    let affected = conn
    .execute(
      "INSERT OR IGNORE INTO mem_items (id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction, sync_status) \
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
      params![
        id,
        title,
        snippet,
        source,
        kinds_json,
        created,
        provenance,
        entity_id,
        confidence,
        redaction,
        "local_only"
      ],
    )
    .map_err(|e| e.to_string())?;
    let skipped = affected == 0;

    let mut item_map = serde_json::Map::new();
    item_map.insert("id".to_string(), json!(id));
    item_map.insert("title".to_string(), json!(title));
    item_map.insert("snippet".to_string(), json!(snippet));
    item_map.insert("kinds".to_string(), kinds.clone());
    item_map.insert("source".to_string(), json!(source));
    item_map.insert("created_at".to_string(), json!(created as u64));
    item_map.insert("provenance".to_string(), json!(provenance));
    // Phase 2.0b: surface sync_status in the synchronous ingest response so
    // frontends that re-use it (without a follow-up fetch) see the field.
    // sync_excluded_reason is always None on the ingest path; omitted.
    item_map.insert("syncStatus".to_string(), json!("local_only"));
    if let Some(ref e) = entity_id {
        item_map.insert("entity_id".to_string(), json!(e));
    }
    if let Some(c) = confidence {
        item_map.insert("confidence".to_string(), json!(c));
    }
    if let Some(ref r) = redaction {
        item_map.insert("redaction".to_string(), json!(r));
    }
    let item = Value::Object(item_map);

    let out = json!({
      "item": item,
      "skipped": skipped,
      "echo": payload,
      "stub": false,
    });

    let skip_embed = source == "capture_sampler" || source == "capture_ax";
    if !skipped && !skip_embed {
        let id_spawn = id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = embed_row_by_id(&id_spawn).await {
                log::warn!("memory embed {}: {}", id_spawn, e);
            }
        });
        crate::memory_obs::emit(
            "ingest_done",
            &[
                ("source", source.to_string()),
                ("provenance", provenance.clone()),
                ("embedding_queued", (!skip_embed).to_string()),
            ],
        );
    }

    Ok(out)
}

/// Capture-specific ingest: upsert on `(source, entity_id)` so duplicate screen
/// context refreshes `created_at` instead of appending rows.
pub fn ingest_capture_upsert(payload: &Value) -> Result<Value, String> {
    let conn = open_conn()?;
    let title = payload
        .get("title")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "title is required".to_string())?;
    let snippet = payload
        .get("snippet")
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let source = payload
        .get("source")
        .and_then(|t| t.as_str())
        .unwrap_or("capture");
    let kinds = payload
        .get("kinds")
        .cloned()
        .unwrap_or_else(|| json!(["screen"]));
    let kinds_json = serde_json::to_string(&kinds).map_err(|e| e.to_string())?;
    let provenance = payload
        .get("provenance")
        .and_then(|v| v.as_str())
        .filter(|s| is_valid_provenance(s))
        .map(String::from)
        .unwrap_or_else(|| derive_provenance(source).to_string());
    let entity_id = payload
        .get("entity_id")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| "entity_id is required for capture upsert".to_string())?;
    let confidence: Option<f64> = payload
        .get("confidence")
        .and_then(|v| v.as_f64())
        .filter(|c| c.is_finite())
        .map(|c| c.clamp(0.0, 1.0));
    let redaction: Option<String> = payload
        .get("redaction")
        .and_then(|v| v.as_str())
        .filter(|s| is_valid_redaction(s))
        .map(String::from);
    let meeting_id: Option<String> = payload
        .get("meeting_id")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let meeting_offset_ms: Option<i64> = payload
        .get("meeting_offset_ms")
        .and_then(|v| v.as_u64())
        .map(|v| v as i64);

    static INGEST_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = INGEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let id = format!("m_{}_{}", now_ms(), seq);
    let created = now_ms() as i64;

    let affected = conn
    .execute(
      "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction, meeting_id, meeting_offset_ms) \
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
       ON CONFLICT(source, entity_id) DO UPDATE SET \
         created_at = excluded.created_at, \
         snippet = excluded.snippet, \
         title = excluded.title, \
         kinds_json = excluded.kinds_json, \
         meeting_id = excluded.meeting_id, \
         meeting_offset_ms = excluded.meeting_offset_ms",
      params![
        id,
        title,
        snippet,
        source,
        kinds_json,
        created,
        provenance,
        entity_id,
        confidence,
        redaction,
        meeting_id,
        meeting_offset_ms
      ],
    )
    .map_err(|e| e.to_string())?;
    let inserted = affected == 1;

    crate::memory_notify::notify_index_changed_if_capture(source);

    Ok(json!({
      "item": {
        "id": id,
        "title": title,
        "snippet": snippet,
        "source": source,
        "kinds": kinds,
        "created_at": created as u64,
        "entity_id": entity_id,
        "meeting_id": meeting_id,
        "meeting_offset_ms": meeting_offset_ms.map(|v| v as u64),
      },
      "inserted": inserted,
      "updated": !inserted,
      "stub": false,
    }))
}

/// Screen captures tagged with an active meeting session.
pub fn list_meeting_capture_rows(meeting_id: &str, limit: usize) -> Result<Vec<Value>, String> {
    let conn = open_conn()?;
    let lim = limit.clamp(1, 500) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, snippet, source, created_at, meeting_offset_ms \
       FROM mem_items \
       WHERE meeting_id = ?1 \
       ORDER BY COALESCE(meeting_offset_ms, created_at) ASC \
       LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![meeting_id, lim], |r| {
            Ok(json!({
              "id": r.get::<_, String>(0)?,
              "title": r.get::<_, String>(1)?,
              "snippet": r.get::<_, String>(2)?,
              "source": r.get::<_, String>(3)?,
              "created_at": r.get::<_, i64>(4)? as u64,
              "meeting_offset_ms": r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Delete aged capture rows (`capture_%` sources). Returns rows removed.
pub fn cleanup_capture_retention(retention_days: u64) -> Result<u64, String> {
    if retention_days == 0 {
        return Ok(0);
    }
    let conn = open_conn()?;
    let cutoff = now_ms() as i64 - (retention_days as i64) * 86_400_000;
    let n = conn
        .execute(
            "DELETE FROM mem_items WHERE source LIKE 'capture_%' AND created_at < ?1",
            params![cutoff],
        )
        .map_err(|e| e.to_string())?;
    Ok(n as u64)
}

/// Top apps from capture sources in the last 24h for the Capture UI.
pub fn stats_app_coverage(limit: usize) -> Result<Vec<(String, i64)>, String> {
    let conn = open_conn()?;
    let day_ago = now_ms() as i64 - 86_400_000;
    let cap = limit.clamp(1, 20) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT \
         CASE \
           WHEN instr(title, ' · ') > 0 THEN substr(title, instr(title, ' · ') + 3) \
           ELSE title \
         END AS app_label, \
         COUNT(*) AS c \
       FROM mem_items \
       WHERE source LIKE 'capture_%' AND created_at >= ?1 \
       GROUP BY app_label \
       ORDER BY c DESC \
       LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![day_ago, cap], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|x| x.ok())
        .collect();
    Ok(rows)
}

/// Lexical / FTS search only (`query`, `kinds`, `limit`).
pub fn search(payload: &Value) -> Result<Value, String> {
    let scope = payload
        .get("scope")
        .and_then(|s| s.as_str())
        .unwrap_or("all");
    if scope.eq_ignore_ascii_case("meetings_only") || scope.eq_ignore_ascii_case("meetingsonly") {
        let query = payload
            .get("query")
            .and_then(|q| q.as_str())
            .unwrap_or("")
            .trim();
        let limit = payload
            .get("limit")
            .and_then(|l| l.as_u64())
            .unwrap_or(20)
            .clamp(1, 200) as usize;
        let hits = crate::meeting_store::search_meeting_memory_hits(query, limit)?;
        let total = hits.len();
        return Ok(json!({
          "hits": hits,
          "total": total,
          "echo": payload,
          "stub": false,
        }));
    }
    if scope.eq_ignore_ascii_case("timeline") {
        return search_timeline(payload);
    }

    let conn = open_conn()?;
    let query = payload
        .get("query")
        .and_then(|q| q.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let limit = payload
        .get("limit")
        .and_then(|l| l.as_u64())
        .unwrap_or(20)
        .clamp(1, 200) as usize;

    let kinds_want: Vec<String> = payload
        .get("kinds")
        .and_then(|k| k.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let (hits, total) = if query.is_empty() {
        search_recent(&conn, &kinds_want, limit)?
    } else if let Some(fts_q) = fts_match_query(&query) {
        match search_fts(&conn, &fts_q, &kinds_want, limit) {
            Ok((h, t)) if !h.is_empty() => (h, t),
            Ok((_, _)) => search_fallback_like(&conn, &query.to_lowercase(), &kinds_want, limit)?,
            Err(_) => search_fallback_like(&conn, &query.to_lowercase(), &kinds_want, limit)?,
        }
    } else {
        search_fallback_like(&conn, &query.to_lowercase(), &kinds_want, limit)?
    };

    Ok(json!({
      "hits": hits,
      "total": total,
      "echo": payload,
      "stub": false,
    }))
}

fn timeline_content_types(payload: &Value) -> Vec<String> {
    payload
        .get("content_types")
        .or_else(|| payload.get("contentTypes"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_ascii_lowercase()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn timeline_wants(content_types: &[String], slug: &str) -> bool {
    content_types.is_empty() || content_types.iter().any(|t| t == slug)
}

fn apply_time_window(hits: Vec<Value>, start_ms: Option<u64>, end_ms: Option<u64>) -> Vec<Value> {
    if start_ms.is_none() && end_ms.is_none() {
        return hits;
    }
    hits.into_iter()
        .filter(|hit| {
            let ts = hit.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
            if let Some(s) = start_ms {
                if ts < s {
                    return false;
                }
            }
            if let Some(e) = end_ms {
                if ts > e {
                    return false;
                }
            }
            true
        })
        .collect()
}

fn tag_timeline_hit(mut hit: Value, content_type: &str) -> Value {
    if let Some(map) = hit.as_object_mut() {
        map.insert("content_type".to_string(), json!(content_type));
    }
    hit
}

/// Merge pre-built memory timeline hits with meeting rows and finalize ordering.
pub fn merge_timeline_from_memory_hits(
    payload: &Value,
    memory_hits: Vec<Value>,
    read_path: Option<&str>,
) -> Result<Value, String> {
    let query = payload
        .get("query")
        .and_then(|q| q.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let limit = payload
        .get("limit")
        .and_then(|l| l.as_u64())
        .unwrap_or(20)
        .clamp(1, 200) as usize;
    let start_ms = payload.get("start_ms").and_then(|v| v.as_u64());
    let end_ms = payload.get("end_ms").and_then(|v| v.as_u64());
    let content_types = timeline_content_types(payload);
    let wide = (limit.saturating_mul(4)).min(200);

    let mut merged = memory_hits;

    if timeline_wants(&content_types, "meeting") {
        let meeting_hits =
            crate::meeting_store::search_timeline_hits(&query, wide, start_ms, end_ms)?;
        merged.extend(meeting_hits);
    }

    merged = apply_time_window(merged, start_ms, end_ms);
    merged.sort_by(|a, b| {
        let ta = a.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    let total = merged.len();
    merged.truncate(limit);

    let mut out = json!({
      "hits": merged,
      "total": total,
      "scope": "timeline",
      "echo": payload,
      "stub": false,
    });
    if let Some(rp) = read_path {
        if let Some(obj) = out.as_object_mut() {
            obj.insert("read_path".to_string(), json!(rp));
        }
    }
    Ok(out)
}

/// Unified timeline search across `mem_items` and meetings. Payload:
/// - `query` (optional)
/// - `limit` (default 20)
/// - `start_ms` / `end_ms` optional epoch-ms window
/// - `content_types`: `memory` | `meeting` (default: both)
pub fn search_timeline(payload: &Value) -> Result<Value, String> {
    let limit = payload
        .get("limit")
        .and_then(|l| l.as_u64())
        .unwrap_or(20)
        .clamp(1, 200) as usize;
    let content_types = timeline_content_types(payload);
    let wide = (limit.saturating_mul(4)).min(200);

    let mut memory_hits: Vec<Value> = Vec::new();
    if timeline_wants(&content_types, "memory") {
        let mut mem_payload = payload.clone();
        if let Some(obj) = mem_payload.as_object_mut() {
            obj.remove("scope");
            obj.insert("limit".to_string(), json!(wide));
        }
        let mem_result = search(&mem_payload)?;
        if let Some(arr) = mem_result.get("hits").and_then(|v| v.as_array()) {
            for hit in arr {
                memory_hits.push(tag_timeline_hit(hit.clone(), "memory"));
            }
        }
    }

    merge_timeline_from_memory_hits(payload, memory_hits, None)
}

/// Search with optional **semantic re-ranking** (`semantic: true`, non-empty `query`, LLM key set).
/// Fetches a wider lexical candidate set, embeds the query once, re-orders by cosine similarity
/// (items without `embedding` sort last).
pub async fn search_with_semantics(payload: &Value) -> Result<Value, String> {
    let start = std::time::Instant::now();
    let scope = payload
        .get("scope")
        .and_then(|s| s.as_str())
        .unwrap_or("all");
    if scope.eq_ignore_ascii_case("timeline") {
        let result = search_timeline(payload)?;
        emit_search_with_semantics_done(&result, false, start.elapsed());
        return Ok(result);
    }
    let semantic = payload
        .get("semantic")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let query = payload
        .get("query")
        .and_then(|q| q.as_str())
        .unwrap_or("")
        .trim();
    if !semantic || query.is_empty() {
        let result = search(payload)?;
        emit_search_with_semantics_done(&result, false, start.elapsed());
        return Ok(result);
    }
    if secrets::get_llm_api_key()
        .ok()
        .flatten()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
    {
        let result = search(payload)?;
        emit_search_with_semantics_done(&result, false, start.elapsed());
        return Ok(result);
    }

    let limit = payload
        .get("limit")
        .and_then(|l| l.as_u64())
        .unwrap_or(20)
        .clamp(1, 200) as usize;
    let wide_limit = (limit.saturating_mul(8)).min(160).max(limit) as u64;

    let mut wide_payload = payload.clone();
    if let Some(obj) = wide_payload.as_object_mut() {
        obj.insert("limit".to_string(), json!(wide_limit));
    }

    let mut base = search(&wide_payload)?;
    let arr = base
        .get_mut("hits")
        .and_then(|h| h.as_array_mut())
        .ok_or_else(|| "hits missing".to_string())?;
    if arr.is_empty() {
        emit_search_with_semantics_done(&base, false, start.elapsed());
        return Ok(base);
    }

    let qvec = embeddings::embed_one(query).await?;
    let conn = open_conn()?;
    let mut scored: Vec<(f32, usize, Value)> = Vec::new();
    for (idx, item) in arr.iter().enumerate() {
        let id = item.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT embedding FROM mem_items WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<Vec<u8>>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        let sim = blob
            .as_deref()
            .and_then(decode_embedding_blob)
            .map(|doc| dot_product(&qvec, &doc))
            .unwrap_or(f32::NEG_INFINITY);
        scored.push((sim, idx, item.clone()));
    }
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.cmp(&b.1))
    });
    let new_hits: Vec<Value> = scored.into_iter().take(limit).map(|(_, _, v)| v).collect();
    let total = base.get("total").cloned().unwrap_or(json!(new_hits.len()));
    base["hits"] = json!(new_hits);
    base["semanticRerank"] = json!(true);
    base["total"] = total;
    emit_search_with_semantics_done(&base, true, start.elapsed());
    Ok(base)
}

fn emit_search_with_semantics_done(
    v: &Value,
    semantic_applied: bool,
    elapsed: std::time::Duration,
) {
    let returned = v
        .get("hits")
        .and_then(|h| h.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let total = v.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
    crate::memory_obs::emit(
        "search_with_semantics_done",
        &[
            ("returned", returned.to_string()),
            ("total", total.to_string()),
            ("semantic_applied", semantic_applied.to_string()),
            ("elapsed_ms", (elapsed.as_millis() as u64).to_string()),
        ],
    );
}

/// Fill **`embedding`** for rows that lack it (excludes capture sampler noise).
/// Payload: **`limit?`** (default 40, max 200), **`delayMs`** or **`delay_ms`** (0–3000, pause between rows for rate limits).
/// Response: **`embedded`**, **`failed`**, **`remaining`** (still missing after this run), **`attempted`**, optional **`firstError`**,
/// optional **`cancelled`** (user cancelled mid-run). Emits Tauri event **`memory-embed-backfill-progress`** when **`ctx.app`** is set.
pub async fn backfill_embeddings(
    payload: &Value,
    ctx: BackfillEmitContext<'_>,
) -> Result<Value, String> {
    let limit = payload
        .get("limit")
        .and_then(|x| x.as_u64())
        .unwrap_or(40)
        .clamp(1, 200) as usize;
    let delay_ms = payload
        .get("delayMs")
        .or_else(|| payload.get("delay_ms"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0)
        .clamp(0, 3000);
    let ids: Vec<String> = {
        let conn = open_conn()?;
        let mut stmt = conn
      .prepare(
        "SELECT id FROM mem_items WHERE embedding IS NULL AND source NOT IN ('capture_sampler', 'capture_ax') ORDER BY created_at DESC LIMIT ?1",
      )
      .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let collected: Vec<String> = rows.filter_map(|r| r.ok()).collect();
        collected
    };

    let attempted = ids.len() as u64;
    let mut embedded = 0u64;
    let mut failed = 0u64;
    let mut first_error: Option<String> = None;
    let mut cancelled = false;
    for (i, id) in ids.iter().enumerate() {
        if ctx
            .cancel
            .map(|c| c.load(Ordering::SeqCst))
            .unwrap_or(false)
        {
            cancelled = true;
            break;
        }
        if i > 0 && delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
        if ctx
            .cancel
            .map(|c| c.load(Ordering::SeqCst))
            .unwrap_or(false)
        {
            cancelled = true;
            break;
        }
        match embed_row_by_id_with_retries(id).await {
            Ok(()) => embedded += 1,
            Err(e) => {
                failed += 1;
                if first_error.is_none() {
                    first_error = Some(truncate_api_error(e));
                }
            }
        }
        if let Some(app) = ctx.app.as_ref() {
            emit_backfill_progress(app, (i as u64) + 1, attempted, embedded, failed);
        }
    }

    let remaining = count_missing_embeddings()?;

    let mut out = json!({
      "embedded": embedded,
      "failed": failed,
      "remaining": remaining,
      "attempted": attempted,
      "echo": payload,
      "stub": false,
      "cancelled": cancelled,
    });
    if let Some(e) = first_error {
        out["firstError"] = json!(e);
    }
    Ok(out)
}

/// Fetch by `id` or `ids`. Payload: `{ id?: string, ids?: string[] }`.
pub fn fetch(payload: &Value) -> Result<Value, String> {
    let conn = open_conn()?;
    let mut id_list: Vec<String> = Vec::new();
    if let Some(arr) = payload.get("ids").and_then(|x| x.as_array()) {
        id_list.extend(arr.iter().filter_map(|v| v.as_str().map(String::from)));
    }
    if let Some(s) = payload.get("id").and_then(|x| x.as_str()) {
        id_list.push(s.to_string());
    }

    if id_list.is_empty() {
        return Ok(json!({
          "items": [],
          "echo": payload,
          "stub": false,
        }));
    }

    let mut out = Vec::new();
    for want in &id_list {
        let found = conn
      .query_row(
        "SELECT id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction, sync_status, sync_excluded_reason, cloud_index_id, encrypted_at FROM mem_items WHERE id = ?1",
        params![want],
        |r| {
          Ok(row_to_item(
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
            r.get(8)?,
            r.get(9)?,
            r.get(10).ok(),
            r.get(11).ok(),
            r.get(12).ok(),
            r.get(13).ok(),
          ))
        },
      )
      .optional()
      .map_err(|e| e.to_string())?;
        if let Some(item) = found {
            out.push(item);
        }
    }

    Ok(json!({
      "items": out,
      "echo": payload,
      "stub": false,
    }))
}

/// Remove items by `id` or `ids` from the local index (WRITE).
pub fn delete_items(payload: &Value) -> Result<Value, String> {
    let conn = open_conn()?;
    let mut id_list: Vec<String> = Vec::new();
    if let Some(arr) = payload.get("ids").and_then(|x| x.as_array()) {
        id_list.extend(arr.iter().filter_map(|v| v.as_str().map(String::from)));
    }
    if let Some(s) = payload.get("id").and_then(|x| x.as_str()) {
        id_list.push(s.to_string());
    }
    id_list.sort();
    id_list.dedup();

    if id_list.is_empty() {
        return Err("id or ids is required".to_string());
    }

    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    for id in &id_list {
        conn.execute("DELETE FROM mem_items WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let removed = (before - after).max(0) as usize;

    Ok(json!({
      "removed": removed,
      "requested": id_list,
      "echo": payload,
      "stub": false,
    }))
}

/// Remove items created on or after `cutoff_ms` (e.g. "last hour" purge).
pub fn delete_items_created_since(cutoff_ms: u64) -> Result<Value, String> {
    let conn = open_conn()?;
    let cutoff = cutoff_ms as i64;
    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM mem_items WHERE created_at >= ?1",
        params![cutoff],
    )
    .map_err(|e| e.to_string())?;
    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let removed = (before - after).max(0) as usize;

    Ok(json!({
      "removed": removed,
      "cutoff_ms": cutoff_ms,
      "stub": false,
    }))
}

/// Count mem_items whose `created_at` falls in `[start_ms, end_ms)`.
pub fn count_items_in_window(start_ms: i64, end_ms: i64) -> Result<i64, String> {
    let conn = open_conn()?;
    conn.query_row(
        "SELECT COUNT(*) FROM mem_items WHERE created_at >= ?1 AND created_at < ?2",
        rusqlite::params![start_ms, end_ms],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Total items and count created in the last 24h (rolling window).
pub fn stats() -> Result<Value, String> {
    let conn = open_conn()?;
    let now = now_ms() as i64;
    let day_ago = now.saturating_sub(86_400_000);
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let last24: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mem_items WHERE created_at >= ?1",
            params![day_ago],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let oldest: Option<i64> = conn
        .query_row(
            "SELECT MIN(created_at) FROM mem_items WHERE created_at > 0",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let history_days = oldest
        .map(|o| ((now - o).max(0) / 86_400_000) as u64)
        .unwrap_or(0);

    Ok(json!({
      "memoryTotal": total,
      "memoriesLast24h": last24,
      "historyDays": history_days,
      "stub": false,
    }))
}

/// Extended stats for the Memory Debugger (B-2). Returns breakdown by source
/// and provenance, FTS integrity (base vs fts row count), and embedding
/// coverage by source. Read-only.
pub fn stats_extended() -> Result<Value, String> {
    let conn = open_conn()?;

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let fts_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM mem_items_fts", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut by_source = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT source, COUNT(*), SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END)
         FROM mem_items GROUP BY source ORDER BY 2 DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2).unwrap_or(0),
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (source, rows_n, with_embed) = row.map_err(|e| e.to_string())?;
            by_source.push(json!({
              "source": source,
              "rows": rows_n,
              "with_embed": with_embed,
            }));
        }
    }

    let mut by_provenance = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT COALESCE(provenance,''), COUNT(*) FROM mem_items GROUP BY provenance")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (prov, rows_n) = row.map_err(|e| e.to_string())?;
            by_provenance.push(json!({
              "provenance": if prov.is_empty() { "(null)".to_string() } else { prov },
              "rows": rows_n,
            }));
        }
    }

    let (earliest, latest): (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT MIN(created_at), MAX(created_at) FROM mem_items",
            [],
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)),
        )
        .map_err(|e| e.to_string())?;

    let db_bytes = db_path()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(json!({
      "total": total,
      "fts_total": fts_total,
      "fts_integrity": total == fts_total,
      "by_source": by_source,
      "by_provenance": by_provenance,
      "earliest_ms": earliest,
      "latest_ms": latest,
      "db_bytes": db_bytes,
    }))
}

/// Roll-up "entities" from indexed memories: one row per distinct `source`.
pub fn entities_from_catalog(payload: &Value) -> Result<Value, String> {
    use std::collections::HashMap;

    let conn = open_conn()?;
    let q = payload
        .get("query")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    // Output is a GROUP BY rollup of (source, count), not individual mem_items
    // rows — sync_status would be ambiguous, so we deliberately omit it. See
    // spec 2026-05-04-sync-status-column-design.md § 3.
    let mut stmt = conn
        .prepare("SELECT source, COUNT(*) FROM mem_items GROUP BY source")
        .map_err(|e| e.to_string())?;
    let grouped = stmt
        .query_map([], |r| {
            let label: String = r.get(0)?;
            let count: i64 = r.get(1)?;
            Ok((label, count as u64))
        })
        .map_err(|e| e.to_string())?;

    let mut counts: HashMap<String, u64> = HashMap::new();
    for row in grouped {
        let (label, count) = row.map_err(|e| e.to_string())?;
        counts.insert(label, count);
    }

    let mut rows: Vec<Value> = counts
        .into_iter()
        .map(|(label, count)| {
            json!({
              "id": format!("source:{}", label),
              "label": label,
              "kind": "source",
              "mentions": count,
            })
        })
        .collect();

    if !q.is_empty() {
        rows.retain(|v| {
            v.get("label")
                .and_then(|x| x.as_str())
                .map(|l| l.to_lowercase().contains(&q))
                .unwrap_or(false)
        });
    }

    rows.sort_by(|a, b| {
        let ca = a.get("mentions").and_then(|x| x.as_u64()).unwrap_or(0);
        let cb = b.get("mentions").and_then(|x| x.as_u64()).unwrap_or(0);
        cb.cmp(&ca)
    });

    Ok(json!({
      "entities": rows,
      "echo": payload,
      "stub": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_time_window, attach_fts_highlights, decode_embedding_blob, derive_provenance,
        encode_embedding_blob, health_check_conn, interpret_quick_check, is_transient_embed_error,
        is_valid_provenance, is_valid_redaction, row_to_item, timeline_wants, truncate_api_error,
        HL_END, HL_START,
    };
    use serde_json::json;

    #[test]
    fn init_schema_succeeds_on_fresh_db_without_entity_id_column() {
        // Regression: init_schema used to issue
        //   DELETE FROM mem_items WHERE entity_id IS NOT NULL ...
        //   CREATE UNIQUE INDEX ... ON mem_items(source, entity_id) ...
        // before `ensure_context_layer_columns` had added the `entity_id`
        // column. Real users were unaffected only because their DBs had been
        // seeded by older code that included the column inline; a fresh
        // install (or any first-run dev / E2E DB) crashed with
        // `no such column: entity_id`. This test exercises the boundary
        // condition by calling `init_schema` against an empty in-memory DB
        // and asserting it returns Ok.
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        super::init_schema(&conn).expect("init_schema must succeed on a fresh DB");
    }

    #[test]
    fn derive_provenance_covers_spec_table() {
        assert_eq!(derive_provenance("capture_sampler"), "screen");
        assert_eq!(derive_provenance("capture_ax"), "screen");
        assert_eq!(derive_provenance("google_calendar"), "connector");
        assert_eq!(derive_provenance("gmail"), "connector");
        assert_eq!(derive_provenance("meeting"), "meeting");
        assert_eq!(derive_provenance("meetings_granola"), "meeting");
        assert_eq!(derive_provenance("meeting_zoom"), "meeting");
        assert_eq!(derive_provenance("home_attachment"), "user");
        assert_eq!(derive_provenance("capture"), "user");
        assert_eq!(derive_provenance("focus_session"), "user");
        assert_eq!(derive_provenance(""), "user");
        assert_eq!(derive_provenance("unknown_source"), "user");
    }

    #[test]
    fn embedding_blob_roundtrip() {
        let v = vec![1.0f32, 0.0, -1.0, std::f32::consts::FRAC_1_SQRT_2];
        let b = encode_embedding_blob(&v);
        let d = decode_embedding_blob(&b).expect("decode");
        assert_eq!(d.len(), v.len());
        for (a, e) in d.iter().zip(v.iter()) {
            assert!((a - e).abs() < 1e-6);
        }
    }

    #[test]
    fn decode_rejects_bad_length() {
        assert!(decode_embedding_blob(&[0u8, 1, 2]).is_none());
    }

    #[test]
    fn truncate_api_error_caps_length() {
        let long = "x".repeat(300);
        let t = truncate_api_error(long);
        assert!(t.chars().count() <= 221);
        assert!(t.ends_with('…'));
        assert_eq!(truncate_api_error("short".to_string()), "short");
    }

    #[test]
    fn transient_error_heuristic() {
        assert!(is_transient_embed_error(
            "Embeddings API error 429: slow down"
        ));
        assert!(is_transient_embed_error(
            "Embeddings network error: timed out"
        ));
        assert!(!is_transient_embed_error(
            "LLM API key is not set. Open Settings and save your key."
        ));
        assert!(!is_transient_embed_error("empty text for embedding"));
    }

    #[test]
    fn is_valid_provenance_whitelist() {
        for v in ["screen", "connector", "meeting", "user"] {
            assert!(is_valid_provenance(v));
        }
        for v in ["", "Screen", "webhook", "cloud", " user "] {
            assert!(!is_valid_provenance(v));
        }
    }

    #[test]
    fn is_valid_redaction_whitelist() {
        for v in ["none", "summary_only", "redacted"] {
            assert!(is_valid_redaction(v));
        }
        for v in ["", "NONE", "partial", "redact"] {
            assert!(!is_valid_redaction(v));
        }
    }

    fn mark(s: &str) -> String {
        format!("{HL_START}{s}{HL_END}")
    }

    #[test]
    fn attach_fts_highlights_adds_title_and_snippet_when_marked() {
        let mut item = json!({ "id": "m_1", "title": "Deploy window", "snippet": "Prod cut" });
        let title_hl = format!("{} window", mark("Deploy"));
        let snippet_hl = format!("…{} cut at 19:00", mark("Prod"));
        attach_fts_highlights(&mut item, Some(title_hl.clone()), Some(snippet_hl.clone()));
        assert_eq!(item["title_highlight"], json!(title_hl));
        assert_eq!(item["snippet_highlight"], json!(snippet_hl));
        // Raw values untouched so context_assembly still sees the clean text.
        assert_eq!(item["title"], json!("Deploy window"));
        assert_eq!(item["snippet"], json!("Prod cut"));
    }

    #[test]
    fn attach_fts_highlights_skips_columns_without_matches() {
        // FTS returns the raw column text when a column has no matches; without
        // the sentinel the frontend has nothing to highlight, so we drop it.
        let mut item = json!({ "id": "m_1", "title": "Plain", "snippet": "Plain" });
        attach_fts_highlights(&mut item, Some("Plain".into()), Some("Plain".into()));
        assert!(item.get("title_highlight").is_none());
        assert!(item.get("snippet_highlight").is_none());
    }

    #[test]
    fn attach_fts_highlights_handles_partial_matches() {
        let mut item = json!({ "id": "m_1" });
        // Match only in the snippet column.
        attach_fts_highlights(&mut item, Some("No match".into()), Some(mark("hit")));
        assert!(item.get("title_highlight").is_none());
        assert_eq!(item["snippet_highlight"], json!(mark("hit")));
    }

    #[test]
    fn attach_fts_highlights_tolerates_none_inputs() {
        let mut item = json!({ "id": "m_1" });
        attach_fts_highlights(&mut item, None, None);
        assert!(item.get("title_highlight").is_none());
        assert!(item.get("snippet_highlight").is_none());
    }

    #[test]
    fn attach_fts_highlights_no_op_when_item_is_not_object() {
        let mut item = json!("not an object");
        attach_fts_highlights(&mut item, Some(mark("x")), None);
        assert_eq!(item, json!("not an object"));
    }

    #[test]
    fn row_to_item_emits_persisted_provenance_when_present() {
        let v = row_to_item(
            "m_1".into(),
            "T".into(),
            "S".into(),
            "capture_sampler".into(),
            "[]".into(),
            10,
            Some("user".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        // Persisted `user` overrides the would-be-derived `screen`.
        assert_eq!(v.get("provenance").and_then(|x| x.as_str()), Some("user"));
    }

    #[test]
    fn row_to_item_falls_back_to_derivation_when_column_null() {
        let v = row_to_item(
            "m_2".into(),
            "T".into(),
            "S".into(),
            "google_calendar".into(),
            "[]".into(),
            10,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(
            v.get("provenance").and_then(|x| x.as_str()),
            Some("connector"),
        );
    }

    #[test]
    fn row_to_item_falls_back_when_stored_provenance_is_empty_string() {
        let v = row_to_item(
            "m_3".into(),
            "T".into(),
            "S".into(),
            "capture_ax".into(),
            "[]".into(),
            10,
            Some(String::new()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(v.get("provenance").and_then(|x| x.as_str()), Some("screen"));
    }

    #[test]
    fn row_to_item_includes_optional_fields_only_when_present() {
        let full = row_to_item(
            "m_4".into(),
            "T".into(),
            "S".into(),
            "gmail".into(),
            "[]".into(),
            10,
            Some("connector".into()),
            Some("eid-1".into()),
            Some(0.83),
            Some("summary_only".into()),
            None,
            None,
            None,
            None,
        );
        assert_eq!(
            full.get("entity_id").and_then(|x| x.as_str()),
            Some("eid-1")
        );
        assert_eq!(full.get("confidence").and_then(|x| x.as_f64()), Some(0.83));
        assert_eq!(
            full.get("redaction").and_then(|x| x.as_str()),
            Some("summary_only"),
        );

        let sparse = row_to_item(
            "m_5".into(),
            "T".into(),
            "S".into(),
            "gmail".into(),
            "[]".into(),
            10,
            Some("connector".into()),
            Some(String::new()),
            None,
            Some(String::new()),
            None,
            None,
            None,
            None,
        );
        assert!(sparse.get("entity_id").is_none());
        assert!(sparse.get("confidence").is_none());
        assert!(sparse.get("redaction").is_none());
    }

    #[test]
    fn row_to_item_drops_non_finite_confidence() {
        let v = row_to_item(
            "m_6".into(),
            "T".into(),
            "S".into(),
            "user".into(),
            "[]".into(),
            0,
            Some("user".into()),
            None,
            Some(f64::NAN),
            None,
            None,
            None,
            None,
            None,
        );
        assert!(v.get("confidence").is_none());
    }

    #[test]
    fn row_to_item_clamps_negative_created_at_to_zero() {
        let v = row_to_item(
            "m_7".into(),
            "T".into(),
            "S".into(),
            "user".into(),
            "[]".into(),
            -5,
            Some("user".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(v.get("created_at").and_then(|x| x.as_u64()), Some(0));
    }

    #[test]
    fn row_to_item_preserves_kinds_as_array() {
        let v = row_to_item(
            "m_8".into(),
            "T".into(),
            "S".into(),
            "user".into(),
            "[\"note\",\"screen\"]".into(),
            0,
            Some("user".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(v.get("kinds"), Some(&json!(["note", "screen"])));
    }

    #[test]
    fn interpret_quick_check_ok_and_corrupt() {
        assert!(interpret_quick_check("ok").is_ok());
        assert!(interpret_quick_check(" ok ").is_ok());
        assert!(interpret_quick_check("*** in database main ***\nrow 5 missing").is_err());
    }

    #[test]
    fn health_check_passes_on_a_fresh_db() {
        // Audit F-14: a well-formed DB reports healthy.
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);")
            .expect("seed");
        assert!(health_check_conn(&conn).is_ok());
    }

    #[test]
    fn init_schema_creates_mem_summaries_table() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory");
        // Mirror the same CREATE TABLE statement from init_schema.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS mem_summaries (
        target_kind    TEXT    NOT NULL,
        target_id      TEXT    NOT NULL,
        title          TEXT    NOT NULL,
        key_points     TEXT    NOT NULL,
        source_type    TEXT    NOT NULL,
        priority       TEXT    NOT NULL,
        reason         TEXT,
        model          TEXT    NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        generated_at   INTEGER NOT NULL,
        raw_json       TEXT    NOT NULL,
        PRIMARY KEY (target_kind, target_id)
      );",
        )
        .expect("create mem_summaries");

        // Verify we can insert a row.
        conn.execute(
      "INSERT INTO mem_summaries
         (target_kind, target_id, title, key_points, source_type, priority, reason, model, generated_at, raw_json)
       VALUES
         ('item', 'm_1', 'T', '[\"k\"]', 'mail', 'medium', 'r', 'heuristic', 1, '{}')",
      [],
    ).expect("insert row");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM mem_summaries", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
    }

    // ── Phase 2.0b: sync_status / sync_excluded_reason tests ──────────────────

    /// Helper: create a fresh in-memory connection with mem_items table (new schema).
    fn make_mem_items_fresh() -> rusqlite::Connection {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS mem_items (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        snippet TEXT NOT NULL,
        source TEXT NOT NULL,
        kinds_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'local_only',
        sync_excluded_reason TEXT
      );",
        )
        .expect("create mem_items");
        conn
    }

    /// Helper: create a legacy in-memory connection (old schema, without sync columns).
    fn make_mem_items_legacy() -> rusqlite::Connection {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS mem_items (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        snippet TEXT NOT NULL,
        source TEXT NOT NULL,
        kinds_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );",
        )
        .expect("create legacy mem_items");
        conn
    }

    /// Helper: collect column names from PRAGMA table_info for mem_items.
    fn pragma_column_names(conn: &rusqlite::Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("PRAGMA table_info(mem_items)")
            .expect("prepare pragma");
        stmt.query_map([], |r| r.get::<_, String>(1))
            .expect("query")
            .filter_map(|r| r.ok())
            .collect()
    }

    /// Helper: collect (name, notnull, dflt_value) from PRAGMA table_info for a column.
    fn pragma_column_info(
        conn: &rusqlite::Connection,
        col: &str,
    ) -> Option<(String, i64, Option<String>)> {
        let mut stmt = conn
            .prepare("PRAGMA table_info(mem_items)")
            .expect("prepare pragma");
        let rows: Vec<_> = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .expect("query")
            .filter_map(|r| r.ok())
            .collect();
        rows.into_iter().find(|(name, _, _)| name == col)
    }

    /// RAII guard that points `db_path()` at a fresh temp file for the lifetime
    /// of the test, then removes the file and clears the override on drop. Lets
    /// tests exercise the public `ingest()` / `fetch()` paths without polluting
    /// the user's real app-data directory. Pattern mirrors `kioku_backup`'s
    /// `tmp_path` helper so we don't pull in a new dependency.
    ///
    /// Used to pre-seed the schema with the phase-1 column set as a workaround
    /// for an `init_schema` ordering bug that referenced `entity_id` before
    /// `ensure_context_layer_columns` had added it. That bug is fixed in main
    /// (commit `a5b1fe5`, PR #37): the dedupe DELETE + UNIQUE INDEX moved into
    /// `ensure_context_layer_columns` itself, so a fresh DB now goes through
    /// the canonical migration sequence cleanly. The guard is now just file
    /// naming + cleanup + the test-path override.
    struct TempDbGuard {
        path: std::path::PathBuf,
    }
    impl TempDbGuard {
        fn new(name: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static UNIQ: AtomicU64 = AtomicU64::new(0);
            let n = UNIQ.fetch_add(1, Ordering::Relaxed);
            let mut p = std::env::temp_dir();
            p.push(format!(
                "shogun-mem-test-{}-{}-{}-memory.db",
                std::process::id(),
                n,
                name
            ));
            // Best-effort cleanup of any leftover from a prior crashed test run.
            let _ = std::fs::remove_file(&p);
            let _ = std::fs::remove_file(format!("{}-wal", p.display()));
            let _ = std::fs::remove_file(format!("{}-shm", p.display()));

            super::set_test_db_path(p.clone());
            TempDbGuard { path: p }
        }
    }
    impl Drop for TempDbGuard {
        fn drop(&mut self) {
            super::clear_test_db_path();
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
            let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
        }
    }

    /// T1: Fresh DB has both sync columns with correct constraints.
    #[test]
    fn t1_fresh_db_has_sync_status_columns() {
        let conn = make_mem_items_fresh();
        // Run the migration helper (idempotent on a fresh schema).
        super::migrate_sync_status_columns(&conn).expect("migrate should succeed on fresh db");

        let names = pragma_column_names(&conn);
        assert!(
            names.contains(&"sync_status".to_string()),
            "sync_status missing"
        );
        assert!(
            names.contains(&"sync_excluded_reason".to_string()),
            "sync_excluded_reason missing"
        );

        // sync_status: NOT NULL (notnull=1), default 'local_only'
        let (_, notnull, dflt) =
            pragma_column_info(&conn, "sync_status").expect("sync_status column info");
        assert_eq!(notnull, 1, "sync_status should be NOT NULL");
        assert!(
            dflt.as_deref() == Some("'local_only'"),
            "expected default 'local_only', got {:?}",
            dflt
        );

        // sync_excluded_reason: nullable (notnull=0)
        let (_, notnull_reason, _) = pragma_column_info(&conn, "sync_excluded_reason")
            .expect("sync_excluded_reason column info");
        assert_eq!(notnull_reason, 0, "sync_excluded_reason should be nullable");
    }

    /// T2: Legacy DB (old schema) gets both columns via migration; existing rows survive.
    #[test]
    fn t2_legacy_db_migration_adds_columns_and_preserves_rows() {
        let conn = make_mem_items_legacy();

        // Insert 5 legacy rows without sync columns (per spec § 6 T2).
        for i in 1..=5i64 {
            conn.execute(
                "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at)
         VALUES (?1, ?2, '', 'capture', '[]', ?3)",
                rusqlite::params![format!("m_{}", i), format!("Title {}", i), i],
            )
            .expect("insert legacy row");
        }

        // Run migration.
        super::migrate_sync_status_columns(&conn).expect("migration should succeed");

        // Both columns must now exist.
        let names = pragma_column_names(&conn);
        assert!(
            names.contains(&"sync_status".to_string()),
            "sync_status missing after migration"
        );
        assert!(
            names.contains(&"sync_excluded_reason".to_string()),
            "sync_excluded_reason missing after migration"
        );

        // All 5 rows must survive.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 5, "row count should be 5 after migration");

        // All pre-existing rows must have sync_status='local_only', sync_excluded_reason IS NULL.
        let mismatch: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mem_items WHERE sync_status != 'local_only'",
                [],
                |r| r.get(0),
            )
            .expect("check sync_status");
        assert_eq!(mismatch, 0, "all rows should have sync_status='local_only'");

        let with_reason: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mem_items WHERE sync_excluded_reason IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .expect("check sync_excluded_reason");
        assert_eq!(
            with_reason, 0,
            "no rows should have sync_excluded_reason set"
        );
    }

    /// T3: Idempotent re-run — calling migrate_sync_status_columns twice does not error.
    #[test]
    fn t3_migration_is_idempotent() {
        let conn = make_mem_items_legacy();

        // First migration.
        super::migrate_sync_status_columns(&conn).expect("first migration");

        // Insert a row after first migration.
        conn.execute(
      "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at, sync_status)
       VALUES ('m_check', 'T', '', 'capture', '[]', 1, 'local_only')",
      [],
    ).expect("insert after first migration");

        // Second migration (must be a no-op).
        super::migrate_sync_status_columns(&conn).expect("second migration should be idempotent");

        // Column count should be stable.
        let names = pragma_column_names(&conn);
        assert_eq!(
            names.iter().filter(|n| *n == "sync_status").count(),
            1,
            "sync_status should appear exactly once"
        );
        assert_eq!(
            names
                .iter()
                .filter(|n| *n == "sync_excluded_reason")
                .count(),
            1,
            "sync_excluded_reason should appear exactly once"
        );

        // Data unchanged.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
        let status: String = conn
            .query_row(
                "SELECT sync_status FROM mem_items WHERE id = 'm_check'",
                [],
                |r| r.get(0),
            )
            .expect("read status");
        assert_eq!(status, "local_only");
    }

    /// T4: public `ingest()` writes `sync_status='local_only'` to the DB row.
    /// Uses a tempdir-backed DB so the public path runs end-to-end. Source is
    /// `capture_sampler` to skip the embedding spawn (which would need a runtime).
    #[test]
    fn t4_ingest_writes_sync_status_default() {
        let _guard = TempDbGuard::new("t4");

        let payload = json!({
          "title": "T4 Title",
          "snippet": "T4 Snippet",
          "source": "capture_sampler",
          "kinds": ["screen"],
        });
        let out = super::ingest(&payload).expect("ingest");
        let id = out["item"]["id"]
            .as_str()
            .expect("ingest returned id")
            .to_string();

        // Synchronous response payload must surface syncStatus (Fix I-1) so
        // frontends that reuse it without a follow-up fetch see the field.
        assert_eq!(
            out["item"].get("syncStatus").and_then(|v| v.as_str()),
            Some("local_only"),
            "ingest response should include syncStatus='local_only'"
        );
        assert!(
            out["item"].get("syncExcludedReason").is_none(),
            "ingest response should not include syncExcludedReason on the normal path"
        );

        // Verify via raw SQL on the same DB the public ingest() wrote to.
        let conn = super::open_conn().expect("open_conn");
        let (status, reason): (String, Option<String>) = conn
            .query_row(
                "SELECT sync_status, sync_excluded_reason FROM mem_items WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("select");
        assert_eq!(status, "local_only");
        assert!(reason.is_none());
    }

    /// T5: public `ingest()` then public `fetch()` returns JSON with
    /// `syncStatus: "local_only"` and no `syncExcludedReason` key.
    #[test]
    fn t5_fetch_roundtrip_with_default_sync_status() {
        let _guard = TempDbGuard::new("t5");

        let payload = json!({
          "title": "T5 Title",
          "snippet": "T5 Snippet",
          "source": "capture_sampler",
          "kinds": ["screen"],
        });
        let out = super::ingest(&payload).expect("ingest");
        let id = out["item"]["id"]
            .as_str()
            .expect("ingest returned id")
            .to_string();

        let fetched = super::fetch(&json!({ "id": id })).expect("fetch");
        let items = fetched["items"].as_array().expect("items array");
        assert_eq!(items.len(), 1, "fetch should return exactly one item");
        let item = &items[0];

        assert_eq!(
            item.get("syncStatus").and_then(|v| v.as_str()),
            Some("local_only"),
            "syncStatus should be 'local_only'"
        );
        assert!(
            item.get("syncExcludedReason").is_none(),
            "syncExcludedReason key must be absent when reason is None"
        );
    }

    /// T6: direct INSERT of an excluded row, then public `fetch()` returns
    /// JSON with both `syncStatus` and `syncExcludedReason`. No production
    /// code writes 'excluded' yet, so we seed via raw SQL on the same DB
    /// `fetch()` will read.
    #[test]
    fn t6_fetch_roundtrip_with_excluded_sync_status() {
        let _guard = TempDbGuard::new("t6");

        // Open the test DB; this also runs init_schema + migrations.
        let conn = super::open_conn().expect("open_conn");

        // Direct INSERT simulating a future "store-but-mark-excluded" write.
        conn.execute(
            "INSERT INTO mem_items
         (id, title, snippet, source, kinds_json, created_at,
          sync_status, sync_excluded_reason)
       VALUES ('m_t6', 'Excluded Title', '', 'capture_sampler', '[]', 3000,
               'excluded', 'payment_screen')",
            [],
        )
        .expect("insert excluded row");
        drop(conn);

        let fetched = super::fetch(&json!({ "id": "m_t6" })).expect("fetch");
        let items = fetched["items"].as_array().expect("items array");
        assert_eq!(items.len(), 1, "fetch should return the excluded row");
        let item = &items[0];

        assert_eq!(
            item.get("syncStatus").and_then(|v| v.as_str()),
            Some("excluded"),
            "syncStatus should be 'excluded'"
        );
        assert_eq!(
            item.get("syncExcludedReason").and_then(|v| v.as_str()),
            Some("payment_screen"),
            "syncExcludedReason should be 'payment_screen'"
        );
    }

    // ─── Mirror column tests (Phase 2.1.2) ────────────────────────────────────

    /// TM1: Fresh DB has all mirror columns (cloud_index_id, encrypted_at,
    /// sync_attempt_count). The first two are nullable; sync_attempt_count is
    /// NOT NULL with DEFAULT 0 so the retry-and-stuck guard always has a value.
    #[test]
    fn tm1_fresh_db_has_mirror_columns() {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        super::init_schema(&conn).expect("init_schema");

        let names = pragma_column_names(&conn);
        assert!(
            names.contains(&"cloud_index_id".to_string()),
            "cloud_index_id missing"
        );
        assert!(
            names.contains(&"encrypted_at".to_string()),
            "encrypted_at missing"
        );
        assert!(
            names.contains(&"sync_attempt_count".to_string()),
            "sync_attempt_count missing"
        );

        // cloud_index_id + encrypted_at must be nullable (notnull=0).
        let (_, notnull_cid, _) =
            pragma_column_info(&conn, "cloud_index_id").expect("cloud_index_id column info");
        assert_eq!(notnull_cid, 0, "cloud_index_id should be nullable");

        let (_, notnull_ea, _) =
            pragma_column_info(&conn, "encrypted_at").expect("encrypted_at column info");
        assert_eq!(notnull_ea, 0, "encrypted_at should be nullable");

        // sync_attempt_count must be NOT NULL with default 0.
        let (_, notnull_sac, default_sac) = pragma_column_info(&conn, "sync_attempt_count")
            .expect("sync_attempt_count column info");
        assert_eq!(notnull_sac, 1, "sync_attempt_count should be NOT NULL");
        assert_eq!(
            default_sac.as_deref(),
            Some("0"),
            "sync_attempt_count default should be 0"
        );
    }

    /// TM2: Legacy DB (no mirror columns) gets both via migration; existing rows NULL.
    #[test]
    fn tm2_legacy_db_migration_adds_mirror_columns() {
        let conn = make_mem_items_legacy();

        // Insert a row before migration.
        conn.execute(
            "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at)
       VALUES ('m_legacy', 'Legacy', '', 'capture', '[]', 1)",
            [],
        )
        .expect("insert legacy row");

        // Add sync_status columns first (legacy path).
        super::migrate_sync_status_columns(&conn).expect("sync migration");

        // Now add mirror columns.
        super::migrate_mirror_columns(&conn).expect("mirror migration");

        let names = pragma_column_names(&conn);
        assert!(
            names.contains(&"cloud_index_id".to_string()),
            "cloud_index_id missing after migration"
        );
        assert!(
            names.contains(&"encrypted_at".to_string()),
            "encrypted_at missing after migration"
        );

        // Existing row must have NULLs for both new columns.
        let (cid, ea): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT cloud_index_id, encrypted_at FROM mem_items WHERE id = 'm_legacy'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("select");
        assert!(
            cid.is_none(),
            "cloud_index_id should be NULL for legacy row"
        );
        assert!(ea.is_none(), "encrypted_at should be NULL for legacy row");
    }

    /// TM3: Calling migrate_mirror_columns twice is idempotent.
    #[test]
    fn tm3_mirror_migration_is_idempotent() {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        super::init_schema(&conn).expect("init_schema");

        // Second call must succeed without error.
        super::migrate_mirror_columns(&conn).expect("second migrate_mirror_columns is idempotent");

        // Columns appear exactly once.
        let names = pragma_column_names(&conn);
        assert_eq!(
            names.iter().filter(|n| *n == "cloud_index_id").count(),
            1,
            "cloud_index_id should appear exactly once"
        );
        assert_eq!(
            names.iter().filter(|n| *n == "encrypted_at").count(),
            1,
            "encrypted_at should appear exactly once"
        );
    }

    /// TM4: fetch() round-trip surfaces cloudIndexId when populated, absent when NULL.
    #[test]
    fn tm4_fetch_roundtrip_with_cloud_index_id() {
        let _guard = TempDbGuard::new("tm4");

        let conn = super::open_conn().expect("open_conn");

        // Insert two rows: one with cloud_index_id, one without.
        conn.execute(
      "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at, cloud_index_id, encrypted_at)
       VALUES ('m_synced', 'Synced', '', 'capture_sampler', '[]', 1000, '01HV_blob_id_xxx', 1700000000000)",
      [],
    ).expect("insert synced row");
        conn.execute(
            "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at)
       VALUES ('m_local', 'Local Only', '', 'capture_sampler', '[]', 2000)",
            [],
        )
        .expect("insert local row");
        drop(conn);

        // Fetch the synced row — cloudIndexId must appear.
        let fetched = super::fetch(&json!({ "id": "m_synced" })).expect("fetch synced");
        let items = fetched["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].get("cloudIndexId").and_then(|v| v.as_str()),
            Some("01HV_blob_id_xxx"),
            "cloudIndexId should be surfaced in JSON"
        );
        assert_eq!(
            items[0].get("encryptedAt").and_then(|v| v.as_i64()),
            Some(1700000000000),
            "encryptedAt should be surfaced in JSON"
        );

        // Fetch the local-only row — cloudIndexId must be absent.
        let fetched_local = super::fetch(&json!({ "id": "m_local" })).expect("fetch local");
        let items_local = fetched_local["items"].as_array().expect("items");
        assert_eq!(items_local.len(), 1);
        assert!(
            items_local[0].get("cloudIndexId").is_none(),
            "cloudIndexId must be absent for un-synced row"
        );
        assert!(
            items_local[0].get("encryptedAt").is_none(),
            "encryptedAt must be absent for un-synced row"
        );
    }

    #[test]
    fn timeline_wants_defaults_to_all_content_types() {
        assert!(timeline_wants(&[], "memory"));
        assert!(timeline_wants(&[], "meeting"));
        assert!(timeline_wants(&["memory".into()], "memory"));
        assert!(!timeline_wants(&["memory".into()], "meeting"));
    }

    #[test]
    fn apply_time_window_filters_by_created_at() {
        let hits = vec![
            json!({ "id": "a", "created_at": 100 }),
            json!({ "id": "b", "created_at": 500 }),
            json!({ "id": "c", "created_at": 900 }),
        ];
        let out = apply_time_window(hits, Some(200), Some(800));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].get("id").and_then(|v| v.as_str()), Some("b"));
    }
}
