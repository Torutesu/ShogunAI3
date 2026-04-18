//! Local JSON settings under the OS app data directory (via `directories`).

use crate::paths;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

fn settings_path() -> Result<PathBuf, String> {
  Ok(paths::app_data_dir()?.join("settings.json"))
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
  }
  v
}

/// Merges `payload` into `sections[section]` using all keys except `section`.
pub fn save_patch(payload: &Value) -> Result<Value, String> {
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

  fs::write(
    &path,
    serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
  )
  .map_err(|e| e.to_string())?;

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
pub fn upsert_integration_provider(slug: &str, patch: &Value) -> Result<Value, String> {
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

  fs::write(
    &path,
    serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
  )
  .map_err(|e| e.to_string())?;

  Ok(doc)
}

