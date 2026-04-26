//! KIOKU decision graph + kioku hit assembly. Phase 2 Stage 2 (T6).
//!
//! Produces `DecisionGraphHit` and `KiokuHit` payloads that match the AMC
//! pipeline's Zod schemas (`hifi/amc-pipeline/src/schemas.js`) so the Node
//! orchestrator can consume them without a translation layer. The schemas.js
//! file is **not modified** — this module is the Rust-side producer.
//!
//! Spec: `docs/memory-architecture/migration-plan.md` §Stage 2.6,
//!       `docs/memory-architecture/target-design.md` §2.2 / §5.

#![allow(dead_code)]

use rusqlite::Connection;
#[cfg(test)]
use rusqlite::params;
use serde::{Deserialize, Serialize};

// ── DecisionGraphHit ───────────────────────────────────────────────────────

/// Mirror of `hifi/amc-pipeline/src/schemas.js::DecisionGraphHitSchema`.
/// `follow_ups_pending` is `Option` to preserve the schema's `.optional()`
/// behavior — we still emit it as a number when known.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct DecisionGraphHit {
  pub decision_id: String,
  pub summary: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub follow_ups_pending: Option<i64>,
}

/// Mirror of `KiokuHitSchema`. `last_touched` is an ISO date string;
/// `relevance_score` is in `[0, 1]`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct KiokuHit {
  pub doc_id: String,
  pub title: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub snippet: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub last_touched: Option<String>,
  pub relevance_score: f64,
}

// ── Fetchers (TDD red phase) ───────────────────────────────────────────────

/// Pull all current-valid `node_kind='decision'` nodes plus a count of
/// `follows_up` edges to current-valid `node_kind='task'` nodes. Returns at
/// most `limit` rows ordered by `last_accessed_at DESC` (most-recently-touched
/// decisions first). `limit == 0` is treated as "all rows".
pub fn fetch_decision_graph_hits(
  conn: &Connection,
  limit: usize,
) -> Result<Vec<DecisionGraphHit>, String> {
  // One query: decisions LEFT JOIN follows_up edges LEFT JOIN target tasks,
  // counting only the (edge active, target task active) combinations.
  let sql = "
    SELECT
      d.id,
      d.snippet,
      COALESCE(SUM(
        CASE
          WHEN e.id IS NOT NULL
            AND e.valid_to IS NULL
            AND t.id IS NOT NULL
            AND t.valid_to IS NULL
            AND t.node_kind = 'task'
          THEN 1
          ELSE 0
        END
      ), 0) AS pending_count
    FROM mem_items d
    LEFT JOIN mem_edges e
      ON e.from_node = d.id AND e.edge_type = 'follows_up'
    LEFT JOIN mem_items t
      ON t.id = e.to_node
    WHERE d.node_kind = 'decision' AND d.valid_to IS NULL
    GROUP BY d.id, d.snippet, d.last_accessed_at
    ORDER BY d.last_accessed_at DESC
  ";
  let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| {
      Ok(DecisionGraphHit {
        decision_id: r.get::<_, String>(0)?,
        summary: r.get::<_, String>(1)?,
        follow_ups_pending: Some(r.get::<_, i64>(2)?),
      })
    })
    .map_err(|e| e.to_string())?;
  let mut out: Vec<DecisionGraphHit> = rows.filter_map(|x| x.ok()).collect();
  if limit > 0 && out.len() > limit {
    out.truncate(limit);
  }
  Ok(out)
}

/// Pull recent current-valid nodes (excluding `capture_summary`) as
/// `KiokuHit` payloads. `relevance_score` is the node's `decay_score` when
/// available, otherwise a recency-only heuristic. Used by the AMC pipeline
/// to populate `MorningBriefCandidate.related_kioku_hits` when no explicit
/// query string is provided (Stage 2 fallback path).
pub fn fetch_recent_kioku_hits(
  conn: &Connection,
  limit: usize,
) -> Result<Vec<KiokuHit>, String> {
  let sql = "
    SELECT id, title, snippet, last_accessed_at, decay_score
    FROM mem_items
    WHERE valid_to IS NULL
      AND (node_kind IS NULL OR node_kind != 'capture_summary')
    ORDER BY last_accessed_at DESC
  ";
  let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| {
      let id: String = r.get(0)?;
      let title: String = r.get(1)?;
      let snippet: String = r.get(2)?;
      let last_acc: Option<i64> = r.get(3)?;
      let decay: Option<f64> = r.get(4)?;
      Ok((id, title, snippet, last_acc, decay))
    })
    .map_err(|e| e.to_string())?;
  let mut out: Vec<KiokuHit> = Vec::new();
  for row in rows {
    let (id, title, snippet, last_acc, decay) = row.map_err(|e| e.to_string())?;
    let snippet_opt = if snippet.trim().is_empty() {
      None
    } else {
      Some(snippet)
    };
    let last_touched = last_acc.map(format_iso_date_from_ms);
    let relevance_score = decay
      .map(|d| d.clamp(0.0, 1.0))
      .unwrap_or(0.5);
    out.push(KiokuHit {
      doc_id: id,
      title,
      snippet: snippet_opt,
      last_touched,
      relevance_score,
    });
    if limit > 0 && out.len() >= limit {
      break;
    }
  }
  Ok(out)
}

/// Format a millisecond timestamp as `YYYY-MM-DD` (UTC). Used for the
/// `KiokuHit.last_touched` field which the AMC schema documents as
/// "ISO-8601 date" — we emit just the date so the consumer doesn't have to
/// strip a time component.
fn format_iso_date_from_ms(ms: i64) -> String {
  use chrono::{TimeZone, Utc};
  Utc
    .timestamp_millis_opt(ms)
    .single()
    .map(|dt| dt.format("%Y-%m-%d").to_string())
    .unwrap_or_else(|| String::from("1970-01-01"))
}

#[cfg(test)]
mod tests {
  use super::*;

  // ── DecisionGraphHit JSON shape ────────────────────────────────────────
  #[test]
  fn decision_graph_hit_serializes_to_amc_schema_shape() {
    let h = DecisionGraphHit {
      decision_id: "m_dec_01".into(),
      summary: "Stage 1 schema landed".into(),
      follow_ups_pending: Some(2),
    };
    let v = serde_json::to_value(&h).unwrap();
    assert_eq!(v["decision_id"], serde_json::json!("m_dec_01"));
    assert_eq!(v["summary"], serde_json::json!("Stage 1 schema landed"));
    assert_eq!(v["follow_ups_pending"], serde_json::json!(2));
  }

  #[test]
  fn decision_graph_hit_omits_follow_ups_when_none() {
    let h = DecisionGraphHit {
      decision_id: "m_dec_01".into(),
      summary: "x".into(),
      follow_ups_pending: None,
    };
    let v = serde_json::to_value(&h).unwrap();
    assert!(v.get("follow_ups_pending").is_none());
  }

  #[test]
  fn kioku_hit_serializes_to_amc_schema_shape() {
    let h = KiokuHit {
      doc_id: "m_user_01".into(),
      title: "Idea: snippet clip default 500".into(),
      snippet: Some("Pack files leak AX dumps...".into()),
      last_touched: Some("2026-04-25".into()),
      relevance_score: 0.78,
    };
    let v = serde_json::to_value(&h).unwrap();
    assert_eq!(v["doc_id"], serde_json::json!("m_user_01"));
    assert_eq!(v["title"], serde_json::json!("Idea: snippet clip default 500"));
    assert_eq!(v["snippet"], serde_json::json!("Pack files leak AX dumps..."));
    assert_eq!(v["last_touched"], serde_json::json!("2026-04-25"));
    let rs = v["relevance_score"].as_f64().unwrap();
    assert!((rs - 0.78).abs() < 1e-9);
  }

  #[test]
  fn kioku_hit_omits_optional_fields_when_none() {
    let h = KiokuHit {
      doc_id: "m_1".into(),
      title: "T".into(),
      snippet: None,
      last_touched: None,
      relevance_score: 0.5,
    };
    let v = serde_json::to_value(&h).unwrap();
    assert!(v.get("snippet").is_none());
    assert!(v.get("last_touched").is_none());
  }

  // Test fixtures ───────────────────────────────────────────────────────
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

  fn seed_node(
    conn: &Connection,
    id: &str,
    title: &str,
    snippet: &str,
    node_kind: &str,
    valid_to: Option<i64>,
    created_at: i64,
  ) {
    conn
      .execute(
        "INSERT INTO mem_items
           (id, title, snippet, source, kinds_json, created_at,
            valid_from, recorded_at, last_accessed_at, access_count,
            node_kind, valid_to)
         VALUES (?1, ?2, ?3, 'extraction', '[]', ?4,
                 ?4, ?4, ?4, 0, ?5, ?6)",
        params![id, title, snippet, created_at, node_kind, valid_to],
      )
      .expect("seed node");
  }

  fn seed_edge(
    conn: &Connection,
    from: &str,
    to: &str,
    edge_type: &str,
    valid_to: Option<i64>,
    valid_from: i64,
  ) {
    conn
      .execute(
        "INSERT INTO mem_edges (from_node, to_node, edge_type, valid_from, recorded_at, valid_to)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![from, to, edge_type, valid_from, valid_to],
      )
      .expect("seed edge");
  }

  // ── fetch_decision_graph_hits ──────────────────────────────────────────
  #[test]
  fn fetch_decision_graph_hits_returns_empty_when_no_decisions() {
    let conn = open_test_conn();
    seed_node(&conn, "m_n_1", "X", "Y", "note", None, 1_000);
    let hits = fetch_decision_graph_hits(&conn, 10).expect("ok");
    assert!(hits.is_empty());
  }

  #[test]
  fn fetch_decision_graph_hits_returns_decisions_with_summary_from_snippet() {
    let conn = open_test_conn();
    seed_node(&conn, "m_dec_1", "Decision: ship Stage 1", "Stage 1 schema additions land in T1.", "decision", None, 1_000);
    let hits = fetch_decision_graph_hits(&conn, 10).expect("ok");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].decision_id, "m_dec_1");
    assert_eq!(hits[0].summary, "Stage 1 schema additions land in T1.");
  }

  #[test]
  fn fetch_decision_graph_hits_skips_superseded_decisions() {
    let conn = open_test_conn();
    seed_node(&conn, "m_dec_old", "old", "old summary", "decision", Some(1_500), 1_000);
    seed_node(&conn, "m_dec_new", "new", "new summary", "decision", None, 1_500);
    let hits = fetch_decision_graph_hits(&conn, 10).expect("ok");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].decision_id, "m_dec_new");
  }

  #[test]
  fn fetch_decision_graph_hits_counts_pending_follow_ups() {
    let conn = open_test_conn();
    seed_node(&conn, "m_dec_1", "Decision", "Plan Q2", "decision", None, 1_000);
    seed_node(&conn, "m_task_a", "Task A", "do A", "task", None, 1_100);
    seed_node(&conn, "m_task_b", "Task B", "do B", "task", None, 1_100);
    seed_node(&conn, "m_task_done", "Task C done", "done", "task", Some(1_300), 1_100);
    seed_edge(&conn, "m_dec_1", "m_task_a", "follows_up", None, 1_100);
    seed_edge(&conn, "m_dec_1", "m_task_b", "follows_up", None, 1_100);
    seed_edge(&conn, "m_dec_1", "m_task_done", "follows_up", None, 1_100);
    let hits = fetch_decision_graph_hits(&conn, 10).expect("ok");
    assert_eq!(hits.len(), 1);
    // Task C is superseded → only A and B count.
    assert_eq!(hits[0].follow_ups_pending, Some(2));
  }

  #[test]
  fn fetch_decision_graph_hits_excludes_retired_edges() {
    let conn = open_test_conn();
    seed_node(&conn, "m_dec_1", "D", "summary", "decision", None, 1_000);
    seed_node(&conn, "m_task_a", "A", "do A", "task", None, 1_100);
    // Edge was valid but is now retired (valid_to set).
    seed_edge(&conn, "m_dec_1", "m_task_a", "follows_up", Some(1_400), 1_100);
    let hits = fetch_decision_graph_hits(&conn, 10).expect("ok");
    assert_eq!(hits[0].follow_ups_pending, Some(0));
  }

  #[test]
  fn fetch_decision_graph_hits_ignores_non_task_targets() {
    let conn = open_test_conn();
    seed_node(&conn, "m_dec_1", "D", "summary", "decision", None, 1_000);
    seed_node(&conn, "m_evt_1", "Event", "x", "event", None, 1_100);
    seed_edge(&conn, "m_dec_1", "m_evt_1", "follows_up", None, 1_100);
    let hits = fetch_decision_graph_hits(&conn, 10).expect("ok");
    assert_eq!(hits[0].follow_ups_pending, Some(0));
  }

  #[test]
  fn fetch_decision_graph_hits_respects_limit() {
    let conn = open_test_conn();
    for i in 0..5 {
      seed_node(&conn, &format!("m_dec_{}", i), "D", "s", "decision", None, 1_000 + i);
    }
    let hits = fetch_decision_graph_hits(&conn, 3).expect("ok");
    assert_eq!(hits.len(), 3);
  }

  #[test]
  fn fetch_decision_graph_hits_orders_by_last_accessed_desc() {
    let conn = open_test_conn();
    // Create 3 decisions with different last_accessed_at.
    seed_node(&conn, "m_dec_a", "A", "first", "decision", None, 1_000);
    seed_node(&conn, "m_dec_b", "B", "second", "decision", None, 2_000);
    seed_node(&conn, "m_dec_c", "C", "third", "decision", None, 3_000);
    let hits = fetch_decision_graph_hits(&conn, 10).expect("ok");
    assert_eq!(hits[0].decision_id, "m_dec_c");
    assert_eq!(hits[1].decision_id, "m_dec_b");
    assert_eq!(hits[2].decision_id, "m_dec_a");
  }

  // ── fetch_recent_kioku_hits ────────────────────────────────────────────
  #[test]
  fn fetch_recent_kioku_hits_returns_empty_for_empty_db() {
    let conn = open_test_conn();
    let hits = fetch_recent_kioku_hits(&conn, 10).expect("ok");
    assert!(hits.is_empty());
  }

  #[test]
  fn fetch_recent_kioku_hits_skips_capture_summary_and_retired() {
    let conn = open_test_conn();
    seed_node(&conn, "m_cap_1", "screen sample", "x", "capture_summary", None, 1_000);
    seed_node(&conn, "m_old_1", "old note", "x", "note", Some(1_500), 1_000);
    seed_node(&conn, "m_note_1", "fresh note", "y", "note", None, 2_000);
    let hits = fetch_recent_kioku_hits(&conn, 10).expect("ok");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].doc_id, "m_note_1");
  }

  #[test]
  fn fetch_recent_kioku_hits_orders_by_last_accessed_desc() {
    let conn = open_test_conn();
    seed_node(&conn, "m_a", "A", "x", "note", None, 1_000);
    seed_node(&conn, "m_b", "B", "y", "note", None, 3_000);
    seed_node(&conn, "m_c", "C", "z", "note", None, 2_000);
    let hits = fetch_recent_kioku_hits(&conn, 10).expect("ok");
    assert_eq!(hits[0].doc_id, "m_b");
    assert_eq!(hits[1].doc_id, "m_c");
    assert_eq!(hits[2].doc_id, "m_a");
  }

  #[test]
  fn fetch_recent_kioku_hits_clamps_relevance_to_unit_interval() {
    let conn = open_test_conn();
    seed_node(&conn, "m_a", "A", "x", "note", None, 1_000);
    let hits = fetch_recent_kioku_hits(&conn, 10).expect("ok");
    assert!(hits[0].relevance_score >= 0.0 && hits[0].relevance_score <= 1.0);
  }

  #[test]
  fn fetch_recent_kioku_hits_respects_limit() {
    let conn = open_test_conn();
    for i in 0..5 {
      seed_node(&conn, &format!("m_n_{}", i), "T", "S", "note", None, 1_000 + i);
    }
    let hits = fetch_recent_kioku_hits(&conn, 3).expect("ok");
    assert_eq!(hits.len(), 3);
  }
}
