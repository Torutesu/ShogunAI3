//! Persistent last-success timestamps for interval batch jobs (audit F-10).
//!
//! `patterns_sync` / `supersession_sync` kept their "last run" only in an
//! in-memory `Mutex`, so on every process restart the 24h / 30-day elapsed-gate
//! saw `None` and re-fired the job. For `supersession` — which calls the LLM
//! judge over up to 1000 rules — that meant re-spending BYOK budget on every
//! boot. Persisting the last success to the DB makes the gate track wall-clock
//! time across restarts.

use rusqlite::{params, Connection};

/// Job-name keys. Keep stable — they are the primary key in `job_runs`.
pub const JOB_SUPERSESSION: &str = "supersession";
pub const JOB_PATTERNS: &str = "patterns";

fn ensure(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS job_runs (
           job_name        TEXT PRIMARY KEY NOT NULL,
           last_success_at INTEGER NOT NULL
         )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the last successful run time for `job` on the given connection.
pub fn last_success_ms_conn(conn: &Connection, job: &str) -> Option<i64> {
    ensure(conn).ok()?;
    conn.query_row(
        "SELECT last_success_at FROM job_runs WHERE job_name = ?1",
        params![job],
        |r| r.get::<_, i64>(0),
    )
    .ok()
}

/// Persist `job`'s last successful run time on the given connection.
pub fn mark_success_conn(conn: &Connection, job: &str, ts_ms: i64) -> Result<(), String> {
    ensure(conn)?;
    conn.execute(
        "INSERT INTO job_runs (job_name, last_success_at) VALUES (?1, ?2)
         ON CONFLICT(job_name) DO UPDATE SET last_success_at = excluded.last_success_at",
        params![job, ts_ms],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Convenience wrapper opening its own connection. Returns `None` on any DB
/// error so callers can treat "unknown" as "never ran".
pub fn last_success_ms(job: &str) -> Option<i64> {
    let conn = crate::memory_store::open_conn().ok()?;
    last_success_ms_conn(&conn, job)
}

/// Best-effort persist; a DB failure is logged, never propagated.
pub fn mark_success(job: &str, ts_ms: i64) {
    match crate::memory_store::open_conn() {
        Ok(conn) => {
            if let Err(e) = mark_success_conn(&conn, job, ts_ms) {
                log::warn!("job_runs: failed to persist {} success: {}", job, e);
            }
        }
        Err(e) => log::warn!("job_runs: open_conn failed for {}: {}", job, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        Connection::open_in_memory().expect("open in-memory")
    }

    #[test]
    fn unknown_job_reads_none() {
        let c = conn();
        assert_eq!(last_success_ms_conn(&c, JOB_SUPERSESSION), None);
    }

    #[test]
    fn mark_then_read_roundtrips_and_survives_a_new_connection_view() {
        let c = conn();
        mark_success_conn(&c, JOB_SUPERSESSION, 12_345).expect("mark");
        assert_eq!(last_success_ms_conn(&c, JOB_SUPERSESSION), Some(12_345));
        // A different job is still unknown.
        assert_eq!(last_success_ms_conn(&c, JOB_PATTERNS), None);
        // Upsert overwrites.
        mark_success_conn(&c, JOB_SUPERSESSION, 99_999).expect("update");
        assert_eq!(last_success_ms_conn(&c, JOB_SUPERSESSION), Some(99_999));
    }
}
