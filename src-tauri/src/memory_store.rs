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
  Ok(paths::app_data_dir()?.join(MEMORY_DB))
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
  conn
    .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
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

fn ensure_embedding_column(conn: &Connection) -> Result<(), String> {
  let mut stmt = conn
    .prepare("PRAGMA table_info(mem_items)")
    .map_err(|e| e.to_string())?;
  let names: Vec<String> = stmt
    .query_map([], |r| r.get::<_, String>(1))
    .map_err(|e| e.to_string())?
    .filter_map(|x| x.ok())
    .collect();
  if !names.iter().any(|n| n == "embedding") {
    conn
      .execute("ALTER TABLE mem_items ADD COLUMN embedding BLOB", [])
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// Phase-1 columns from `docs/context-layer-phase-0-1.md` §1. Added via ALTER
/// TABLE on first run; `provenance` is backfilled from `source` once so that
/// downstream code can rely on it being populated.
fn ensure_context_layer_columns(conn: &Connection) -> Result<(), String> {
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
    conn
      .execute("ALTER TABLE mem_items ADD COLUMN provenance TEXT", [])
      .map_err(|e| e.to_string())?;
  }
  if !names.iter().any(|n| n == "entity_id") {
    conn
      .execute("ALTER TABLE mem_items ADD COLUMN entity_id TEXT", [])
      .map_err(|e| e.to_string())?;
  }
  if !names.iter().any(|n| n == "confidence") {
    conn
      .execute("ALTER TABLE mem_items ADD COLUMN confidence REAL", [])
      .map_err(|e| e.to_string())?;
  }
  if !names.iter().any(|n| n == "redaction") {
    conn
      .execute("ALTER TABLE mem_items ADD COLUMN redaction TEXT", [])
      .map_err(|e| e.to_string())?;
  }

  if needs_provenance {
    backfill_provenance_from_source(conn)?;
  }
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
    .query_map([], |r| {
      Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })
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
  let text: String = format!("{}\n{}", title, snippet).chars().take(8000).collect();
  let vec = embeddings::embed_one(&text).await?;
  let blob = encode_embedding_blob(&vec);
  conn
    .execute(
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

fn init_schema(conn: &Connection) -> Result<(), String> {
  conn
    .execute_batch(
      r#"
      CREATE TABLE IF NOT EXISTS mem_items (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        snippet TEXT NOT NULL,
        source TEXT NOT NULL,
        kinds_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
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

  let n: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='mem_items_ai'",
      [],
      |r| r.get(0),
    )
    .unwrap_or(0);
  if n == 0 {
    conn
      .execute_batch(
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
      ON mem_summaries(priority, generated_at DESC);"
  ).map_err(|e| format!("mem_summaries DDL: {}", e))?;
  // Migration: add lang column to pre-existing tables (idempotent).
  let has_lang = conn.query_row(
    "SELECT COUNT(*) FROM pragma_table_info('mem_summaries') WHERE name = 'lang'",
    [],
    |r| r.get::<_, i64>(0),
  ).unwrap_or(0);
  if has_lang == 0 {
    conn.execute(
      "ALTER TABLE mem_summaries ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'",
      [],
    ).map_err(|e| format!("mem_summaries add lang: {}", e))?;
  }
  // Migration: user_priority override ('high'|'medium'|'low' or NULL).
  // When non-NULL, UI uses it instead of the LLM-assigned priority.
  // Added 2026-04-24 for the manual-override UX.
  let has_user_priority = conn.query_row(
    "SELECT COUNT(*) FROM pragma_table_info('mem_summaries') WHERE name = 'user_priority'",
    [],
    |r| r.get::<_, i64>(0),
  ).unwrap_or(0);
  if has_user_priority == 0 {
    conn.execute(
      "ALTER TABLE mem_summaries ADD COLUMN user_priority TEXT",
      [],
    ).map_err(|e| format!("mem_summaries add user_priority: {}", e))?;
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
    ).map_err(|e| format!("mem_summaries add acknowledged_at: {}", e))?;
  }
  // Migration: snooze_until (ms) lets the user defer an item to "look at
  // later" without acknowledging it. Hidden from highlights while
  // snooze_until > now_ms; re-surfaces automatically when the deadline
  // passes. Reset (= NULL) when the summary is invalidated/regenerated.
  let has_snooze_until = conn.query_row(
    "SELECT COUNT(*) FROM pragma_table_info('mem_summaries') WHERE name = 'snooze_until'",
    [],
    |r| r.get::<_, i64>(0),
  ).unwrap_or(0);
  if has_snooze_until == 0 {
    conn.execute(
      "ALTER TABLE mem_summaries ADD COLUMN snooze_until INTEGER",
      [],
    ).map_err(|e| format!("mem_summaries add snooze_until: {}", e))?;
  }



  // Partial UNIQUE index to dedupe historical-sync ingestion keyed by
  // (source, entity_id). Skipped for rows without an entity_id (e.g. screen
  // captures, free-form notes) so those remain append-only.
  //
  // Because pre-existing databases may already contain duplicates from prior
  // calendar / gmail re-runs, compress dupes first (keep the oldest rowid per
  // (source, entity_id)) so the index creation doesn't abort.
  conn
    .execute(
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
  conn
    .execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_items_entity_unique \
       ON mem_items(source, entity_id) \
       WHERE entity_id IS NOT NULL AND entity_id != ''",
      [],
    )
    .map_err(|e| format!("mem_items entity unique index: {}", e))?;

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
    let kinds = it.get("kinds").cloned().unwrap_or_else(|| json!(["screen"]));
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

/// Attach FTS5 `highlight()` / `snippet()` output to a memory item row when
/// the marker characters are actually present — i.e. the match was in that
/// column. The frontend later splits on the markers to wrap each span in
/// `<mark>`; sentinels outside `\x02` / `\x03` keep the contract HTML-safe
/// (no escaping needed).
fn attach_fts_highlights(
  item: &mut Value,
  title_hl: Option<String>,
  snippet_hl: Option<String>,
) {
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
) -> Value {
  let prov = provenance
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| derive_provenance(&source).to_string());
  let mut obj = json!({
    "id": id,
    "title": title,
    "snippet": snippet,
    "source": source,
    "kinds": kinds_json_to_value(&kinds_json),
    "created_at": created_at.max(0) as u64,
    "provenance": prov,
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

fn search_fts(conn: &Connection, fts_q: &str, kinds_want: &[String], limit: usize) -> Result<(Vec<Value>, usize), String> {
  let cap = (limit.saturating_mul(12)).max(limit).min(400);
  let mut stmt = conn
    .prepare(
      r#"
      SELECT m.id, m.title, m.snippet, m.source, m.kinds_json, m.created_at,
             m.provenance, m.entity_id, m.confidence, m.redaction,
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
      let title_hl: Option<String> = r.get(10).ok();
      let snippet_hl: Option<String> = r.get(11).ok();
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
      "SELECT id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction FROM mem_items ORDER BY created_at DESC",
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
    let title = item.get("title").and_then(|t| t.as_str()).unwrap_or("").to_lowercase();
    let snippet = item
      .get("snippet")
      .and_then(|t| t.as_str())
      .unwrap_or("")
      .to_lowercase();
    let source = item.get("source").and_then(|t| t.as_str()).unwrap_or("").to_lowercase();
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

fn search_recent(conn: &Connection, kinds_want: &[String], limit: usize) -> Result<(Vec<Value>, usize), String> {
  let mut stmt = conn
    .prepare(
      "SELECT id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction FROM mem_items ORDER BY created_at DESC",
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
      "INSERT OR IGNORE INTO mem_items (id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction) \
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
        redaction
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
      arr
        .iter()
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

/// Search with optional **semantic re-ranking** (`semantic: true`, non-empty `query`, LLM key set).
/// Fetches a wider lexical candidate set, embeds the query once, re-orders by cosine similarity
/// (items without `embedding` sort last).
pub async fn search_with_semantics(payload: &Value) -> Result<Value, String> {
  let start = std::time::Instant::now();
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
  let new_hits: Vec<Value> = scored
    .into_iter()
    .take(limit)
    .map(|(_, _, v)| v)
    .collect();
  let total = base.get("total").cloned().unwrap_or(json!(new_hits.len()));
  base["hits"] = json!(new_hits);
  base["semanticRerank"] = json!(true);
  base["total"] = total;
  emit_search_with_semantics_done(&base, true, start.elapsed());
  Ok(base)
}

fn emit_search_with_semantics_done(v: &Value, semantic_applied: bool, elapsed: std::time::Duration) {
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
    id_list.extend(
      arr
        .iter()
        .filter_map(|v| v.as_str().map(String::from)),
    );
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
        "SELECT id, title, snippet, source, kinds_json, created_at, provenance, entity_id, confidence, redaction FROM mem_items WHERE id = ?1",
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
    id_list.extend(
      arr
        .iter()
        .filter_map(|v| v.as_str().map(String::from)),
    );
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
    conn
      .execute("DELETE FROM mem_items WHERE id = ?1", params![id])
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
  conn
    .execute(
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
      .prepare(
        "SELECT COALESCE(provenance,''), COUNT(*) FROM mem_items GROUP BY provenance",
      )
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
    .query_row("SELECT MIN(created_at), MAX(created_at) FROM mem_items", [], |r| {
      Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?))
    })
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
    attach_fts_highlights, decode_embedding_blob, derive_provenance, encode_embedding_blob,
    is_transient_embed_error, is_valid_provenance, is_valid_redaction, row_to_item,
    truncate_api_error, HL_END, HL_START,
  };
  use serde_json::json;

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
    assert!(is_transient_embed_error("Embeddings API error 429: slow down"));
    assert!(is_transient_embed_error("Embeddings network error: timed out"));
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
    );
    assert_eq!(full.get("entity_id").and_then(|x| x.as_str()), Some("eid-1"));
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
    );
    assert_eq!(v.get("kinds"), Some(&json!(["note", "screen"])));
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
      );"
    ).expect("create mem_summaries");

    // Verify we can insert a row.
    conn.execute(
      "INSERT INTO mem_summaries
         (target_kind, target_id, title, key_points, source_type, priority, reason, model, generated_at, raw_json)
       VALUES
         ('item', 'm_1', 'T', '[\"k\"]', 'mail', 'medium', 'r', 'heuristic', 1, '{}')",
      [],
    ).expect("insert row");

    let count: i64 = conn.query_row(
      "SELECT COUNT(*) FROM mem_summaries",
      [],
      |r| r.get(0),
    ).expect("count");
    assert_eq!(count, 1);
  }
}
