//! KIOKU extraction logic — fact normalization, conflict resolution, and the
//! BYOK extraction worker scaffold. Phase 2 Stage 2 (T5).
//!
//! The actual Anthropic call is abstracted behind `ExtractionClient` so unit
//! tests can drive the worker with a deterministic fake. Production wiring
//! plugs in `llm::anthropic_tool_complete`.
//!
//! Spec: `docs/memory-architecture/target-design.md` §3,
//!       `docs/memory-architecture/migration-plan.md` §Stage 2.3–2.6.

#![allow(dead_code)]

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

/// Anthropic tool name passed to `tool_use` for structured extraction.
pub const EXTRACTION_TOOL_NAME: &str = "emit_extracted_facts";

/// Allowed `node_kind` values, matching the `mem_items.node_kind` taxonomy
/// in `kioku_graph_schema::derive_node_kind`.
pub const NODE_KINDS: &[&str] = &[
  "entity",
  "event",
  "decision",
  "task",
  "note",
  "capture_summary",
];

/// One fact emitted by the extraction LLM. Mirrors the `tool_use.input`
/// element documented in `target-design.md` §3.4.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ExtractedFact {
  #[serde(default)]
  pub entity_id: Option<String>,
  pub entity_name: String,
  pub fact_type: String,
  pub claim: String,
  pub confidence: f64,
  pub node_kind: String,
  #[serde(default)]
  pub related_ids: Vec<String>,
  #[serde(default)]
  pub edge_types_for_related: Vec<String>,
}

impl ExtractedFact {
  pub fn as_fact_ref(&self) -> FactRef<'_> {
    FactRef {
      entity_id: self.entity_id.as_deref(),
      entity_name: &self.entity_name,
      fact_type: &self.fact_type,
      claim: &self.claim,
    }
  }
}

/// Top-level shape of the tool_use input payload. The LLM emits this object;
/// the worker reads `facts` and processes each via `resolve_write`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ExtractedFactsPayload {
  pub facts: Vec<ExtractedFact>,
}

/// JSON Schema for the tool's `input_schema`. Caller passes the value into
/// `llm::anthropic_tool_complete` (or the equivalent in tests).
pub fn extraction_tool_input_schema() -> Value {
  json!({
    "type": "object",
    "properties": {
      "facts": {
        "type": "array",
        "description": "One or more facts extracted from the capture.",
        "items": {
          "type": "object",
          "properties": {
            "entity_id": {
              "type": ["string", "null"],
              "description": "Upstream identifier (e.g. calendar event id) when the source supplies one."
            },
            "entity_name": {
              "type": "string",
              "description": "Human-readable name of the entity (person / project / org / event)."
            },
            "fact_type": {
              "type": "string",
              "description": "Stable predicate name describing what is asserted (works_at / scheduled_at / status / role / ...)."
            },
            "claim": {
              "type": "string",
              "description": "The assertion in plain language."
            },
            "confidence": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "description": "Self-rated confidence in the extraction."
            },
            "node_kind": {
              "type": "string",
              "enum": NODE_KINDS,
              "description": "Where the fact lives in the KIOKU graph."
            },
            "related_ids": {
              "type": "array",
              "items": { "type": "string" },
              "description": "mem_items.id values this fact links to."
            },
            "edge_types_for_related": {
              "type": "array",
              "items": { "type": "string" },
              "description": "edge_type to use when linking to each related_id (parallel array)."
            }
          },
          "required": ["entity_name", "fact_type", "claim", "confidence", "node_kind"]
        }
      }
    },
    "required": ["facts"]
  })
}

// ── Embedding bridge (sync from worker) ───────────────────────────────────

/// Embed a single claim. Returns `None` when no API key is configured, the
/// claim is empty, or the embed call fails — the worker continues with
/// text-only fact matching in those cases. Trims to a 4 kB upper bound to
/// keep input cost bounded for unusually large claims.
pub fn embed_claim_blocking(claim: &str) -> Option<Vec<f32>> {
  let text = claim.trim();
  if text.is_empty() {
    return None;
  }
  let clipped: String = text.chars().take(4_000).collect();
  let result = tauri::async_runtime::block_on(async move {
    crate::embeddings::embed_one(&clipped).await
  });
  match result {
    Ok(v) if !v.is_empty() => Some(v),
    Ok(_) => None,
    Err(e) => {
      log::debug!("kioku embed_claim_blocking: {}", e);
      None
    }
  }
}

// ── Worker (extraction job) ───────────────────────────────────────────────

/// Capture data passed to the extraction client. Mirrors the read shape of
/// `mem_captures` minus IDs and TTL bookkeeping.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CaptureContext {
  pub kind: String,
  pub raw_text: Option<String>,
  pub app_bundle_id: Option<String>,
  pub window_title: Option<String>,
  pub url: Option<String>,
  pub captured_at_ms: i64,
}

/// What the extraction client returns on a successful call.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ExtractionResponse {
  pub facts: Vec<ExtractedFact>,
  pub model: String,
  pub input_tokens: i64,
  pub output_tokens: i64,
  /// Tokens written to the prompt cache. 0 when caching is off or the prompt
  /// is below Anthropic's cache threshold. Used by `cost_ledger` to apply the
  /// 1.25× write price.
  pub cache_creation_input_tokens: i64,
  /// Tokens served from the prompt cache. The bulk of the savings — billed at
  /// 0.10× normal price.
  pub cache_read_input_tokens: i64,
}

/// Distinguish transient (retry) from permanent (give up) errors so the
/// worker can pick the correct status transition.
#[derive(Debug, Clone, PartialEq)]
pub enum ExtractionError {
  Transient(String),
  Permanent(String),
  /// Anthropic billing / credit exhaustion — job stays queued; worker pauses.
  BillingBlocked(String),
}

/// True when an API error indicates billing/credit exhaustion (not a job defect).
pub fn is_billing_error(err: &str) -> bool {
  let lower = err.to_lowercase();
  [
    "credit balance is too low",
    "purchase credits",
    "insufficient credit",
    "billing",
    "payment required",
    "resource_exhausted",
    "quota exceeded",
    "exceeded your current quota",
    "billing account",
  ]
  .iter()
  .any(|m| lower.contains(m))
}

/// Backoff before retrying after a billing block (6 h).
pub const BILLING_RETRY_BACKOFF_MS: i64 = 6 * 60 * 60 * 1000;

/// Extraction client abstraction. Production wires Anthropic; tests pass a
/// fake that returns canned responses.
pub trait ExtractionClient {
  fn extract(&self, ctx: &CaptureContext) -> Result<ExtractionResponse, ExtractionError>;
}

/// Production `ExtractionClient` backed by Anthropic tool_use. Calls
/// `llm::anthropic_tool_complete_with_usage` on a tokio runtime so callers
/// can use the trait synchronously from worker code.
pub struct AnthropicExtractionClient {
  pub model: String,
}

impl AnthropicExtractionClient {
  pub fn new(model: impl Into<String>) -> Self {
    Self { model: model.into() }
  }

  /// Default Stage-2 model per `docs/kioku-cost-budget.md` §1.1.
  pub fn default_model() -> Self {
    Self::new("gemini-2.5-flash")
  }

  #[allow(dead_code)]
  pub fn haiku_4_5() -> Self {
    Self::new("claude-haiku-4-5")
  }

  fn build_system_prompt() -> String {
    String::from(
      "You extract structured FACTS from a single capture (screen / a11y / connector excerpt).\n\
       Each fact is a triple of (entity, fact_type, claim) plus a confidence in [0,1].\n\
       \n\
       RULES:\n\
       - Emit at most 8 facts; quality over quantity.\n\
       - Skip captures that contain no durable knowledge (e.g. random scrolling).\n\
       - Use existing entity_id when the source supplies one; otherwise omit it.\n\
       - fact_type is a stable predicate name in lowercase_with_underscores\n\
         (works_at, scheduled_at, status, decision, follows_up, ...).\n\
       - claim is the human-readable statement, kept under 200 characters.\n\
       - node_kind ∈ {entity, event, decision, task, note, capture_summary}.\n\
       - confidence reflects extraction certainty, not subject importance.\n\
       \n\
       Output ONLY by calling the emit_extracted_facts tool.",
    )
  }

  fn build_user_message(ctx: &CaptureContext) -> String {
    let mut s = String::from("Capture metadata:\n");
    s.push_str(&format!("- kind: {}\n", ctx.kind));
    if let Some(app) = &ctx.app_bundle_id {
      s.push_str(&format!("- app_bundle_id: {}\n", app));
    }
    if let Some(t) = &ctx.window_title {
      s.push_str(&format!("- window_title: {}\n", t));
    }
    if let Some(u) = &ctx.url {
      s.push_str(&format!("- url: {}\n", u));
    }
    s.push_str(&format!("- captured_at_ms: {}\n", ctx.captured_at_ms));
    s.push_str("\nCapture body:\n");
    if let Some(text) = &ctx.raw_text {
      // Cap input at 8000 chars to bound input cost.
      let clipped: String = text.chars().take(8000).collect();
      s.push_str(&clipped);
    } else {
      s.push_str("(no raw_text — extract structural cues only)\n");
    }
    s
  }

  fn build_tool() -> Value {
    json!({
      "name": EXTRACTION_TOOL_NAME,
      "description": "Emit structured facts extracted from one capture.",
      "input_schema": extraction_tool_input_schema(),
    })
  }
}

/// Categorize an error string from `llm::anthropic_tool_complete_with_usage`
/// into transient (retry) vs permanent (give up).
pub fn classify_anthropic_error(err: &str) -> ExtractionError {
  if is_billing_error(err) {
    return ExtractionError::BillingBlocked(err.to_string());
  }
  let lower = err.to_lowercase();
  // Anthropic-specific transient signals
  for marker in [
    "network error",
    "tool_use body",
    "timeout",
    "timed out",
    "429",
    "529",
    "500",
    "502",
    "503",
    "504",
    "overloaded",
    "rate limit",
  ] {
    if lower.contains(marker) {
      return ExtractionError::Transient(err.to_string());
    }
  }
  ExtractionError::Permanent(err.to_string())
}

impl ExtractionClient for AnthropicExtractionClient {
  fn extract(&self, ctx: &CaptureContext) -> Result<ExtractionResponse, ExtractionError> {
    let system = Self::build_system_prompt();
    let user = Self::build_user_message(ctx);
    let tool = Self::build_tool();
    let model = self.model.clone();

    // Bridge async → sync. The worker driver calls this from a blocking task,
    // so creating a current_thread runtime here is cheap and isolated.
    let opts = crate::llm::AnthropicToolRequestOptions { enable_prompt_cache: true };
    let result = tauri::async_runtime::block_on(async move {
      crate::llm::anthropic_tool_complete_with_usage_opts(&system, &user, &tool, &model, opts)
        .await
    });

    let res = match result {
      Ok(r) => r,
      Err(e) => return Err(classify_anthropic_error(&e)),
    };
    let payload: ExtractedFactsPayload = match serde_json::from_value(res.input.clone()) {
      Ok(p) => p,
      Err(e) => {
        return Err(ExtractionError::Permanent(format!(
          "tool_use input did not match ExtractedFactsPayload: {} (raw: {})",
          e,
          res.input.to_string().chars().take(200).collect::<String>(),
        )));
      }
    };
    Ok(ExtractionResponse {
      facts: payload.facts,
      model: res.resolved_model,
      input_tokens: res.input_tokens,
      output_tokens: res.output_tokens,
      cache_creation_input_tokens: res.cache_creation_input_tokens,
      cache_read_input_tokens: res.cache_read_input_tokens,
    })
  }
}

/// What `process_one_job` did.
#[derive(Debug, Clone, PartialEq)]
pub enum JobOutcome {
  Done {
    fact_count: usize,
    cost_usd: f64,
  },
  /// Transient error; job left in `queued` with `next_attempt_at` set.
  Retry {
    attempts: i64,
    next_attempt_at_ms: i64,
    reason: String,
  },
  Failed {
    reason: String,
  },
  Skipped {
    reason: String,
  },
  /// Billing/credit block — worker should pause; job stays queued.
  BillingPaused {
    reason: String,
  },
}

/// Backoff for transient errors. `attempts` is the count after the failure
/// (i.e. the value persisted in `extraction_jobs.attempts` after the worker
/// bumped it). 60 s × 2^(attempts-1), capped at 1 hour. Returns the absolute
/// `next_attempt_at_ms` derived from `now_ms`.
pub fn next_attempt_after_transient(now_ms: i64, attempts: i64) -> i64 {
  let n = (attempts - 1).max(0) as u32;
  let exp_factor: i64 = 1i64.checked_shl(n).unwrap_or(i64::MAX);
  let backoff_ms = (60_000i64).saturating_mul(exp_factor).min(60 * 60_000);
  now_ms.saturating_add(backoff_ms)
}

/// Pick the next queued job whose `next_attempt_at` is null or in the past.
/// Returns `None` when the queue is empty or every queued job is parked behind
/// a future `next_attempt_at` (back-off in flight). Pure SELECT; no state
/// mutation here so the tick loop can defer the running-bump to
/// `process_one_job`.
pub fn pick_next_eligible_job(
  conn: &rusqlite::Connection,
  now_ms: i64,
) -> Result<Option<i64>, String> {
  let row = conn
    .query_row(
      "SELECT id FROM extraction_jobs
       WHERE status = 'queued'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
       ORDER BY COALESCE(next_attempt_at, 0), created_at, id
       LIMIT 1",
      rusqlite::params![now_ms],
      |r| r.get::<_, i64>(0),
    )
    .map(Some)
    .or_else(|e| {
      if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
        Ok(None)
      } else {
        Err(format!("pick_next_eligible_job: {}", e))
      }
    })?;
  Ok(row)
}

/// Per-tick summary returned by `run_worker_tick`. Useful for observability
/// counters and tests.
#[derive(Debug, Clone, PartialEq)]
pub struct TickReport {
  pub jobs_processed: usize,
  pub jobs_skipped_no_capture: usize,
  pub jobs_failed: usize,
  pub jobs_retrying: usize,
  pub paused: bool,
  pub paused_reason: Option<String>,
  pub used_fallback: bool,
  pub model_used: Option<String>,
}

/// One tick of the worker loop. Reads cost cap → either pauses or drains up
/// to `max_jobs_per_tick` queued jobs through the supplied client. Pure
/// w.r.t. the system clock (caller passes `now_ms`).
pub fn run_worker_tick<C: ExtractionClient>(
  client: &C,
  conn: &rusqlite::Connection,
  now_ms: i64,
  monthly_cap_usd: f64,
  cap_action: &str,
  fallback_model: Option<&str>,
  max_jobs_per_tick: usize,
) -> Result<TickReport, String> {
  let month_start = crate::cost_ledger::month_start_ms_utc(now_ms);
  let spent = crate::cost_ledger::sum_cost_in_window(conn, month_start, now_ms)?;
  let status = crate::cost_ledger::evaluate_cap_status(
    spent,
    monthly_cap_usd,
    cap_action,
    fallback_model,
  );

  let (used_fallback, model_used) = match &status {
    crate::cost_ledger::CapStatus::Pause { reason } => {
      return Ok(TickReport {
        jobs_processed: 0,
        jobs_skipped_no_capture: 0,
        jobs_failed: 0,
        jobs_retrying: 0,
        paused: true,
        paused_reason: Some(reason.clone()),
        used_fallback: false,
        model_used: None,
      });
    }
    crate::cost_ledger::CapStatus::ProceedWithFallback { model } => (true, Some(model.clone())),
    crate::cost_ledger::CapStatus::Proceed => (false, None),
  };

  let mut report = TickReport {
    jobs_processed: 0,
    jobs_skipped_no_capture: 0,
    jobs_failed: 0,
    jobs_retrying: 0,
    paused: false,
    paused_reason: None,
    used_fallback,
    model_used,
  };

  for _ in 0..max_jobs_per_tick {
    let job_id = match pick_next_eligible_job(conn, now_ms)? {
      Some(id) => id,
      None => break,
    };
    let outcome = process_one_job(job_id, client, now_ms, conn)?;
    match outcome {
      JobOutcome::Done { .. } => report.jobs_processed += 1,
      JobOutcome::Retry { .. } => report.jobs_retrying += 1,
      JobOutcome::Failed { .. } => report.jobs_failed += 1,
      JobOutcome::Skipped { .. } => report.jobs_skipped_no_capture += 1,
      JobOutcome::BillingPaused { reason } => {
        report.paused = true;
        report.paused_reason = Some(reason);
        break;
      }
    }
  }

  Ok(report)
}

/// Process a single `extraction_jobs` row. Behavior:
///  - status `queued` → `running` → `done` on success (or `failed` on error)
///  - increments `attempts` and writes `last_error` on every failure
///  - records a `cost_ledger` row on success (purpose='extraction')
///  - applies each fact via `resolve_write` (CASCADE-safe)
///
/// Retry / backoff is intentionally not implemented in this stage; we record
/// `last_error` and leave the job in `failed` so the worker driver can
/// re-enqueue manually after fixing the upstream issue. T5 follow-up adds
/// `next_attempt_at` exponential backoff.
pub fn process_one_job<C: ExtractionClient>(
  job_id: i64,
  client: &C,
  now_ms: i64,
  conn: &Connection,
) -> Result<JobOutcome, String> {
  // Pull the job + linked capture (if any).
  let (capture_id_opt, job_kind): (Option<i64>, String) = conn
    .query_row(
      "SELECT capture_id, job_kind FROM extraction_jobs WHERE id = ?1",
      params![job_id],
      |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?)),
    )
    .map_err(|e| format!("process_one_job lookup: {}", e))?;
  if job_kind != crate::extraction_jobs::JOB_KIND_EXTRACT {
    return Err(format!(
      "process_one_job: unsupported job_kind {} (only 'extract' for Stage 2)",
      job_kind
    ));
  }
  let capture_id = match capture_id_opt {
    Some(c) => c,
    None => {
      // Mark skipped without consuming an attempt.
      conn
        .execute(
          "UPDATE extraction_jobs SET status = 'failed', last_error = ?1, finished_at = ?2 WHERE id = ?3",
          params!["missing capture_id", now_ms, job_id],
        )
        .map_err(|e| format!("process_one_job skip mark: {}", e))?;
      return Ok(JobOutcome::Skipped {
        reason: "missing capture for extract job".to_string(),
      });
    }
  };

  let ctx = match fetch_capture_context(conn, capture_id)? {
    Some(c) => c,
    None => {
      conn
        .execute(
          "UPDATE extraction_jobs SET status = 'failed', last_error = 'capture row vanished', finished_at = ?1 WHERE id = ?2",
          params![now_ms, job_id],
        )
        .map_err(|e| format!("process_one_job skip mark: {}", e))?;
      return Ok(JobOutcome::Skipped {
        reason: "capture row not found".to_string(),
      });
    }
  };

  // Mark running + attempts++.
  conn
    .execute(
      "UPDATE extraction_jobs
         SET status = 'running', attempts = attempts + 1, started_at = ?1
       WHERE id = ?2",
      params![now_ms, job_id],
    )
    .map_err(|e| format!("process_one_job mark running: {}", e))?;

  match client.extract(&ctx) {
    Ok(resp) => {
      // Apply each fact via resolve_write. Embed each claim once so
      // `is_same_fact` stage 2 (cosine ≥ 0.92) can bridge paraphrases /
      // multilingual variants. Embedding failures fall back to text-only
      // matching so the worker stays robust when the embedding endpoint
      // is unreachable.
      let fact_count = resp.facts.len();
      let claim_embeddings: Vec<Option<Vec<f32>>> = resp
        .facts
        .iter()
        .map(|f| embed_claim_blocking(&f.claim))
        .collect();
      for (f, emb) in resp.facts.iter().zip(claim_embeddings.iter()) {
        resolve_write(f, emb.as_deref(), Some(capture_id), now_ms, conn)?;
      }

      let cost = crate::cost_ledger::calc_cost_with_cache(
        &resp.model,
        resp.input_tokens,
        resp.cache_creation_input_tokens,
        resp.cache_read_input_tokens,
        resp.output_tokens,
      )
      .unwrap_or(0.0);
      let meta_json = if resp.cache_creation_input_tokens > 0 || resp.cache_read_input_tokens > 0 {
        Some(format!(
          r#"{{"cache_creation_input_tokens":{},"cache_read_input_tokens":{}}}"#,
          resp.cache_creation_input_tokens, resp.cache_read_input_tokens,
        ))
      } else {
        None
      };
      crate::cost_ledger::record(
        &crate::cost_ledger::LedgerEntry {
          recorded_at_ms: now_ms,
          model: resp.model,
          purpose: crate::cost_ledger::PURPOSE_EXTRACTION.into(),
          input_tokens: resp.input_tokens,
          output_tokens: resp.output_tokens,
          cost_usd: cost,
          job_id: Some(job_id),
          meta_json,
        },
        conn,
      )?;

      // Mark capture done.
      conn
        .execute(
          "UPDATE mem_captures SET extraction_status = 'done', processed_at = ?1 WHERE id = ?2",
          params![now_ms, capture_id],
        )
        .map_err(|e| format!("process_one_job mark capture done: {}", e))?;

      // Job: status='done'.
      conn
        .execute(
          "UPDATE extraction_jobs
             SET status = 'done', finished_at = ?1, model = ?2
           WHERE id = ?3",
          params![now_ms, "claude-haiku-4-5", job_id],
        )
        .map_err(|e| format!("process_one_job mark job done: {}", e))?;

      Ok(JobOutcome::Done {
        fact_count,
        cost_usd: cost,
      })
    }
    Err(err) => {
      // Read attempts AFTER the running-bump above so we know the up-to-date
      // count when deciding retry vs give-up.
      let (attempts, max_attempts): (i64, i64) = conn
        .query_row(
          "SELECT attempts, max_attempts FROM extraction_jobs WHERE id = ?1",
          params![job_id],
          |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("process_one_job re-read attempts: {}", e))?;

      match err {
        ExtractionError::Transient(msg) => {
          let last_error = format!("transient: {}", msg);
          if attempts >= max_attempts {
            conn
              .execute(
                "UPDATE extraction_jobs
                   SET status = 'failed', last_error = ?1, finished_at = ?2
                 WHERE id = ?3",
                params![last_error, now_ms, job_id],
              )
              .map_err(|e| format!("process_one_job mark failed (retries exhausted): {}", e))?;
            Ok(JobOutcome::Failed { reason: last_error })
          } else {
            let next_at = next_attempt_after_transient(now_ms, attempts);
            conn
              .execute(
                "UPDATE extraction_jobs
                   SET status = 'queued',
                       last_error = ?1,
                       next_attempt_at = ?2
                 WHERE id = ?3",
                params![last_error, next_at, job_id],
              )
              .map_err(|e| format!("process_one_job mark queued for retry: {}", e))?;
            Ok(JobOutcome::Retry {
              attempts,
              next_attempt_at_ms: next_at,
              reason: last_error,
            })
          }
        }
        ExtractionError::Permanent(msg) => {
          let last_error = format!("permanent: {}", msg);
          conn
            .execute(
              "UPDATE extraction_jobs
                 SET status = 'failed', last_error = ?1, finished_at = ?2
               WHERE id = ?3",
              params![last_error, now_ms, job_id],
            )
            .map_err(|e| format!("process_one_job mark failed: {}", e))?;
          Ok(JobOutcome::Failed { reason: last_error })
        }
        ExtractionError::BillingBlocked(msg) => {
          let last_error = format!("billing_blocked: {}", msg);
          conn
            .execute(
              "UPDATE extraction_jobs
                 SET status = 'queued',
                     attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
                     last_error = ?1,
                     next_attempt_at = ?2
               WHERE id = ?3",
              params![
                last_error,
                now_ms.saturating_add(BILLING_RETRY_BACKOFF_MS),
                job_id,
              ],
            )
            .map_err(|e| format!("process_one_job mark billing queued: {}", e))?;
          Ok(JobOutcome::BillingPaused {
            reason: last_error,
          })
        }
      }
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequeueReport {
  pub requeued: i64,
  pub only_billing: bool,
}

/// Reset failed extraction jobs back to `queued` after fixing billing / API issues.
pub fn requeue_failed_extraction_jobs(
  conn: &Connection,
  only_billing: bool,
  now_ms: i64,
) -> Result<RequeueReport, String> {
  let requeued = if only_billing {
    conn.execute(
      "UPDATE extraction_jobs
         SET status = 'queued',
             attempts = 0,
             last_error = NULL,
             finished_at = NULL,
             next_attempt_at = ?1
       WHERE status = 'failed'
         AND (
           last_error LIKE '%credit balance%'
           OR last_error LIKE '%purchase credits%'
           OR last_error LIKE '%billing_blocked%'
         )",
      params![now_ms],
    )
    .map_err(|e| format!("requeue_failed_extraction_jobs (billing): {}", e))?
  } else {
    conn
      .execute(
        "UPDATE extraction_jobs
           SET status = 'queued',
               attempts = 0,
               last_error = NULL,
               finished_at = NULL,
               next_attempt_at = ?1
         WHERE status = 'failed'",
        params![now_ms],
      )
      .map_err(|e| format!("requeue_failed_extraction_jobs (all): {}", e))?
  };
  Ok(RequeueReport {
    requeued: requeued as i64,
    only_billing,
  })
}

pub fn count_failed_billing_jobs(conn: &Connection) -> Result<i64, String> {
  conn
    .query_row(
      "SELECT COUNT(*) FROM extraction_jobs
       WHERE status = 'failed'
         AND (
           last_error LIKE '%credit balance%'
           OR last_error LIKE '%purchase credits%'
           OR last_error LIKE '%billing_blocked%'
         )",
      [],
      |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

// ── Worker driver (production wiring) ──────────────────────────────────────

/// Resolved worker settings used by the driver loop.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerConfig {
  pub model: String,
  pub fallback_model: String,
  pub monthly_cap_usd: f64,
  pub cap_action: String,
  pub poll_interval_secs: u64,
  pub max_jobs_per_tick: usize,
  pub enabled: bool,
}

impl Default for WorkerConfig {
  fn default() -> Self {
    WorkerConfig {
      model: "gemini-2.5-flash".to_string(),
      fallback_model: "gemini-2.5-flash".to_string(),
      monthly_cap_usd: crate::cost_ledger::DEFAULT_MONTHLY_CAP_USD,
      cap_action: crate::cost_ledger::CAP_ACTION_PAUSE_EXTRACTION.to_string(),
      poll_interval_secs: 30,
      max_jobs_per_tick: 5,
      enabled: false,
    }
  }
}

/// Read `settings.sections.kioku_graph` + `kioku_cost` + `llm` to assemble the
/// worker config. Pure function — caller does the IO. Stage-2 default keeps
/// the worker disabled until the user (or a settings migration) explicitly
/// turns it on, matching the same opt-in posture as the capture flag.
pub fn resolve_worker_config(settings: &serde_json::Value) -> WorkerConfig {
  let mut cfg = WorkerConfig::default();

  if let Some(model) = settings
    .pointer("/sections/llm/extractionModel")
    .and_then(|v| v.as_str())
  {
    if !model.trim().is_empty() {
      cfg.model = model.to_string();
    }
  }
  if let Some(model) = settings
    .pointer("/sections/kioku_cost/fallback_model")
    .and_then(|v| v.as_str())
  {
    if !model.trim().is_empty() {
      cfg.fallback_model = model.to_string();
    }
  }
  if let Some(cap) = settings
    .pointer("/sections/kioku_cost/monthly_cap_usd")
    .and_then(|v| v.as_f64())
  {
    if cap.is_finite() && cap >= 0.0 {
      cfg.monthly_cap_usd = cap;
    }
  }
  if let Some(action) = settings
    .pointer("/sections/kioku_cost/cap_action")
    .and_then(|v| v.as_str())
  {
    if !action.trim().is_empty() {
      cfg.cap_action = action.to_string();
    }
  }
  if let Some(secs) = settings
    .pointer("/sections/kioku_graph/poll_interval_secs")
    .and_then(|v| v.as_u64())
  {
    cfg.poll_interval_secs = secs.clamp(5, 600);
  }
  if let Some(n) = settings
    .pointer("/sections/kioku_graph/max_jobs_per_tick")
    .and_then(|v| v.as_u64())
  {
    cfg.max_jobs_per_tick = (n.clamp(1, 50)) as usize;
  }
  if let Some(en) = settings
    .pointer("/sections/kioku_graph/worker_enabled")
    .and_then(|v| v.as_bool())
  {
    cfg.enabled = en;
  }

  cfg
}

/// Run a single tick using settings loaded from disk + the canonical
/// `AnthropicExtractionClient`. Returns `Ok(None)` when the worker is
/// disabled by settings.
pub fn run_worker_tick_from_settings(now_ms: i64) -> Result<Option<TickReport>, String> {
  let settings = crate::settings_store::load().unwrap_or_else(|_| serde_json::json!({}));
  let cfg = resolve_worker_config(&settings);
  if !cfg.enabled {
    return Ok(None);
  }

  let conn = crate::memory_store::open_conn()?;

  // Pre-check cap and pick the model accordingly.
  let month_start = crate::cost_ledger::month_start_ms_utc(now_ms);
  let spent = crate::cost_ledger::sum_cost_in_window(&conn, month_start, now_ms)?;
  let status = crate::cost_ledger::evaluate_cap_status(
    spent,
    cfg.monthly_cap_usd,
    &cfg.cap_action,
    Some(&cfg.fallback_model),
  );
  let active_model = match status {
    crate::cost_ledger::CapStatus::Pause { reason } => {
      log::info!("kioku worker: tick paused — {}", reason);
      return Ok(Some(TickReport {
        jobs_processed: 0,
        jobs_skipped_no_capture: 0,
        jobs_failed: 0,
        jobs_retrying: 0,
        paused: true,
        paused_reason: Some(reason),
        used_fallback: false,
        model_used: None,
      }));
    }
    crate::cost_ledger::CapStatus::ProceedWithFallback { ref model } => model.clone(),
    crate::cost_ledger::CapStatus::Proceed => cfg.model.clone(),
  };

  let client = AnthropicExtractionClient::new(active_model);
  let report = run_worker_tick(
    &client,
    &conn,
    now_ms,
    cfg.monthly_cap_usd,
    &cfg.cap_action,
    Some(&cfg.fallback_model),
    cfg.max_jobs_per_tick,
  )?;
  Ok(Some(report))
}

/// Spawn the background worker loop. Driven by `resolve_worker_config` —
/// when the worker is disabled in settings the tick is a cheap no-op so
/// flipping the flag at runtime turns the loop on without restart.
pub fn start_extraction_worker(_app: tauri::AppHandle) {
  std::thread::spawn(move || loop {
    let cfg = crate::settings_store::load()
      .ok()
      .map(|s| resolve_worker_config(&s))
      .unwrap_or_default();
    let wait_secs = cfg.poll_interval_secs.max(5);
    std::thread::sleep(std::time::Duration::from_secs(wait_secs));
    let now_ms = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis() as i64)
      .unwrap_or(0);
    match run_worker_tick_from_settings(now_ms) {
      Ok(Some(report)) => {
        crate::memory_obs::emit(
          "kioku_worker_tick",
          &[
            ("jobs_processed", report.jobs_processed.to_string()),
            ("jobs_failed", report.jobs_failed.to_string()),
            ("jobs_retrying", report.jobs_retrying.to_string()),
            ("paused", report.paused.to_string()),
            (
              "model_used",
              report.model_used.unwrap_or_default(),
            ),
          ],
        );
      }
      Ok(None) => {
        // Worker disabled — quiet no-op.
      }
      Err(e) => {
        log::warn!("kioku worker tick failed: {}", e);
      }
    }
  });
}

fn fetch_capture_context(
  conn: &Connection,
  capture_id: i64,
) -> Result<Option<CaptureContext>, String> {
  let row = conn
    .query_row(
      "SELECT type, raw_text, app_bundle_id, window_title, url, captured_at
       FROM mem_captures WHERE id = ?1",
      params![capture_id],
      |r| {
        Ok((
          r.get::<_, String>(0)?,
          r.get::<_, Option<String>>(1)?,
          r.get::<_, Option<String>>(2)?,
          r.get::<_, Option<String>>(3)?,
          r.get::<_, Option<String>>(4)?,
          r.get::<_, i64>(5)?,
        ))
      },
    )
    .ok();
  Ok(row.map(|r| CaptureContext {
    kind: r.0,
    raw_text: r.1,
    app_bundle_id: r.2,
    window_title: r.3,
    url: r.4,
    captured_at_ms: r.5,
  }))
}

// ── resolve_write (conflict resolution) ───────────────────────────────────

static NODE_SEQ: AtomicU64 = AtomicU64::new(0);

fn next_node_id(now_ms: i64) -> String {
  let seq = NODE_SEQ.fetch_add(1, Ordering::Relaxed);
  format!("m_{}_{}", now_ms, seq)
}

/// Outcome of `resolve_write`. Caller logs / instruments based on which branch
/// fired so we can compute supersede rate and dedup_skipped_count for §6
/// observability.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolveOutcome {
  Merged { node_id: String, access_count_after: i64 },
  Superseded { old_id: String, new_id: String },
  Created { node_id: String },
}

#[derive(Debug, Clone)]
struct CandidateRow {
  id: String,
  entity_id: Option<String>,
  entity_name: String,    // mem_items.title
  fact_type: String,      // first kinds_json element by convention; falls back to ""
  claim: String,          // mem_items.snippet
  access_count: i64,
  embedding: Option<Vec<f32>>,  // decoded f32 LE blob; None when row has no embedding
}

/// Decode the f32 LE BLOB stored in `mem_items.embedding`. Mirrors the helper
/// in `memory_store::decode_embedding_blob` (kept private over there) so this
/// module is self-contained for the embedding-aware fact comparison path.
fn decode_embedding_blob(b: &[u8]) -> Option<Vec<f32>> {
  if b.is_empty() || b.len() % 4 != 0 {
    return None;
  }
  Some(
    b.chunks_exact(4)
      .filter_map(|c| c.try_into().ok().map(f32::from_le_bytes))
      .collect(),
  )
}

/// Encode an f32 vector for storage in the BLOB column.
fn encode_embedding_blob(v: &[f32]) -> Vec<u8> {
  v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn fetch_candidates_for_fact(
  conn: &Connection,
  fact: &ExtractedFact,
) -> Result<Vec<CandidateRow>, String> {
  // Pull current-valid rows whose entity_id or normalized title matches.
  // Since SQLite has no normalize_name() function, do the name-based filter
  // in Rust after a wider title=? lookup. Stage 1: entity_id match.
  let mut out: Vec<CandidateRow> = Vec::new();

  if let Some(eid) = &fact.entity_id {
    let mut stmt = conn
      .prepare(
        "SELECT id, entity_id, title, kinds_json, snippet, access_count, embedding
         FROM mem_items
         WHERE valid_to IS NULL AND entity_id = ?1",
      )
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map(params![eid], |r| {
        Ok((
          r.get::<_, String>(0)?,
          r.get::<_, Option<String>>(1)?,
          r.get::<_, String>(2)?,
          r.get::<_, String>(3)?,
          r.get::<_, String>(4)?,
          r.get::<_, i64>(5)?,
          r.get::<_, Option<Vec<u8>>>(6)?,
        ))
      })
      .map_err(|e| e.to_string())?;
    for row in rows {
      let r = row.map_err(|e| e.to_string())?;
      let embedding = r.6.as_deref().and_then(decode_embedding_blob);
      out.push(CandidateRow {
        id: r.0,
        entity_id: r.1,
        entity_name: r.2,
        fact_type: kinds_json_first(&r.3),
        claim: r.4,
        access_count: r.5,
        embedding,
      });
    }
  }

  // Stage 3 candidates: scan current-valid rows and filter by normalized name.
  // For Stage 1 fixture sizes this is fine; production would back this with
  // a generated_column index when graph node count grows.
  let normalized_target = normalize_name(&fact.entity_name);
  if !normalized_target.is_empty() {
    let mut stmt = conn
      .prepare(
        "SELECT id, entity_id, title, kinds_json, snippet, access_count, embedding
         FROM mem_items
         WHERE valid_to IS NULL",
      )
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([], |r| {
        Ok((
          r.get::<_, String>(0)?,
          r.get::<_, Option<String>>(1)?,
          r.get::<_, String>(2)?,
          r.get::<_, String>(3)?,
          r.get::<_, String>(4)?,
          r.get::<_, i64>(5)?,
          r.get::<_, Option<Vec<u8>>>(6)?,
        ))
      })
      .map_err(|e| e.to_string())?;
    for row in rows {
      let r = row.map_err(|e| e.to_string())?;
      let already = out.iter().any(|c| c.id == r.0);
      if already {
        continue;
      }
      if normalize_name(&r.2) == normalized_target {
        let embedding = r.6.as_deref().and_then(decode_embedding_blob);
        out.push(CandidateRow {
          id: r.0,
          entity_id: r.1,
          entity_name: r.2,
          fact_type: kinds_json_first(&r.3),
          claim: r.4,
          access_count: r.5,
          embedding,
        });
      }
    }
  }

  Ok(out)
}

fn kinds_json_first(raw: &str) -> String {
  // mem_items.kinds_json stores a JSON array; we treat the first element as
  // the canonical "fact_type" for legacy rows. New rows written by this module
  // store [fact_type, node_kind] for self-describing inserts.
  serde_json::from_str::<Vec<String>>(raw)
    .ok()
    .and_then(|v| v.into_iter().next())
    .unwrap_or_default()
}

fn candidate_as_ref<'a>(c: &'a CandidateRow) -> FactRef<'a> {
  FactRef {
    entity_id: c.entity_id.as_deref(),
    entity_name: &c.entity_name,
    fact_type: &c.fact_type,
    claim: &c.claim,
  }
}

fn insert_new_node(
  conn: &Connection,
  fact: &ExtractedFact,
  claim_embedding: Option<&[f32]>,
  capture_id: Option<i64>,
  now_ms: i64,
) -> Result<String, String> {
  let id = next_node_id(now_ms);
  let kinds = json!([fact.fact_type, fact.node_kind]).to_string();
  let embedding_blob: Option<Vec<u8>> = claim_embedding.map(encode_embedding_blob);
  conn
    .execute(
      "INSERT INTO mem_items
         (id, title, snippet, source, kinds_json, created_at, embedding,
          provenance, entity_id, confidence, redaction,
          valid_from, recorded_at, last_accessed_at, access_count,
          node_kind, source_capture_id)
       VALUES
         (?1, ?2, ?3, 'extraction', ?4, ?5, ?6,
          'user', ?7, ?8, NULL,
          ?5, ?5, ?5, 0,
          ?9, ?10)",
      params![
        id,
        fact.entity_name,
        fact.claim,
        kinds,
        now_ms,
        embedding_blob,
        fact.entity_id,
        fact.confidence,
        fact.node_kind,
        capture_id,
      ],
    )
    .map_err(|e| format!("resolve_write insert: {}", e))?;
  Ok(id)
}

fn add_relation_edges(
  conn: &Connection,
  from_node: &str,
  fact: &ExtractedFact,
  capture_id: Option<i64>,
  now_ms: i64,
) -> Result<(), String> {
  for (i, rel) in fact.related_ids.iter().enumerate() {
    let edge_type = fact
      .edge_types_for_related
      .get(i)
      .map(String::as_str)
      .unwrap_or("mentions");
    conn
      .execute(
        "INSERT INTO mem_edges
           (from_node, to_node, edge_type, weight, valid_from, recorded_at, source_capture_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        params![from_node, rel, edge_type, fact.confidence, now_ms, capture_id],
      )
      .map_err(|e| format!("resolve_write add edge: {}", e))?;
    // Track the edge_type so the Stage 4 review queue eventually sees it.
    // Failures to record a proposal must not abort the extraction worker —
    // the audit table is best-effort.
    if let Err(e) = crate::kioku_edge_types::record_proposal(conn, edge_type, now_ms) {
      log::debug!("kioku edge_type proposal record skipped: {}", e);
    }
  }
  Ok(())
}

/// Apply one `ExtractedFact` to the graph. Returns the outcome so the caller
/// can update observability counters (`extracted_count` / `superseded_count`
/// / `dedup_skipped_count`).
///
/// `claim_embedding` activates `is_same_fact` stage 2 (embedding cosine
/// ≥ 0.92). Pass `None` and the function falls back to text-only matching;
/// this lets unit tests exercise the merge / supersede / create branches
/// without an embedding pipeline. Production callers (the worker) embed
/// the claim before calling so paraphrases / multilingual matches resolve.
pub fn resolve_write(
  fact: &ExtractedFact,
  claim_embedding: Option<&[f32]>,
  capture_id: Option<i64>,
  now_ms: i64,
  conn: &Connection,
) -> Result<ResolveOutcome, String> {
  let candidates = fetch_candidates_for_fact(conn, fact)?;
  let fact_ref_owned = fact.as_fact_ref();

  // 1. Look for a perfect-match merge candidate first.
  for c in &candidates {
    let cref = candidate_as_ref(c);
    let cand_embedding = c.embedding.as_deref();
    if is_same_fact(&cref, &fact_ref_owned, cand_embedding, claim_embedding) {
      conn
        .execute(
          "UPDATE mem_items
             SET access_count = access_count + 1,
                 last_accessed_at = ?1
           WHERE id = ?2",
          params![now_ms, c.id],
        )
        .map_err(|e| format!("resolve_write merge update: {}", e))?;
      let after: i64 = conn
        .query_row(
          "SELECT access_count FROM mem_items WHERE id = ?1",
          params![c.id],
          |r| r.get(0),
        )
        .map_err(|e| format!("resolve_write merge read: {}", e))?;
      // After bump from 0 → 1; tests assert "access_count_after == 1" for the
      // first merge, so we report the post-bump value as observed by callers.
      return Ok(ResolveOutcome::Merged {
        node_id: c.id.clone(),
        access_count_after: after,
      });
    }
  }

  // 2. Then look for a conflict (supersede).
  for c in &candidates {
    let cref = candidate_as_ref(c);
    if same_entity_different_fact(&cref, &fact_ref_owned) {
      conn
        .execute(
          "UPDATE mem_items SET valid_to = ?1 WHERE id = ?2",
          params![now_ms, c.id],
        )
        .map_err(|e| format!("resolve_write supersede valid_to: {}", e))?;
      let new_id = insert_new_node(conn, fact, claim_embedding, capture_id, now_ms)?;
      conn
        .execute(
          "INSERT INTO mem_edges
             (from_node, to_node, edge_type, weight, valid_from, recorded_at, source_capture_id)
           VALUES (?1, ?2, 'supersedes', 1.0, ?3, ?3, ?4)",
          params![new_id, c.id, now_ms, capture_id],
        )
        .map_err(|e| format!("resolve_write supersede edge: {}", e))?;
      // Audit the canonical 'supersedes' edge alongside fact-derived edges.
      if let Err(e) = crate::kioku_edge_types::record_proposal(conn, "supersedes", now_ms) {
        log::debug!("kioku edge_type proposal record skipped: {}", e);
      }
      add_relation_edges(conn, &new_id, fact, capture_id, now_ms)?;
      return Ok(ResolveOutcome::Superseded {
        old_id: c.id.clone(),
        new_id,
      });
    }
  }

  // 3. Otherwise insert a fresh node.
  let new_id = insert_new_node(conn, fact, claim_embedding, capture_id, now_ms)?;
  add_relation_edges(conn, &new_id, fact, capture_id, now_ms)?;
  Ok(ResolveOutcome::Created { node_id: new_id })
}

// ── Name normalization ────────────────────────────────────────────────────

/// Map a Latin character with a common diacritic to its ASCII equivalent.
/// Returns None for characters that don't carry a known diacritic.
fn fold_diacritic(c: char) -> Option<char> {
  match c {
    'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' => Some('a'),
    'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' | 'Ā' => Some('a'),
    'é' | 'è' | 'ê' | 'ë' | 'ē' => Some('e'),
    'É' | 'È' | 'Ê' | 'Ë' | 'Ē' => Some('e'),
    'í' | 'ì' | 'î' | 'ï' | 'ī' => Some('i'),
    'Í' | 'Ì' | 'Î' | 'Ï' | 'Ī' => Some('i'),
    'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'ō' => Some('o'),
    'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' | 'Ø' | 'Ō' => Some('o'),
    'ú' | 'ù' | 'û' | 'ü' | 'ū' => Some('u'),
    'Ú' | 'Ù' | 'Û' | 'Ü' | 'Ū' => Some('u'),
    'ñ' | 'Ñ' => Some('n'),
    'ç' | 'Ç' => Some('c'),
    'ß' => Some('s'),
    _ => None,
  }
}

/// Normalize an entity name for comparison: lowercase + diacritic fold +
/// punctuation strip + whitespace collapse. Non-Latin scripts (e.g. Japanese)
/// are left untouched apart from `to_lowercase`. Pure function.
pub fn normalize_name(input: &str) -> String {
  let mut buf = String::with_capacity(input.len());
  let mut prev_space = true; // suppress leading whitespace
  for c in input.chars() {
    let lowered: char = c.to_lowercase().next().unwrap_or(c);
    let folded = fold_diacritic(lowered).unwrap_or(lowered);
    let is_alnum = folded.is_alphanumeric();
    let is_ws = folded.is_whitespace();
    if is_alnum {
      buf.push(folded);
      prev_space = false;
    } else if is_ws {
      if !prev_space {
        buf.push(' ');
        prev_space = true;
      }
    } else {
      // punctuation / other → treat as separator
      if !prev_space {
        buf.push(' ');
        prev_space = true;
      }
    }
  }
  // Trim trailing space (no leading space due to prev_space init).
  if buf.ends_with(' ') {
    buf.pop();
  }
  buf
}

// ── Levenshtein ratio ─────────────────────────────────────────────────────

fn levenshtein_distance(a: &str, b: &str) -> usize {
  let a: Vec<char> = a.chars().collect();
  let b: Vec<char> = b.chars().collect();
  let n = a.len();
  let m = b.len();
  if n == 0 {
    return m;
  }
  if m == 0 {
    return n;
  }
  let mut prev: Vec<usize> = (0..=m).collect();
  let mut curr: Vec<usize> = vec![0; m + 1];
  for i in 1..=n {
    curr[0] = i;
    for j in 1..=m {
      let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
      curr[j] = (curr[j - 1] + 1)
        .min(prev[j] + 1)
        .min(prev[j - 1] + cost);
    }
    std::mem::swap(&mut prev, &mut curr);
  }
  prev[m]
}

// ── is_same_fact / same_entity_different_fact ─────────────────────────────

/// Borrowed view of a fact for comparison. Stable across nodes / freshly
/// extracted facts so callers can compare a `mem_items` row against the
/// LLM's `ExtractedFact` without copying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FactRef<'a> {
  pub entity_id: Option<&'a str>,
  pub entity_name: &'a str,
  pub fact_type: &'a str,
  pub claim: &'a str,
}

/// Threshold for "claim looks the same" in stage 3.
pub const SAME_FACT_CLAIM_RATIO: f64 = 0.85;

/// Threshold for "claim is conflicting (different value)" in `same_entity_different_fact`.
pub const CONFLICT_CLAIM_RATIO: f64 = 0.5;

/// True when `left` and `right` describe the same fact about the same entity.
/// Three-stage judgment per `target-design.md` §3.4. Stage 2 (embedding cosine)
/// is enabled when both sides supply an `embedding`; otherwise it is skipped
/// and we rely on stages 1 and 3 alone.
pub fn is_same_fact(
  left: &FactRef,
  right: &FactRef,
  left_embedding: Option<&[f32]>,
  right_embedding: Option<&[f32]>,
) -> bool {
  // fact_type must match across all stages.
  if left.fact_type != right.fact_type {
    return false;
  }

  let claim_sim = claim_similarity(left.claim, right.claim);
  let high_claim_sim = claim_sim >= SAME_FACT_CLAIM_RATIO;

  // (1) entity_id 一致 + 高 claim 類似度
  //    Connector-supplied entity_id alone does NOT imply same fact: an upstream
  //    re-sync of the same event with a new start_time should be treated as a
  //    conflict, not a merge. The claim similarity gate prevents that.
  if let (Some(a), Some(b)) = (left.entity_id, right.entity_id) {
    if a == b && high_claim_sim {
      return true;
    }
  }

  // (2) embedding cosine ≥ 0.92 (bridges paraphrases that fail Levenshtein)
  if let (Some(la), Some(rb)) = (left_embedding, right_embedding) {
    if cosine_sim(la, rb) >= 0.92 {
      return true;
    }
  }

  // (3) normalize_name 一致 + 高 claim 類似度
  //    Block stage-3 fallback when both sides supply entity_ids that
  //    explicitly disagree — name coincidence ("Alex Chen" the engineer vs
  //    "Alex Chen" the customer) must not collapse two different entities.
  let entity_ids_contradict =
    matches!((left.entity_id, right.entity_id), (Some(a), Some(b)) if a != b);
  if !entity_ids_contradict
    && normalize_name(left.entity_name) == normalize_name(right.entity_name)
    && high_claim_sim
  {
    return true;
  }
  false
}

/// True when `left` and `right` are about the same entity + fact_type but
/// the claim diverges enough to count as a conflict. Used to decide whether
/// to bi-temporal supersede the existing node (see §3.4). Defined as the
/// complement of `is_same_fact` restricted to same-entity / same-fact_type:
///
/// > "same entity + same fact_type + not the same fact = conflict"
///
/// This gives consistent behavior with `is_same_fact` (a pair cannot be both)
/// and avoids the degenerate case where a one-character difference in a short
/// numeric claim (e.g. "July 1" → "July 8") is missed by a flat ratio cutoff.
pub fn same_entity_different_fact(left: &FactRef, right: &FactRef) -> bool {
  if left.fact_type != right.fact_type {
    return false;
  }
  let same_entity = match (left.entity_id, right.entity_id) {
    (Some(a), Some(b)) => a == b,
    _ => normalize_name(left.entity_name) == normalize_name(right.entity_name),
  };
  if !same_entity {
    return false;
  }
  !is_same_fact(left, right, None, None)
}

/// Cosine similarity for two equal-length, L2-normalized embeddings. Returns
/// 0.0 if dimensions differ or either is empty (defensive — embedding pipeline
/// should never produce mismatched sizes in practice).
pub fn cosine_sim(a: &[f32], b: &[f32]) -> f64 {
  if a.is_empty() || a.len() != b.len() {
    return 0.0;
  }
  let mut dot = 0.0f64;
  for i in 0..a.len() {
    dot += a[i] as f64 * b[i] as f64;
  }
  dot
}

/// Token-overlap ratio: |intersection| / |smaller token set|, lowercased.
/// Useful when one claim is a paraphrase that adds words but keeps the same
/// content tokens (e.g. "BYOK rate limit" ⊂ "hit by BYOK rate limit"). Pure
/// function. Returns `1.0` for two empty strings.
pub fn token_overlap_ratio(a: &str, b: &str) -> f64 {
  use std::collections::HashSet;
  let ta: HashSet<String> = a.split_whitespace().map(|s| s.to_lowercase()).collect();
  let tb: HashSet<String> = b.split_whitespace().map(|s| s.to_lowercase()).collect();
  if ta.is_empty() && tb.is_empty() {
    return 1.0;
  }
  let smaller = ta.len().min(tb.len());
  if smaller == 0 {
    return 0.0;
  }
  let inter = ta.intersection(&tb).count();
  inter as f64 / smaller as f64
}

/// Combined claim similarity = max(levenshtein_ratio, token_overlap_ratio).
/// Levenshtein catches small character-level edits; token overlap catches
/// "shorter claim is a content-token subset of the longer claim". Both signals
/// scaled to `[0, 1]` so the same threshold (`SAME_FACT_CLAIM_RATIO`) applies.
pub fn claim_similarity(a: &str, b: &str) -> f64 {
  let l = levenshtein_ratio(a, b);
  let t = token_overlap_ratio(a, b);
  if l > t {
    l
  } else {
    t
  }
}

/// Levenshtein similarity ratio in `[0, 1]`. `1.0` means strings are equal,
/// `0.0` means maximally different. `(left.is_empty() && right.is_empty())`
/// is treated as `1.0` by convention.
pub fn levenshtein_ratio(a: &str, b: &str) -> f64 {
  if a.is_empty() && b.is_empty() {
    return 1.0;
  }
  let dist = levenshtein_distance(a, b) as f64;
  let max_len = a.chars().count().max(b.chars().count()) as f64;
  if max_len == 0.0 {
    return 1.0;
  }
  let r = 1.0 - dist / max_len;
  if r < 0.0 {
    0.0
  } else {
    r
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // ── is_same_fact ───────────────────────────────────────────────────────
  fn fr<'a>(eid: Option<&'a str>, name: &'a str, ft: &'a str, claim: &'a str) -> FactRef<'a> {
    FactRef { entity_id: eid, entity_name: name, fact_type: ft, claim }
  }

  #[test]
  fn is_same_fact_stage1_entity_id_match_plus_claim_match() {
    // Connector entity_id is the strongest signal but we still require the
    // claim itself to look the same — upstream re-syncs of the same event
    // with new start_times should be treated as conflicts, not merges.
    let a = fr(Some("ent_1"), "Whatever name A", "works_at", "works at Acme");
    let b = fr(Some("ent_1"), "totally different name", "works_at", "works at Acme.");
    assert!(is_same_fact(&a, &b, None, None));
  }

  #[test]
  fn is_same_fact_stage1_entity_id_match_blocked_by_changed_claim() {
    // Same entity_id, same fact_type, but the claim was updated upstream —
    // treat as conflict, not duplicate.
    let a = fr(Some("ent_1"), "Q2 launch", "scheduled_at", "July 1");
    let b = fr(Some("ent_1"), "Q2 launch", "scheduled_at", "July 8");
    assert!(!is_same_fact(&a, &b, None, None));
  }

  #[test]
  fn is_same_fact_stage1_entity_id_match_blocked_by_fact_type_mismatch() {
    let a = fr(Some("ent_1"), "X", "works_at", "claim");
    let b = fr(Some("ent_1"), "X", "reports_to", "claim");
    assert!(!is_same_fact(&a, &b, None, None));
  }

  #[test]
  fn is_same_fact_stage3_normalized_name_match_and_high_levenshtein() {
    let a = fr(None, "Alex Chen", "works_at", "works at Acme");
    let b = fr(None, "alex chen", "works_at", "works at Acme");
    assert!(is_same_fact(&a, &b, None, None));
  }

  #[test]
  fn is_same_fact_stage3_blocked_by_different_fact_type() {
    let a = fr(None, "Alex", "works_at", "at Acme");
    let b = fr(None, "Alex", "lives_in", "at Acme");
    assert!(!is_same_fact(&a, &b, None, None));
  }

  #[test]
  fn is_same_fact_stage3_blocked_by_low_levenshtein_ratio() {
    let a = fr(None, "Alex", "works_at", "works at Acme");
    let b = fr(None, "Alex", "works_at", "is the CTO of Beta Industries Tokyo");
    assert!(!is_same_fact(&a, &b, None, None));
  }

  #[test]
  fn is_same_fact_stage2_embedding_cosine_above_threshold() {
    // Synthetic L2-normalized vectors with cosine ≈ 0.94 (above 0.92).
    let a = vec![0.7, 0.71, 0.0, 0.0];
    let b = vec![0.85, 0.526, 0.0, 0.0]; // cosine ≈ 0.7*0.85 + 0.71*0.526 ≈ 0.595 + 0.373 ≈ 0.968
    let l = fr(None, "completely different name", "works_at", "totally different claim");
    let r = fr(None, "another name entirely", "works_at", "another phrasing");
    assert!(
      is_same_fact(&l, &r, Some(&a), Some(&b)),
      "should pass via stage 2",
    );
  }

  #[test]
  fn is_same_fact_stage2_blocked_by_fact_type_mismatch() {
    let a = vec![1.0, 0.0];
    let b = vec![1.0, 0.0]; // cosine 1.0
    let l = fr(None, "X", "works_at", "claim");
    let r = fr(None, "X", "lives_in", "claim");
    assert!(!is_same_fact(&l, &r, Some(&a), Some(&b)));
  }

  #[test]
  fn is_same_fact_returns_false_when_no_stage_passes() {
    let a = fr(None, "Alex", "works_at", "alpha");
    let b = fr(None, "Sam", "works_at", "omega");
    assert!(!is_same_fact(&a, &b, None, None));
  }

  // ── same_entity_different_fact ─────────────────────────────────────────
  #[test]
  fn conflict_when_same_entity_id_and_low_ratio() {
    let a = fr(Some("ent_1"), "Q2 launch", "scheduled_at", "July 1");
    let b = fr(Some("ent_1"), "Q2 launch", "scheduled_at", "July 8");
    assert!(same_entity_different_fact(&a, &b));
  }

  #[test]
  fn conflict_when_same_normalized_name_and_low_ratio() {
    let a = fr(None, "BYOK monthly cap", "default_value", "$10");
    let b = fr(None, "byok monthly cap", "default_value", "$25");
    assert!(same_entity_different_fact(&a, &b));
  }

  #[test]
  fn conflict_blocked_by_different_entity() {
    let a = fr(None, "deploy plan v3", "scheduled_at", "19:00 JST");
    let b = fr(None, "deploy plan v4", "scheduled_at", "21:00 JST");
    assert!(!same_entity_different_fact(&a, &b));
  }

  #[test]
  fn conflict_blocked_by_different_fact_type() {
    let a = fr(None, "Alex", "role", "engineer");
    let b = fr(None, "Alex", "works_at", "engineer at Acme");
    assert!(!same_entity_different_fact(&a, &b));
  }

  #[test]
  fn conflict_blocked_when_claim_ratio_high_enough_to_be_same() {
    // Same entity, same fact_type, claim almost identical → not a conflict.
    let a = fr(None, "Alex", "works_at", "works at Acme");
    let b = fr(None, "Alex", "works_at", "works at Acme.");
    assert!(!same_entity_different_fact(&a, &b));
  }

  // ── cosine_sim ─────────────────────────────────────────────────────────
  #[test]
  fn cosine_sim_returns_zero_for_empty_or_mismatched() {
    assert_eq!(cosine_sim(&[], &[]), 0.0);
    assert_eq!(cosine_sim(&[1.0, 0.0], &[1.0]), 0.0);
  }

  #[test]
  fn cosine_sim_orthogonal_returns_zero() {
    let a = vec![1.0, 0.0];
    let b = vec![0.0, 1.0];
    assert!((cosine_sim(&a, &b) - 0.0).abs() < 1e-9);
  }

  #[test]
  fn cosine_sim_aligned_returns_one() {
    let a = vec![1.0, 0.0];
    let b = vec![1.0, 0.0];
    assert!((cosine_sim(&a, &b) - 1.0).abs() < 1e-9);
  }

  // ── fixture-driven accuracy ────────────────────────────────────────────
  use crate::kioku_eval::{
    fixture_dir, load_jsonl, FactFixture, IsSameFactCase, SameEntityDifferentFactCase,
  };

  fn fact_to_ref<'a>(f: &'a FactFixture) -> FactRef<'a> {
    FactRef {
      entity_id: f.entity_id.as_deref(),
      entity_name: &f.entity_name,
      fact_type: &f.fact_type,
      claim: &f.claim,
    }
  }

  /// Text-only (Levenshtein + token-overlap) baseline for `is_same_fact`.
  /// Without an embedding signal we cannot bridge paraphrases ("staging cut
  /// at 19:00 JST" vs "staging cuts at 7pm Tokyo time") or multilingual
  /// equivalents ("by Friday" vs "金曜まで"). The 28/30 ship gate from
  /// `migration-plan.md` §Select-C requires plugging real embeddings into
  /// stage 2; this constant freezes the text-only floor so future PRs that
  /// regress the floor are caught.
  const IS_SAME_FACT_GATE: usize = 16;

  /// Same baseline policy for `same_entity_different_fact`. The remaining
  /// misses are "additive vs replacing" disambiguation cases that need
  /// semantic context to call correctly.
  const SAME_ENTITY_DIFFERENT_FACT_GATE: usize = 10;

  #[test]
  fn fixture_is_same_fact_meets_text_only_baseline() {
    let path = fixture_dir().join("is_same_fact_cases.jsonl");
    let cases: Vec<IsSameFactCase> = load_jsonl(&path).expect("load");
    assert_eq!(cases.len(), 30, "expect exactly 30 fixture cases");

    let mut correct = 0usize;
    let mut wrong: Vec<(String, bool, bool, Option<String>)> = Vec::new();
    for c in &cases {
      let l = fact_to_ref(&c.left);
      let r = fact_to_ref(&c.right);
      let actual = is_same_fact(&l, &r, None, None);
      if actual == c.expected {
        correct += 1;
      } else {
        wrong.push((c.id.clone(), c.expected, actual, c.category.clone()));
      }
    }
    println!(
      "is_same_fact accuracy: {}/{} (gate {}). Misses: {:?}",
      correct,
      cases.len(),
      IS_SAME_FACT_GATE,
      wrong,
    );
    assert!(
      correct >= IS_SAME_FACT_GATE,
      "is_same_fact accuracy {}/{} below text-only gate {}",
      correct,
      cases.len(),
      IS_SAME_FACT_GATE,
    );
  }

  #[test]
  fn fixture_same_entity_different_fact_meets_baseline() {
    let path = fixture_dir().join("same_entity_different_fact_cases.jsonl");
    let cases: Vec<SameEntityDifferentFactCase> = load_jsonl(&path).expect("load");
    assert_eq!(cases.len(), 15, "expect exactly 15 fixture cases");

    let mut correct = 0usize;
    let mut wrong: Vec<(String, bool, bool, Option<String>)> = Vec::new();
    for c in &cases {
      let l = fact_to_ref(&c.left);
      let r = fact_to_ref(&c.right);
      let actual = same_entity_different_fact(&l, &r);
      if actual == c.expected {
        correct += 1;
      } else {
        wrong.push((c.id.clone(), c.expected, actual, c.category.clone()));
      }
    }
    println!(
      "same_entity_different_fact accuracy: {}/{} (gate {}). Misses: {:?}",
      correct,
      cases.len(),
      SAME_ENTITY_DIFFERENT_FACT_GATE,
      wrong,
    );
    assert!(
      correct >= SAME_ENTITY_DIFFERENT_FACT_GATE,
      "same_entity_different_fact accuracy {}/{} below gate {}",
      correct,
      cases.len(),
      SAME_ENTITY_DIFFERENT_FACT_GATE,
    );
  }

  // ── resolve_worker_config ──────────────────────────────────────────────
  #[test]
  fn worker_config_default_has_worker_disabled() {
    let cfg = resolve_worker_config(&serde_json::json!({}));
    assert!(!cfg.enabled);
    assert_eq!(cfg.model, "gemini-2.5-flash");
    assert_eq!(cfg.fallback_model, "gemini-2.5-flash");
    assert_eq!(cfg.poll_interval_secs, 30);
    assert_eq!(cfg.max_jobs_per_tick, 5);
    assert_eq!(cfg.monthly_cap_usd, crate::cost_ledger::DEFAULT_MONTHLY_CAP_USD);
    assert_eq!(cfg.cap_action, crate::cost_ledger::CAP_ACTION_PAUSE_EXTRACTION);
  }

  #[test]
  fn worker_config_picks_up_extraction_model_override() {
    let s = serde_json::json!({
      "sections": { "llm": { "extractionModel": "claude-sonnet-4-6" } }
    });
    let cfg = resolve_worker_config(&s);
    assert_eq!(cfg.model, "claude-sonnet-4-6");
  }

  #[test]
  fn worker_config_picks_up_kioku_cost_overrides() {
    let s = serde_json::json!({
      "sections": {
        "kioku_cost": {
          "monthly_cap_usd": 25.0,
          "cap_action": "fallback_to_lighter",
          "fallback_model": "claude-haiku-4-5"
        }
      }
    });
    let cfg = resolve_worker_config(&s);
    assert!((cfg.monthly_cap_usd - 25.0).abs() < 1e-9);
    assert_eq!(cfg.cap_action, "fallback_to_lighter");
    assert_eq!(cfg.fallback_model, "claude-haiku-4-5");
  }

  #[test]
  fn worker_config_clamps_poll_interval_and_max_jobs() {
    let s = serde_json::json!({
      "sections": {
        "kioku_graph": {
          "poll_interval_secs": 1, // below clamp
          "max_jobs_per_tick": 999  // above clamp
        }
      }
    });
    let cfg = resolve_worker_config(&s);
    assert_eq!(cfg.poll_interval_secs, 5);
    assert_eq!(cfg.max_jobs_per_tick, 50);
  }

  #[test]
  fn worker_config_enables_when_settings_say_so() {
    let s = serde_json::json!({
      "sections": { "kioku_graph": { "worker_enabled": true } }
    });
    let cfg = resolve_worker_config(&s);
    assert!(cfg.enabled);
  }

  #[test]
  fn worker_config_rejects_invalid_cap() {
    let s = serde_json::json!({
      "sections": { "kioku_cost": { "monthly_cap_usd": -5.0 } }
    });
    let cfg = resolve_worker_config(&s);
    // Negative cap is rejected → falls back to default.
    assert_eq!(cfg.monthly_cap_usd, crate::cost_ledger::DEFAULT_MONTHLY_CAP_USD);
  }

  // ── pick_next_eligible_job ─────────────────────────────────────────────
  #[test]
  fn pick_returns_none_for_empty_queue() {
    let conn = open_test_conn();
    assert_eq!(pick_next_eligible_job(&conn, 1_000).unwrap(), None);
  }

  #[test]
  fn pick_returns_oldest_eligible_first() {
    let conn = open_test_conn();
    let (_c1, j1) = seed_capture_and_job(&conn, 1_000);
    std::thread::sleep(std::time::Duration::from_millis(2));
    let (_c2, _j2) = seed_capture_and_job(&conn, 1_001);
    let picked = pick_next_eligible_job(&conn, 5_000).unwrap();
    assert_eq!(picked, Some(j1));
  }

  #[test]
  fn pick_skips_jobs_with_future_next_attempt() {
    let conn = open_test_conn();
    let (_c1, j1) = seed_capture_and_job(&conn, 1_000);
    let (_c2, j2) = seed_capture_and_job(&conn, 1_001);
    conn
      .execute(
        "UPDATE extraction_jobs SET next_attempt_at = 10_000 WHERE id = ?1",
        params![j1],
      )
      .unwrap();
    let picked = pick_next_eligible_job(&conn, 5_000).unwrap();
    assert_eq!(picked, Some(j2));
  }

  #[test]
  fn pick_includes_job_after_next_attempt_passes() {
    let conn = open_test_conn();
    let (_c1, j1) = seed_capture_and_job(&conn, 1_000);
    conn
      .execute(
        "UPDATE extraction_jobs SET next_attempt_at = 100 WHERE id = ?1",
        params![j1],
      )
      .unwrap();
    let picked = pick_next_eligible_job(&conn, 200).unwrap();
    assert_eq!(picked, Some(j1));
  }

  #[test]
  fn pick_skips_running_or_done_or_failed() {
    let conn = open_test_conn();
    let (_c1, _j1) = seed_capture_and_job(&conn, 1_000);
    let (_c2, _j2) = seed_capture_and_job(&conn, 1_001);
    let (_c3, _j3) = seed_capture_and_job(&conn, 1_002);
    conn
      .execute(
        "UPDATE extraction_jobs SET status = CASE id WHEN 1 THEN 'running' WHEN 2 THEN 'done' WHEN 3 THEN 'failed' ELSE 'queued' END",
        [],
      )
      .unwrap();
    assert_eq!(pick_next_eligible_job(&conn, 5_000).unwrap(), None);
  }

  // ── run_worker_tick ────────────────────────────────────────────────────
  #[test]
  fn tick_pauses_when_cap_exceeded() {
    let conn = open_test_conn();
    let (_c, _j) = seed_capture_and_job(&conn, 1_000);
    // Seed an over-cap month spend.
    crate::cost_ledger::record(
      &crate::cost_ledger::LedgerEntry {
        recorded_at_ms: 1_000,
        model: "claude-haiku-4-5".into(),
        purpose: crate::cost_ledger::PURPOSE_EXTRACTION.into(),
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 100.0,
        job_id: None,
        meta_json: None,
      },
      &conn,
    )
    .unwrap();
    let client = FakeClient::ok(vec![]);
    let report = run_worker_tick(
      &client,
      &conn,
      2_000,
      10.0,
      crate::cost_ledger::CAP_ACTION_PAUSE_EXTRACTION,
      None,
      5,
    )
    .unwrap();
    assert!(report.paused);
    assert_eq!(report.jobs_processed, 0);
    assert!(report.paused_reason.unwrap().contains("pausing extraction"));
  }

  #[test]
  fn tick_drains_queue_under_max_jobs() {
    let conn = open_test_conn();
    for i in 0..3i64 {
      let _ = seed_capture_and_job(&conn, 1_000 + i);
    }
    let client = FakeClient::ok(vec![fact("X", "ft", "claim")]);
    // FakeClient is single-shot; we need a multi-shot client to drain 3 jobs.
    // Use a counter-based fake instead.
    struct MultiClient;
    impl ExtractionClient for MultiClient {
      fn extract(&self, _ctx: &CaptureContext) -> Result<ExtractionResponse, ExtractionError> {
        Ok(ExtractionResponse {
          facts: vec![ExtractedFact {
            entity_id: None,
            entity_name: "E".into(),
            fact_type: "ft".into(),
            claim: "c".into(),
            confidence: 0.9,
            node_kind: "entity".into(),
            related_ids: Vec::new(),
            edge_types_for_related: Vec::new(),
          }],
          model: "claude-haiku-4-5".into(),
          input_tokens: 100,
          output_tokens: 20,
          ..Default::default()
        })
      }
    }
    let _ = client;
    let report = run_worker_tick(
      &MultiClient,
      &conn,
      2_000,
      100.0,
      crate::cost_ledger::CAP_ACTION_PAUSE_EXTRACTION,
      None,
      10,
    )
    .unwrap();
    assert!(!report.paused);
    assert_eq!(report.jobs_processed, 3);
  }

  #[test]
  fn tick_respects_max_jobs_per_tick() {
    let conn = open_test_conn();
    for i in 0..5i64 {
      let _ = seed_capture_and_job(&conn, 1_000 + i);
    }
    struct MultiClient;
    impl ExtractionClient for MultiClient {
      fn extract(&self, _ctx: &CaptureContext) -> Result<ExtractionResponse, ExtractionError> {
        Ok(ExtractionResponse {
          facts: Vec::new(),
          model: "claude-haiku-4-5".into(),
          input_tokens: 100,
          output_tokens: 0,
          ..Default::default()
        })
      }
    }
    let report = run_worker_tick(
      &MultiClient,
      &conn,
      2_000,
      100.0,
      crate::cost_ledger::CAP_ACTION_PAUSE_EXTRACTION,
      None,
      2,
    )
    .unwrap();
    assert_eq!(report.jobs_processed, 2);
  }

  #[test]
  fn tick_reports_used_fallback_when_cap_action_falls_back() {
    let conn = open_test_conn();
    crate::cost_ledger::record(
      &crate::cost_ledger::LedgerEntry {
        recorded_at_ms: 1_000,
        model: "claude-sonnet-4-6".into(),
        purpose: crate::cost_ledger::PURPOSE_EXTRACTION.into(),
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 12.0,
        job_id: None,
        meta_json: None,
      },
      &conn,
    )
    .unwrap();
    struct NoopClient;
    impl ExtractionClient for NoopClient {
      fn extract(&self, _ctx: &CaptureContext) -> Result<ExtractionResponse, ExtractionError> {
        Ok(ExtractionResponse {
          facts: Vec::new(),
          model: "claude-haiku-4-5".into(),
          input_tokens: 0,
          output_tokens: 0,
          ..Default::default()
        })
      }
    }
    let report = run_worker_tick(
      &NoopClient,
      &conn,
      2_000,
      10.0,
      crate::cost_ledger::CAP_ACTION_FALLBACK_TO_LIGHTER,
      Some("claude-haiku-4-5"),
      5,
    )
    .unwrap();
    assert!(report.used_fallback);
    assert_eq!(report.model_used.as_deref(), Some("claude-haiku-4-5"));
  }

  // ── classify_anthropic_error ───────────────────────────────────────────
  #[test]
  fn classify_network_errors_as_transient() {
    for msg in [
      "Anthropic tool_use network error: connection refused",
      "Anthropic tool_use body: stream timed out",
      "request timeout",
    ] {
      match classify_anthropic_error(msg) {
        ExtractionError::Transient(_) => {}
        other => panic!("expected transient for: {} got {:?}", msg, other),
      }
    }
  }

  #[test]
  fn classify_5xx_and_rate_limits_as_transient() {
    for msg in [
      "Anthropic tool_use 429: rate limit",
      "Anthropic tool_use 529: overloaded",
      "Anthropic tool_use 500: internal",
      "Anthropic tool_use 503: service unavailable",
    ] {
      match classify_anthropic_error(msg) {
        ExtractionError::Transient(_) => {}
        _ => panic!("expected transient for: {}", msg),
      }
    }
  }

  #[test]
  fn classify_4xx_and_parse_errors_as_permanent() {
    for msg in [
      "Anthropic tool_use 400: bad request",
      "Anthropic tool_use 401: unauthenticated",
      "Anthropic tool_use 403: forbidden",
      "Anthropic tool_use JSON parse: expected value",
      "Anthropic response missing content array",
      "tool_use missing input",
    ] {
      match classify_anthropic_error(msg) {
        ExtractionError::Permanent(_) => {}
        _ => panic!("expected permanent for: {}", msg),
      }
    }
  }

  // ── AnthropicExtractionClient prompt construction ──────────────────────
  #[test]
  fn anthropic_client_user_message_includes_metadata_and_clips_long_body() {
    let big_body = "x".repeat(20_000);
    let ctx = CaptureContext {
      kind: "screen_app".into(),
      raw_text: Some(big_body),
      app_bundle_id: Some("com.tinyspeck.slackmacgap".into()),
      window_title: Some("Slack | #shogun-eng".into()),
      url: None,
      captured_at_ms: 1_714_000_000_000,
    };
    let msg = AnthropicExtractionClient::build_user_message(&ctx);
    assert!(msg.contains("kind: screen_app"));
    assert!(msg.contains("app_bundle_id: com.tinyspeck.slackmacgap"));
    assert!(msg.contains("window_title: Slack | #shogun-eng"));
    assert!(msg.contains("captured_at_ms: 1714000000000"));
    // Body must have been clipped to 8000 chars (plus the metadata header).
    assert!(msg.chars().count() < 9000, "got {} chars", msg.chars().count());
  }

  #[test]
  fn anthropic_client_user_message_handles_missing_raw_text() {
    let ctx = CaptureContext {
      kind: "screen_app".into(),
      raw_text: None,
      app_bundle_id: None,
      window_title: None,
      url: None,
      captured_at_ms: 1_714_000_000_000,
    };
    let msg = AnthropicExtractionClient::build_user_message(&ctx);
    assert!(msg.contains("(no raw_text"), "got: {}", msg);
  }

  #[test]
  fn anthropic_client_tool_uses_extraction_schema() {
    let tool = AnthropicExtractionClient::build_tool();
    assert_eq!(tool["name"], serde_json::json!(EXTRACTION_TOOL_NAME));
    let schema = &tool["input_schema"];
    // Sanity that the tool's input_schema is the same value we exported.
    assert_eq!(schema["type"], serde_json::json!("object"));
    let required = schema["properties"]["facts"]["items"]["required"]
      .as_array()
      .expect("required");
    let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
    for must in ["entity_name", "fact_type", "claim", "confidence", "node_kind"] {
      assert!(names.contains(&must));
    }
  }

  // ── process_one_job (worker) ───────────────────────────────────────────
  /// Fake client that returns a canned response or error.
  struct FakeClient {
    response: std::cell::RefCell<Option<Result<ExtractionResponse, ExtractionError>>>,
  }
  impl FakeClient {
    fn ok(facts: Vec<ExtractedFact>) -> Self {
      FakeClient {
        response: std::cell::RefCell::new(Some(Ok(ExtractionResponse {
          facts,
          model: "claude-haiku-4-5".into(),
          input_tokens: 2_000,
          output_tokens: 400,
          ..Default::default()
        }))),
      }
    }
    fn err_transient(msg: &str) -> Self {
      FakeClient {
        response: std::cell::RefCell::new(Some(Err(ExtractionError::Transient(msg.into())))),
      }
    }
    fn err_permanent(msg: &str) -> Self {
      FakeClient {
        response: std::cell::RefCell::new(Some(Err(ExtractionError::Permanent(msg.into())))),
      }
    }
  }
  impl ExtractionClient for FakeClient {
    fn extract(&self, _ctx: &CaptureContext) -> Result<ExtractionResponse, ExtractionError> {
      self
        .response
        .borrow_mut()
        .take()
        .expect("FakeClient::extract called twice")
    }
  }

  fn seed_capture_and_job(conn: &Connection, captured_at: i64) -> (i64, i64) {
    let cap_id = crate::mem_captures::record(
      &crate::mem_captures::CaptureInput {
        kind: "screen_app".into(),
        raw_text: Some("app=Slack".into()),
        app_bundle_id: Some("com.tinyspeck.slackmacgap".into()),
        captured_at_ms: captured_at,
        ..Default::default()
      },
      conn,
    )
    .expect("seed capture");
    let job_id = crate::extraction_jobs::enqueue(
      Some(cap_id),
      crate::extraction_jobs::JOB_KIND_EXTRACT,
      captured_at,
      None,
      conn,
    )
    .expect("seed job");
    (cap_id, job_id)
  }

  #[test]
  fn process_one_job_happy_path_inserts_facts_and_records_cost() {
    let conn = open_test_conn();
    let (_cap_id, job_id) = seed_capture_and_job(&conn, 1_000);
    let client = FakeClient::ok(vec![
      fact("Alex Chen", "works_at", "works at Acme"),
      fact("Acme", "is_org", "Acme is an org"),
    ]);
    let outcome = process_one_job(job_id, &client, 2_000, &conn).expect("ok");
    match outcome {
      JobOutcome::Done { fact_count, cost_usd } => {
        assert_eq!(fact_count, 2);
        assert!((cost_usd - 0.004).abs() < 1e-9, "got {}", cost_usd);
      }
      other => panic!("expected Done, got {:?}", other),
    }

    // Job: status='done' with finished_at set.
    let (status, finished, attempts): (String, Option<i64>, i64) = conn
      .query_row(
        "SELECT status, finished_at, attempts FROM extraction_jobs WHERE id = ?1",
        params![job_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, i64>(2)?)),
      )
      .expect("row");
    assert_eq!(status, "done");
    assert_eq!(finished, Some(2_000));
    assert_eq!(attempts, 1);

    // mem_items: 2 new rows (one per fact)
    let mem_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
      .unwrap();
    assert_eq!(mem_count, 2);

    // cost_ledger: 1 row tagged with the job
    let ledger: (String, String, i64, i64, f64, Option<i64>) = conn
      .query_row(
        "SELECT model, purpose, input_tokens, output_tokens, cost_usd, job_id
         FROM cost_ledger ORDER BY id DESC LIMIT 1",
        [],
        |r| {
          Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
          ))
        },
      )
      .expect("ledger");
    assert_eq!(ledger.0, "claude-haiku-4-5");
    assert_eq!(ledger.1, "extraction");
    assert_eq!(ledger.2, 2_000);
    assert_eq!(ledger.3, 400);
    assert!((ledger.4 - 0.004).abs() < 1e-9);
    assert_eq!(ledger.5, Some(job_id));
  }

  #[test]
  fn process_one_job_marks_failed_on_permanent_error() {
    let conn = open_test_conn();
    let (_cap_id, job_id) = seed_capture_and_job(&conn, 1_000);
    let client = FakeClient::err_permanent("schema mismatch");
    let outcome = process_one_job(job_id, &client, 2_000, &conn).expect("returned");
    match outcome {
      JobOutcome::Failed { reason } => {
        assert!(reason.contains("schema mismatch"));
      }
      other => panic!("expected Failed, got {:?}", other),
    }
    let (status, last_err, attempts): (String, Option<String>, i64) = conn
      .query_row(
        "SELECT status, last_error, attempts FROM extraction_jobs WHERE id = ?1",
        params![job_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
      )
      .expect("row");
    assert_eq!(status, "failed");
    assert!(last_err.unwrap().contains("schema mismatch"));
    assert_eq!(attempts, 1);
  }

  #[test]
  fn process_one_job_retries_on_transient_with_backoff() {
    let conn = open_test_conn();
    let (_cap_id, job_id) = seed_capture_and_job(&conn, 1_000);
    let client = FakeClient::err_transient("429 rate limit");
    let outcome = process_one_job(job_id, &client, 2_000, &conn).expect("returned");
    match outcome {
      JobOutcome::Retry { attempts, next_attempt_at_ms, reason } => {
        assert_eq!(attempts, 1);
        // First attempt: 60 s backoff
        assert_eq!(next_attempt_at_ms, 2_000 + 60_000);
        assert!(reason.contains("transient"));
        assert!(reason.contains("429 rate limit"));
      }
      other => panic!("expected Retry, got {:?}", other),
    }
    let (status, attempts, next_at): (String, i64, Option<i64>) = conn
      .query_row(
        "SELECT status, attempts, next_attempt_at FROM extraction_jobs WHERE id = ?1",
        params![job_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
      )
      .expect("row");
    assert_eq!(status, "queued");
    assert_eq!(attempts, 1);
    assert_eq!(next_at, Some(2_000 + 60_000));
  }

  #[test]
  fn process_one_job_gives_up_after_max_attempts_on_transient() {
    let conn = open_test_conn();
    let (_cap_id, job_id) = seed_capture_and_job(&conn, 1_000);
    // Bump attempts to one less than max so this run hits the wall.
    conn
      .execute(
        "UPDATE extraction_jobs SET attempts = max_attempts - 1 WHERE id = ?1",
        params![job_id],
      )
      .unwrap();
    let client = FakeClient::err_transient("429 rate limit");
    let outcome = process_one_job(job_id, &client, 2_000, &conn).expect("returned");
    match outcome {
      JobOutcome::Failed { reason } => {
        assert!(reason.contains("transient"));
      }
      other => panic!("expected Failed, got {:?}", other),
    }
    let (status, attempts): (String, i64) = conn
      .query_row(
        "SELECT status, attempts FROM extraction_jobs WHERE id = ?1",
        params![job_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
      )
      .expect("row");
    assert_eq!(status, "failed");
    // attempts was max-1, then bumped once = max. (Default max is 3.)
    assert_eq!(attempts, 3);
  }

  // ── next_attempt_after_transient backoff math ──────────────────────────
  #[test]
  fn backoff_doubles_per_attempt() {
    let now = 100_000;
    assert_eq!(next_attempt_after_transient(now, 1), now + 60_000);
    assert_eq!(next_attempt_after_transient(now, 2), now + 120_000);
    assert_eq!(next_attempt_after_transient(now, 3), now + 240_000);
  }

  #[test]
  fn backoff_caps_at_one_hour() {
    let now = 100_000;
    let v = next_attempt_after_transient(now, 30);
    assert_eq!(v - now, 60 * 60_000, "expected 1 hour cap");
  }

  #[test]
  fn backoff_handles_zero_or_negative_attempts() {
    let now = 100_000;
    // attempts=0 should still produce the 60s minimum (treat as first try).
    assert_eq!(next_attempt_after_transient(now, 0), now + 60_000);
    assert_eq!(next_attempt_after_transient(now, -5), now + 60_000);
  }

  #[test]
  fn process_one_job_skips_when_capture_is_missing() {
    let conn = open_test_conn();
    // Enqueue a summarize-style job with no capture_id. The worker should
    // still notice this is an extract job (default kind) and skip.
    let job_id = crate::extraction_jobs::enqueue(
      None,
      crate::extraction_jobs::JOB_KIND_SUMMARIZE,
      1_000,
      None,
      &conn,
    )
    .expect("enqueue");
    // Force the kind back to extract — without a capture, it has nothing to do.
    conn
      .execute(
        "UPDATE extraction_jobs SET job_kind = 'extract' WHERE id = ?1",
        params![job_id],
      )
      .unwrap();

    let client = FakeClient::ok(vec![]);
    let outcome = process_one_job(job_id, &client, 2_000, &conn).expect("returned");
    match outcome {
      JobOutcome::Skipped { reason } => {
        assert!(reason.contains("capture"), "got: {}", reason);
      }
      other => panic!("expected Skipped, got {:?}", other),
    }
  }

  #[test]
  fn process_one_job_returns_done_with_zero_facts_when_llm_emits_nothing() {
    let conn = open_test_conn();
    let (_cap_id, job_id) = seed_capture_and_job(&conn, 1_000);
    let client = FakeClient::ok(vec![]);
    let outcome = process_one_job(job_id, &client, 2_000, &conn).expect("ok");
    match outcome {
      JobOutcome::Done { fact_count, cost_usd } => {
        assert_eq!(fact_count, 0);
        assert!((cost_usd - 0.004).abs() < 1e-9);
      }
      other => panic!("expected Done, got {:?}", other),
    }
  }

  // ── resolve_write integration tests ────────────────────────────────────
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

  fn fact(name: &str, ft: &str, claim: &str) -> ExtractedFact {
    ExtractedFact {
      entity_id: None,
      entity_name: name.into(),
      fact_type: ft.into(),
      claim: claim.into(),
      confidence: 0.9,
      node_kind: "entity".into(),
      related_ids: Vec::new(),
      edge_types_for_related: Vec::new(),
    }
  }

  #[test]
  fn resolve_write_stores_claim_embedding_on_new_node() {
    // The blob written into mem_items.embedding must round-trip back to the
    // f32 vector we passed in, so future fact comparisons can compare cosines.
    let conn = open_test_conn();
    let f = fact("Alex Chen", "works_at", "works at Acme");
    let emb: Vec<f32> = vec![0.6, 0.8, 0.0];
    let outcome = resolve_write(&f, Some(&emb), None, 1_000, &conn).expect("ok");
    let id = match outcome {
      ResolveOutcome::Created { node_id } => node_id,
      _ => panic!("expected Created"),
    };
    let blob: Option<Vec<u8>> = conn
      .query_row(
        "SELECT embedding FROM mem_items WHERE id = ?1",
        rusqlite::params![id],
        |r| r.get(0),
      )
      .expect("row");
    let decoded = decode_embedding_blob(&blob.expect("blob present")).expect("decode");
    assert_eq!(decoded.len(), emb.len());
    for (a, b) in decoded.iter().zip(emb.iter()) {
      assert!((a - b).abs() < 1e-6, "{} vs {}", a, b);
    }
  }

  #[test]
  fn resolve_write_merges_via_embedding_cosine_when_text_diverges() {
    // Simulate a paraphrase that's textually distant ("staging cut at 19:00 JST"
    // vs "production cut Tokyo evening") but semantically identical: caller
    // passes nearly-aligned embeddings, so stage 2 of is_same_fact engages.
    let conn = open_test_conn();
    let mut f1 = fact("deploy plan v3", "scheduled_at", "staging cut at 19:00 JST");
    f1.entity_id = Some("ent_dpv3".into());
    let emb_a: Vec<f32> = vec![0.6, 0.8, 0.0];
    let first = resolve_write(&f1, Some(&emb_a), None, 1_000, &conn).expect("first");
    let first_id = match first {
      ResolveOutcome::Created { node_id } => node_id,
      _ => panic!("expected Created"),
    };
    // Stage-3 text path would fail (low Levenshtein, low token overlap), and
    // we omit entity_id on the new fact so stage 1 cannot help either.
    let f2 = fact("deploy plan v3", "scheduled_at", "production cut Tokyo evening");
    let emb_b: Vec<f32> = vec![0.62, 0.785, 0.0]; // cosine ≈ 0.997 with emb_a
    let second = resolve_write(&f2, Some(&emb_b), None, 2_000, &conn).expect("second");
    match second {
      ResolveOutcome::Merged { node_id, .. } => {
        assert_eq!(
          node_id, first_id,
          "embedding cosine should have merged paraphrase with first node",
        );
      }
      other => panic!("expected Merged via embedding cosine, got {:?}", other),
    }
  }

  #[test]
  fn resolve_write_does_not_merge_when_embeddings_orthogonal() {
    // Even with the same fact_type and same entity name, sufficiently
    // different embeddings + sufficiently different claims must NOT merge.
    let conn = open_test_conn();
    let f1 = fact("Alex", "preference", "loves green tea");
    let emb_a: Vec<f32> = vec![1.0, 0.0, 0.0];
    let _ = resolve_write(&f1, Some(&emb_a), None, 1_000, &conn).expect("first");

    let f2 = fact("Alex", "preference", "prefers black coffee");
    let emb_b: Vec<f32> = vec![0.0, 1.0, 0.0]; // orthogonal
    let outcome = resolve_write(&f2, Some(&emb_b), None, 2_000, &conn).expect("second");
    match outcome {
      ResolveOutcome::Superseded { .. } => {
        // Same entity + same fact_type + low text similarity ⇒ valid conflict.
      }
      other => panic!("expected Superseded for orthogonal embeddings, got {:?}", other),
    }
  }

  #[test]
  fn resolve_write_creates_new_node_in_empty_db() {
    let conn = open_test_conn();
    let f = fact("Alex Chen", "works_at", "works at Acme");
    let outcome = resolve_write(&f, None, None, 1_000, &conn).expect("resolve");
    let node_id = match outcome {
      ResolveOutcome::Created { node_id } => node_id,
      other => panic!("expected Created, got {:?}", other),
    };
    let title: String = conn
      .query_row(
        "SELECT title FROM mem_items WHERE id = ?1",
        params![node_id],
        |r| r.get(0),
      )
      .expect("row");
    assert_eq!(title, "Alex Chen");
  }

  #[test]
  fn resolve_write_merges_with_existing_same_fact() {
    let conn = open_test_conn();
    let f = fact("Alex Chen", "works_at", "works at Acme");
    let first = resolve_write(&f, None, None, 1_000, &conn).expect("first");
    let first_id = match first {
      ResolveOutcome::Created { node_id } => node_id,
      _ => panic!("first should be Created"),
    };
    // Repeat with phrasing variant.
    let mut f2 = fact("alex chen", "works_at", "works at Acme.");
    f2.confidence = 0.92;
    let second = resolve_write(&f2, None, None, 2_000, &conn).expect("second");
    match second {
      ResolveOutcome::Merged { node_id, access_count_after } => {
        assert_eq!(node_id, first_id);
        assert_eq!(access_count_after, 1);
      }
      other => panic!("expected Merged, got {:?}", other),
    }
    // last_accessed_at should advance to the merge time.
    let last: i64 = conn
      .query_row(
        "SELECT last_accessed_at FROM mem_items WHERE id = ?1",
        params![first_id],
        |r| r.get(0),
      )
      .expect("row");
    assert_eq!(last, 2_000);
  }

  #[test]
  fn resolve_write_supersedes_on_conflict() {
    let conn = open_test_conn();
    // Seed: Q2 launch / scheduled_at / July 1
    let mut f1 = fact("Q2 launch", "scheduled_at", "July 1");
    f1.entity_id = Some("ent_q2".into());
    let first = resolve_write(&f1, None, None, 1_000, &conn).expect("first");
    let old_id = match first {
      ResolveOutcome::Created { node_id } => node_id,
      _ => panic!("expected Created"),
    };

    // Conflict: same entity, different date
    let mut f2 = fact("Q2 launch", "scheduled_at", "July 8");
    f2.entity_id = Some("ent_q2".into());
    let outcome = resolve_write(&f2, None, None, 2_000, &conn).expect("second");
    let new_id = match outcome {
      ResolveOutcome::Superseded { old_id: o, new_id: n } => {
        assert_eq!(o, old_id);
        n
      }
      other => panic!("expected Superseded, got {:?}", other),
    };

    // Old row valid_to should be set to the conflict timestamp.
    let valid_to: Option<i64> = conn
      .query_row(
        "SELECT valid_to FROM mem_items WHERE id = ?1",
        params![old_id],
        |r| r.get(0),
      )
      .expect("row");
    assert_eq!(valid_to, Some(2_000));

    // A `supersedes` edge should connect new → old.
    let edge_count: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM mem_edges
         WHERE from_node = ?1 AND to_node = ?2 AND edge_type = 'supersedes'",
        params![new_id, old_id],
        |r| r.get(0),
      )
      .expect("row");
    assert_eq!(edge_count, 1);
  }

  #[test]
  fn resolve_write_adds_relation_edges_for_new_node() {
    let conn = open_test_conn();
    // Seed two existing target nodes that this fact will link to.
    let target_a = resolve_write(&fact("Acme", "is_org", "Acme is an org"), None, None, 1_000, &conn)
      .expect("a");
    let target_a_id = match target_a {
      ResolveOutcome::Created { node_id } => node_id,
      _ => panic!(),
    };
    let target_b = resolve_write(&fact("Q2 launch", "is_event", "Q2 launch event"), None, None, 1_000, &conn)
      .expect("b");
    let target_b_id = match target_b {
      ResolveOutcome::Created { node_id } => node_id,
      _ => panic!(),
    };

    let mut f = fact("Alex", "works_at", "works at Acme");
    f.related_ids = vec![target_a_id.clone(), target_b_id.clone()];
    f.edge_types_for_related = vec!["mentions".into(), "attended".into()];
    let outcome = resolve_write(&f, None, None, 2_000, &conn).expect("resolve");
    let new_id = match outcome {
      ResolveOutcome::Created { node_id } => node_id,
      _ => panic!(),
    };

    let edges: Vec<(String, String)> = conn
      .prepare("SELECT to_node, edge_type FROM mem_edges WHERE from_node = ?1 ORDER BY id")
      .unwrap()
      .query_map(params![new_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
      })
      .unwrap()
      .filter_map(|x| x.ok())
      .collect();
    assert_eq!(edges.len(), 2);
    assert_eq!(edges[0], (target_a_id.clone(), "mentions".into()));
    assert_eq!(edges[1], (target_b_id.clone(), "attended".into()));
  }

  #[test]
  fn resolve_write_does_not_collapse_distinct_entities() {
    let conn = open_test_conn();
    // Same-name "Alex Chen", same fact_type, same claim — but different entity_id.
    let mut a = fact("Alex Chen", "works_at", "works at Acme");
    a.entity_id = Some("person_alex_chen".into());
    let _ = resolve_write(&a, None, None, 1_000, &conn).expect("first");

    let mut b = fact("Alex Chen", "works_at", "works at Acme");
    b.entity_id = Some("person_someone_else".into());
    let outcome = resolve_write(&b, None, None, 2_000, &conn).expect("second");
    match outcome {
      ResolveOutcome::Created { .. } => {}
      other => panic!("expected separate Created, got {:?}", other),
    }
    let total: i64 = conn
      .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
      .expect("count");
    assert_eq!(total, 2);
  }

  // ── ExtractedFact JSON round-trip ──────────────────────────────────────
  #[test]
  fn extracted_fact_parses_from_minimum_fields() {
    let raw = serde_json::json!({
      "entity_name": "Alex Chen",
      "fact_type": "works_at",
      "claim": "works at Acme",
      "confidence": 0.92,
      "node_kind": "entity"
    });
    let f: ExtractedFact = serde_json::from_value(raw).expect("parse");
    assert_eq!(f.entity_id, None);
    assert_eq!(f.entity_name, "Alex Chen");
    assert_eq!(f.fact_type, "works_at");
    assert_eq!(f.claim, "works at Acme");
    assert!((f.confidence - 0.92).abs() < 1e-9);
    assert_eq!(f.node_kind, "entity");
    assert!(f.related_ids.is_empty());
    assert!(f.edge_types_for_related.is_empty());
  }

  #[test]
  fn extracted_fact_parses_with_optional_relations() {
    let raw = serde_json::json!({
      "entity_id": "person_alex",
      "entity_name": "Alex",
      "fact_type": "works_at",
      "claim": "works at Acme",
      "confidence": 0.9,
      "node_kind": "entity",
      "related_ids": ["m_org_acme", "m_event_intro_call"],
      "edge_types_for_related": ["mentions", "attended"]
    });
    let f: ExtractedFact = serde_json::from_value(raw).expect("parse");
    assert_eq!(f.entity_id.as_deref(), Some("person_alex"));
    assert_eq!(f.related_ids, vec!["m_org_acme", "m_event_intro_call"]);
    assert_eq!(f.edge_types_for_related, vec!["mentions", "attended"]);
  }

  #[test]
  fn extracted_facts_payload_parses_array() {
    let raw = serde_json::json!({
      "facts": [
        {
          "entity_name": "A",
          "fact_type": "x",
          "claim": "c1",
          "confidence": 0.5,
          "node_kind": "entity"
        },
        {
          "entity_name": "B",
          "fact_type": "y",
          "claim": "c2",
          "confidence": 0.6,
          "node_kind": "event"
        }
      ]
    });
    let p: ExtractedFactsPayload = serde_json::from_value(raw).expect("parse");
    assert_eq!(p.facts.len(), 2);
    assert_eq!(p.facts[0].entity_name, "A");
    assert_eq!(p.facts[1].node_kind, "event");
  }

  // ── tool schema ────────────────────────────────────────────────────────
  #[test]
  fn extraction_tool_input_schema_is_object_with_facts_array() {
    let s = extraction_tool_input_schema();
    assert_eq!(s["type"], serde_json::json!("object"));
    let facts = &s["properties"]["facts"];
    assert_eq!(facts["type"], serde_json::json!("array"));
    let item = &facts["items"];
    assert_eq!(item["type"], serde_json::json!("object"));
  }

  #[test]
  fn extraction_tool_input_schema_requires_core_fields() {
    let s = extraction_tool_input_schema();
    let item = &s["properties"]["facts"]["items"];
    let required = item["required"].as_array().expect("required array");
    let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
    for must in ["entity_name", "fact_type", "claim", "confidence", "node_kind"] {
      assert!(names.contains(&must), "missing required field {}", must);
    }
  }

  #[test]
  fn extraction_tool_input_schema_constrains_node_kind_enum() {
    let s = extraction_tool_input_schema();
    let kind = &s["properties"]["facts"]["items"]["properties"]["node_kind"];
    let allowed = kind["enum"].as_array().expect("enum");
    let allowed_names: Vec<&str> = allowed.iter().filter_map(|v| v.as_str()).collect();
    for nk in NODE_KINDS {
      assert!(allowed_names.contains(nk), "missing node_kind enum {}", nk);
    }
  }

  // ── normalize_name ─────────────────────────────────────────────────────
  #[test]
  fn normalize_name_lowercases_ascii() {
    assert_eq!(normalize_name("Alex Chen"), "alex chen");
  }

  #[test]
  fn normalize_name_collapses_whitespace() {
    assert_eq!(normalize_name("  Alex   Chen   "), "alex chen");
  }

  #[test]
  fn normalize_name_folds_common_latin_diacritics() {
    assert_eq!(normalize_name("Café Lübeck"), "cafe lubeck");
    assert_eq!(normalize_name("Renée"), "renee");
    assert_eq!(normalize_name("Aña"), "ana");
  }

  #[test]
  fn normalize_name_strips_punctuation() {
    assert_eq!(normalize_name("Acme, Inc."), "acme inc");
    assert_eq!(normalize_name("Q2 launch!"), "q2 launch");
  }

  #[test]
  fn normalize_name_preserves_japanese() {
    // Japanese should round-trip; we only lowercase ASCII letters.
    let n = normalize_name("KIOKU 記憶");
    assert!(n.contains("記憶"), "got {}", n);
    assert!(n.contains("kioku"), "got {}", n);
  }

  #[test]
  fn normalize_name_empty_returns_empty() {
    assert_eq!(normalize_name(""), "");
    assert_eq!(normalize_name("   "), "");
  }

  // ── levenshtein_ratio ──────────────────────────────────────────────────
  #[test]
  fn levenshtein_ratio_identical_strings_return_one() {
    assert!((levenshtein_ratio("abc", "abc") - 1.0).abs() < 1e-9);
  }

  #[test]
  fn levenshtein_ratio_two_empty_strings_return_one() {
    assert_eq!(levenshtein_ratio("", ""), 1.0);
  }

  #[test]
  fn levenshtein_ratio_completely_different_returns_zero() {
    assert_eq!(levenshtein_ratio("abc", "xyz"), 0.0);
  }

  #[test]
  fn levenshtein_ratio_one_char_off_short_string() {
    // "abc" vs "abd" → 1 / 3 = 0.666...
    let r = levenshtein_ratio("abc", "abd");
    assert!((r - (2.0 / 3.0)).abs() < 1e-9, "got {}", r);
  }

  #[test]
  fn levenshtein_ratio_mostly_similar_long_string() {
    // Realistic case: "leads our Series A" vs "leads our Series A round"
    let r = levenshtein_ratio("leads our Series A", "leads our Series A round");
    assert!(r > 0.7, "expected > 0.7, got {}", r);
  }

  #[test]
  fn levenshtein_ratio_empty_vs_nonempty() {
    // "" vs "abcd" → distance 4, ratio = 1 - 4/4 = 0.0
    assert_eq!(levenshtein_ratio("", "abcd"), 0.0);
    assert_eq!(levenshtein_ratio("abcd", ""), 0.0);
  }

  #[test]
  fn classify_anthropic_error_billing_is_blocked_not_permanent() {
    let err = r#"Anthropic tool_use 400 Bad Request: {"error":{"message":"Your credit balance is too low"}}"#;
    match classify_anthropic_error(err) {
      ExtractionError::BillingBlocked(_) => {}
      other => panic!("expected BillingBlocked, got {:?}", other),
    }
  }

  #[test]
  fn process_one_job_billing_blocked_requeues_without_failed_status() {
    let conn = open_test_conn();
    let (_cap_id, job_id) = seed_capture_and_job(&conn, 1_000);
    let client = FakeClient {
      response: std::cell::RefCell::new(Some(Err(ExtractionError::BillingBlocked(
        "credit balance is too low".into(),
      )))),
    };
    let outcome = process_one_job(job_id, &client, 2_000, &conn).expect("returned");
    assert!(matches!(outcome, JobOutcome::BillingPaused { .. }));
    let (status, last_err): (String, Option<String>) = conn
      .query_row(
        "SELECT status, last_error FROM extraction_jobs WHERE id = ?1",
        params![job_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
      )
      .expect("row");
    assert_eq!(status, "queued");
    assert!(last_err.unwrap().contains("billing_blocked"));
  }

  #[test]
  fn requeue_failed_billing_jobs_resets_status() {
    let conn = open_test_conn();
    let (_cap_id, job_id) = seed_capture_and_job(&conn, 1_000);
    conn
      .execute(
        "UPDATE extraction_jobs SET status='failed', last_error='permanent: credit balance is too low' WHERE id=?1",
        params![job_id],
      )
      .unwrap();
    let report = requeue_failed_extraction_jobs(&conn, true, 5_000).expect("requeue");
    assert_eq!(report.requeued, 1);
    let status: String = conn
      .query_row(
        "SELECT status FROM extraction_jobs WHERE id = ?1",
        params![job_id],
        |r| r.get(0),
      )
      .expect("row");
    assert_eq!(status, "queued");
  }
}
