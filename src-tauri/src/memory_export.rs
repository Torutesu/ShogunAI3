//! Memory export / import. JSONL format with a header line, base64-encoded
//! embeddings, no settings (provider keys excluded by design).
//! See spec docs/superpowers/specs/2026-05-04-memory-export-import-design.md.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

pub const FORMAT: &str = "shogun-memory-export";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportHeader {
  pub format: String,
  pub version: u32,
  pub exported_at: String,
  pub row_count: u64,
  pub schema_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemItemRow {
  pub id: String,
  pub title: String,
  pub snippet: String,
  pub source: String,
  pub kinds_json: String,
  pub created_at: i64,
  pub embedding: Option<Vec<u8>>,
  pub provenance: Option<String>,
  pub entity_id: Option<String>,
  pub confidence: Option<f64>,
  pub redaction: Option<String>,
  pub sync_status: String,
  pub sync_excluded_reason: Option<String>,
}

const SCHEMA_COLUMNS: &[&str] = &[
  "id",
  "title",
  "snippet",
  "source",
  "kinds_json",
  "created_at",
  "embedding",
  "provenance",
  "entity_id",
  "confidence",
  "redaction",
  "sync_status",
  "sync_excluded_reason",
];

// --------------------------------------------------------------------------
// Pure helpers — testable on any platform.
// --------------------------------------------------------------------------

/// Validate the import IPC payload — require an explicit `confirm: "REPLACE"`
/// field. The replace-mode import is destructive (it wipes all `mem_items`),
/// so the caller must opt in by typing the literal string. Lives here so the
/// check is unit-testable without spinning up the Tauri command surface.
pub fn validate_import_payload(payload: &Value) -> Result<(), String> {
  let confirm = payload
    .get("confirm")
    .and_then(|v| v.as_str())
    .unwrap_or("");
  if confirm != "REPLACE" {
    return Err("import requires explicit REPLACE confirmation".into());
  }
  Ok(())
}

/// Parse the first line of a SHOGUN memory export and validate it.
pub fn validate_header(line: &str) -> Result<ExportHeader, String> {
  let h: ExportHeader = serde_json::from_str(line.trim())
    .map_err(|e| format!("header parse: {}", e))?;
  if h.format != FORMAT {
    return Err(format!("unknown format: {}", h.format));
  }
  if h.version != VERSION {
    return Err(format!("unsupported version: {}", h.version));
  }
  Ok(h)
}

/// Serialize a `MemItemRow` to a JSON `Value`. The `embedding` BLOB is
/// base64-encoded; all keys use snake_case.
pub fn row_to_json(row: &MemItemRow) -> Value {
  let embedding_b64: Value = match &row.embedding {
    Some(b) => Value::String(B64.encode(b)),
    None => Value::Null,
  };
  json!({
    "id": row.id,
    "title": row.title,
    "snippet": row.snippet,
    "source": row.source,
    "kinds_json": row.kinds_json,
    "created_at": row.created_at,
    "embedding": embedding_b64,
    "provenance": row.provenance,
    "entity_id": row.entity_id,
    "confidence": row.confidence,
    "redaction": row.redaction,
    "sync_status": row.sync_status,
    "sync_excluded_reason": row.sync_excluded_reason,
  })
}

/// Deserialize a JSON `Value` back to a `MemItemRow`. The `embedding` field
/// must be a base64 string or null.
pub fn json_to_row(v: &Value) -> Result<MemItemRow, String> {
  let str_field = |key: &str| -> Result<String, String> {
    v.get(key)
      .and_then(|x| x.as_str())
      .map(|s| s.to_string())
      .ok_or_else(|| format!("missing or non-string field: {}", key))
  };
  let opt_str = |key: &str| -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
  };

  let id = str_field("id")?;
  let title = str_field("title")?;
  let snippet = str_field("snippet")?;
  let source = str_field("source")?;
  let kinds_json = str_field("kinds_json")?;
  let created_at = v
    .get("created_at")
    .and_then(|x| x.as_i64())
    .ok_or_else(|| "missing or non-integer field: created_at".to_string())?;
  let sync_status = v
    .get("sync_status")
    .and_then(|x| x.as_str())
    .unwrap_or("local_only")
    .to_string();

  // embedding: base64 string or null
  let embedding: Option<Vec<u8>> = match v.get("embedding") {
    Some(Value::String(s)) => {
      let b = B64
        .decode(s)
        .map_err(|e| format!("base64 decode error for embedding: {}", e))?;
      Some(b)
    }
    Some(Value::Null) | None => None,
    other => {
      return Err(format!(
        "embedding must be a base64 string or null, got: {:?}",
        other
      ))
    }
  };

  let confidence: Option<f64> = v.get("confidence").and_then(|x| x.as_f64());

  Ok(MemItemRow {
    id,
    title,
    snippet,
    source,
    kinds_json,
    created_at,
    embedding,
    provenance: opt_str("provenance"),
    entity_id: opt_str("entity_id"),
    confidence,
    redaction: opt_str("redaction"),
    sync_status,
    sync_excluded_reason: opt_str("sync_excluded_reason"),
  })
}

// --------------------------------------------------------------------------
// I/O — exercised by smaller-bore tests via in-memory readers/writers.
// --------------------------------------------------------------------------

/// Write all `mem_items` rows from `conn` to `out` in JSONL format (header
/// line first, then one JSON object per line). Returns the number of rows
/// written. Uses buffered I/O at the call site for best performance.
pub fn export_to_writer<W: Write>(
  conn: &rusqlite::Connection,
  out: &mut W,
) -> Result<u64, String> {
  // Collect all rows first so we know row_count for the header.
  let mut stmt = conn
    .prepare(
      "SELECT id, title, snippet, source, kinds_json, created_at, \
       embedding, provenance, entity_id, confidence, redaction, \
       sync_status, sync_excluded_reason \
       FROM mem_items ORDER BY created_at ASC",
    )
    .map_err(|e| format!("export prepare: {}", e))?;

  let rows: Vec<MemItemRow> = stmt
    .query_map([], |r| {
      Ok(MemItemRow {
        id: r.get(0)?,
        title: r.get(1)?,
        snippet: r.get(2)?,
        source: r.get(3)?,
        kinds_json: r.get(4)?,
        created_at: r.get(5)?,
        embedding: r.get(6)?,
        provenance: r.get(7)?,
        entity_id: r.get(8)?,
        confidence: r.get(9)?,
        redaction: r.get(10)?,
        sync_status: r
          .get::<_, Option<String>>(11)?
          .unwrap_or_else(|| "local_only".to_string()),
        sync_excluded_reason: r.get(12)?,
      })
    })
    .map_err(|e| format!("export query: {}", e))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| format!("export row read: {}", e))?;

  let row_count = rows.len() as u64;
  let exported_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

  let header = ExportHeader {
    format: FORMAT.to_string(),
    version: VERSION,
    exported_at,
    row_count,
    schema_columns: SCHEMA_COLUMNS.iter().map(|s| s.to_string()).collect(),
  };

  let header_line = serde_json::to_string(&header)
    .map_err(|e| format!("header serialize: {}", e))?;
  writeln!(out, "{}", header_line).map_err(|e| format!("write header: {}", e))?;

  for row in &rows {
    let v = row_to_json(row);
    let line = serde_json::to_string(&v).map_err(|e| format!("row serialize: {}", e))?;
    writeln!(out, "{}", line).map_err(|e| format!("write row: {}", e))?;
  }

  Ok(row_count)
}

/// Read JSONL from `reader`, validate the header, then replace all `mem_items`
/// with the rows in the file. The entire replace is wrapped in a single
/// transaction; any parse or insert error rolls back and the original data is
/// preserved. Returns the number of rows imported.
pub fn import_from_reader<R: BufRead>(
  conn: &rusqlite::Connection,
  reader: R,
) -> Result<u64, String> {
  let mut lines = reader.lines();

  // --- Line 1: header ---
  let first = lines
    .next()
    .ok_or_else(|| "empty file: no header line".to_string())?
    .map_err(|e| format!("read header line: {}", e))?;
  let _header = validate_header(&first)?;

  // --- Collect remaining lines (do NOT touch DB until we have them all) ---
  // We parse eagerly so a malformed file is rejected before we delete anything.
  let mut parsed_rows: Vec<MemItemRow> = Vec::new();
  for line_result in lines {
    let line = line_result.map_err(|e| format!("read row: {}", e))?;
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    let v: Value =
      serde_json::from_str(trimmed).map_err(|e| format!("row parse: {}", e))?;
    let row = json_to_row(&v)?;
    parsed_rows.push(row);
  }

  // --- Transactional replace ---
  let tx = conn
    .unchecked_transaction()
    .map_err(|e| format!("begin transaction: {}", e))?;

  tx.execute("DELETE FROM mem_items", [])
    .map_err(|e| format!("delete existing rows: {}", e))?;

  // Rebuild FTS after deleting all rows.
  tx.execute_batch("INSERT INTO mem_items_fts(mem_items_fts) VALUES('rebuild')")
    .map_err(|e| format!("fts rebuild after delete: {}", e))?;

  let count = parsed_rows.len() as u64;
  for row in &parsed_rows {
    // Plain INSERT (not OR REPLACE) so duplicate `id` values within the file
    // surface as a transactional error rather than silently overwriting. The
    // table was already cleared by the DELETE above, so only intra-file
    // collisions can fire this path — those are export bugs and should abort
    // the import so the user keeps their original data.
    tx.execute(
      "INSERT INTO mem_items \
       (id, title, snippet, source, kinds_json, created_at, embedding, \
        provenance, entity_id, confidence, redaction, sync_status, sync_excluded_reason) \
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
      params![
        row.id,
        row.title,
        row.snippet,
        row.source,
        row.kinds_json,
        row.created_at,
        row.embedding,
        row.provenance,
        row.entity_id,
        row.confidence,
        row.redaction,
        row.sync_status,
        row.sync_excluded_reason,
      ],
    )
    .map_err(|e| format!("insert row {}: {}", row.id, e))?;
  }

  tx.commit().map_err(|e| format!("commit: {}", e))?;

  Ok(count)
}

// --------------------------------------------------------------------------
// Tests (T1–T10 from spec § 6)
// --------------------------------------------------------------------------
#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::Connection;

  /// Create a fully-initialized in-memory DB with all 13 mem_items columns.
  /// Mirrors the canonical sequence in `memory_store::open_conn`:
  ///   1. `init_schema` — base table (sync_status / sync_excluded_reason
  ///      inline + migrate_sync_status_columns) + FTS + triggers.
  ///   2. `ensure_embedding_column` — adds `embedding` BLOB.
  ///   3. `ensure_context_layer_columns` — adds `provenance`, `entity_id`,
  ///      `confidence`, `redaction` and the entity unique index.
  /// We skip `ensure_redaction_nullable` (rebuild path) and the kioku schema
  /// since they're not exercised by the export/import surface. Stays in sync
  /// automatically with future schema changes that flow through the same
  /// migration helpers.
  fn fresh_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory");
    crate::memory_store::init_schema(&conn).expect("init_schema");
    crate::memory_store::ensure_embedding_column(&conn).expect("ensure_embedding_column");
    crate::memory_store::ensure_context_layer_columns(&conn)
      .expect("ensure_context_layer_columns");
    conn
  }

  fn insert_row(conn: &Connection, row: &MemItemRow) {
    conn.execute(
      "INSERT INTO mem_items \
       (id, title, snippet, source, kinds_json, created_at, embedding, \
        provenance, entity_id, confidence, redaction, sync_status, sync_excluded_reason) \
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
      params![
        row.id,
        row.title,
        row.snippet,
        row.source,
        row.kinds_json,
        row.created_at,
        row.embedding,
        row.provenance,
        row.entity_id,
        row.confidence,
        row.redaction,
        row.sync_status,
        row.sync_excluded_reason,
      ],
    )
    .expect("insert test row");
  }

  fn make_row(id: &str) -> MemItemRow {
    MemItemRow {
      id: id.to_string(),
      title: format!("Title {}", id),
      snippet: format!("Snippet {}", id),
      source: "test".to_string(),
      kinds_json: r#"["note"]"#.to_string(),
      created_at: 1_700_000_000 + id.len() as i64,
      embedding: None,
      provenance: Some("user".to_string()),
      entity_id: None,
      confidence: None,
      redaction: None,
      sync_status: "local_only".to_string(),
      sync_excluded_reason: None,
    }
  }

  fn count_rows(conn: &Connection) -> i64 {
    conn
      .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
      .unwrap_or(0)
  }

  // --- T1: Export header is well-formed ---
  #[test]
  fn t1_export_header_well_formed() {
    let conn = fresh_conn();
    for i in 0..3 {
      insert_row(&conn, &make_row(&format!("row-{}", i)));
    }
    let mut buf = Vec::<u8>::new();
    let n = export_to_writer(&conn, &mut buf).expect("export");
    assert_eq!(n, 3);

    let output = String::from_utf8(buf).expect("utf8");
    let first_line = output.lines().next().expect("first line");
    let h: ExportHeader = serde_json::from_str(first_line).expect("header parse");
    assert_eq!(h.format, FORMAT);
    assert_eq!(h.version, VERSION);
    assert_eq!(h.row_count, 3);
    let expected_cols: Vec<&str> = SCHEMA_COLUMNS.to_vec();
    assert_eq!(h.schema_columns, expected_cols);
  }

  // --- T2: Round-trip preserves data (NULLs, various sync_status) ---
  #[test]
  fn t2_round_trip_preserves_data() {
    let conn = fresh_conn();

    // Row with embedding
    let mut r1 = make_row("rt-1");
    r1.embedding = Some(vec![0x01, 0x02, 0x03, 0x04]);
    r1.sync_status = "excluded".to_string();
    r1.sync_excluded_reason = Some("test-reason".to_string());
    r1.confidence = Some(0.9);
    insert_row(&conn, &r1);

    // Row with all optionals null
    let r2 = make_row("rt-2");
    insert_row(&conn, &r2);

    // Export
    let mut buf = Vec::<u8>::new();
    export_to_writer(&conn, &mut buf).expect("export");

    // Import into a fresh DB
    let conn2 = fresh_conn();
    let n = import_from_reader(&conn2, std::io::BufReader::new(buf.as_slice()))
      .expect("import");
    assert_eq!(n, 2);

    // Check r1 round-tripped correctly
    let row: MemItemRow = conn2
      .query_row(
        "SELECT id, title, snippet, source, kinds_json, created_at, embedding, \
         provenance, entity_id, confidence, redaction, sync_status, sync_excluded_reason \
         FROM mem_items WHERE id = 'rt-1'",
        [],
        |r| {
          Ok(MemItemRow {
            id: r.get(0)?,
            title: r.get(1)?,
            snippet: r.get(2)?,
            source: r.get(3)?,
            kinds_json: r.get(4)?,
            created_at: r.get(5)?,
            embedding: r.get(6)?,
            provenance: r.get(7)?,
            entity_id: r.get(8)?,
            confidence: r.get(9)?,
            redaction: r.get(10)?,
            sync_status: r.get::<_, Option<String>>(11)?.unwrap_or_default(),
            sync_excluded_reason: r.get(12)?,
          })
        },
      )
      .expect("query rt-1");
    assert_eq!(row, r1);
  }

  // --- T3: Import replace semantics ---
  #[test]
  fn t3_import_replace_semantics() {
    let conn = fresh_conn();

    // Pre-populate with 2 rows
    for i in 0..2 {
      insert_row(&conn, &make_row(&format!("pre-{}", i)));
    }
    assert_eq!(count_rows(&conn), 2);

    // Build a JSONL file with 5 rows in a *separate* source DB
    let conn_src = fresh_conn();
    for i in 0..5 {
      insert_row(&conn_src, &make_row(&format!("new-{}", i)));
    }
    let mut buf = Vec::<u8>::new();
    export_to_writer(&conn_src, &mut buf).expect("export");

    // Import into the original DB (which had 2 rows)
    let n = import_from_reader(&conn, std::io::BufReader::new(buf.as_slice()))
      .expect("import");
    assert_eq!(n, 5);
    assert_eq!(count_rows(&conn), 5);

    // Verify the old rows are gone
    let old_still_present: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM mem_items WHERE id LIKE 'pre-%'",
        [],
        |r| r.get(0),
      )
      .unwrap_or(0);
    assert_eq!(old_still_present, 0);
  }

  // --- T4: Validation: unknown format ---
  #[test]
  fn t4_unknown_format_rejected() {
    let bad_header = r#"{"format":"totally-wrong","version":1,"exported_at":"2026-01-01T00:00:00Z","row_count":0,"schema_columns":[]}"#;
    let err = validate_header(bad_header).unwrap_err();
    assert!(
      err.contains("unknown format") || err.contains("format"),
      "error was: {}",
      err
    );
  }

  // --- T5: Validation: unsupported version ---
  #[test]
  fn t5_unsupported_version_rejected() {
    let bad_header = r#"{"format":"shogun-memory-export","version":99,"exported_at":"2026-01-01T00:00:00Z","row_count":0,"schema_columns":[]}"#;
    let err = validate_header(bad_header).unwrap_err();
    assert!(
      err.contains("unsupported version") || err.contains("version"),
      "error was: {}",
      err
    );
  }

  // --- T6: Insert failure mid-transaction rolls back (spec § 6) ---
  // Forces an INSERT failure by feeding two rows with the same `id` (mem_items
  // has `id TEXT PRIMARY KEY`). The transaction has already executed
  // `DELETE FROM mem_items` and the first INSERT before the second INSERT
  // fails — exercising the rollback path that restores the original 3 rows.
  #[test]
  fn t6_malformed_row_rolls_back() {
    let conn = fresh_conn();
    for i in 0..3 {
      insert_row(&conn, &make_row(&format!("pre-{}", i)));
    }
    assert_eq!(count_rows(&conn), 3);

    let header = json!({
      "format": "shogun-memory-export",
      "version": 1,
      "exported_at": "2026-01-01T00:00:00Z",
      "row_count": 2,
      "schema_columns": SCHEMA_COLUMNS,
    });
    let row1 = json!({
      "id": "dup", "title": "row 1", "snippet": "first", "source": "test",
      "kinds_json": "[]", "created_at": 1_700_000_000i64,
      "embedding": serde_json::Value::Null, "provenance": "user",
      "entity_id": serde_json::Value::Null, "confidence": serde_json::Value::Null,
      "redaction": serde_json::Value::Null, "sync_status": "local_only",
      "sync_excluded_reason": serde_json::Value::Null,
    });
    let row2 = json!({
      "id": "dup", "title": "row 2", "snippet": "duplicate id", "source": "test",
      "kinds_json": "[]", "created_at": 1_700_000_001i64,
      "embedding": serde_json::Value::Null, "provenance": "user",
      "entity_id": serde_json::Value::Null, "confidence": serde_json::Value::Null,
      "redaction": serde_json::Value::Null, "sync_status": "local_only",
      "sync_excluded_reason": serde_json::Value::Null,
    });
    let payload = format!(
      "{}\n{}\n{}\n",
      serde_json::to_string(&header).unwrap(),
      serde_json::to_string(&row1).unwrap(),
      serde_json::to_string(&row2).unwrap(),
    );

    let result = import_from_reader(&conn, std::io::BufReader::new(payload.as_bytes()));
    assert!(
      result.is_err(),
      "duplicate id within import file should fail mid-transaction"
    );

    // Pre-existing rows are restored by rollback.
    assert_eq!(
      count_rows(&conn),
      3,
      "original rows must be restored after rollback"
    );
    let dup_count: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM mem_items WHERE id = 'dup'",
        [],
        |r| r.get(0),
      )
      .expect("count");
    assert_eq!(dup_count, 0, "no 'dup' row should be left behind");
  }

  // --- T6b: Malformed JSON in a data line aborts before touching the DB ---
  // Complementary to T6: the parse-phase error path. We collect rows eagerly
  // before opening the transaction, so a parse error never deletes anything.
  #[test]
  fn t6b_malformed_header_does_not_touch_db() {
    let conn = fresh_conn();
    for i in 0..3 {
      insert_row(&conn, &make_row(&format!("orig-{}", i)));
    }
    assert_eq!(count_rows(&conn), 3);

    let good_header = r#"{"format":"shogun-memory-export","version":1,"exported_at":"2026-01-01T00:00:00Z","row_count":2,"schema_columns":["id"]}"#;
    let good_row = r#"{"id":"x1","title":"T","snippet":"S","source":"test","kinds_json":"[]","created_at":1700000000,"sync_status":"local_only"}"#;
    let bad_row = "{not-valid-json}";
    let payload = format!("{}\n{}\n{}\n", good_header, good_row, bad_row);

    let result = import_from_reader(&conn, std::io::BufReader::new(payload.as_bytes()));
    assert!(result.is_err(), "should have returned an error");

    // Original 3 rows must still be present (rollback / no-op)
    assert_eq!(count_rows(&conn), 3);
  }

  // --- T7: Import requires explicit REPLACE confirmation (spec § 6) ---
  // Validates the IPC-layer guard in `validate_import_payload`, which the
  // Tauri command wrapper (`shogun_memory_import`) calls before any file I/O.
  #[test]
  fn t7_import_requires_replace_confirm() {
    use serde_json::json;
    // Missing confirm field → error
    let err = validate_import_payload(&json!({})).unwrap_err();
    assert!(
      err.contains("REPLACE"),
      "error should mention REPLACE; got: {}",
      err
    );
    // Wrong confirm value → error
    assert!(validate_import_payload(&json!({ "confirm": "yes" })).is_err());
    assert!(validate_import_payload(&json!({ "confirm": "replace" })).is_err());
    assert!(validate_import_payload(&json!({ "confirm": "" })).is_err());
    // Correct confirm value → ok
    assert!(validate_import_payload(&json!({ "confirm": "REPLACE" })).is_ok());
  }

  // --- T7b: pure import_from_reader does not check for confirm ---
  // The REPLACE guard is intentionally at the IPC layer (T7), so the pure
  // function accepts any well-formed input and leaves authorization to its
  // caller. This test pins that behavior.
  #[test]
  fn t7b_pure_import_fn_no_confirm_required() {
    let conn = fresh_conn();
    let good_header = r#"{"format":"shogun-memory-export","version":1,"exported_at":"2026-01-01T00:00:00Z","row_count":0,"schema_columns":[]}"#;
    let n = import_from_reader(&conn, std::io::BufReader::new(good_header.as_bytes()))
      .expect("import should succeed without confirm param");
    assert_eq!(n, 0);
  }

  // --- T8: Embedding BLOB round-trip ---
  #[test]
  fn t8_embedding_blob_round_trip() {
    let original_blob: Vec<u8> = (0u8..=255).collect();

    let row = MemItemRow {
      id: "blob-rt".to_string(),
      title: "Blob test".to_string(),
      snippet: "".to_string(),
      source: "test".to_string(),
      kinds_json: "[]".to_string(),
      created_at: 1_700_000_000,
      embedding: Some(original_blob.clone()),
      provenance: None,
      entity_id: None,
      confidence: None,
      redaction: None,
      sync_status: "local_only".to_string(),
      sync_excluded_reason: None,
    };

    let v = row_to_json(&row);
    let back = json_to_row(&v).expect("json_to_row");
    assert_eq!(back.embedding, Some(original_blob));
  }

  // --- T9: Header line written before rows ---
  #[test]
  fn t9_header_line_first() {
    let conn = fresh_conn();
    insert_row(&conn, &make_row("t9-row"));

    let mut buf = Vec::<u8>::new();
    export_to_writer(&conn, &mut buf).expect("export");

    let first_bytes = &buf[..std::cmp::min(9, buf.len())];
    // Should start with {"format":
    assert!(
      buf.starts_with(b"{\"format\":"),
      "first bytes: {:?}",
      first_bytes
    );

    // Second line should be a data row
    let text = String::from_utf8(buf).unwrap();
    let mut lines = text.lines();
    let first = lines.next().expect("line 1");
    let second = lines.next().expect("line 2");
    let h: Value = serde_json::from_str(first).expect("header parse");
    assert_eq!(h.get("format").and_then(|v| v.as_str()), Some(FORMAT));
    let row: Value = serde_json::from_str(second).expect("row parse");
    assert_eq!(
      row.get("id").and_then(|v| v.as_str()),
      Some("t9-row")
    );
  }

  // --- T10: Empty DB exports cleanly ---
  #[test]
  fn t10_empty_db_exports_cleanly() {
    let conn = fresh_conn();
    let mut buf = Vec::<u8>::new();
    let n = export_to_writer(&conn, &mut buf).expect("export");
    assert_eq!(n, 0);

    let text = String::from_utf8(buf).unwrap();
    let mut lines = text.lines();
    let header_line = lines.next().expect("header line");
    assert!(lines.next().is_none(), "no data lines for empty DB");

    let h: ExportHeader = serde_json::from_str(header_line).expect("header parse");
    assert_eq!(h.format, FORMAT);
    assert_eq!(h.version, VERSION);
    assert_eq!(h.row_count, 0);
  }
}
