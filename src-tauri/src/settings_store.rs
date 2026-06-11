//! Local JSON settings under the OS app data directory (via `directories`).
//!
//! Concurrency: `save_patch` and `upsert_integration_provider` both perform a
//! read-modify-write on the same file. Multiple writers can race today (in-app
//! Settings toggle vs. the macOS tray's emergency-stop click vs. background
//! integration sync). To prevent the lost-update problem AND truncate-on-crash
//! corruption, all writes are serialized through a process-level mutex AND
//! committed via tempfile + atomic rename.

use crate::app_error::AppError;
use crate::paths;
use serde_json::{json, Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Serializes ALL write paths against this file. Reads (`load`) deliberately
/// do not take the lock — a torn read would only produce a brief invalid-JSON
/// error that the caller already handles, and read-side serialization would
/// turn frequent UI loads into a contention bottleneck.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn settings_path() -> Result<PathBuf, AppError> {
  #[cfg(test)]
  {
    if let Some(p) = test_settings_path_override() {
      return Ok(p);
    }
  }
  Ok(paths::app_data_dir()
    .map_err(AppError::Other)?
    .join("settings.json"))
}

// Test seam mirroring `memory_store::set_test_db_path`: a thread-local path
// override so tests can exercise the real `load` / `save_patch` /
// `upsert_integration_provider` code paths without touching the user's real
// settings.json. cfg(test)-only — production behavior is unchanged.
#[cfg(test)]
thread_local! {
  static TEST_SETTINGS_PATH: std::cell::RefCell<Option<PathBuf>> =
    const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn test_settings_path_override() -> Option<PathBuf> {
  TEST_SETTINGS_PATH.with(|c| c.borrow().clone())
}

#[cfg(test)]
pub(crate) fn set_test_settings_path(p: PathBuf) {
  TEST_SETTINGS_PATH.with(|c| *c.borrow_mut() = Some(p));
}

#[cfg(test)]
pub(crate) fn clear_test_settings_path() {
  TEST_SETTINGS_PATH.with(|c| *c.borrow_mut() = None);
}

/// RAII guard pointing `settings_path()` at a unique temp file for the
/// current test thread; clears the override and removes the file on drop.
/// `pub(crate)` so command-level tests (e.g. `app_settings_load`) can reuse it.
#[cfg(test)]
pub(crate) struct TestSettingsGuard {
  pub(crate) path: PathBuf,
}

#[cfg(test)]
impl TestSettingsGuard {
  pub(crate) fn new(name: &str) -> Self {
    static UNIQ: AtomicU64 = AtomicU64::new(0);
    let n = UNIQ.fetch_add(1, Ordering::Relaxed);
    let mut p = std::env::temp_dir();
    p.push(format!(
      "shogun-settings-test-{}-{}-{}.json",
      std::process::id(),
      n,
      name
    ));
    let _ = fs::remove_file(&p);
    set_test_settings_path(p.clone());
    TestSettingsGuard { path: p }
  }
}

#[cfg(test)]
impl Drop for TestSettingsGuard {
  fn drop(&mut self) {
    clear_test_settings_path();
    let _ = fs::remove_file(&self.path);
  }
}

/// Atomic write via tempfile + rename in the same directory. Power-loss /
/// kill-9 mid-write leaves either the old file or the new file, never a
/// truncated intermediate. Using the same directory keeps `rename` atomic on
/// the same filesystem (POSIX guarantee on macOS / Linux; same-volume
/// guarantee on Windows since Rust's `fs::rename` uses MoveFileExW with
/// REPLACE_EXISTING under the hood).
fn write_atomic(target: &Path, contents: &[u8]) -> Result<(), AppError> {
  let parent = target
    .parent()
    .ok_or_else(|| AppError::InvalidInput("settings target has no parent dir".to_string()))?;
  fs::create_dir_all(parent)?;
  // Unique tempfile name that's clearly identifiable as ours, in case we
  // crash and leave one behind — the next successful write replaces it.
  // PID + monotonic counter guarantees uniqueness even when many threads
  // hit `write_atomic` concurrently.
  static SEQ: AtomicU64 = AtomicU64::new(0);
  let mut tmp = parent.to_path_buf();
  let pid = std::process::id();
  let seq = SEQ.fetch_add(1, Ordering::Relaxed);
  tmp.push(format!(".settings.json.tmp-{}-{}", pid, seq));
  {
    let mut f = fs::File::create(&tmp)?;
    f.write_all(contents)?;
    // Best-effort fsync so the rename's "either old or new" guarantee
    // actually means "new contents are durable". Ignore unsupported errors
    // (e.g. some FUSE filesystems).
    let _ = f.sync_all();
  }
  if let Err(e) = fs::rename(&tmp, target) {
    let _ = fs::remove_file(&tmp);
    return Err(AppError::Io(e));
  }
  Ok(())
}

fn empty_doc() -> Value {
  json!({ "sections": {} })
}

fn load_inner() -> Result<Value, AppError> {
  let path = settings_path()?;
  if !path.exists() {
    return Ok(ensure_shape(empty_doc()));
  }
  let raw = fs::read_to_string(&path)?;
  let v: Value = serde_json::from_str(&raw)?;
  let prev_ver = v.get("settingsSchemaVersion").and_then(|x| x.as_u64());
  let shaped = ensure_shape(v);
  if prev_ver != shaped.get("settingsSchemaVersion").and_then(|x| x.as_u64()) {
    if let Ok(bytes) = serde_json::to_string_pretty(&shaped) {
      let _ = write_atomic(&path, bytes.as_bytes());
    }
  }
  Ok(shaped)
}

pub fn load() -> Result<Value, String> {
  load_inner().map_err(|e| e.to_ipc_string())
}

fn ensure_shape(mut v: Value) -> Value {
  if v.get("sections").and_then(|s| s.as_object()).is_none() {
    if let Some(obj) = v.as_object_mut() {
      obj.insert("sections".to_string(), json!({}));
    }
  }
  // Migrations must run BEFORE default backfill: e.g. the v3 migration copies
  // legacy `autoRecord` into `autoStartOnCalendar` only when the key is absent,
  // so inserting the default first would silently drop the user's preference.
  v = migrate_kioku_flags(v);
  v = migrate_meetings_auto_start(v);
  v = migrate_kioku_meeting_extraction(v);
  if let Some(sections) = v.get_mut("sections").and_then(|s| s.as_object_mut()) {
    let sec = sections
      .entry("security".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = sec.as_object_mut() {
      o.entry("biometricLockEnabled".to_string())
        .or_insert(json!(false));
    }
    let mem = sections
      .entry("memory".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = mem.as_object_mut() {
      o.entry("enableMemorySummary".to_string())
        .or_insert(json!(false));
      o.entry("autoDigest".to_string()).or_insert(json!(false));
      o.entry("autoDigestIntervalMins".to_string()).or_insert(json!(360));
      o.entry("autoDigestLang".to_string()).or_insert(json!("en"));
      o.entry("semanticRerank".to_string()).or_insert(json!(false));
    }
    let cap = sections
      .entry("capture".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = cap.as_object_mut() {
      o.entry("axRichCapture".to_string()).or_insert(json!(true));
      o.entry("sampleIntervalSecs".to_string()).or_insert(json!(4));
      o.entry("axMinIntervalSecs".to_string()).or_insert(json!(0));
      o.entry("paused".to_string()).or_insert(json!(false));
      o.entry("retentionDays".to_string()).or_insert(json!(30));
    }
    let onboarding = sections
      .entry("onboarding".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = onboarding.as_object_mut() {
      o.entry("complete".to_string()).or_insert(json!(false));
    }
    let kioku_graph = sections
      .entry("kioku_graph".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = kioku_graph.as_object_mut() {
      o.entry("capture_to_mem_captures".to_string())
        .or_insert(json!(true));
      o.entry("worker_enabled".to_string())
        .or_insert(json!(true));
      o.entry("read_path".to_string())
        .or_insert(json!("graph"));
      o.entry("poll_interval_secs".to_string())
        .or_insert(json!(30));
      o.entry("max_jobs_per_tick".to_string())
        .or_insert(json!(5));
      o.entry("meeting_extraction_enabled".to_string())
        .or_insert(json!(true));
    }
    let kioku_cost = sections
      .entry("kioku_cost".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = kioku_cost.as_object_mut() {
      o.entry("monthly_cap_usd".to_string())
        .or_insert(json!(10.0));
      o.entry("cap_action".to_string())
        .or_insert(json!("pause_extraction"));
      o.entry("fallback_model".to_string())
        .or_insert(json!("claude-haiku-4-5"));
    }
    let mtg = sections
      .entry("meetings".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = mtg.as_object_mut() {
      o.entry("autoStartOnCalendar".to_string())
        .or_insert(json!(false));
      o.entry("autoIngestToMemory".to_string())
        .or_insert(json!(true));
      o.entry("liveSttStreaming".to_string())
        .or_insert(json!(true));
      o.entry("autoStartOnVideoDetect".to_string())
        .or_insert(json!(true));
      o.entry("autoStartMicOnVideoDetect".to_string())
        .or_insert(json!(true));
    }
    let llm = sections
      .entry("llm".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = llm.as_object_mut() {
      o.entry("extractionModel".to_string())
        .or_insert(json!("claude-haiku-4-5"));
    }
  }
  v
}

/// Backfill KIOKU graph flags for existing users who saved settings before
/// Phase 2 defaults existed. Idempotent — safe to run on every load.
fn migrate_kioku_flags(mut v: Value) -> Value {
  let ver = v
    .get("settingsSchemaVersion")
    .and_then(|x| x.as_u64())
    .unwrap_or(0);
  if ver >= 2 {
    return v;
  }
  if let Some(sections) = v.get_mut("sections").and_then(|s| s.as_object_mut()) {
    let kioku_graph = sections
      .entry("kioku_graph".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = kioku_graph.as_object_mut() {
      o.entry("capture_to_mem_captures".to_string())
        .or_insert(json!(true));
      o.entry("worker_enabled".to_string())
        .or_insert(json!(true));
      o.entry("read_path".to_string())
        .or_insert(json!("graph"));
    }
    let mem = sections
      .entry("memory".to_string())
      .or_insert_with(|| json!({}));
    if let Some(o) = mem.as_object_mut() {
      o.entry("enableMemorySummary".to_string())
        .or_insert(json!(true));
    }
  }
  if let Some(obj) = v.as_object_mut() {
    obj.insert("settingsSchemaVersion".to_string(), json!(2));
  }
  v
}

/// Rename legacy `autoRecord` → `autoStartOnCalendar` (calendar window auto-open).
fn migrate_meetings_auto_start(mut v: Value) -> Value {
  let ver = v
    .get("settingsSchemaVersion")
    .and_then(|x| x.as_u64())
    .unwrap_or(0);
  if ver >= 3 {
    return v;
  }
  if let Some(mtg) = v
    .pointer_mut("/sections/meetings")
    .and_then(|s| s.as_object_mut())
  {
    if !mtg.contains_key("autoStartOnCalendar") {
      let from_legacy = mtg
        .get("autoRecord")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
      mtg.insert("autoStartOnCalendar".to_string(), json!(from_legacy));
    }
  }
  if let Some(obj) = v.as_object_mut() {
    obj.insert("settingsSchemaVersion".to_string(), json!(3));
  }
  v
}

/// Enable meeting → mem_captures extraction for existing installs.
fn migrate_kioku_meeting_extraction(mut v: Value) -> Value {
  let ver = v
    .get("settingsSchemaVersion")
    .and_then(|x| x.as_u64())
    .unwrap_or(0);
  if ver >= 4 {
    return v;
  }
  if let Some(o) = v
    .pointer_mut("/sections/kioku_graph")
    .and_then(|s| s.as_object_mut())
  {
    o.entry("meeting_extraction_enabled".to_string())
      .or_insert(json!(true));
  }
  if let Some(obj) = v.as_object_mut() {
    obj.insert("settingsSchemaVersion".to_string(), json!(4));
  }
  v
}

/// Merges `payload` into `sections[section]` using all keys except `section`.
///
/// Holds the process-level write lock for the entire read-modify-write so
/// concurrent callers (e.g. in-app Settings toggle vs. macOS tray click)
/// can't lose each other's updates. Persists via atomic rename so an
/// interrupted write never truncates the existing file.
fn save_patch_inner(payload: &Value) -> Result<Value, AppError> {
  let _guard = WRITE_LOCK.lock()?;
  let path = settings_path()?;
  let mut doc = if path.exists() {
    let raw = fs::read_to_string(&path)?;
    ensure_shape(serde_json::from_str(&raw).unwrap_or_else(|_| empty_doc()))
  } else {
    empty_doc()
  };

  let section = payload
    .get("section")
    .and_then(|s| s.as_str())
    .unwrap_or("misc")
    .to_string();

  let patch_map: Map<String, Value> = match payload.as_object() {
    Some(o) => o
      .iter()
      .filter(|(k, _)| *k != "section")
      .map(|(k, v)| (k.clone(), v.clone()))
      .collect(),
    None => Map::new(),
  };

  let sections = doc
    .as_object_mut()
    .and_then(|o| o.get_mut("sections"))
    .and_then(|s| s.as_object_mut())
    .ok_or_else(|| AppError::InvalidInput("invalid settings document".to_string()))?;

  let entry = sections.entry(section).or_insert_with(|| json!({}));
  let entry_obj = entry.as_object_mut().ok_or_else(|| {
    AppError::InvalidInput("section value must be an object".to_string())
  })?;
  for (k, v) in patch_map {
    entry_obj.insert(k, v);
  }

  if let Some(obj) = doc.as_object_mut() {
    obj.insert("updatedAt".to_string(), json!(now_ms()));
  }

  let serialized = serde_json::to_string_pretty(&doc)?;
  write_atomic(&path, serialized.as_bytes())?;

  Ok(doc)
}

pub fn save_patch(payload: &Value) -> Result<Value, String> {
  save_patch_inner(payload).map_err(|e| e.to_ipc_string())
}

fn now_ms() -> u64 {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Merge keys into `sections.integrations.providers[slug]` and persist the full document.
///
/// Shares `WRITE_LOCK` with `save_patch` so the two write paths can't race.
/// Atomic write via `write_atomic` for crash safety.
pub fn upsert_integration_provider(slug: &str, patch: &Value) -> Result<Value, String> {
  let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
  let path = settings_path().map_err(|e| e.to_ipc_string())?;
  let mut doc = if path.exists() {
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    ensure_shape(serde_json::from_str(&raw).unwrap_or_else(|_| empty_doc()))
  } else {
    empty_doc()
  };

  let sections = doc
    .as_object_mut()
    .and_then(|o| o.get_mut("sections"))
    .and_then(|s| s.as_object_mut())
    .ok_or_else(|| "invalid settings document".to_string())?;

  let integ = sections
    .entry("integrations".to_string())
    .or_insert_with(|| json!({}));
  let integ_obj = integ
    .as_object_mut()
    .ok_or_else(|| "integrations must be an object".to_string())?;

  let prov = integ_obj
    .entry("providers".to_string())
    .or_insert_with(|| json!({}));
  let prov_obj = prov
    .as_object_mut()
    .ok_or_else(|| "integrations.providers must be an object".to_string())?;

  let cur = prov_obj
    .entry(slug.to_string())
    .or_insert_with(|| json!({}));
  let cur_obj = cur
    .as_object_mut()
    .ok_or_else(|| "provider entry must be an object".to_string())?;

  if let Some(p) = patch.as_object() {
    for (k, v) in p {
      cur_obj.insert(k.clone(), v.clone());
    }
  }
  cur_obj.insert("updatedAt".to_string(), json!(now_ms()));

  if let Some(obj) = doc.as_object_mut() {
    obj.insert("updatedAt".to_string(), json!(now_ms()));
  }

  let serialized = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
  write_atomic(&path, serialized.as_bytes()).map_err(|e| e.to_ipc_string())?;

  Ok(doc)
}



#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn migrate_kioku_flags_backfills_legacy_doc() {
    let legacy = json!({
      "sections": {
        "memory": { "enableMemorySummary": false }
      }
    });
    let migrated = ensure_shape(legacy);
    assert_eq!(
      migrated.get("settingsSchemaVersion").and_then(|v| v.as_u64()),
      Some(4)
    );
    assert_eq!(
      migrated
        .pointer("/sections/kioku_graph/worker_enabled")
        .and_then(|v| v.as_bool()),
      Some(true)
    );
    assert_eq!(
      migrated
        .pointer("/sections/kioku_graph/read_path")
        .and_then(|v| v.as_str()),
      Some("graph")
    );
    assert_eq!(
      migrated
        .pointer("/sections/meetings/autoStartOnVideoDetect")
        .and_then(|v| v.as_bool()),
      Some(true)
    );
    assert_eq!(
      migrated
        .pointer("/sections/meetings/autoStartOnCalendar")
        .and_then(|v| v.as_bool()),
      Some(false)
    );
  }

  #[test]
  fn migrate_auto_record_to_auto_start_on_calendar() {
    let legacy = json!({
      "settingsSchemaVersion": 2,
      "sections": {
        "meetings": { "autoRecord": true, "autoStartOnVideoDetect": false }
      }
    });
    let migrated = ensure_shape(legacy);
    assert_eq!(
      migrated.get("settingsSchemaVersion").and_then(|v| v.as_u64()),
      Some(4)
    );
    assert_eq!(
      migrated
        .pointer("/sections/meetings/autoStartOnCalendar")
        .and_then(|v| v.as_bool()),
      Some(true)
    );
  }

  /// `write_atomic` round-trip + no leftover tempfile after success.
  #[test]
  fn write_atomic_round_trip_no_litter() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("settings.json");
    write_atomic(&target, b"{\"hello\": 1}\n").expect("write");
    assert_eq!(
      fs::read_to_string(&target).expect("read"),
      "{\"hello\": 1}\n"
    );
    let leftovers: Vec<_> = fs::read_dir(dir.path())
      .expect("readdir")
      .filter_map(|e| e.ok())
      .map(|e| e.file_name())
      .filter(|n| n.to_string_lossy().starts_with(".settings.json.tmp-"))
      .collect();
    assert!(leftovers.is_empty(), "tempfiles left: {:?}", leftovers);
  }

  /// `write_atomic` overwrites in place — rename replaces existing target.
  #[test]
  fn write_atomic_replaces_existing_in_place() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("settings.json");
    fs::write(&target, b"{\"v\": 1}").expect("seed");
    write_atomic(&target, b"{\"v\": 2}").expect("write");
    assert_eq!(fs::read_to_string(&target).expect("read"), "{\"v\": 2}");
  }

  /// Concurrent writers race-test: rename is atomic, so the file is always
  /// either old or new contents — never torn. `WRITE_LOCK` serializes the
  /// higher-level read-modify-write in `save_patch` / `upsert_*`; this test
  /// pins the underlying primitive's guarantee.
  #[test]
  fn write_atomic_under_concurrent_writers() {
    use std::sync::Arc;
    use std::thread;
    let dir = Arc::new(tempfile::tempdir().expect("tempdir"));
    let target = Arc::new(dir.path().join("settings.json"));
    let mut handles = vec![];
    for i in 0..16 {
      let target = Arc::clone(&target);
      let payload = format!("{{\"writer\": {}}}\n", i);
      handles.push(thread::spawn(move || {
        write_atomic(&target, payload.as_bytes()).expect("concurrent write");
      }));
    }
    for h in handles {
      h.join().expect("thread join");
    }
    let final_contents = fs::read_to_string(&*target).expect("read final");
    let parsed: serde_json::Value =
      serde_json::from_str(&final_contents).expect("final file parses");
    assert!(parsed.get("writer").and_then(|v| v.as_u64()).is_some());
  }

  // ── Characterization: load / save_patch / upsert_integration_provider ────
  // These lock in current behavior ahead of the commands.rs / store refactor.
  // All use TestSettingsGuard so the user's real settings.json is untouched.

  /// `load()` with no file on disk returns the shaped empty document with all
  /// section defaults and the current schema version, without creating a file.
  #[test]
  fn load_missing_file_returns_shaped_defaults() {
    let guard = TestSettingsGuard::new("load-missing");
    let doc = load().expect("load");
    assert_eq!(
      doc.get("settingsSchemaVersion").and_then(|v| v.as_u64()),
      Some(4),
      "fresh doc should carry the latest schema version"
    );
    // Spot-check the section defaults the frontend relies on.
    assert_eq!(
      doc.pointer("/sections/memory/enableMemorySummary").and_then(|v| v.as_bool()),
      Some(true),
      "migrate_kioku_flags backfills enableMemorySummary=true for fresh installs"
    );
    assert_eq!(
      doc.pointer("/sections/capture/retentionDays").and_then(|v| v.as_u64()),
      Some(30)
    );
    assert_eq!(
      doc.pointer("/sections/meetings/autoIngestToMemory").and_then(|v| v.as_bool()),
      Some(true)
    );
    assert_eq!(
      doc.pointer("/sections/kioku_cost/monthly_cap_usd").and_then(|v| v.as_f64()),
      Some(10.0)
    );
    assert_eq!(
      doc.pointer("/sections/llm/extractionModel").and_then(|v| v.as_str()),
      Some("claude-haiku-4-5")
    );
    assert!(!guard.path.exists(), "load() must not create the file");
  }

  /// `load()` on a legacy (pre-versioned) file migrates it AND persists the
  /// migrated document back to disk (schema-version bump triggers a rewrite).
  #[test]
  fn load_migrates_legacy_file_and_persists_bump() {
    let guard = TestSettingsGuard::new("load-migrate");
    fs::write(
      &guard.path,
      r#"{ "sections": { "meetings": { "autoRecord": true } } }"#,
    )
    .expect("seed legacy file");

    let doc = load().expect("load");
    assert_eq!(
      doc.get("settingsSchemaVersion").and_then(|v| v.as_u64()),
      Some(4)
    );
    // v3 migration: legacy autoRecord is copied into autoStartOnCalendar.
    assert_eq!(
      doc.pointer("/sections/meetings/autoStartOnCalendar").and_then(|v| v.as_bool()),
      Some(true)
    );

    // The migrated doc must have been written back.
    let on_disk: Value =
      serde_json::from_str(&fs::read_to_string(&guard.path).expect("read")).expect("parse");
    assert_eq!(
      on_disk.get("settingsSchemaVersion").and_then(|v| v.as_u64()),
      Some(4),
      "migration result should be persisted"
    );
  }

  /// `load()` surfaces invalid JSON as Err (callers fall back to defaults).
  #[test]
  fn load_invalid_json_is_an_error() {
    let guard = TestSettingsGuard::new("load-bad-json");
    fs::write(&guard.path, b"{ not json").expect("seed corrupt file");
    assert!(load().is_err());
  }

  /// `save_patch` merges keys into the named section, preserves other
  /// sections, and stamps a top-level `updatedAt`.
  #[test]
  fn save_patch_merges_into_section_and_preserves_others() {
    let _guard = TestSettingsGuard::new("save-merge");
    save_patch(&json!({ "section": "capture", "paused": true })).expect("first save");
    let doc = save_patch(&json!({ "section": "memory", "autoDigest": true, "autoDigestLang": "jp" }))
      .expect("second save");

    assert_eq!(
      doc.pointer("/sections/memory/autoDigest").and_then(|v| v.as_bool()),
      Some(true)
    );
    assert_eq!(
      doc.pointer("/sections/memory/autoDigestLang").and_then(|v| v.as_str()),
      Some("jp")
    );
    // First section survived the second patch.
    assert_eq!(
      doc.pointer("/sections/capture/paused").and_then(|v| v.as_bool()),
      Some(true)
    );
    assert!(doc.get("updatedAt").and_then(|v| v.as_u64()).is_some());
    // The `section` discriminator key itself is never persisted as data.
    assert!(doc.pointer("/sections/memory/section").is_none());
  }

  /// `save_patch` without a `section` key falls back to the `misc` section.
  #[test]
  fn save_patch_defaults_to_misc_section() {
    let _guard = TestSettingsGuard::new("save-misc");
    let doc = save_patch(&json!({ "someFlag": 42 })).expect("save");
    assert_eq!(
      doc.pointer("/sections/misc/someFlag").and_then(|v| v.as_u64()),
      Some(42)
    );
  }

  /// `save_patch` overwrites existing keys within a section (last write wins)
  /// while leaving that section's other keys intact.
  #[test]
  fn save_patch_overwrites_key_keeps_siblings() {
    let _guard = TestSettingsGuard::new("save-overwrite");
    save_patch(&json!({ "section": "capture", "paused": false, "retentionDays": 7 }))
      .expect("seed");
    let doc = save_patch(&json!({ "section": "capture", "paused": true })).expect("patch");
    assert_eq!(
      doc.pointer("/sections/capture/paused").and_then(|v| v.as_bool()),
      Some(true)
    );
    assert_eq!(
      doc.pointer("/sections/capture/retentionDays").and_then(|v| v.as_u64()),
      Some(7)
    );
  }

  /// `upsert_integration_provider` creates the nested
  /// `sections.integrations.providers[slug]` path, merges patches, and stamps
  /// `updatedAt` on both the provider entry and the document.
  #[test]
  fn upsert_integration_provider_creates_and_merges() {
    let _guard = TestSettingsGuard::new("upsert-provider");
    upsert_integration_provider("gmail", &json!({ "connected": true })).expect("first upsert");
    let doc =
      upsert_integration_provider("gmail", &json!({ "scope": "read" })).expect("second upsert");

    let prov = doc
      .pointer("/sections/integrations/providers/gmail")
      .expect("provider entry");
    assert_eq!(prov.get("connected").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(prov.get("scope").and_then(|v| v.as_str()), Some("read"));
    assert!(prov.get("updatedAt").and_then(|v| v.as_u64()).is_some());
    assert!(doc.get("updatedAt").and_then(|v| v.as_u64()).is_some());
  }
}
