//! KIOKU capture pipeline — significance filter + dedup + ingestion entry.
//!
//! Phase 2 Stage 2 (T4) deliverable. Replaces `capture_sampler`'s
//! `LAST_SIG`-based ad-hoc dedup with a proper signature ring + batched
//! window + a11y diff filter, then routes accepted captures to
//! `mem_captures::record` and (optionally) `extraction_jobs::enqueue`.
//!
//! All sub-modules in this file are pure or take a `&Connection`; there is
//! no global state and no platform-specific code so the macOS sampler can
//! reuse the same primitives in a `cfg`-gated wrapper.

#![allow(dead_code)]

// ── Settings flag + ingestion routing ──────────────────────────────────────

/// Read the `settings.sections.kioku_graph.capture_to_mem_captures` flag.
/// Returns false when the section / key is missing — Stage 2 ships the flag
/// OFF by default so existing capture flow is untouched until the wiring is
/// validated.
pub fn capture_to_mem_captures_flag(settings: &serde_json::Value) -> bool {
  settings
    .pointer("/sections/kioku_graph/capture_to_mem_captures")
    .and_then(|v| v.as_bool())
    .unwrap_or(false)
}

/// Record a capture into `mem_captures` and enqueue an extraction job pointing
/// to it. Enqueue failures are logged but do not bubble — the capture row is
/// the source of truth and a follow-up sweep can re-enqueue stragglers.
pub fn route_capture(
  input: &crate::mem_captures::CaptureInput,
  conn: &rusqlite::Connection,
) -> Result<i64, String> {
  let cap_id = crate::mem_captures::record(input, conn)?;
  if let Err(e) = crate::extraction_jobs::enqueue(
    Some(cap_id),
    crate::extraction_jobs::JOB_KIND_EXTRACT,
    input.captured_at_ms,
    None,
    conn,
  ) {
    log::warn!(
      "kioku_capture::route_capture: enqueue failed for capture {}: {}",
      cap_id,
      e,
    );
  }
  Ok(cap_id)
}

// ── 64-bit SimHash + Hamming distance ──────────────────────────────────────

/// FNV-1a 64-bit hash of a token. Deterministic, no salt — stability across
/// runs is intentional (sigring needs the same hash for the same text).
fn fnv1a64(token: &str) -> u64 {
  const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
  const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
  let mut h = FNV_OFFSET;
  for b in token.as_bytes() {
    h ^= *b as u64;
    h = h.wrapping_mul(FNV_PRIME);
  }
  h
}

/// 64-bit SimHash of `text`, hashing whitespace-separated tokens.
///
/// Returns `0` for empty / whitespace-only input. Stable across calls
/// (deterministic FNV-1a inner hash).
pub fn simhash64(text: &str) -> u64 {
  let mut counters = [0i32; 64];
  let mut any_token = false;
  for token in text.split_whitespace() {
    if token.is_empty() {
      continue;
    }
    any_token = true;
    let h = fnv1a64(token);
    for (bit, c) in counters.iter_mut().enumerate() {
      if (h >> bit) & 1 == 1 {
        *c += 1;
      } else {
        *c -= 1;
      }
    }
  }
  if !any_token {
    return 0;
  }
  let mut out = 0u64;
  for (bit, c) in counters.iter().enumerate() {
    if *c > 0 {
      out |= 1u64 << bit;
    }
  }
  out
}

/// Number of differing bits between two 64-bit fingerprints.
pub fn hamming64(a: u64, b: u64) -> u32 {
  (a ^ b).count_ones()
}

// ── Signature ring ─────────────────────────────────────────────────────────

/// Last AX dump remembered for a `(app_bundle_id, window_title)` key, used
/// by the a11y-diff filter step. `lines` keeps the parsed snapshot lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastAxDump {
  pub key: String,
  pub lines: Vec<String>,
}

/// In-memory ring buffer of recent capture signatures. Replaces
/// `capture_sampler::LAST_SIG` so we can detect near-duplicates seen in
/// the last `capacity` ingests, not only the previous one.
pub struct SigRing {
  buf: std::collections::VecDeque<u64>,
  cap: usize,
  ax: std::collections::HashMap<String, LastAxDump>,
}

impl SigRing {
  /// Empty ring with the given capacity (oldest entry evicted past capacity).
  /// `capacity == 0` is treated as 1 (always retains at least the last one).
  pub fn new(capacity: usize) -> Self {
    let cap = capacity.max(1);
    SigRing {
      buf: std::collections::VecDeque::with_capacity(cap),
      cap,
      ax: std::collections::HashMap::new(),
    }
  }

  pub fn capacity(&self) -> usize {
    self.cap
  }

  pub fn len(&self) -> usize {
    self.buf.len()
  }

  pub fn is_empty(&self) -> bool {
    self.buf.is_empty()
  }

  /// Returns true if `sig` is within `max_dist` Hamming bits of any entry.
  pub fn has_near(&self, sig: u64, max_dist: u32) -> bool {
    self.buf.iter().any(|&s| hamming64(s, sig) <= max_dist)
  }

  /// Add a new fingerprint to the ring. Oldest is evicted past capacity.
  pub fn push(&mut self, sig: u64) {
    if self.buf.len() == self.cap {
      self.buf.pop_front();
    }
    self.buf.push_back(sig);
  }

  /// Last AX dump observed for `(app_bundle_id, window_title)`. None when
  /// the key has never been seen.
  pub fn last_ax_for(&self, key: &str) -> Option<&LastAxDump> {
    self.ax.get(key)
  }

  /// Remember `lines` as the latest AX dump for `key`.
  pub fn put_ax(&mut self, key: &str, lines: Vec<String>) {
    self.ax.insert(
      key.to_string(),
      LastAxDump { key: key.to_string(), lines },
    );
  }
}

// ── Significance filter ────────────────────────────────────────────────────

/// Decision returned by `should_capture`. `Skip(reason)` lets callers attribute
/// the skip in `mem_captures.filter_meta_json` for observability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureDecision {
  Accept,
  Skip(SkipReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
  Privacy,           // app or url denylist hit
  ShortDwell,        // dwell_ms below threshold
  NearDuplicate,     // simhash within hamming threshold of recent ring entry
  TrivialDiff,       // a11y dump differs by < min_lines from last
}

/// Inputs to the significance filter. Mirrors what `capture_sampler` knows
/// at sample time. `ax_lines` is `None` for non-AX captures.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CaptureSignal {
  pub app_bundle_id: Option<String>,
  pub window_title: Option<String>,
  pub url: Option<String>,
  pub raw_text: String,
  pub ax_lines: Option<Vec<String>>,
  pub dwell_ms: Option<i64>,
}

/// Configurable thresholds. Defaults match `target-design.md` §3.2.
#[derive(Debug, Clone, PartialEq)]
pub struct FilterConfig {
  pub denylist_apps: Vec<String>,
  pub denylist_url_substrings: Vec<String>,
  pub min_dwell_ms: i64,
  pub max_simhash_dist: u32,
  pub min_ax_diff_lines: usize,
}

impl Default for FilterConfig {
  fn default() -> Self {
    FilterConfig {
      denylist_apps: Vec::new(),
      denylist_url_substrings: Vec::new(),
      min_dwell_ms: 5_000,
      max_simhash_dist: 4,
      min_ax_diff_lines: 3,
    }
  }
}

fn ax_diff_lines(prev: &[String], next: &[String]) -> usize {
  // Count distinct lines in each direction (set-symmetric-difference size).
  let prev_set: std::collections::HashSet<&str> =
    prev.iter().map(|s| s.as_str()).collect();
  let next_set: std::collections::HashSet<&str> =
    next.iter().map(|s| s.as_str()).collect();
  prev_set.symmetric_difference(&next_set).count()
}

fn signal_dedup_key(sig: &CaptureSignal) -> String {
  // Use `(app_bundle_id, window_title or url)` as the bucket key. Empty
  // strings stand in for None so the join is unambiguous.
  let app = sig.app_bundle_id.as_deref().unwrap_or("");
  let win = sig
    .window_title
    .as_deref()
    .or(sig.url.as_deref())
    .unwrap_or("");
  format!("{}|{}", app, win)
}

/// Apply the four-stage significance filter. Order matters: denylist → dwell
/// → simhash → a11y diff so a denylisted app exits before any expensive work.
pub fn should_capture(
  sig: &CaptureSignal,
  ring: &SigRing,
  cfg: &FilterConfig,
) -> CaptureDecision {
  // 1. Privacy denylist (apps + url substrings)
  if let Some(app) = &sig.app_bundle_id {
    if cfg.denylist_apps.iter().any(|d| d == app) {
      return CaptureDecision::Skip(SkipReason::Privacy);
    }
  }
  if let Some(url) = &sig.url {
    if cfg
      .denylist_url_substrings
      .iter()
      .any(|d| !d.is_empty() && url.contains(d.as_str()))
    {
      return CaptureDecision::Skip(SkipReason::Privacy);
    }
  }

  // 2. Dwell time
  if let Some(dwell) = sig.dwell_ms {
    if dwell < cfg.min_dwell_ms {
      return CaptureDecision::Skip(SkipReason::ShortDwell);
    }
  }

  // 3. SimHash near-duplicate
  if !sig.raw_text.trim().is_empty() {
    let h = simhash64(&sig.raw_text);
    if ring.has_near(h, cfg.max_simhash_dist) {
      return CaptureDecision::Skip(SkipReason::NearDuplicate);
    }
  }

  // 4. AX-diff trivial change
  if let Some(lines) = &sig.ax_lines {
    let key = signal_dedup_key(sig);
    if let Some(prev) = ring.last_ax_for(&key) {
      if ax_diff_lines(&prev.lines, lines) < cfg.min_ax_diff_lines {
        return CaptureDecision::Skip(SkipReason::TrivialDiff);
      }
    }
  }

  CaptureDecision::Accept
}

// ── Batched dedup window ───────────────────────────────────────────────────

/// One pending capture inside the batched window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCapture {
  pub key: String,            // (app_bundle_id, window_title or url) join
  pub captured_at_ms: i64,
  pub dwell_ms: i64,
  pub raw_text_hash: u64,     // simhash64 of raw_text
}

/// Outcome of `BatchedDedupWindow::observe`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowOutcome {
  /// Caller may keep going (no capture has matured into a flush yet).
  Pending,
  /// Caller should ingest the listed captures as a single aggregated unit.
  Flush(Vec<PendingCapture>),
}

/// Default batched-dedup window length. 60s gives the aggregator more chances
/// to collapse same-(app, title) captures into one extraction job. Doubled
/// from the original 30s after Stage 1 cost observation showed we need ~25%
/// fewer jobs to keep heavy-load users inside the BYOK monthly cap. See
/// `docs/kioku-cost-budget.md` §3.3.
pub const DEFAULT_BATCHED_DEDUP_WINDOW_MS: i64 = 60_000;

/// Sliding window aggregator. Holds pending captures until the window for
/// their `key` expires, then `observe` returns the aggregated list as
/// `Flush(...)`. Default window length is `DEFAULT_BATCHED_DEDUP_WINDOW_MS`.
pub struct BatchedDedupWindow {
  window_ms: i64,
  pending: std::collections::HashMap<String, Vec<PendingCapture>>,
}

impl BatchedDedupWindow {
  pub fn new(window_ms: i64) -> Self {
    BatchedDedupWindow {
      window_ms: window_ms.max(0),
      pending: std::collections::HashMap::new(),
    }
  }

  pub fn window_ms(&self) -> i64 {
    self.window_ms
  }

  /// Size of the pending bucket for `key`.
  pub fn pending_for(&self, key: &str) -> usize {
    self.pending.get(key).map(|v| v.len()).unwrap_or(0)
  }

  /// Record a new capture. If its `captured_at_ms` is more than `window_ms`
  /// after the bucket's earliest entry, return `Flush(taken_bucket)` with
  /// the bucket replaced by `[new]`. Otherwise append to the bucket and
  /// return `Pending`.
  pub fn observe(&mut self, capture: PendingCapture) -> WindowOutcome {
    let key = capture.key.clone();
    let bucket = self.pending.entry(key.clone()).or_default();
    if let Some(first) = bucket.first() {
      if capture.captured_at_ms - first.captured_at_ms > self.window_ms {
        // Take the existing bucket and replace it with the new arrival.
        let drained = std::mem::take(bucket);
        bucket.push(capture);
        return WindowOutcome::Flush(drained);
      }
    }
    bucket.push(capture);
    WindowOutcome::Pending
  }

  /// Drop all pending state. Used by tests; production callers prefer
  /// `drain_expired` so nothing is lost.
  pub fn clear(&mut self) {
    self.pending.clear();
  }

  /// Force-flush all buckets whose first entry is older than `now - window_ms`
  /// and return them. Used on idle ticks so a quiet user doesn't sit on stale
  /// buckets.
  pub fn drain_expired(&mut self, now_ms: i64) -> Vec<Vec<PendingCapture>> {
    let cutoff = now_ms - self.window_ms;
    let stale_keys: Vec<String> = self
      .pending
      .iter()
      .filter_map(|(k, v)| match v.first() {
        Some(first) if first.captured_at_ms <= cutoff => Some(k.clone()),
        _ => None,
      })
      .collect();
    let mut out = Vec::with_capacity(stale_keys.len());
    for k in stale_keys {
      if let Some(v) = self.pending.remove(&k) {
        out.push(v);
      }
    }
    out
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // ── simhash64 / hamming64 ──────────────────────────────────────────────
  #[test]
  fn simhash64_empty_returns_zero() {
    assert_eq!(simhash64(""), 0);
    assert_eq!(simhash64("   "), 0);
  }

  #[test]
  fn simhash64_stable_for_same_input() {
    let a = simhash64("hello world from kioku");
    let b = simhash64("hello world from kioku");
    assert_eq!(a, b);
  }

  #[test]
  fn simhash64_token_order_invariant() {
    // SimHash should be (mostly) order-independent for token bags. We don't
    // require strict equality (token order can flip a couple of bits in
    // edge cases); within hamming distance 4 is the operative threshold.
    let a = simhash64("alpha beta gamma delta epsilon");
    let b = simhash64("epsilon delta gamma beta alpha");
    assert!(
      hamming64(a, b) <= 4,
      "expected order-invariant similarity, got hamming = {}",
      hamming64(a, b),
    );
  }

  #[test]
  fn simhash64_near_duplicates_within_threshold() {
    // Adding one token to a long passage should perturb at most a few bits.
    let a = simhash64(
      "The quick brown fox jumps over the lazy dog and then trots away \
       slowly through the autumn meadow toward the riverbank at dusk.",
    );
    let b = simhash64(
      "The quick brown fox jumps over the lazy dog and then trots away \
       slowly through the autumn meadow toward the riverbank at dusk today.",
    );
    let dist = hamming64(a, b);
    assert!(
      dist <= 4,
      "near-duplicate texts should have hamming ≤ 4, got {}",
      dist,
    );
  }

  #[test]
  fn simhash64_distinct_texts_far_apart() {
    let a = simhash64("application logs from backend service");
    let b = simhash64(
      "weather report says heavy rain across the entire pacific northwest \
       this weekend with possible flooding in low-lying coastal regions",
    );
    let dist = hamming64(a, b);
    assert!(
      dist > 12,
      "unrelated texts should have hamming > 12, got {}",
      dist,
    );
  }

  // ── capture_to_mem_captures_flag ───────────────────────────────────────
  use serde_json::json;

  #[test]
  fn flag_default_off_when_settings_empty() {
    let s = json!({});
    assert!(!capture_to_mem_captures_flag(&s));
  }

  #[test]
  fn flag_default_off_when_section_missing() {
    let s = json!({ "sections": { "memory": { "enableMemorySummary": true } } });
    assert!(!capture_to_mem_captures_flag(&s));
  }

  #[test]
  fn flag_returns_true_when_explicitly_enabled() {
    let s = json!({
      "sections": { "kioku_graph": { "capture_to_mem_captures": true } }
    });
    assert!(capture_to_mem_captures_flag(&s));
  }

  #[test]
  fn flag_returns_false_when_explicitly_disabled() {
    let s = json!({
      "sections": { "kioku_graph": { "capture_to_mem_captures": false } }
    });
    assert!(!capture_to_mem_captures_flag(&s));
  }

  #[test]
  fn flag_treats_non_bool_value_as_off() {
    // Defensive: a stringly typed misconfiguration shouldn't enable the flag.
    let s = json!({
      "sections": { "kioku_graph": { "capture_to_mem_captures": "true" } }
    });
    assert!(!capture_to_mem_captures_flag(&s));
  }

  // ── route_capture ──────────────────────────────────────────────────────
  fn open_test_conn() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().expect("open");
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

  #[test]
  fn route_capture_records_capture_and_enqueues_extract_job() {
    let conn = open_test_conn();
    let input = crate::mem_captures::CaptureInput {
      kind: "screen_app".into(),
      raw_text: Some("app=Slack".into()),
      app_bundle_id: Some("com.tinyspeck.slackmacgap".into()),
      window_title: Some("Slack | #shogun-eng".into()),
      captured_at_ms: 5_000,
      ..Default::default()
    };
    let cap_id = route_capture(&input, &conn).expect("route ok");
    assert!(cap_id > 0);

    let cap_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM mem_captures WHERE id = ?1", rusqlite::params![cap_id], |r| r.get(0))
      .expect("count");
    assert_eq!(cap_count, 1);

    let job_count: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM extraction_jobs WHERE capture_id = ?1 AND job_kind = 'extract'",
        rusqlite::params![cap_id],
        |r| r.get(0),
      )
      .expect("count");
    assert_eq!(job_count, 1, "expected exactly one extract job for the capture");
  }

  #[test]
  fn route_capture_propagates_record_validation_errors() {
    let conn = open_test_conn();
    let input = crate::mem_captures::CaptureInput {
      kind: "".into(), // invalid
      captured_at_ms: 5_000,
      ..Default::default()
    };
    let err = route_capture(&input, &conn).expect_err("must error");
    assert!(err.to_lowercase().contains("kind"), "got: {}", err);
  }

  // ── should_capture (significance filter) ───────────────────────────────
  fn signal_with_text(text: &str) -> CaptureSignal {
    CaptureSignal {
      app_bundle_id: Some("com.tinyspeck.slackmacgap".into()),
      window_title: Some("Slack | #shogun-eng".into()),
      url: None,
      raw_text: text.to_string(),
      ax_lines: None,
      dwell_ms: Some(10_000),
    }
  }

  #[test]
  fn should_capture_accepts_fresh_signal() {
    let sig = signal_with_text("first observation");
    let ring = SigRing::new(8);
    let cfg = FilterConfig::default();
    assert_eq!(should_capture(&sig, &ring, &cfg), CaptureDecision::Accept);
  }

  #[test]
  fn should_capture_skips_denylisted_app() {
    let sig = signal_with_text("anything");
    let ring = SigRing::new(8);
    let cfg = FilterConfig {
      denylist_apps: vec!["com.tinyspeck.slackmacgap".into()],
      ..FilterConfig::default()
    };
    assert_eq!(
      should_capture(&sig, &ring, &cfg),
      CaptureDecision::Skip(SkipReason::Privacy),
    );
  }

  #[test]
  fn should_capture_skips_denylisted_url_substring() {
    let mut sig = signal_with_text("anything");
    sig.url = Some("https://internal.bank.example/account".into());
    sig.window_title = None;
    let ring = SigRing::new(8);
    let cfg = FilterConfig {
      denylist_url_substrings: vec!["bank.example".into()],
      ..FilterConfig::default()
    };
    assert_eq!(
      should_capture(&sig, &ring, &cfg),
      CaptureDecision::Skip(SkipReason::Privacy),
    );
  }

  #[test]
  fn should_capture_skips_short_dwell() {
    let mut sig = signal_with_text("hi");
    sig.dwell_ms = Some(2_000);
    let ring = SigRing::new(8);
    let cfg = FilterConfig::default();
    assert_eq!(
      should_capture(&sig, &ring, &cfg),
      CaptureDecision::Skip(SkipReason::ShortDwell),
    );
  }

  #[test]
  fn should_capture_no_dwell_does_not_block() {
    // dwell_ms = None means we couldn't measure focus; don't penalize.
    let mut sig = signal_with_text("interesting payload");
    sig.dwell_ms = None;
    let ring = SigRing::new(8);
    let cfg = FilterConfig::default();
    assert_eq!(should_capture(&sig, &ring, &cfg), CaptureDecision::Accept);
  }

  #[test]
  fn should_capture_skips_near_duplicate_via_simhash() {
    let mut ring = SigRing::new(8);
    // Realistic capture text — same window title sampled twice in a row.
    let captured = "app=Slack channel=#shogun-eng workspace=shogunai";
    ring.push(simhash64(captured));
    let sig = signal_with_text(captured);
    let cfg = FilterConfig::default();
    assert_eq!(
      should_capture(&sig, &ring, &cfg),
      CaptureDecision::Skip(SkipReason::NearDuplicate),
    );
  }

  #[test]
  fn should_capture_skips_long_passage_near_duplicate() {
    // For longer passages a single-token difference stays within hamming 4.
    let mut ring = SigRing::new(8);
    let original = "The quick brown fox jumps over the lazy dog and then trots away \
                    slowly through the autumn meadow toward the riverbank at dusk.";
    ring.push(simhash64(original));
    let near = "The quick brown fox jumps over the lazy dog and then trots away \
                slowly through the autumn meadow toward the riverbank at dusk today.";
    let sig = signal_with_text(near);
    let cfg = FilterConfig::default();
    assert_eq!(
      should_capture(&sig, &ring, &cfg),
      CaptureDecision::Skip(SkipReason::NearDuplicate),
    );
  }

  #[test]
  fn should_capture_skips_trivial_ax_diff() {
    let mut ring = SigRing::new(8);
    let sig = CaptureSignal {
      app_bundle_id: Some("com.apple.mail".into()),
      window_title: Some("Inbox".into()),
      url: None,
      raw_text: "anything".into(),
      ax_lines: Some(vec![
        "role=AXTextField title=Subject value=Re: deploy plan".to_string(),
        "role=AXButton title=Send".to_string(),
        "role=AXStaticText value=Inbox".to_string(),
      ]),
      dwell_ms: Some(10_000),
    };
    // Seed prior AX dump that's almost identical (1 line different).
    ring.put_ax(
      &signal_dedup_key(&sig),
      vec![
        "role=AXTextField title=Subject value=Re: deploy plan v3".to_string(),
        "role=AXButton title=Send".to_string(),
        "role=AXStaticText value=Inbox".to_string(),
      ],
    );
    let cfg = FilterConfig::default();
    assert_eq!(
      should_capture(&sig, &ring, &cfg),
      CaptureDecision::Skip(SkipReason::TrivialDiff),
    );
  }

  #[test]
  fn should_capture_accepts_substantial_ax_diff() {
    let mut ring = SigRing::new(8);
    let sig = CaptureSignal {
      app_bundle_id: Some("com.apple.mail".into()),
      window_title: Some("Inbox".into()),
      url: None,
      raw_text: "fresh content".into(),
      ax_lines: Some(vec![
        "role=AXTextField title=Subject value=Re: contract draft".to_string(),
        "role=AXButton title=Reply".to_string(),
        "role=AXStaticText value=From legal".to_string(),
        "role=AXStaticText value=DPA attached".to_string(),
      ]),
      dwell_ms: Some(10_000),
    };
    ring.put_ax(
      &signal_dedup_key(&sig),
      vec!["role=AXTextField title=Search".to_string()],
    );
    let cfg = FilterConfig::default();
    assert_eq!(should_capture(&sig, &ring, &cfg), CaptureDecision::Accept);
  }

  // ── BatchedDedupWindow ─────────────────────────────────────────────────
  #[test]
  fn default_batched_dedup_window_is_60_seconds() {
    assert_eq!(DEFAULT_BATCHED_DEDUP_WINDOW_MS, 60_000);
  }

  fn pc(key: &str, captured_at_ms: i64, dwell_ms: i64, raw_text_hash: u64) -> PendingCapture {
    PendingCapture {
      key: key.to_string(),
      captured_at_ms,
      dwell_ms,
      raw_text_hash,
    }
  }

  #[test]
  fn window_new_records_window_size() {
    let w = BatchedDedupWindow::new(30_000);
    assert_eq!(w.window_ms(), 30_000);
  }

  #[test]
  fn window_first_observation_pending_no_flush() {
    let mut w = BatchedDedupWindow::new(30_000);
    let r = w.observe(pc("Slack|#shogun-eng", 1_000, 5_000, 0xaa));
    assert_eq!(r, WindowOutcome::Pending);
    assert_eq!(w.pending_for("Slack|#shogun-eng"), 1);
  }

  #[test]
  fn window_within_window_aggregates_in_bucket() {
    let mut w = BatchedDedupWindow::new(30_000);
    assert_eq!(w.observe(pc("k", 1_000, 5_000, 0x1)), WindowOutcome::Pending);
    // 10 s later, same key, still inside window: pending.
    assert_eq!(w.observe(pc("k", 11_000, 5_000, 0x2)), WindowOutcome::Pending);
    assert_eq!(w.pending_for("k"), 2);
  }

  #[test]
  fn window_past_window_flushes_old_bucket() {
    let mut w = BatchedDedupWindow::new(30_000);
    assert_eq!(w.observe(pc("k", 1_000, 5_000, 0x1)), WindowOutcome::Pending);
    assert_eq!(w.observe(pc("k", 11_000, 5_000, 0x2)), WindowOutcome::Pending);
    // 31 s past first → flush the two pending, replace with [new].
    let r = w.observe(pc("k", 32_000, 5_000, 0x3));
    match r {
      WindowOutcome::Flush(items) => {
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].raw_text_hash, 0x1);
        assert_eq!(items[1].raw_text_hash, 0x2);
      }
      _ => panic!("expected Flush, got {:?}", r),
    }
    // Bucket now holds the new arrival.
    assert_eq!(w.pending_for("k"), 1);
  }

  #[test]
  fn window_keys_are_independent() {
    let mut w = BatchedDedupWindow::new(30_000);
    assert_eq!(w.observe(pc("a", 1_000, 1_000, 0x1)), WindowOutcome::Pending);
    assert_eq!(w.observe(pc("b", 1_000, 1_000, 0x2)), WindowOutcome::Pending);
    assert_eq!(w.pending_for("a"), 1);
    assert_eq!(w.pending_for("b"), 1);
  }

  #[test]
  fn window_drain_expired_collects_old_buckets() {
    let mut w = BatchedDedupWindow::new(30_000);
    w.observe(pc("a", 1_000, 1_000, 0x1));
    w.observe(pc("b", 1_000, 1_000, 0x2));
    // 60 s later — both buckets stale.
    let drained = w.drain_expired(60_000);
    assert_eq!(drained.len(), 2);
    assert_eq!(w.pending_for("a"), 0);
    assert_eq!(w.pending_for("b"), 0);
  }

  #[test]
  fn window_drain_expired_keeps_fresh_buckets() {
    let mut w = BatchedDedupWindow::new(30_000);
    w.observe(pc("a", 1_000, 1_000, 0x1));
    w.observe(pc("b", 50_000, 1_000, 0x2)); // newer bucket
    // 60 s later — only "a" is stale (50_000 + 30_000 = 80_000 > 60_000).
    let drained = w.drain_expired(60_000);
    assert_eq!(drained.len(), 1);
    assert_eq!(w.pending_for("a"), 0);
    assert_eq!(w.pending_for("b"), 1);
  }

  // ── SigRing ────────────────────────────────────────────────────────────
  #[test]
  fn sigring_new_starts_empty() {
    let r = SigRing::new(8);
    assert_eq!(r.capacity(), 8);
    assert_eq!(r.len(), 0);
    assert!(r.is_empty());
  }

  #[test]
  fn sigring_push_increments_len_until_capacity() {
    let mut r = SigRing::new(3);
    r.push(0xaa);
    r.push(0xbb);
    assert_eq!(r.len(), 2);
    r.push(0xcc);
    r.push(0xdd); // evicts 0xaa
    assert_eq!(r.len(), 3);
    assert_eq!(r.capacity(), 3);
  }

  #[test]
  fn sigring_has_near_finds_exact_match() {
    let mut r = SigRing::new(4);
    r.push(0xdead_beef);
    assert!(r.has_near(0xdead_beef, 0));
  }

  #[test]
  fn sigring_has_near_uses_hamming_threshold() {
    let mut r = SigRing::new(4);
    let base = 0u64;
    r.push(base);
    // Differ by 4 bits → within threshold 4
    let close = 0b1111u64;
    assert!(r.has_near(close, 4));
    // Differ by 5 bits → outside threshold 4
    let far = 0b1_1111u64;
    assert!(!r.has_near(far, 4));
  }

  #[test]
  fn sigring_evicts_oldest_when_at_capacity() {
    let mut r = SigRing::new(2);
    r.push(0x1);
    r.push(0x2);
    r.push(0x3); // evicts 0x1
    assert!(!r.has_near(0x1, 0), "0x1 should have been evicted");
    assert!(r.has_near(0x2, 0));
    assert!(r.has_near(0x3, 0));
  }

  #[test]
  fn sigring_zero_capacity_normalizes_to_one() {
    let mut r = SigRing::new(0);
    assert_eq!(r.capacity(), 1);
    r.push(0xa);
    r.push(0xb); // evicts 0xa
    assert!(!r.has_near(0xa, 0));
    assert!(r.has_near(0xb, 0));
  }

  #[test]
  fn sigring_remembers_ax_dump_per_key() {
    let mut r = SigRing::new(8);
    let key = "com.tinyspeck.slack|Slack | #shogun-eng";
    assert!(r.last_ax_for(key).is_none());
    r.put_ax(key, vec!["role=AXTextField".to_string(), "value=hi".to_string()]);
    let got = r.last_ax_for(key).expect("should be present");
    assert_eq!(got.lines.len(), 2);
    // Update overwrites
    r.put_ax(key, vec!["role=AXButton".to_string()]);
    let got = r.last_ax_for(key).expect("after update");
    assert_eq!(got.lines, vec!["role=AXButton".to_string()]);
  }

  #[test]
  fn sigring_ax_dump_keys_are_independent() {
    let mut r = SigRing::new(8);
    r.put_ax("a|win1", vec!["x".into()]);
    r.put_ax("b|win2", vec!["y".into()]);
    assert_eq!(r.last_ax_for("a|win1").unwrap().lines, vec!["x".to_string()]);
    assert_eq!(r.last_ax_for("b|win2").unwrap().lines, vec!["y".to_string()]);
    assert!(r.last_ax_for("c|win3").is_none());
  }

  #[test]
  fn hamming64_self_is_zero() {
    assert_eq!(hamming64(0xdead_beef, 0xdead_beef), 0);
  }

  #[test]
  fn hamming64_complement_is_64() {
    assert_eq!(hamming64(0, !0u64), 64);
  }

  #[test]
  fn hamming64_single_bit_difference() {
    assert_eq!(hamming64(0, 1), 1);
    assert_eq!(hamming64(0b1010, 0b1011), 1);
  }
}
