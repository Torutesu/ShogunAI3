//! Local JSON settings under the OS app data directory (via `directories`).
//!
//! Concurrency: `save_patch` and `upsert_integration_provider` both perform a
//! read-modify-write on the same file. Multiple writers can race today (in-app
//! Settings toggle vs. the macOS tray's emergency-stop click vs. background
//! integration sync). To prevent the lost-update problem AND truncate-on-crash
//! corruption, all writes are serialized through a process-level mutex AND
//! committed via tempfile + atomic rename.

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

fn settings_path() -> Result<PathBuf, String> {
  Ok(paths::app_data_dir()?.join("settings.json"))
}

/// Atomic write via tempfile + rename in the same directory. Power-loss /
/// kill-9 mid-write leaves either the old file or the new file, never a
/// truncated intermediate. Using the same directory keeps `rename` atomic on
/// the same filesystem (POSIX guarantee on macOS / Linux; same-volume
/// guarantee on Windows since Rust's `fs::rename` uses MoveFileExW with
/// REPLACE_EXISTING under the hood).
fn write_atomic(target: &Path, contents: &[u8]) -> Result<(), String> {
  let parent = target
    .parent()
    .ok_or_else(|| "settings target has no parent dir".to_string())?;
  fs::create_dir_all(parent).map_err(|e| e.to_string())?;
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
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(contents).map_err(|e| e.to_string())?;
    // Best-effort fsync so the rename's "either old or new" guarantee
    // actually means "new contents are durable". Ignore unsupported errors
    // (e.g. some FUSE filesystems).
    let _ = f.sync_all();
  }
  fs::rename(&tmp, target).map_err(|e| {
    // If rename fails, clean up the tempfile so we don't leave litter.
    let _ = fs::remove_file(&tmp);
    e.to_string()
  })
}

fn empty_doc() -> Value {
  json!({ "sections": {} })
}

pub fn load() -> Result<Value, String> {
  let path = settings_path()?;
  if !path.exists() {
    return Ok(empty_doc());
  }
  let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
  let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
  Ok(ensure_shape(v))
}

fn ensure_shape(mut v: Value) -> Value {
  if v.get("sections").and_then(|s| s.as_object()).is_none() {
    if let Some(obj) = v.as_object_mut() {
      obj.insert("sections".to_string(), json!({}));
    }
  }
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
      // Memory Digest (Phase 1): feature flag for summary generation and display.
      o.entry("enableMemorySummary".to_string()).or_insert(json!(true));
      // Auto-generate day + week rollups in the background so the Home
      // "Memory digest" card is populated when the user opens the app.
      o.entry("autoDigest".to_string()).or_insert(json!(true));
      o.entry("autoDigestIntervalMins".to_string()).or_insert(json!(360));
      o.entry("autoDigestLang".to_string()).or_insert(json!("en"));
    }
  }
  v
}

/// Merges `payload` into `sections[section]` using all keys except `section`.
///
/// Holds the process-level write lock for the entire read-modify-write so
/// concurrent callers (e.g. in-app Settings toggle vs. macOS tray click)
/// can't lose each other's updates. Persists via atomic rename so an
/// interrupted write never truncates the existing file.
pub fn save_patch(payload: &Value) -> Result<Value, String> {
  let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
  let path = settings_path()?;
  let mut doc = if path.exists() {
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
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
    .ok_or_else(|| "invalid settings document".to_string())?;

  let entry = sections.entry(section).or_insert_with(|| json!({}));
  let entry_obj = entry.as_object_mut().ok_or_else(|| "section value must be an object".to_string())?;
  for (k, v) in patch_map {
    entry_obj.insert(k, v);
  }

  if let Some(obj) = doc.as_object_mut() {
    obj.insert("updatedAt".to_string(), json!(now_ms()));
  }

  let serialized = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
  write_atomic(&path, serialized.as_bytes())?;

  Ok(doc)
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
  let path = settings_path()?;
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
  write_atomic(&path, serialized.as_bytes())?;

  Ok(doc)
}



#[cfg(test)]
mod tests {
  use super::*;

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
}
