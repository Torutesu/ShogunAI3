//! KIOKU `memory.db` backup helper.
//!
//! Uses SQLite's `VACUUM INTO 'path'` so the copy is consistent (handles WAL
//! correctly) and optimized (fresh page layout, free-pages reclaimed). Runs
//! while the app is live — `VACUUM INTO` only briefly serializes against the
//! main writer.
//!
//! Spec: `docs/memory-architecture/migration-plan.md` §Stage 5 (バックアップ
//! 推奨 UI を Stage 5 着手前に追加する).

#![allow(dead_code)]

use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Result returned from a backup. `bytes` is the size of the produced file
/// (read from the filesystem after `VACUUM INTO` completes), useful as a UI
/// confirmation that something actually got written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupResult {
    pub source_path: String,
    pub dest_path: String,
    pub bytes: u64,
    pub completed_at_ms: i64,
}

/// Produce the default backup filename in the same directory as the source
/// DB. Format: `memory.db.backup-YYYY-MM-DD-HHMMSS` (UTC). The
/// `pre-stage5-*` naming used by `migration-plan.md` §Stage 5 dry-run is a
/// caller-side override — operators can pass a custom dest before running
/// the actual stage5 apply.
pub fn default_backup_dest(source_db: &Path, now_ms: i64) -> PathBuf {
    use chrono::{TimeZone, Utc};
    let stamp = Utc
        .timestamp_millis_opt(now_ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d-%H%M%S").to_string())
        .unwrap_or_else(|| "00000000-000000".to_string());
    let dir = source_db
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let file_name = source_db
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "memory.db".to_string());
    dir.join(format!("{}.backup-{}", file_name, stamp))
}

/// Run `VACUUM INTO 'dest'` to produce a consistent, compacted copy of the
/// open database at `dest`. `dest` must not already exist (SQLite refuses to
/// overwrite). Returns metadata on success.
pub fn backup_db(
    conn: &Connection,
    source_db: &Path,
    dest: &Path,
    now_ms: i64,
) -> Result<BackupResult, String> {
    if dest.exists() {
        return Err(format!(
            "kioku_backup::backup_db: destination already exists ({}). \
       Pick a different path or remove the existing file first.",
            dest.display()
        ));
    }
    // Ensure parent dir exists so a fresh dest can be written.
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!(
                "kioku_backup::backup_db: parent directory does not exist ({}).",
                parent.display()
            ));
        }
    }

    // VACUUM INTO 'path' wants a SQL string literal — escape single quotes.
    let escaped = dest.to_string_lossy().replace('\'', "''");
    let sql = format!("VACUUM INTO '{}'", escaped);
    conn.execute_batch(&sql)
        .map_err(|e| format!("kioku_backup::backup_db: {}", e))?;

    let bytes = std::fs::metadata(dest)
        .map(|m| m.len())
        .map_err(|e| format!("kioku_backup::backup_db stat dest: {}", e))?;

    Ok(BackupResult {
        source_path: source_db.to_string_lossy().to_string(),
        dest_path: dest.to_string_lossy().to_string(),
        bytes,
        completed_at_ms: now_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_conn(path: &Path) -> Connection {
        let conn = Connection::open(path).expect("open");
        conn.execute_batch("PRAGMA journal_mode=WAL;").expect("WAL");
        conn.execute_batch(
            "CREATE TABLE mem_items (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL);
         INSERT INTO mem_items VALUES ('m_1', 'sample');",
        )
        .expect("seed");
        conn
    }

    fn tmp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "kioku-backup-test-{}-{}.db",
            std::process::id(),
            name
        ));
        p
    }

    // ── default_backup_dest ────────────────────────────────────────────────
    #[test]
    fn default_dest_appends_iso_timestamp_in_same_dir() {
        let src = PathBuf::from("/tmp/anywhere/memory.db");
        let dest = default_backup_dest(&src, 1_745_686_800_000);
        assert!(dest.starts_with("/tmp/anywhere/"));
        let name = dest.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("memory.db.backup-"), "got {}", name);
        assert!(
            name.contains("2025-04-26-"),
            "expected 2025-04-26 in {}",
            name
        );
    }

    #[test]
    fn default_dest_handles_invalid_now() {
        let src = PathBuf::from("/tmp/memory.db");
        let dest = default_backup_dest(&src, i64::MIN);
        let name = dest.file_name().unwrap().to_string_lossy();
        // Even with a malformed timestamp we still emit a deterministic suffix
        // so two parallel calls don't clobber each other.
        assert!(name.contains("backup-"));
    }

    #[test]
    fn default_dest_falls_back_to_cwd_for_root_path() {
        let src = PathBuf::from("memory.db");
        let dest = default_backup_dest(&src, 1_745_686_800_000);
        let name = dest.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("memory.db.backup-"), "got {}", name);
    }

    // ── backup_db ──────────────────────────────────────────────────────────
    #[test]
    fn backup_db_produces_a_readable_copy() {
        let src = tmp_path("source");
        let _ = std::fs::remove_file(&src);
        let conn = open_test_conn(&src);

        let dest = tmp_path("dest-readable");
        let _ = std::fs::remove_file(&dest);

        let r = backup_db(&conn, &src, &dest, 1_000).expect("backup ok");
        assert!(dest.exists());
        assert_eq!(r.dest_path, dest.to_string_lossy().to_string());
        assert!(r.bytes > 0);
        assert_eq!(r.completed_at_ms, 1_000);

        // Reopen the destination and confirm rows are intact.
        let copy = Connection::open(&dest).expect("reopen");
        let title: String = copy
            .query_row("SELECT title FROM mem_items WHERE id = 'm_1'", [], |row| {
                row.get(0)
            })
            .expect("row");
        assert_eq!(title, "sample");

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dest);
    }

    #[test]
    fn backup_db_refuses_to_overwrite_existing_dest() {
        let src = tmp_path("source-overwrite");
        let _ = std::fs::remove_file(&src);
        let conn = open_test_conn(&src);

        let dest = tmp_path("dest-overwrite");
        std::fs::write(&dest, b"already here").unwrap();

        let err = backup_db(&conn, &src, &dest, 1_000).expect_err("must error");
        assert!(err.contains("already exists"), "got {}", err);

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dest);
    }

    #[test]
    fn backup_db_rejects_nonexistent_parent_dir() {
        let src = tmp_path("source-noparent");
        let _ = std::fs::remove_file(&src);
        let conn = open_test_conn(&src);

        let dest = PathBuf::from("/this/path/should/not/exist/kioku-backup.db");
        let err = backup_db(&conn, &src, &dest, 1_000).expect_err("must error");
        assert!(
            err.contains("parent directory does not exist"),
            "got {}",
            err
        );

        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn backup_db_handles_destinations_with_apostrophes_in_path() {
        // SQLite's VACUUM INTO uses a quoted string literal; we escape ' as ''.
        let src = tmp_path("source-quoted");
        let _ = std::fs::remove_file(&src);
        let conn = open_test_conn(&src);

        let mut dest = std::env::temp_dir();
        dest.push(format!("kioku 'backup' {}.db", std::process::id()));
        let _ = std::fs::remove_file(&dest);

        let r = backup_db(&conn, &src, &dest, 1_000).expect("quoted path ok");
        assert!(r.bytes > 0);

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dest);
    }
}
