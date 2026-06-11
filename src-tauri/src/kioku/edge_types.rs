//! `edge_type` taxonomy + proposal tracking. Phase 2 Stage 4 prep.
//!
//! `mem_edges.edge_type` is intentionally a free-form string in Stage 2 so the
//! extraction agent can name new relations as it discovers them. To prevent
//! the value space from sprawling, every edge written by the worker emits a
//! row into `edge_type_proposals` (incrementing `seen_count` on existing
//! entries). At Stage 4 GA the human reviewer marks each proposal as
//! `reviewed = 1` (accept) or `reviewed = 2` (reject); accepted types make it
//! into the `CHECK` constraint added to `mem_edges` in a follow-up migration.
//!
//! Spec: `docs/memory-architecture/migration-plan.md` §Stage 4.

#![allow(dead_code)]

use rusqlite::{params, Connection};
use serde::Serialize;

/// Canonical edge_type set documented in `docs/kioku-edge-types.md`. New
/// proposals are checked against this list; matching ones are auto-accepted
/// (`reviewed = 1`) on first sight so the review queue stays focused on the
/// genuinely new edges the agent invented.
pub const CANONICAL_EDGE_TYPES: &[&str] = &[
  "decided_in",     // task / commitment lives in a decision
  "follows_up",     // decision → subsequent task
  "mentions",       // note / capture summary → entity / event
  "attended",       // person → event
  "blocks",         // task A blocks task B
  "derives_from",   // extracted node → its source capture
  "co_occurs_with", // calendar event ↔ meeting recording
  "supersedes",     // newer node retires older (matched valid_to)
];

/// Review status: 0 unreviewed, 1 accepted, 2 rejected.
pub const REVIEW_UNREVIEWED: i64 = 0;
pub const REVIEW_ACCEPTED: i64 = 1;
pub const REVIEW_REJECTED: i64 = 2;

/// One proposal row enriched for the review UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProposalRow {
  pub edge_type: String,
  pub first_seen_at: i64,
  pub last_seen_at: i64,
  pub seen_count: i64,
  pub reviewed: i64,
  pub reviewer_note: Option<String>,
  pub canonical: bool,
}

/// True when `edge_type` is in the canonical list.
pub fn is_canonical(edge_type: &str) -> bool {
  CANONICAL_EDGE_TYPES.contains(&edge_type)
}

/// Insert-or-bump a proposal. Canonical types are recorded with
/// `reviewed = REVIEW_ACCEPTED` so the review UI shows them as "already in".
/// `now_ms` is supplied by the caller so tests stay deterministic.
pub fn record_proposal(
  conn: &Connection,
  edge_type: &str,
  now_ms: i64,
) -> Result<(), String> {
  let edge_type = edge_type.trim();
  if edge_type.is_empty() {
    return Ok(());
  }
  // Pre-set `reviewed` only on first insert; subsequent bumps must not
  // overwrite a human review decision.
  let initial_reviewed = if is_canonical(edge_type) {
    REVIEW_ACCEPTED
  } else {
    REVIEW_UNREVIEWED
  };
  conn
    .execute(
      "INSERT INTO edge_type_proposals
         (edge_type, first_seen_at, last_seen_at, seen_count, reviewed)
       VALUES (?1, ?2, ?2, 1, ?3)
       ON CONFLICT(edge_type) DO UPDATE
         SET last_seen_at = excluded.last_seen_at,
             seen_count = seen_count + 1",
      params![edge_type, now_ms, initial_reviewed],
    )
    .map_err(|e| format!("kioku_edge_types::record_proposal: {}", e))?;
  Ok(())
}

/// List proposals for the review UI. `only_unreviewed = true` filters to
/// reviewed = 0; otherwise returns everything. `limit = 0` ⇒ no cap.
pub fn list_proposals(
  conn: &Connection,
  only_unreviewed: bool,
  limit: usize,
) -> Result<Vec<ProposalRow>, String> {
  let where_clause = if only_unreviewed {
    "WHERE reviewed = 0"
  } else {
    ""
  };
  let limit_clause = if limit > 0 {
    format!("LIMIT {}", limit as i64)
  } else {
    String::new()
  };
  let sql = format!(
    "SELECT edge_type, first_seen_at, last_seen_at, seen_count, reviewed, reviewer_note
     FROM edge_type_proposals
     {where_clause}
     ORDER BY seen_count DESC, last_seen_at DESC
     {limit_clause}"
  );
  let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| {
      let edge_type: String = r.get(0)?;
      let first_seen_at: i64 = r.get(1)?;
      let last_seen_at: i64 = r.get(2)?;
      let seen_count: i64 = r.get(3)?;
      let reviewed: i64 = r.get(4)?;
      let reviewer_note: Option<String> = r.get(5)?;
      let canonical = is_canonical(&edge_type);
      Ok(ProposalRow {
        edge_type,
        first_seen_at,
        last_seen_at,
        seen_count,
        reviewed,
        reviewer_note,
        canonical,
      })
    })
    .map_err(|e| e.to_string())?;
  Ok(rows.filter_map(|x| x.ok()).collect())
}

/// Stamp a review decision on an existing proposal. Returns the number of
/// rows updated (0 means the edge_type isn't in the table yet).
pub fn set_review_status(
  conn: &Connection,
  edge_type: &str,
  status: i64,
  note: Option<&str>,
) -> Result<usize, String> {
  if status != REVIEW_UNREVIEWED && status != REVIEW_ACCEPTED && status != REVIEW_REJECTED {
    return Err(format!(
      "kioku_edge_types::set_review_status: invalid status {} (expected 0|1|2)",
      status
    ));
  }
  let n = conn
    .execute(
      "UPDATE edge_type_proposals
         SET reviewed = ?1, reviewer_note = ?2
       WHERE edge_type = ?3",
      params![status, note, edge_type],
    )
    .map_err(|e| format!("kioku_edge_types::set_review_status: {}", e))?;
  Ok(n)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn open_test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch("PRAGMA foreign_keys=ON;").expect("FK");
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
      .expect("phase1");
    crate::kioku_graph_schema::ensure_kioku_graph_schema(&conn).expect("phase2");
    conn
  }

  // ── is_canonical ────────────────────────────────────────────────────────
  #[test]
  fn canonical_set_includes_documented_types() {
    for et in [
      "decided_in",
      "follows_up",
      "mentions",
      "attended",
      "blocks",
      "derives_from",
      "co_occurs_with",
      "supersedes",
    ] {
      assert!(is_canonical(et), "{} should be canonical", et);
    }
  }

  #[test]
  fn unknown_type_is_not_canonical() {
    assert!(!is_canonical("totally_new_edge"));
    assert!(!is_canonical(""));
    assert!(!is_canonical("Mentions")); // case-sensitive on purpose
  }

  // ── record_proposal ─────────────────────────────────────────────────────
  #[test]
  fn record_proposal_inserts_new_row_with_canonical_reviewed_flag() {
    let conn = open_test_conn();
    record_proposal(&conn, "mentions", 1_000).unwrap();
    let row: (i64, i64, i64) = conn
      .query_row(
        "SELECT seen_count, reviewed, first_seen_at FROM edge_type_proposals WHERE edge_type = 'mentions'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
      )
      .unwrap();
    assert_eq!(row.0, 1);
    assert_eq!(row.1, REVIEW_ACCEPTED);
    assert_eq!(row.2, 1_000);
  }

  #[test]
  fn record_proposal_inserts_new_type_unreviewed() {
    let conn = open_test_conn();
    record_proposal(&conn, "discusses", 1_000).unwrap();
    let reviewed: i64 = conn
      .query_row(
        "SELECT reviewed FROM edge_type_proposals WHERE edge_type = 'discusses'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(reviewed, REVIEW_UNREVIEWED);
  }

  #[test]
  fn record_proposal_increments_seen_count_and_updates_last_seen() {
    let conn = open_test_conn();
    record_proposal(&conn, "discusses", 1_000).unwrap();
    record_proposal(&conn, "discusses", 2_000).unwrap();
    record_proposal(&conn, "discusses", 3_000).unwrap();
    let row: (i64, i64, i64) = conn
      .query_row(
        "SELECT seen_count, first_seen_at, last_seen_at FROM edge_type_proposals WHERE edge_type = 'discusses'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
      )
      .unwrap();
    assert_eq!(row.0, 3);
    assert_eq!(row.1, 1_000, "first_seen_at must not change after the initial insert");
    assert_eq!(row.2, 3_000);
  }

  #[test]
  fn record_proposal_does_not_overwrite_human_review_decision() {
    let conn = open_test_conn();
    record_proposal(&conn, "discusses", 1_000).unwrap();
    set_review_status(&conn, "discusses", REVIEW_REJECTED, Some("too vague")).unwrap();
    record_proposal(&conn, "discusses", 2_000).unwrap();
    let row: (i64, Option<String>) = conn
      .query_row(
        "SELECT reviewed, reviewer_note FROM edge_type_proposals WHERE edge_type = 'discusses'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
      )
      .unwrap();
    assert_eq!(row.0, REVIEW_REJECTED, "human decision must persist across re-sightings");
    assert_eq!(row.1.as_deref(), Some("too vague"));
  }

  #[test]
  fn record_proposal_skips_empty_or_whitespace() {
    let conn = open_test_conn();
    record_proposal(&conn, "", 1_000).unwrap();
    record_proposal(&conn, "   ", 1_000).unwrap();
    let count: i64 = conn
      .query_row("SELECT COUNT(*) FROM edge_type_proposals", [], |r| r.get(0))
      .unwrap();
    assert_eq!(count, 0);
  }

  #[test]
  fn record_proposal_trims_whitespace() {
    let conn = open_test_conn();
    record_proposal(&conn, "  blocks  ", 1_000).unwrap();
    let edge_type: String = conn
      .query_row("SELECT edge_type FROM edge_type_proposals LIMIT 1", [], |r| r.get(0))
      .unwrap();
    assert_eq!(edge_type, "blocks");
  }

  // ── list_proposals ──────────────────────────────────────────────────────
  #[test]
  fn list_proposals_returns_empty_for_empty_table() {
    let conn = open_test_conn();
    let rows = list_proposals(&conn, false, 0).unwrap();
    assert!(rows.is_empty());
  }

  #[test]
  fn list_proposals_orders_by_seen_count_desc_then_last_seen() {
    let conn = open_test_conn();
    record_proposal(&conn, "rare_a", 1_000).unwrap();
    record_proposal(&conn, "common", 1_500).unwrap();
    record_proposal(&conn, "common", 2_500).unwrap();
    record_proposal(&conn, "common", 3_500).unwrap();
    record_proposal(&conn, "rare_b", 4_000).unwrap();

    let rows = list_proposals(&conn, false, 0).unwrap();
    assert_eq!(rows[0].edge_type, "common");
    assert_eq!(rows[0].seen_count, 3);
    // rare_a (count 1, last 1000) vs rare_b (count 1, last 4000) → rare_b wins on tie-break.
    assert_eq!(rows[1].edge_type, "rare_b");
    assert_eq!(rows[2].edge_type, "rare_a");
  }

  #[test]
  fn list_proposals_only_unreviewed_skips_canonical_and_judged() {
    let conn = open_test_conn();
    record_proposal(&conn, "mentions", 1_000).unwrap(); // canonical → auto-accepted
    record_proposal(&conn, "discusses", 1_000).unwrap();
    record_proposal(&conn, "spans_meetings", 1_000).unwrap();
    set_review_status(&conn, "discusses", REVIEW_REJECTED, None).unwrap();

    let rows = list_proposals(&conn, true, 0).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].edge_type, "spans_meetings");
  }

  #[test]
  fn list_proposals_marks_canonical_flag() {
    let conn = open_test_conn();
    record_proposal(&conn, "mentions", 1_000).unwrap();
    record_proposal(&conn, "discusses", 1_000).unwrap();
    let rows = list_proposals(&conn, false, 0).unwrap();
    let mentions = rows.iter().find(|r| r.edge_type == "mentions").unwrap();
    let discusses = rows.iter().find(|r| r.edge_type == "discusses").unwrap();
    assert!(mentions.canonical);
    assert!(!discusses.canonical);
  }

  #[test]
  fn list_proposals_respects_limit() {
    let conn = open_test_conn();
    for i in 0..5 {
      record_proposal(&conn, &format!("type_{}", i), 1_000 + i).unwrap();
    }
    let rows = list_proposals(&conn, false, 3).unwrap();
    assert_eq!(rows.len(), 3);
  }

  // ── set_review_status ───────────────────────────────────────────────────
  #[test]
  fn set_review_accepts_with_optional_note() {
    let conn = open_test_conn();
    record_proposal(&conn, "discusses", 1_000).unwrap();
    let n = set_review_status(&conn, "discusses", REVIEW_ACCEPTED, Some("matches AMC schema")).unwrap();
    assert_eq!(n, 1);
    let row: (i64, Option<String>) = conn
      .query_row(
        "SELECT reviewed, reviewer_note FROM edge_type_proposals WHERE edge_type = 'discusses'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
      )
      .unwrap();
    assert_eq!(row.0, REVIEW_ACCEPTED);
    assert_eq!(row.1.as_deref(), Some("matches AMC schema"));
  }

  #[test]
  fn set_review_status_returns_zero_for_unknown_edge_type() {
    let conn = open_test_conn();
    let n = set_review_status(&conn, "phantom", REVIEW_ACCEPTED, None).unwrap();
    assert_eq!(n, 0);
  }

  #[test]
  fn set_review_status_rejects_invalid_status() {
    let conn = open_test_conn();
    record_proposal(&conn, "discusses", 1_000).unwrap();
    let err = set_review_status(&conn, "discusses", 7, None).expect_err("invalid status");
    assert!(err.contains("invalid status"), "got: {}", err);
  }
}
