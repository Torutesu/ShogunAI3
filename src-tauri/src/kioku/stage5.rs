//! KIOKU Phase 2 Stage 5: dry-run + soft-retire + TTL raw-cleanup +
//! physical-delete + VACUUM.
//!
//! All destructive operations are gated by `settings.kioku_graph.stage5_apply`
//! at the Tauri command layer; the functions themselves do exactly what they
//! say so tests can drive each step in isolation.
//!
//! Spec: `docs/memory-architecture/migration-plan.md` §Stage 5.

#![allow(dead_code)]

use rusqlite::{params, Connection};
use serde::Serialize;

/// `mem_items.source` values that came in via the legacy (pre-T4) capture
/// path. Stage 5 retires / deletes only these; everything else is left
/// untouched (gmail / google_calendar / meeting_* / capture_summary etc.).
pub const CAPTURE_LEGACY_SOURCES: &[&str] = &["capture_sampler", "capture_ax"];

/// Soft-retired rows must sit `STAGE5_SOFT_RETIRE_GRACE_DAYS` days before
/// physical-delete picks them up. Mirrors `migration-plan.md` §Stage 5.4.
pub const STAGE5_SOFT_RETIRE_GRACE_DAYS: i64 = 30;

const MS_PER_DAY: i64 = 86_400_000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SoftRetireBlock {
    pub matching_rows: i64,
    pub already_retired: i64,
    pub oldest_created_at_ms: Option<i64>,
    pub newest_created_at_ms: Option<i64>,
    pub embedding_blob_count: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TtlExpiredBlock {
    pub rows_with_raw_to_clean: i64,
    pub raw_path_files_to_unlink: i64,
    pub raw_text_rows_to_null: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PhysicalDeleteBlock {
    pub eligible_rows: i64,
    pub cascade_edges: i64,
    pub orphaned_summaries: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StorageEstimate {
    pub db_size_before_bytes: u64,
    pub raw_path_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TtlCleanupResult {
    pub rows_marked_expired: usize,
    pub raw_paths_unlinked: usize,
    pub raw_text_nulled: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Stage5DryRunReport {
    pub generated_at_ms: i64,
    pub soft_retire: SoftRetireBlock,
    pub ttl_expired: TtlExpiredBlock,
    pub physical_delete: PhysicalDeleteBlock,
    pub storage: StorageEstimate,
    pub legacy_sources: Vec<String>,
    pub grace_days: i64,
}

// ── Dry-run query ──────────────────────────────────────────────────────────

fn placeholders_for(n: usize) -> String {
    std::iter::repeat("?").take(n).collect::<Vec<_>>().join(",")
}

fn legacy_source_params() -> Vec<Box<dyn rusqlite::ToSql>> {
    CAPTURE_LEGACY_SOURCES
        .iter()
        .map(|s| Box::new(s.to_string()) as Box<dyn rusqlite::ToSql>)
        .collect()
}

fn count_query(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<i64, String> {
    conn.query_row(sql, params, |r| r.get::<_, i64>(0))
        .map_err(|e| format!("kioku_stage5 count query: {}", e))
}

fn soft_retire_block(conn: &Connection) -> Result<SoftRetireBlock, String> {
    let placeholders = placeholders_for(CAPTURE_LEGACY_SOURCES.len());
    let p = legacy_source_params();
    let p_refs: Vec<&dyn rusqlite::ToSql> = p.iter().map(|b| b.as_ref()).collect();

    let matching = count_query(
        conn,
        &format!(
            "SELECT COUNT(*) FROM mem_items WHERE source IN ({})",
            placeholders
        ),
        &p_refs,
    )?;
    let already_retired = count_query(
        conn,
        &format!(
            "SELECT COUNT(*) FROM mem_items WHERE source IN ({}) AND valid_to IS NOT NULL",
            placeholders
        ),
        &p_refs,
    )?;
    let oldest_created_at_ms: Option<i64> = conn
        .query_row(
            &format!(
                "SELECT MIN(created_at) FROM mem_items WHERE source IN ({})",
                placeholders
            ),
            &*p_refs,
            |r| r.get::<_, Option<i64>>(0),
        )
        .map_err(|e| e.to_string())?;
    let newest_created_at_ms: Option<i64> = conn
        .query_row(
            &format!(
                "SELECT MAX(created_at) FROM mem_items WHERE source IN ({})",
                placeholders
            ),
            &*p_refs,
            |r| r.get::<_, Option<i64>>(0),
        )
        .map_err(|e| e.to_string())?;
    let embedding_blob_count = count_query(
        conn,
        &format!(
            "SELECT COUNT(*) FROM mem_items WHERE source IN ({}) AND embedding IS NOT NULL",
            placeholders
        ),
        &p_refs,
    )?;

    Ok(SoftRetireBlock {
        matching_rows: matching,
        already_retired,
        oldest_created_at_ms,
        newest_created_at_ms,
        embedding_blob_count,
    })
}

fn ttl_expired_block(conn: &Connection, now_ms: i64) -> Result<TtlExpiredBlock, String> {
    let rows_with_raw = count_query(
        conn,
        "SELECT COUNT(*) FROM mem_captures
     WHERE ttl_expires_at < ?1 AND extraction_status = 'done'
       AND (raw_text IS NOT NULL OR raw_path IS NOT NULL)",
        &[&now_ms],
    )?;
    let raw_path_files = count_query(
        conn,
        "SELECT COUNT(*) FROM mem_captures
     WHERE ttl_expires_at < ?1 AND extraction_status = 'done'
       AND raw_path IS NOT NULL AND raw_path != ''",
        &[&now_ms],
    )?;
    let raw_text_rows = count_query(
        conn,
        "SELECT COUNT(*) FROM mem_captures
     WHERE ttl_expires_at < ?1 AND extraction_status = 'done'
       AND raw_text IS NOT NULL",
        &[&now_ms],
    )?;
    Ok(TtlExpiredBlock {
        rows_with_raw_to_clean: rows_with_raw,
        raw_path_files_to_unlink: raw_path_files,
        raw_text_rows_to_null: raw_text_rows,
    })
}

fn physical_delete_block(conn: &Connection, now_ms: i64) -> Result<PhysicalDeleteBlock, String> {
    let cutoff = now_ms - STAGE5_SOFT_RETIRE_GRACE_DAYS * MS_PER_DAY;
    let placeholders = placeholders_for(CAPTURE_LEGACY_SOURCES.len());
    let p = legacy_source_params();
    let mut p_refs: Vec<&dyn rusqlite::ToSql> = p.iter().map(|b| b.as_ref()).collect();
    p_refs.push(&cutoff);

    let eligible = count_query(
        conn,
        &format!(
            "SELECT COUNT(*) FROM mem_items
       WHERE source IN ({}) AND valid_to IS NOT NULL AND valid_to < ?{}",
            placeholders,
            CAPTURE_LEGACY_SOURCES.len() + 1
        ),
        &p_refs,
    )?;
    let cascade_edges = count_query(
        conn,
        &format!(
            "SELECT COUNT(*) FROM mem_edges e
       JOIN mem_items m ON (e.from_node = m.id OR e.to_node = m.id)
       WHERE m.source IN ({}) AND m.valid_to IS NOT NULL AND m.valid_to < ?{}",
            placeholders,
            CAPTURE_LEGACY_SOURCES.len() + 1
        ),
        &p_refs,
    )?;
    // Orphaned mem_summaries: target_id pointing to a soon-to-delete row.
    let orphaned_summaries = count_query(
        conn,
        &format!(
            "SELECT COUNT(*) FROM mem_summaries s
       JOIN mem_items m ON s.target_id = m.id AND s.target_kind = 'item'
       WHERE m.source IN ({}) AND m.valid_to IS NOT NULL AND m.valid_to < ?{}",
            placeholders,
            CAPTURE_LEGACY_SOURCES.len() + 1
        ),
        &p_refs,
    )?;
    Ok(PhysicalDeleteBlock {
        eligible_rows: eligible,
        cascade_edges,
        orphaned_summaries,
    })
}

fn storage_estimate(conn: &Connection, ttl: &TtlExpiredBlock) -> Result<StorageEstimate, String> {
    // SQLite page count × page size approximates the file size; works on
    // in-memory DBs too. The raw_path bytes estimate is an *upper bound* the
    // CLI computes from the filesystem.
    let page_count: i64 = conn
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let db_size_before_bytes = (page_count.max(0) as u64) * (page_size.max(0) as u64);
    // Use 4 KiB / file as a conservative placeholder; the CLI replaces this
    // with the actual sum when invoked from outside.
    let raw_path_bytes = (ttl.raw_path_files_to_unlink.max(0) as u64) * 4_096;
    Ok(StorageEstimate {
        db_size_before_bytes,
        raw_path_bytes,
    })
}

/// Compose all dry-run blocks into a single Markdown / JSON-friendly report.
pub fn run_dry_run(conn: &Connection, now_ms: i64) -> Result<Stage5DryRunReport, String> {
    let soft_retire = soft_retire_block(conn)?;
    let ttl_expired = ttl_expired_block(conn, now_ms)?;
    let physical_delete = physical_delete_block(conn, now_ms)?;
    let storage = storage_estimate(conn, &ttl_expired)?;
    Ok(Stage5DryRunReport {
        generated_at_ms: now_ms,
        soft_retire,
        ttl_expired,
        physical_delete,
        storage,
        legacy_sources: CAPTURE_LEGACY_SOURCES
            .iter()
            .map(|s| (*s).to_string())
            .collect(),
        grace_days: STAGE5_SOFT_RETIRE_GRACE_DAYS,
    })
}

// ── Soft retire ────────────────────────────────────────────────────────────

/// Soft-retire every legacy-capture mem_items row that isn't already retired.
/// Sets `valid_to = now_ms`. Returns how many rows were touched.
pub fn soft_retire_capture_rows(conn: &Connection, now_ms: i64) -> Result<usize, String> {
    let placeholders = placeholders_for(CAPTURE_LEGACY_SOURCES.len());
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    params.push(Box::new(now_ms));
    for s in CAPTURE_LEGACY_SOURCES {
        params.push(Box::new(s.to_string()));
    }
    let p_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let n = conn
        .execute(
            &format!(
                "UPDATE mem_items SET valid_to = ?1
         WHERE source IN ({}) AND valid_to IS NULL",
                placeholders
            ),
            &*p_refs,
        )
        .map_err(|e| format!("kioku_stage5::soft_retire_capture_rows: {}", e))?;
    Ok(n)
}

// ── TTL cleanup ────────────────────────────────────────────────────────────

/// For every mem_captures row with `extraction_status = 'done'` and
/// `ttl_expires_at < now_ms`:
///  1. unlink `raw_path` from disk (best-effort; logs on failure but
///     continues so a missing file doesn't block table cleanup).
///  2. NULL out `raw_text` and `raw_path`.
///  3. Mark `extraction_status = 'expired'`.
/// Derived nodes already exist; this only strips the raw payload to honor
/// the 14-day TTL documented in `target-design.md` §2.3.
pub fn cleanup_ttl_expired_captures(
    conn: &Connection,
    now_ms: i64,
) -> Result<TtlCleanupResult, String> {
    // Pull candidates so we can unlink files outside the DB transaction.
    let mut stmt = conn
        .prepare(
            "SELECT id, raw_path, raw_text IS NOT NULL
       FROM mem_captures
       WHERE ttl_expires_at < ?1 AND extraction_status = 'done'
         AND (raw_path IS NOT NULL OR raw_text IS NOT NULL)",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![now_ms], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, bool>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut to_clean: Vec<(i64, Option<String>, bool)> = Vec::new();
    for row in rows {
        to_clean.push(row.map_err(|e| e.to_string())?);
    }
    drop(stmt);

    let mut raw_paths_unlinked = 0usize;
    let mut raw_text_nulled = 0usize;
    for (_id, raw_path, has_raw_text) in &to_clean {
        if let Some(p) = raw_path {
            if !p.is_empty() {
                match std::fs::remove_file(p) {
                    Ok(_) => raw_paths_unlinked += 1,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // Already gone — count as cleaned for accounting purposes.
                        raw_paths_unlinked += 1;
                    }
                    Err(e) => {
                        log::warn!("kioku_stage5: failed to unlink {}: {}", p, e);
                    }
                }
            }
        }
        if *has_raw_text {
            raw_text_nulled += 1;
        }
    }

    // Update DB rows in one transaction. We only touch rows that actually
    // had raw payload to clean — otherwise a previously-cleaned 'done' row
    // would get re-marked 'expired' on every subsequent run.
    let mut rows_marked_expired = 0usize;
    if !to_clean.is_empty() {
        let n = conn
            .execute(
                "UPDATE mem_captures
           SET raw_path = NULL,
               raw_text = NULL,
               extraction_status = 'expired'
         WHERE ttl_expires_at < ?1 AND extraction_status = 'done'
           AND (raw_path IS NOT NULL OR raw_text IS NOT NULL)",
                params![now_ms],
            )
            .map_err(|e| format!("kioku_stage5::cleanup_ttl_expired_captures: {}", e))?;
        rows_marked_expired = n;
    }

    Ok(TtlCleanupResult {
        rows_marked_expired,
        raw_paths_unlinked,
        raw_text_nulled,
    })
}

// ── Physical delete + VACUUM ───────────────────────────────────────────────

/// Hard-delete legacy capture mem_items rows that have been soft-retired
/// for at least `STAGE5_SOFT_RETIRE_GRACE_DAYS` days. `mem_edges` rows
/// cascade via `ON DELETE CASCADE`; FTS triggers cleanup `mem_items_fts`.
/// Returns how many `mem_items` rows were dropped.
pub fn physical_delete_old_capture_rows(conn: &Connection, now_ms: i64) -> Result<usize, String> {
    let cutoff = now_ms - STAGE5_SOFT_RETIRE_GRACE_DAYS * MS_PER_DAY;
    let placeholders = placeholders_for(CAPTURE_LEGACY_SOURCES.len());
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for s in CAPTURE_LEGACY_SOURCES {
        params.push(Box::new(s.to_string()));
    }
    params.push(Box::new(cutoff));
    let p_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let n = conn
        .execute(
            &format!(
                "DELETE FROM mem_items
         WHERE source IN ({}) AND valid_to IS NOT NULL AND valid_to < ?{}",
                placeholders,
                CAPTURE_LEGACY_SOURCES.len() + 1
            ),
            &*p_refs,
        )
        .map_err(|e| format!("kioku_stage5::physical_delete_old_capture_rows: {}", e))?;
    Ok(n)
}

/// Run `VACUUM` to compact the database. SQLite holds an exclusive lock for
/// the duration; callers should ensure no other writer is active.
pub fn vacuum_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("VACUUM;")
        .map_err(|e| format!("kioku_stage5::vacuum_db: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn open_test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys=ON;").expect("FK");
        conn.execute_batch(
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
         );
         -- mem_summaries (Phase 1 baseline) — needed by the dry-run join.
         CREATE TABLE mem_summaries (
           target_kind TEXT NOT NULL,
           target_id TEXT NOT NULL,
           title TEXT NOT NULL,
           key_points TEXT NOT NULL,
           source_type TEXT NOT NULL,
           priority TEXT NOT NULL,
           reason TEXT,
           model TEXT NOT NULL,
           schema_version INTEGER NOT NULL DEFAULT 1,
           generated_at INTEGER NOT NULL,
           raw_json TEXT NOT NULL,
           PRIMARY KEY (target_kind, target_id)
         );",
        )
        .expect("phase1");
        crate::kioku_graph_schema::ensure_kioku_graph_schema(&conn).expect("phase2");
        conn
    }

    fn seed_mem_item(
        conn: &Connection,
        id: &str,
        source: &str,
        valid_to: Option<i64>,
        embedding: Option<&[f32]>,
        created_at: i64,
    ) {
        let blob: Option<Vec<u8>> =
            embedding.map(|v| v.iter().flat_map(|f| f.to_le_bytes()).collect());
        conn.execute(
            "INSERT INTO mem_items
           (id, title, snippet, source, kinds_json, created_at, embedding,
            provenance, valid_from, recorded_at, last_accessed_at, access_count, valid_to)
         VALUES (?1, 'T', 'S', ?2, '[]', ?3, ?4, 'screen', ?3, ?3, ?3, 0, ?5)",
            params![id, source, created_at, blob, valid_to],
        )
        .expect("seed mem_item");
    }

    fn seed_capture(
        conn: &Connection,
        captured_at: i64,
        ttl: i64,
        status: &str,
        raw_text: Option<&str>,
        raw_path: Option<&str>,
    ) -> i64 {
        conn.execute(
            "INSERT INTO mem_captures
           (type, raw_text, raw_path, captured_at, extraction_status, ttl_expires_at)
         VALUES ('screen_app', ?1, ?2, ?3, ?4, ?5)",
            params![raw_text, raw_path, captured_at, status, ttl],
        )
        .expect("seed capture");
        conn.last_insert_rowid()
    }

    // ── soft_retire dry-run ─────────────────────────────────────────────────
    #[test]
    fn dry_run_soft_retire_counts_only_legacy_capture_sources() {
        let conn = open_test_conn();
        seed_mem_item(&conn, "m_a", "capture_sampler", None, None, 1_000);
        seed_mem_item(&conn, "m_b", "capture_ax", None, None, 2_000);
        seed_mem_item(&conn, "m_c", "google_calendar", None, None, 3_000);
        seed_mem_item(&conn, "m_d", "extraction", None, None, 4_000);

        let report = run_dry_run(&conn, 5_000).expect("dry run");
        assert_eq!(report.soft_retire.matching_rows, 2);
        assert_eq!(report.soft_retire.oldest_created_at_ms, Some(1_000));
        assert_eq!(report.soft_retire.newest_created_at_ms, Some(2_000));
    }

    #[test]
    fn dry_run_soft_retire_already_retired_count_is_separate() {
        let conn = open_test_conn();
        seed_mem_item(&conn, "m_a", "capture_sampler", None, None, 1_000);
        seed_mem_item(&conn, "m_b", "capture_ax", Some(2_500), None, 2_000);
        let report = run_dry_run(&conn, 5_000).expect("dry run");
        assert_eq!(report.soft_retire.matching_rows, 2);
        assert_eq!(report.soft_retire.already_retired, 1);
    }

    #[test]
    fn dry_run_soft_retire_counts_embedding_blobs() {
        let conn = open_test_conn();
        seed_mem_item(
            &conn,
            "m_a",
            "capture_sampler",
            None,
            Some(&[0.1, 0.2]),
            1_000,
        );
        seed_mem_item(&conn, "m_b", "capture_ax", None, None, 2_000);
        let report = run_dry_run(&conn, 5_000).expect("dry run");
        assert_eq!(report.soft_retire.embedding_blob_count, 1);
    }

    // ── ttl_expired dry-run ─────────────────────────────────────────────────
    #[test]
    fn dry_run_ttl_block_counts_only_done_with_raw() {
        let conn = open_test_conn();
        let now = 100_000;
        seed_capture(
            &conn,
            1_000,
            now - 1,
            "done",
            Some("rawtext"),
            Some("/tmp/a"),
        );
        seed_capture(&conn, 1_500, now - 1, "done", None, None); // already cleaned → skipped
        seed_capture(&conn, 2_000, now - 1, "queued", Some("rawtext"), None); // not done → skipped
        seed_capture(&conn, 3_000, now + 100, "done", Some("rawtext"), None); // future ttl → skipped
        seed_capture(
            &conn,
            4_000,
            now - 1,
            "done",
            Some("rawtext"),
            Some("/tmp/b"),
        );

        let report = run_dry_run(&conn, now).expect("dry run");
        assert_eq!(report.ttl_expired.rows_with_raw_to_clean, 2);
        assert_eq!(report.ttl_expired.raw_path_files_to_unlink, 2);
        assert_eq!(report.ttl_expired.raw_text_rows_to_null, 2);
    }

    // ── physical_delete dry-run ─────────────────────────────────────────────
    #[test]
    fn dry_run_physical_delete_only_picks_rows_past_grace_window() {
        let conn = open_test_conn();
        let now = 31 * MS_PER_DAY;
        // Eligible: retired 31 days ago (cutoff = now - 30 days).
        seed_mem_item(&conn, "m_old", "capture_sampler", Some(0), None, 0);
        // Just retired (within grace) — not yet eligible.
        seed_mem_item(
            &conn,
            "m_recent",
            "capture_sampler",
            Some(now - 1),
            None,
            1_000,
        );
        // Active row — never eligible.
        seed_mem_item(&conn, "m_live", "capture_sampler", None, None, 1_000);
        // Non-legacy source — never eligible.
        seed_mem_item(&conn, "m_keep", "google_calendar", Some(0), None, 0);

        let report = run_dry_run(&conn, now).expect("dry run");
        assert_eq!(report.physical_delete.eligible_rows, 1);
    }

    #[test]
    fn dry_run_physical_delete_counts_cascading_edges() {
        let conn = open_test_conn();
        let now = 31 * MS_PER_DAY;
        seed_mem_item(&conn, "m_old", "capture_sampler", Some(0), None, 0);
        seed_mem_item(&conn, "m_other", "extraction", None, None, 0);
        conn.execute(
            "INSERT INTO mem_edges
           (from_node, to_node, edge_type, valid_from, recorded_at)
         VALUES ('m_old', 'm_other', 'mentions', 0, 0),
                ('m_other', 'm_old', 'mentions', 0, 0)",
            [],
        )
        .unwrap();
        let report = run_dry_run(&conn, now).expect("dry run");
        // Both edges touch the soon-to-delete m_old.
        assert_eq!(report.physical_delete.cascade_edges, 2);
    }

    // ── storage estimate ────────────────────────────────────────────────────
    #[test]
    fn dry_run_includes_db_size_estimate() {
        let conn = open_test_conn();
        seed_mem_item(&conn, "m_a", "capture_sampler", None, None, 1_000);
        let report = run_dry_run(&conn, 5_000).expect("dry run");
        // page_count × page_size > 0 once we've inserted a row.
        assert!(report.storage.db_size_before_bytes > 0);
    }

    // ── soft_retire_capture_rows ────────────────────────────────────────────
    #[test]
    fn soft_retire_marks_only_active_legacy_rows() {
        let conn = open_test_conn();
        seed_mem_item(&conn, "m_a", "capture_sampler", None, None, 1_000);
        seed_mem_item(&conn, "m_b", "capture_ax", None, None, 2_000);
        seed_mem_item(&conn, "m_c", "capture_sampler", Some(500), None, 3_000); // already retired
        seed_mem_item(&conn, "m_d", "google_calendar", None, None, 4_000); // non-legacy
        let n = soft_retire_capture_rows(&conn, 9_999).unwrap();
        assert_eq!(n, 2);
        let valid_to_a: Option<i64> = conn
            .query_row("SELECT valid_to FROM mem_items WHERE id = 'm_a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(valid_to_a, Some(9_999));
        let valid_to_d: Option<i64> = conn
            .query_row("SELECT valid_to FROM mem_items WHERE id = 'm_d'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(valid_to_d, None, "non-legacy source must stay active");
    }

    #[test]
    fn soft_retire_is_idempotent_after_first_run() {
        let conn = open_test_conn();
        seed_mem_item(&conn, "m_a", "capture_sampler", None, None, 1_000);
        soft_retire_capture_rows(&conn, 100).unwrap();
        let n2 = soft_retire_capture_rows(&conn, 200).unwrap();
        assert_eq!(n2, 0);
        let valid_to: Option<i64> = conn
            .query_row("SELECT valid_to FROM mem_items WHERE id = 'm_a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(valid_to, Some(100));
    }

    // ── cleanup_ttl_expired_captures ────────────────────────────────────────
    #[test]
    fn ttl_cleanup_marks_expired_and_nulls_raw() {
        let conn = open_test_conn();
        let now = 100_000;
        seed_capture(&conn, 1_000, now - 1, "done", Some("rawtext"), None);
        seed_capture(&conn, 2_000, now - 1, "done", None, None); // already nulled
        seed_capture(&conn, 3_000, now + 1, "done", Some("rawtext"), None); // future ttl

        let result = cleanup_ttl_expired_captures(&conn, now).unwrap();
        assert_eq!(result.rows_marked_expired, 1);
        assert_eq!(result.raw_text_nulled, 1);
        assert_eq!(result.raw_paths_unlinked, 0);

        let statuses: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT extraction_status FROM mem_captures ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .filter_map(|x| x.ok())
                .collect()
        };
        assert_eq!(statuses, vec!["expired", "done", "done"]);
    }

    #[test]
    fn ttl_cleanup_unlinks_files_when_they_exist() {
        let conn = open_test_conn();
        let now = 100_000;
        let dir = std::env::temp_dir();
        let path = dir.join(format!("kioku-stage5-test-{}.bin", std::process::id()));
        std::fs::write(&path, b"raw screenshot bytes").unwrap();
        seed_capture(
            &conn,
            1_000,
            now - 1,
            "done",
            None,
            Some(path.to_str().unwrap()),
        );
        let result = cleanup_ttl_expired_captures(&conn, now).unwrap();
        assert_eq!(result.raw_paths_unlinked, 1);
        assert!(!path.exists(), "raw_path file should be unlinked");
    }

    #[test]
    fn ttl_cleanup_handles_missing_files_gracefully() {
        let conn = open_test_conn();
        let now = 100_000;
        seed_capture(
            &conn,
            1_000,
            now - 1,
            "done",
            None,
            Some("/tmp/this-file-does-not-exist-kioku-stage5-test"),
        );
        let result = cleanup_ttl_expired_captures(&conn, now).unwrap();
        // Already-gone files count as unlinked so the row still moves to
        // 'expired'.
        assert_eq!(result.raw_paths_unlinked, 1);
    }

    // ── physical_delete_old_capture_rows ────────────────────────────────────
    #[test]
    fn physical_delete_drops_only_aged_legacy_rows() {
        let conn = open_test_conn();
        let now = 31 * MS_PER_DAY;
        seed_mem_item(&conn, "m_old", "capture_sampler", Some(0), None, 0); // eligible
        seed_mem_item(&conn, "m_recent", "capture_sampler", Some(now - 1), None, 0); // grace
        seed_mem_item(&conn, "m_active", "capture_sampler", None, None, 0); // active
        seed_mem_item(&conn, "m_keep", "google_calendar", Some(0), None, 0); // non-legacy

        let n = physical_delete_old_capture_rows(&conn, now).unwrap();
        assert_eq!(n, 1);
        let remaining: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM mem_items ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .filter_map(|x| x.ok())
                .collect()
        };
        assert_eq!(remaining, vec!["m_active", "m_keep", "m_recent"]);
    }

    #[test]
    fn physical_delete_cascades_into_mem_edges() {
        let conn = open_test_conn();
        let now = 31 * MS_PER_DAY;
        seed_mem_item(&conn, "m_old", "capture_sampler", Some(0), None, 0);
        seed_mem_item(&conn, "m_other", "extraction", None, None, 0);
        conn.execute(
            "INSERT INTO mem_edges
           (from_node, to_node, edge_type, valid_from, recorded_at)
         VALUES ('m_old', 'm_other', 'mentions', 0, 0)",
            [],
        )
        .unwrap();
        physical_delete_old_capture_rows(&conn, now).unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM mem_edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "ON DELETE CASCADE should clean up edges");
    }

    // ── vacuum_db ───────────────────────────────────────────────────────────
    #[test]
    fn vacuum_does_not_error_on_empty_db() {
        let conn = open_test_conn();
        vacuum_db(&conn).expect("vacuum ok");
    }
}
