//! `cost_ledger` table CRUD + per-model price table. Phase 2 Stage 2 (T5).
//!
//! Spec: `docs/memory-architecture/proposed-schema.sql` §6,
//!       `docs/kioku-cost-budget.md` §1.2.

#![allow(dead_code)]

use rusqlite::{params, Connection};

// ── Pricing table (USD per 1M tokens, snapshot 2026-04-26) ─────────────────
//
// Update when Anthropic publishes new pricing. The constants live in code so
// `calc_cost` is auditable and a single edit shifts the cap budget for every
// future call.

pub const PRICE_HAIKU_4_5_INPUT_PER_M: f64 = 1.00;
pub const PRICE_HAIKU_4_5_OUTPUT_PER_M: f64 = 5.00;
pub const PRICE_SONNET_4_6_INPUT_PER_M: f64 = 3.00;
pub const PRICE_SONNET_4_6_OUTPUT_PER_M: f64 = 15.00;
pub const PRICE_OPUS_4_7_INPUT_PER_M: f64 = 15.00;
pub const PRICE_OPUS_4_7_OUTPUT_PER_M: f64 = 75.00;

/// Anthropic prompt-cache multipliers applied to the per-model base input
/// price. Values per Anthropic public pricing (2026-04-26): cache writes cost
/// 1.25× the base input price; cache reads cost 0.10×. KIOKU benefits from
/// reads since the worker hits the same system + tool definition every 30–60s.
pub const CACHE_WRITE_MULTIPLIER: f64 = 1.25;
pub const CACHE_READ_MULTIPLIER: f64 = 0.10;

/// `cost_ledger.purpose` taxonomy.
pub const PURPOSE_EXTRACTION: &str = "extraction";
pub const PURPOSE_SUMMARIZE: &str = "summarize";
pub const PURPOSE_EMBED: &str = "embed";
pub const PURPOSE_LESSON_GENERATION: &str = "lesson_generation";
pub const PURPOSE_LESSON_SUPERSESSION: &str = "lesson_supersession";
pub const PURPOSE_LESSON_VERIFIER: &str = "lesson_verifier";

/// `settings.sections.kioku_cost.cap_action` enum.
pub const CAP_ACTION_PAUSE_CAPTURE: &str = "pause_capture";
pub const CAP_ACTION_PAUSE_EXTRACTION: &str = "pause_extraction";
pub const CAP_ACTION_FALLBACK_TO_LIGHTER: &str = "fallback_to_lighter";

/// Default cap when settings don't specify (`docs/kioku-cost-budget.md` §4.3).
pub const DEFAULT_MONTHLY_CAP_USD: f64 = 10.0;

/// Decision returned by `evaluate_cap_status`. Worker branches on this before
/// calling the extraction client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapStatus {
  /// Below the cap — caller may proceed with the configured model.
  Proceed,
  /// Cap is breached but `cap_action == fallback_to_lighter`. Caller should
  /// substitute the configured fallback model and proceed.
  ProceedWithFallback { model: String },
  /// Cap is breached and the action requires pausing. The reason string is
  /// logged and surfaced via observability.
  Pause { reason: String },
}

/// Pure decision: given spent / cap / action / fallback model, return the
/// CapStatus. Caller separately reads settings + queries `sum_cost_in_window`.
pub fn evaluate_cap_status(
  spent_usd: f64,
  cap_usd: f64,
  cap_action: &str,
  fallback_model: Option<&str>,
) -> CapStatus {
  if cap_usd <= 0.0 {
    // No cap configured (or invalid value) → unconditionally proceed.
    return CapStatus::Proceed;
  }
  if spent_usd < cap_usd {
    return CapStatus::Proceed;
  }
  match cap_action {
    CAP_ACTION_FALLBACK_TO_LIGHTER => {
      let model = fallback_model
        .map(str::to_string)
        .unwrap_or_else(|| "claude-haiku-4-5".to_string());
      CapStatus::ProceedWithFallback { model }
    }
    CAP_ACTION_PAUSE_CAPTURE => CapStatus::Pause {
      reason: format!(
        "monthly_cap_usd reached (${:.2} >= ${:.2}); pausing capture",
        spent_usd, cap_usd,
      ),
    },
    // Default to pause_extraction when the action is missing or unknown so
    // we fail safe (capture continues, extraction halts until next month).
    _ => CapStatus::Pause {
      reason: format!(
        "monthly_cap_usd reached (${:.2} >= ${:.2}); pausing extraction",
        spent_usd, cap_usd,
      ),
    },
  }
}

/// First epoch-millisecond of the calendar month containing `now_ms`. Used by
/// the cap window query so each month resets cleanly.
pub fn month_start_ms_utc(now_ms: i64) -> i64 {
  use chrono::{Datelike, TimeZone, Utc};
  let dt = match Utc.timestamp_millis_opt(now_ms).single() {
    Some(d) => d,
    None => return 0,
  };
  Utc
    .with_ymd_and_hms(dt.year(), dt.month(), 1, 0, 0, 0)
    .single()
    .map(|d| d.timestamp_millis())
    .unwrap_or(0)
}

/// Compute the dollar cost of an Anthropic call given token usage.
/// Returns `None` for unknown models so callers can log/alarm rather than
/// silently undercount.
pub fn calc_cost(model: &str, input_tokens: i64, output_tokens: i64) -> Option<f64> {
  calc_cost_with_cache(model, input_tokens, 0, 0, output_tokens)
}

/// Same as `calc_cost` but accounts for Anthropic prompt-cache token classes.
/// `input_tokens` is the *uncached* portion as reported by `usage.input_tokens`;
/// `cache_creation_tokens` and `cache_read_tokens` come from the matching
/// `usage.cache_*_input_tokens` fields. The three counts do not overlap.
pub fn calc_cost_with_cache(
  model: &str,
  input_tokens: i64,
  cache_creation_tokens: i64,
  cache_read_tokens: i64,
  output_tokens: i64,
) -> Option<f64> {
  let (inp_per_m, out_per_m) = match model {
    "claude-haiku-4-5" => (PRICE_HAIKU_4_5_INPUT_PER_M, PRICE_HAIKU_4_5_OUTPUT_PER_M),
    "claude-sonnet-4-6" => (PRICE_SONNET_4_6_INPUT_PER_M, PRICE_SONNET_4_6_OUTPUT_PER_M),
    "claude-opus-4-7" => (PRICE_OPUS_4_7_INPUT_PER_M, PRICE_OPUS_4_7_OUTPUT_PER_M),
    _ => return None,
  };
  let inp = input_tokens.max(0) as f64;
  let cw = cache_creation_tokens.max(0) as f64;
  let cr = cache_read_tokens.max(0) as f64;
  let out = output_tokens.max(0) as f64;
  Some(
    inp / 1_000_000.0 * inp_per_m
      + cw / 1_000_000.0 * inp_per_m * CACHE_WRITE_MULTIPLIER
      + cr / 1_000_000.0 * inp_per_m * CACHE_READ_MULTIPLIER
      + out / 1_000_000.0 * out_per_m,
  )
}

/// One row recorded in `cost_ledger`. Mirrors the table 1:1 minus auto id.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LedgerEntry {
  pub recorded_at_ms: i64,
  pub model: String,
  pub purpose: String,
  pub input_tokens: i64,
  pub output_tokens: i64,
  pub cost_usd: f64,
  pub job_id: Option<i64>,
  pub meta_json: Option<String>,
}

/// Insert a ledger row. Returns the new id. Caller computes `cost_usd` via
/// `calc_cost` (or other source for non-Anthropic providers).
pub fn record(entry: &LedgerEntry, conn: &Connection) -> Result<i64, String> {
  if entry.model.trim().is_empty() {
    return Err("cost_ledger::record: model is required".to_string());
  }
  if entry.purpose.trim().is_empty() {
    return Err("cost_ledger::record: purpose is required".to_string());
  }
  conn
    .execute(
      "INSERT INTO cost_ledger
         (recorded_at, model, purpose, input_tokens, output_tokens, cost_usd, job_id, meta_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      params![
        entry.recorded_at_ms,
        entry.model,
        entry.purpose,
        entry.input_tokens,
        entry.output_tokens,
        entry.cost_usd,
        entry.job_id,
        entry.meta_json,
      ],
    )
    .map_err(|e| format!("cost_ledger::record insert: {}", e))?;
  Ok(conn.last_insert_rowid())
}

/// Sum `cost_usd` for rows in `[since_ms, until_ms)`. Used by the cap check.
pub fn sum_cost_in_window(
  conn: &Connection,
  since_ms: i64,
  until_ms: i64,
) -> Result<f64, String> {
  let v: f64 = conn
    .query_row(
      "SELECT COALESCE(SUM(cost_usd), 0.0) FROM cost_ledger
       WHERE recorded_at >= ?1 AND recorded_at < ?2",
      params![since_ms, until_ms],
      |r| r.get::<_, f64>(0),
    )
    .map_err(|e| format!("cost_ledger::sum_cost_in_window: {}", e))?;
  Ok(v)
}

/// Sum `cost_usd` per purpose for rows in `[since_ms, until_ms)`. Used by
/// the KIOKU Graph cost summary view to render a per-category breakdown.
pub fn sum_cost_in_window_by_purpose(
  conn: &Connection,
  since_ms: i64,
  until_ms: i64,
) -> Result<std::collections::HashMap<String, f64>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT purpose, COALESCE(SUM(cost_usd), 0.0)
       FROM cost_ledger
       WHERE recorded_at >= ?1 AND recorded_at < ?2
       GROUP BY purpose",
    )
    .map_err(|e| format!("cost_ledger::sum_cost_in_window_by_purpose prepare: {}", e))?;
  let rows = stmt
    .query_map(rusqlite::params![since_ms, until_ms], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    })
    .map_err(|e| format!("cost_ledger::sum_cost_in_window_by_purpose query: {}", e))?;
  let mut out: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
  for r in rows {
    let (purpose, sum) =
      r.map_err(|e| format!("cost_ledger::sum_cost_in_window_by_purpose row: {}", e))?;
    out.insert(purpose, sum);
  }
  Ok(out)
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

  // ── calc_cost ──────────────────────────────────────────────────────────
  #[test]
  fn calc_cost_haiku_matches_per_million() {
    // 1,000,000 input tokens → $1, 1,000,000 output tokens → $5, total $6.
    let cost = calc_cost("claude-haiku-4-5", 1_000_000, 1_000_000).expect("known");
    assert!((cost - 6.0).abs() < 1e-9);
  }

  #[test]
  fn calc_cost_haiku_fractional_tokens() {
    // 2,000 input + 400 output = $0.002 + $0.002 = $0.004 (per cost-budget §2.3).
    let cost = calc_cost("claude-haiku-4-5", 2_000, 400).expect("known");
    assert!((cost - 0.004).abs() < 1e-9, "got {}", cost);
  }

  #[test]
  fn calc_cost_sonnet_3x_haiku() {
    let h = calc_cost("claude-haiku-4-5", 2_000, 400).unwrap();
    let s = calc_cost("claude-sonnet-4-6", 2_000, 400).unwrap();
    assert!((s / h - 3.0).abs() < 1e-9, "ratio {}", s / h);
  }

  #[test]
  fn calc_cost_unknown_model_returns_none() {
    assert!(calc_cost("gpt-9000", 100, 100).is_none());
    assert!(calc_cost("", 100, 100).is_none());
  }

  #[test]
  fn calc_cost_zero_tokens_returns_zero() {
    let cost = calc_cost("claude-haiku-4-5", 0, 0).expect("known");
    assert_eq!(cost, 0.0);
  }

  #[test]
  fn calc_cost_negative_tokens_treated_as_zero() {
    let cost = calc_cost("claude-haiku-4-5", -10, -20).expect("known");
    assert_eq!(cost, 0.0);
  }

  // ── calc_cost_with_cache ──────────────────────────────────────────────
  #[test]
  fn calc_cost_with_cache_zero_cache_matches_calc_cost() {
    let plain = calc_cost("claude-haiku-4-5", 2_000, 400).unwrap();
    let cached = calc_cost_with_cache("claude-haiku-4-5", 2_000, 0, 0, 400).unwrap();
    assert!((plain - cached).abs() < 1e-12);
  }

  #[test]
  fn calc_cost_with_cache_charges_cache_creation_at_125x() {
    // 1,000,000 cache_creation tokens at Haiku 4.5 = $1.25 (1.25× $1.00 base).
    let cost = calc_cost_with_cache("claude-haiku-4-5", 0, 1_000_000, 0, 0).unwrap();
    assert!((cost - 1.25).abs() < 1e-9);
  }

  #[test]
  fn calc_cost_with_cache_charges_cache_read_at_10pct() {
    // 1,000,000 cache_read tokens at Haiku 4.5 = $0.10 (0.10× $1.00 base).
    let cost = calc_cost_with_cache("claude-haiku-4-5", 0, 0, 1_000_000, 0).unwrap();
    assert!((cost - 0.10).abs() < 1e-9);
  }

  #[test]
  fn calc_cost_with_cache_realistic_kioku_extraction_breakdown() {
    // Per docs/kioku-cost-budget.md projected breakdown after caching:
    //   - 500 fresh input tokens (variable user content)  → $0.0005
    //   - 0   cache_creation (already cached)             → $0
    //   - 3,500 cache_read (system + tool)                → $0.00035
    //   - 800 output                                      → $0.004
    //   = $0.00485 / job
    let cost = calc_cost_with_cache("claude-haiku-4-5", 500, 0, 3_500, 800).unwrap();
    let expected = 500.0 / 1e6 * 1.00 + 3_500.0 / 1e6 * 0.10 + 800.0 / 1e6 * 5.00;
    assert!((cost - expected).abs() < 1e-12, "got {} expected {}", cost, expected);
    assert!(cost < 0.005, "per-job under cached path should drop below $0.005");
  }

  #[test]
  fn calc_cost_with_cache_unknown_model_returns_none() {
    assert!(calc_cost_with_cache("gpt-9000", 100, 0, 0, 100).is_none());
  }

  // ── record ────────────────────────────────────────────────────────────
  fn entry(ts: i64, purpose: &str, in_tok: i64, out_tok: i64, cost: f64) -> LedgerEntry {
    LedgerEntry {
      recorded_at_ms: ts,
      model: "claude-haiku-4-5".into(),
      purpose: purpose.into(),
      input_tokens: in_tok,
      output_tokens: out_tok,
      cost_usd: cost,
      job_id: None,
      meta_json: None,
    }
  }

  #[test]
  fn record_inserts_one_row_with_payload() {
    let conn = open_test_conn();
    let id = record(&entry(1_000, PURPOSE_EXTRACTION, 2_000, 400, 0.004), &conn)
      .expect("record ok");
    assert!(id > 0);
    let count: i64 = conn
      .query_row("SELECT COUNT(*) FROM cost_ledger", [], |r| r.get(0))
      .unwrap();
    assert_eq!(count, 1);
  }

  #[test]
  fn record_persists_all_fields() {
    let conn = open_test_conn();
    let mut e = entry(1_000, PURPOSE_EXTRACTION, 2_000, 400, 0.004);
    e.job_id = Some(42);
    e.meta_json = Some(r#"{"latency_ms":820}"#.to_string());
    let id = record(&e, &conn).expect("ok");
    let row: (i64, String, String, i64, i64, f64, Option<i64>, Option<String>) = conn
      .query_row(
        "SELECT recorded_at, model, purpose, input_tokens, output_tokens,
                cost_usd, job_id, meta_json
         FROM cost_ledger WHERE id = ?1",
        params![id],
        |r| {
          Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, f64>(5)?,
            r.get::<_, Option<i64>>(6)?,
            r.get::<_, Option<String>>(7)?,
          ))
        },
      )
      .expect("fetch");
    assert_eq!(row.0, 1_000);
    assert_eq!(row.1, "claude-haiku-4-5");
    assert_eq!(row.2, "extraction");
    assert_eq!(row.3, 2_000);
    assert_eq!(row.4, 400);
    assert!((row.5 - 0.004).abs() < 1e-9);
    assert_eq!(row.6, Some(42));
    assert_eq!(row.7.as_deref(), Some(r#"{"latency_ms":820}"#));
  }

  #[test]
  fn record_rejects_empty_model() {
    let conn = open_test_conn();
    let mut e = entry(1_000, PURPOSE_EXTRACTION, 0, 0, 0.0);
    e.model.clear();
    let err = record(&e, &conn).expect_err("must error");
    assert!(err.to_lowercase().contains("model"), "got {}", err);
  }

  #[test]
  fn record_rejects_empty_purpose() {
    let conn = open_test_conn();
    let mut e = entry(1_000, "", 0, 0, 0.0);
    e.purpose.clear();
    let err = record(&e, &conn).expect_err("must error");
    assert!(err.to_lowercase().contains("purpose"), "got {}", err);
  }

  // ── evaluate_cap_status ────────────────────────────────────────────────
  #[test]
  fn cap_status_proceeds_when_below_cap() {
    let s = evaluate_cap_status(5.0, 10.0, CAP_ACTION_PAUSE_EXTRACTION, None);
    assert_eq!(s, CapStatus::Proceed);
  }

  #[test]
  fn cap_status_pauses_extraction_when_at_or_over_cap() {
    let s = evaluate_cap_status(10.0, 10.0, CAP_ACTION_PAUSE_EXTRACTION, None);
    match s {
      CapStatus::Pause { reason } => assert!(reason.contains("pausing extraction"), "got: {}", reason),
      other => panic!("expected Pause, got {:?}", other),
    }
  }

  #[test]
  fn cap_status_pauses_capture_with_pause_capture_action() {
    let s = evaluate_cap_status(15.0, 10.0, CAP_ACTION_PAUSE_CAPTURE, None);
    match s {
      CapStatus::Pause { reason } => assert!(reason.contains("pausing capture")),
      _ => panic!("expected Pause"),
    }
  }

  #[test]
  fn cap_status_falls_back_to_lighter_model() {
    let s = evaluate_cap_status(
      11.0,
      10.0,
      CAP_ACTION_FALLBACK_TO_LIGHTER,
      Some("claude-haiku-4-5"),
    );
    match s {
      CapStatus::ProceedWithFallback { model } => assert_eq!(model, "claude-haiku-4-5"),
      other => panic!("expected fallback, got {:?}", other),
    }
  }

  #[test]
  fn cap_status_unknown_action_defaults_to_pause_extraction() {
    let s = evaluate_cap_status(10.0, 10.0, "totally_unknown_action", None);
    assert!(matches!(s, CapStatus::Pause { .. }));
  }

  #[test]
  fn cap_status_zero_cap_unconditionally_proceeds() {
    let s = evaluate_cap_status(1_000.0, 0.0, CAP_ACTION_PAUSE_EXTRACTION, None);
    assert_eq!(s, CapStatus::Proceed);
  }

  // ── month_start_ms_utc ─────────────────────────────────────────────────
  #[test]
  fn month_start_returns_first_of_month_for_mid_month_input() {
    // 2026-04-26 17:00 UTC → 2026-04-01 00:00 UTC
    let mid = 1_745_686_800_000; // approx; we only check that result has hour 0
    let start = month_start_ms_utc(mid);
    use chrono::{Datelike, TimeZone, Timelike, Utc};
    let dt = Utc.timestamp_millis_opt(start).single().unwrap();
    assert_eq!(dt.day(), 1);
    assert_eq!(dt.hour(), 0);
    assert_eq!(dt.minute(), 0);
    assert_eq!(dt.second(), 0);
  }

  #[test]
  fn month_start_returns_same_ms_when_input_is_already_month_start() {
    use chrono::{TimeZone, Utc};
    let exact = Utc.with_ymd_and_hms(2026, 4, 1, 0, 0, 0).single().unwrap()
      .timestamp_millis();
    assert_eq!(month_start_ms_utc(exact), exact);
  }

  // ── sum_cost_in_window ─────────────────────────────────────────────────
  #[test]
  fn sum_cost_window_returns_zero_when_empty() {
    let conn = open_test_conn();
    let s = sum_cost_in_window(&conn, 0, 1_000_000).expect("ok");
    assert_eq!(s, 0.0);
  }

  #[test]
  fn sum_cost_window_includes_only_in_range_rows() {
    let conn = open_test_conn();
    record(&entry(500, PURPOSE_EXTRACTION, 0, 0, 0.10), &conn).unwrap();   // before
    record(&entry(1_500, PURPOSE_EXTRACTION, 0, 0, 0.20), &conn).unwrap(); // in
    record(&entry(2_500, PURPOSE_EXTRACTION, 0, 0, 0.30), &conn).unwrap(); // in
    record(&entry(5_000, PURPOSE_EXTRACTION, 0, 0, 0.40), &conn).unwrap(); // after
    let s = sum_cost_in_window(&conn, 1_000, 3_000).expect("ok");
    assert!((s - 0.50).abs() < 1e-9, "got {}", s);
  }

  #[test]
  fn sum_cost_window_treats_until_as_exclusive() {
    let conn = open_test_conn();
    record(&entry(1_000, PURPOSE_EXTRACTION, 0, 0, 0.10), &conn).unwrap();
    // until_ms == recorded_at_ms (boundary): excluded.
    let s = sum_cost_in_window(&conn, 0, 1_000).expect("ok");
    assert_eq!(s, 0.0);
  }
}
