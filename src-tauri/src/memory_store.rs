//! Memory index: SQLite + **FTS5** full-text search (`memory.db` under app data).
//!
//! **Local-first:** Data stays on device; no SHOGUN cloud sync for this index.
//! Migrations: legacy `memory_items.json` is imported once when the DB is empty, then renamed to
//! `memory_items.json.migrated`.

use crate::{embeddings, paths, secrets};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
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
  migrate_json_if_needed(&conn)?;
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
    tx.execute(
      "INSERT OR REPLACE INTO mem_items (id, title, snippet, source, kinds_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      params![id, title, snippet, source, kinds_json, created_at],
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

fn row_to_item(
  id: String,
  title: String,
  snippet: String,
  source: String,
  kinds_json: String,
  created_at: i64,
) -> Value {
  json!({
    "id": id,
    "title": title,
    "snippet": snippet,
    "source": source,
    "kinds": kinds_json_to_value(&kinds_json),
    "created_at": created_at.max(0) as u64,
  })
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

fn search_fts(conn: &Connection, fts_q: &str, kinds_want: &[String], limit: usize) -> Result<(Vec<Value>, usize), String> {
  let cap = (limit.saturating_mul(12)).max(limit).min(400);
  let mut stmt = conn
    .prepare(
      r#"
      SELECT m.id, m.title, m.snippet, m.source, m.kinds_json, m.created_at
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
      Ok(row_to_item(
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
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

fn search_fallback_like(
  conn: &Connection,
  query_lc: &str,
  kinds_want: &[String],
  limit: usize,
) -> Result<(Vec<Value>, usize), String> {
  let mut stmt = conn
    .prepare(
      "SELECT id, title, snippet, source, kinds_json, created_at FROM mem_items ORDER BY created_at DESC",
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
      "SELECT id, title, snippet, source, kinds_json, created_at FROM mem_items ORDER BY created_at DESC",
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

/// Append a memory item. Payload: `{ title, snippet?, kinds?, source? }` (WRITE).
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

  let id = format!("m_{}", now_ms());
  let created = now_ms() as i64;

  conn
    .execute(
      "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      params![id, title, snippet, source, kinds_json, created],
    )
    .map_err(|e| e.to_string())?;

  let item = json!({
    "id": id,
    "title": title,
    "snippet": snippet,
    "kinds": kinds,
    "source": source,
    "created_at": created as u64,
  });

  let out = json!({
    "item": item,
    "echo": payload,
    "stub": false,
  });

  let skip_embed = source == "capture_sampler" || source == "capture_ax";
  if !skip_embed {
    let id_spawn = id.clone();
    tauri::async_runtime::spawn(async move {
      if let Err(e) = embed_row_by_id(&id_spawn).await {
        log::warn!("memory embed {}: {}", id_spawn, e);
      }
    });
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
    return search(payload);
  }
  if secrets::get_llm_api_key()
    .ok()
    .flatten()
    .map(|s| s.trim().is_empty())
    .unwrap_or(true)
  {
    return search(payload);
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
  Ok(base)
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
        "SELECT id, title, snippet, source, kinds_json, created_at FROM mem_items WHERE id = ?1",
        params![want],
        |r| {
          Ok(row_to_item(
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
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
    decode_embedding_blob, derive_provenance, encode_embedding_blob, is_transient_embed_error,
    truncate_api_error,
  };

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
}
