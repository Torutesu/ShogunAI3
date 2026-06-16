//! Debug observability for the KIOKU graph layer. Phase 2 Stage 3 (T8 polish).
//!
//! Returns one consolidated snapshot to the dev `Memory Debugger` so the UI
//! can render queue depth, monthly cost, graph counts, and active flags
//! without N IPC round-trips.
//!
//! Spec: PR follow-up to `target-design.md` §5 (observability).

#![allow(dead_code)]

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct QueueStats {
  pub captures_pending: i64,
  pub captures_running: i64,
  pub captures_done: i64,
  pub captures_failed: i64,
  pub captures_expired: i64,
  pub captures_skipped: i64,
  pub jobs_queued: i64,
  pub jobs_running: i64,
  pub jobs_done: i64,
  pub jobs_failed: i64,
  pub jobs_expired: i64,
  pub oldest_pending_capture_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CostStats {
  pub month_start_ms: i64,
  pub spent_usd: f64,
  pub monthly_cap_usd: f64,
  pub cap_action: String,
  pub fallback_model: String,
  pub extraction_model: String,
  pub status: String, // "Proceed" | "ProceedWithFallback" | "Pause"
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GraphStats {
  pub mem_items_total: i64,
  pub mem_items_active: i64,
  pub mem_items_retired: i64,
  pub edges_total: i64,
  pub edges_active: i64,
  pub captures_total: i64,
  pub by_node_kind: Vec<NodeKindCount>,
  pub by_edge_type: Vec<EdgeTypeCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NodeKindCount {
  pub kind: String,
  pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EdgeTypeCount {
  pub edge_type: String,
  pub count: i64,
}

// ── Helpers ────────────────────────────────────────────────────────────────

pub fn query_queue_stats(conn: &Connection) -> Result<QueueStats, String> {
  // mem_captures by status
  let mut stmt = conn
    .prepare("SELECT extraction_status, COUNT(*) FROM mem_captures GROUP BY extraction_status")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
    .map_err(|e| e.to_string())?;
  let mut s = QueueStats::default();
  for row in rows {
    let (status, count) = row.map_err(|e| e.to_string())?;
    match status.as_str() {
      "queued" => s.captures_pending = count,
      "running" => s.captures_running = count,
      "done" => s.captures_done = count,
      "failed" => s.captures_failed = count,
      "expired" => s.captures_expired = count,
      "skipped" => s.captures_skipped = count,
      _ => {}
    }
  }
  drop(stmt);

  // extraction_jobs by status
  let mut stmt = conn
    .prepare("SELECT status, COUNT(*) FROM extraction_jobs GROUP BY status")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
    .map_err(|e| e.to_string())?;
  for row in rows {
    let (status, count) = row.map_err(|e| e.to_string())?;
    match status.as_str() {
      "queued" => s.jobs_queued = count,
      "running" => s.jobs_running = count,
      "done" => s.jobs_done = count,
      "failed" => s.jobs_failed = count,
      "expired" => s.jobs_expired = count,
      _ => {}
    }
  }
  drop(stmt);

  // Oldest pending capture (queued/failed considered pending for triage)
  s.oldest_pending_capture_ms = conn
    .query_row(
      "SELECT MIN(captured_at) FROM mem_captures
       WHERE extraction_status IN ('queued', 'failed')",
      [],
      |r| r.get::<_, Option<i64>>(0),
    )
    .map_err(|e| e.to_string())?;

  Ok(s)
}

pub fn query_cost_stats(
  conn: &Connection,
  settings: &Value,
  now_ms: i64,
) -> Result<CostStats, String> {
  let month_start = crate::cost_ledger::month_start_ms_utc(now_ms);
  let spent = crate::cost_ledger::sum_cost_in_window(conn, month_start, now_ms.saturating_add(1))?;

  let monthly_cap_usd = settings
    .pointer("/sections/kioku_cost/monthly_cap_usd")
    .and_then(|v| v.as_f64())
    .unwrap_or(crate::cost_ledger::DEFAULT_MONTHLY_CAP_USD);
  let cap_action = settings
    .pointer("/sections/kioku_cost/cap_action")
    .and_then(|v| v.as_str())
    .unwrap_or(crate::cost_ledger::CAP_ACTION_PAUSE_EXTRACTION)
    .to_string();
  let fallback_model = settings
    .pointer("/sections/kioku_cost/fallback_model")
    .and_then(|v| v.as_str())
    .unwrap_or("claude-haiku-4-5")
    .to_string();
  let extraction_model = settings
    .pointer("/sections/llm/extractionModel")
    .and_then(|v| v.as_str())
    .unwrap_or("claude-haiku-4-5")
    .to_string();

  let status = match crate::cost_ledger::evaluate_cap_status(
    spent,
    monthly_cap_usd,
    &cap_action,
    Some(&fallback_model),
  ) {
    crate::cost_ledger::CapStatus::Proceed => "Proceed",
    crate::cost_ledger::CapStatus::ProceedWithFallback { .. } => "ProceedWithFallback",
    crate::cost_ledger::CapStatus::Pause { .. } => "Pause",
  };

  Ok(CostStats {
    month_start_ms: month_start,
    spent_usd: spent,
    monthly_cap_usd,
    cap_action,
    fallback_model,
    extraction_model,
    status: status.to_string(),
  })
}

pub fn query_graph_stats(conn: &Connection) -> Result<GraphStats, String> {
  let mut s = GraphStats::default();

  // mem_items totals
  s.mem_items_total = conn
    .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
    .map_err(|e| e.to_string())?;
  s.mem_items_active = conn
    .query_row("SELECT COUNT(*) FROM mem_items WHERE valid_to IS NULL", [], |r| r.get(0))
    .map_err(|e| e.to_string())?;
  s.mem_items_retired = s.mem_items_total - s.mem_items_active;

  // node_kind grouping (active only — retired kinds not interesting for ops)
  let mut stmt = conn
    .prepare(
      "SELECT COALESCE(node_kind, '(unset)'), COUNT(*)
       FROM mem_items WHERE valid_to IS NULL
       GROUP BY COALESCE(node_kind, '(unset)')
       ORDER BY COUNT(*) DESC",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| Ok(NodeKindCount { kind: r.get(0)?, count: r.get(1)? }))
    .map_err(|e| e.to_string())?;
  s.by_node_kind = rows.filter_map(|x| x.ok()).collect();
  drop(stmt);

  // edges totals
  s.edges_total = conn
    .query_row("SELECT COUNT(*) FROM mem_edges", [], |r| r.get(0))
    .map_err(|e| e.to_string())?;
  s.edges_active = conn
    .query_row("SELECT COUNT(*) FROM mem_edges WHERE valid_to IS NULL", [], |r| r.get(0))
    .map_err(|e| e.to_string())?;

  // edge_type grouping (active only)
  let mut stmt = conn
    .prepare(
      "SELECT edge_type, COUNT(*) FROM mem_edges
       WHERE valid_to IS NULL
       GROUP BY edge_type
       ORDER BY COUNT(*) DESC",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| Ok(EdgeTypeCount { edge_type: r.get(0)?, count: r.get(1)? }))
    .map_err(|e| e.to_string())?;
  s.by_edge_type = rows.filter_map(|x| x.ok()).collect();
  drop(stmt);

  s.captures_total = conn
    .query_row("SELECT COUNT(*) FROM mem_captures", [], |r| r.get(0))
    .map_err(|e| e.to_string())?;

  Ok(s)
}

/// Consolidated payload used by the Tauri command + UI tab. Serializes to a
/// JSON object so the UI doesn't depend on individual stat field names.
pub fn assemble_debug_stats(
  conn: &Connection,
  settings: &Value,
  now_ms: i64,
) -> Result<Value, String> {
  let queue = query_queue_stats(conn)?;
  let cost = query_cost_stats(conn, settings, now_ms)?;
  let graph = query_graph_stats(conn)?;
  let rules = crate::kioku_rules::cached_rules_or_load();
  let rules_summary = json!({
    "count": rules.len(),
    "titles": rules.iter().map(|r| r.title.clone()).collect::<Vec<_>>(),
  });

  let flags = json!({
    "read_path": crate::context_assembly::read_path_mode(settings),
    "capture_to_mem_captures": crate::kioku_capture::capture_to_mem_captures_flag(settings),
    "worker_enabled": settings
      .pointer("/sections/kioku_graph/worker_enabled")
      .and_then(|v| v.as_bool())
      .unwrap_or(false),
    "meeting_extraction_enabled": crate::meeting_kioku::meeting_extraction_enabled(),
  });
  let meeting_captures: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM mem_captures WHERE type = 'audio_chunk' AND url LIKE 'meeting://%'",
      [],
      |r| r.get(0),
    )
    .unwrap_or(0);

  let jobs_terminal = queue.jobs_done.saturating_add(queue.jobs_failed);
  let job_completion_rate = if jobs_terminal > 0 {
    Some(queue.jobs_done as f64 / jobs_terminal as f64)
  } else {
    None
  };
  let edge_density = if graph.mem_items_active > 0 {
    graph.edges_active as f64 / graph.mem_items_active as f64
  } else {
    0.0
  };
  let failed_billing_jobs = crate::kioku::extraction::count_failed_billing_jobs(conn).unwrap_or(0);

  Ok(json!({
    "queue": queue,
    "cost": cost,
    "graph": graph,
    "rules": rules_summary,
    "flags": flags,
    "summary": {
      "jobs_queued": queue.jobs_queued,
      "jobs_running": queue.jobs_running,
      "jobs_done": queue.jobs_done,
      "jobs_failed": queue.jobs_failed,
      "job_completion_rate": job_completion_rate,
      "edges_active": graph.edges_active,
      "mem_items_active": graph.mem_items_active,
      "edge_density": edge_density,
      "failed_billing_jobs": failed_billing_jobs,
      "extraction_paused": failed_billing_jobs > 0 || cost.status == "Pause",
    },
    "meeting_pipeline": {
      "captures": meeting_captures,
    },
    "now_ms": now_ms,
  }))
}

#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::params;

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

  fn seed_capture(conn: &Connection, status: &str, captured_at: i64) -> i64 {
    let id = crate::mem_captures::record(
      &crate::mem_captures::CaptureInput {
        kind: "screen_app".into(),
        captured_at_ms: captured_at,
        ..Default::default()
      },
      conn,
    )
    .expect("seed capture");
    if status != "queued" {
      conn
        .execute(
          "UPDATE mem_captures SET extraction_status = ?1 WHERE id = ?2",
          params![status, id],
        )
        .unwrap();
    }
    id
  }

  fn seed_job(conn: &Connection, capture_id: Option<i64>, status: &str, created_at: i64) -> i64 {
    let id = crate::extraction_jobs::enqueue(
      capture_id,
      crate::extraction_jobs::JOB_KIND_EXTRACT,
      created_at,
      None,
      conn,
    )
    .or_else(|_| {
      // For 'summarize' shape we'd skip the FK requirement; tests use extract.
      crate::extraction_jobs::enqueue(
        capture_id,
        crate::extraction_jobs::JOB_KIND_SUMMARIZE,
        created_at,
        None,
        conn,
      )
    })
    .expect("seed job");
    if status != "queued" {
      conn
        .execute(
          "UPDATE extraction_jobs SET status = ?1 WHERE id = ?2",
          params![status, id],
        )
        .unwrap();
    }
    id
  }

  fn seed_node(
    conn: &Connection,
    id: &str,
    node_kind: Option<&str>,
    valid_to: Option<i64>,
  ) {
    conn
      .execute(
        "INSERT INTO mem_items
           (id, title, snippet, source, kinds_json, created_at,
            valid_from, recorded_at, last_accessed_at, access_count,
            node_kind, valid_to)
         VALUES (?1, 'T', 'S', 'extraction', '[]', 1000,
                 1000, 1000, 1000, 0, ?2, ?3)",
        params![id, node_kind, valid_to],
      )
      .expect("seed node");
  }

  fn seed_edge(conn: &Connection, from: &str, to: &str, edge_type: &str, valid_to: Option<i64>) {
    conn
      .execute(
        "INSERT INTO mem_edges
           (from_node, to_node, edge_type, valid_from, recorded_at, valid_to)
         VALUES (?1, ?2, ?3, 1000, 1000, ?4)",
        params![from, to, edge_type, valid_to],
      )
      .unwrap();
  }

  // ── query_queue_stats ──────────────────────────────────────────────────
  #[test]
  fn queue_stats_empty_returns_zero_rows() {
    let conn = open_test_conn();
    let s = query_queue_stats(&conn).expect("ok");
    assert_eq!(s, QueueStats::default());
  }

  #[test]
  fn queue_stats_counts_captures_by_status() {
    let conn = open_test_conn();
    seed_capture(&conn, "queued", 1_000);
    seed_capture(&conn, "queued", 1_500);
    seed_capture(&conn, "running", 2_000);
    seed_capture(&conn, "done", 3_000);
    seed_capture(&conn, "failed", 4_000);
    let s = query_queue_stats(&conn).expect("ok");
    assert_eq!(s.captures_pending, 2);
    assert_eq!(s.captures_running, 1);
    assert_eq!(s.captures_done, 1);
    assert_eq!(s.captures_failed, 1);
  }

  #[test]
  fn queue_stats_counts_jobs_by_status() {
    let conn = open_test_conn();
    let cap = seed_capture(&conn, "queued", 1_000);
    seed_job(&conn, Some(cap), "queued", 1_100);
    seed_job(&conn, Some(cap), "queued", 1_200);
    seed_job(&conn, Some(cap), "done", 1_300);
    seed_job(&conn, Some(cap), "failed", 1_400);
    let s = query_queue_stats(&conn).expect("ok");
    assert_eq!(s.jobs_queued, 2);
    assert_eq!(s.jobs_done, 1);
    assert_eq!(s.jobs_failed, 1);
  }

  #[test]
  fn queue_stats_reports_oldest_pending_capture() {
    let conn = open_test_conn();
    seed_capture(&conn, "done", 500); // not pending
    seed_capture(&conn, "queued", 1_000);
    seed_capture(&conn, "queued", 2_000);
    let s = query_queue_stats(&conn).expect("ok");
    assert_eq!(s.oldest_pending_capture_ms, Some(1_000));
  }

  #[test]
  fn queue_stats_oldest_pending_is_none_when_no_pending() {
    let conn = open_test_conn();
    seed_capture(&conn, "done", 1_000);
    let s = query_queue_stats(&conn).expect("ok");
    assert_eq!(s.oldest_pending_capture_ms, None);
  }

  // ── query_cost_stats ───────────────────────────────────────────────────
  #[test]
  fn cost_stats_zero_when_ledger_empty() {
    let conn = open_test_conn();
    let s = query_cost_stats(&conn, &json!({}), 1_745_686_800_000).expect("ok");
    assert!((s.spent_usd - 0.0).abs() < 1e-9);
    assert!((s.monthly_cap_usd - crate::cost_ledger::DEFAULT_MONTHLY_CAP_USD).abs() < 1e-9);
    assert_eq!(s.cap_action, crate::cost_ledger::CAP_ACTION_PAUSE_EXTRACTION);
    assert_eq!(s.status, "Proceed");
  }

  #[test]
  fn cost_stats_sums_only_current_month() {
    let conn = open_test_conn();
    use chrono::{TimeZone, Utc};
    let april = Utc.with_ymd_and_hms(2026, 4, 15, 12, 0, 0).single().unwrap()
      .timestamp_millis();
    let march = Utc.with_ymd_and_hms(2026, 3, 31, 23, 59, 0).single().unwrap()
      .timestamp_millis();
    crate::cost_ledger::record(
      &crate::cost_ledger::LedgerEntry {
        recorded_at_ms: march,
        model: "claude-haiku-4-5".into(),
        purpose: "extraction".into(),
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 7.50,
        job_id: None,
        meta_json: None,
      },
      &conn,
    )
    .unwrap();
    crate::cost_ledger::record(
      &crate::cost_ledger::LedgerEntry {
        recorded_at_ms: april,
        model: "claude-haiku-4-5".into(),
        purpose: "extraction".into(),
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 2.25,
        job_id: None,
        meta_json: None,
      },
      &conn,
    )
    .unwrap();
    let now = Utc.with_ymd_and_hms(2026, 4, 26, 17, 0, 0).single().unwrap()
      .timestamp_millis();
    let s = query_cost_stats(&conn, &json!({}), now).expect("ok");
    assert!((s.spent_usd - 2.25).abs() < 1e-9, "got {}", s.spent_usd);
  }

  #[test]
  fn cost_stats_status_pauses_when_over_cap() {
    let conn = open_test_conn();
    use chrono::{TimeZone, Utc};
    let now = Utc.with_ymd_and_hms(2026, 4, 26, 17, 0, 0).single().unwrap()
      .timestamp_millis();
    crate::cost_ledger::record(
      &crate::cost_ledger::LedgerEntry {
        recorded_at_ms: now - 1_000,
        model: "claude-haiku-4-5".into(),
        purpose: "extraction".into(),
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 50.0,
        job_id: None,
        meta_json: None,
      },
      &conn,
    )
    .unwrap();
    let settings = json!({
      "sections": { "kioku_cost": { "monthly_cap_usd": 10.0, "cap_action": "pause_extraction" } }
    });
    let s = query_cost_stats(&conn, &settings, now).expect("ok");
    assert_eq!(s.status, "Pause");
    assert!((s.monthly_cap_usd - 10.0).abs() < 1e-9);
  }

  // ── query_graph_stats ──────────────────────────────────────────────────
  #[test]
  fn graph_stats_empty_db_returns_zeros() {
    let conn = open_test_conn();
    let s = query_graph_stats(&conn).expect("ok");
    assert_eq!(s.mem_items_total, 0);
    assert_eq!(s.mem_items_active, 0);
    assert_eq!(s.edges_total, 0);
    assert!(s.by_node_kind.is_empty());
    assert!(s.by_edge_type.is_empty());
  }

  #[test]
  fn graph_stats_counts_nodes_active_vs_retired() {
    let conn = open_test_conn();
    seed_node(&conn, "m_a", Some("entity"), None);
    seed_node(&conn, "m_b", Some("event"), None);
    seed_node(&conn, "m_c", Some("entity"), Some(2_000));
    let s = query_graph_stats(&conn).expect("ok");
    assert_eq!(s.mem_items_total, 3);
    assert_eq!(s.mem_items_active, 2);
    assert_eq!(s.mem_items_retired, 1);
  }

  #[test]
  fn graph_stats_groups_by_node_kind() {
    let conn = open_test_conn();
    seed_node(&conn, "m_e1", Some("entity"), None);
    seed_node(&conn, "m_e2", Some("entity"), None);
    seed_node(&conn, "m_evt", Some("event"), None);
    seed_node(&conn, "m_dec", Some("decision"), None);
    let s = query_graph_stats(&conn).expect("ok");
    let entity_count = s.by_node_kind.iter().find(|x| x.kind == "entity").map(|x| x.count);
    let event_count = s.by_node_kind.iter().find(|x| x.kind == "event").map(|x| x.count);
    let dec_count = s.by_node_kind.iter().find(|x| x.kind == "decision").map(|x| x.count);
    assert_eq!(entity_count, Some(2));
    assert_eq!(event_count, Some(1));
    assert_eq!(dec_count, Some(1));
  }

  #[test]
  fn graph_stats_counts_edges_active_vs_retired() {
    let conn = open_test_conn();
    seed_node(&conn, "m_a", Some("entity"), None);
    seed_node(&conn, "m_b", Some("event"), None);
    seed_edge(&conn, "m_a", "m_b", "mentions", None);
    seed_edge(&conn, "m_a", "m_b", "follows_up", Some(2_000));
    let s = query_graph_stats(&conn).expect("ok");
    assert_eq!(s.edges_total, 2);
    assert_eq!(s.edges_active, 1);
  }

  #[test]
  fn graph_stats_groups_by_edge_type_active_only() {
    let conn = open_test_conn();
    seed_node(&conn, "m_a", Some("entity"), None);
    seed_node(&conn, "m_b", Some("event"), None);
    seed_edge(&conn, "m_a", "m_b", "mentions", None);
    seed_edge(&conn, "m_a", "m_b", "mentions", None);
    seed_edge(&conn, "m_a", "m_b", "follows_up", None);
    let s = query_graph_stats(&conn).expect("ok");
    let mentions = s.by_edge_type.iter().find(|x| x.edge_type == "mentions").map(|x| x.count);
    let follows = s.by_edge_type.iter().find(|x| x.edge_type == "follows_up").map(|x| x.count);
    assert_eq!(mentions, Some(2));
    assert_eq!(follows, Some(1));
  }

  // ── assemble_debug_stats ───────────────────────────────────────────────
  #[test]
  fn assemble_debug_stats_returns_all_sections() {
    let conn = open_test_conn();
    let v = assemble_debug_stats(&conn, &json!({}), 1_745_686_800_000).expect("ok");
    assert!(v.get("queue").is_some());
    assert!(v.get("cost").is_some());
    assert!(v.get("graph").is_some());
    assert!(v.get("rules").is_some());
    assert!(v.get("flags").is_some());
    assert!(v.get("summary").is_some());
    assert_eq!(v["now_ms"], json!(1_745_686_800_000_i64));
  }

  #[test]
  fn assemble_debug_stats_reports_active_flags() {
    let conn = open_test_conn();
    let settings = json!({
      "sections": {
        "kioku_graph": {
          "read_path": "graph",
          "capture_to_mem_captures": true,
          "worker_enabled": true,
        }
      }
    });
    let v = assemble_debug_stats(&conn, &settings, 1_745_686_800_000).expect("ok");
    assert_eq!(v["flags"]["read_path"], json!("graph"));
    assert_eq!(v["flags"]["capture_to_mem_captures"], json!(true));
    assert_eq!(v["flags"]["worker_enabled"], json!(true));
  }
}
