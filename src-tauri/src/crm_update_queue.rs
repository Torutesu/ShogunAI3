//! Append-only local queue for CRM-style updates before any external sync.

use crate::paths;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn ts_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_queue(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
        .or(Ok(Vec::new()))
}

fn write_queue(path: &Path, arr: &[Value]) -> Result<(), String> {
    fs::write(
        path,
        serde_json::to_string_pretty(arr).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn append_at_path(path: &Path, payload: &Value) -> Result<Value, String> {
    let mut arr = read_queue(path)?;
    let id = format!("crm-{}", ts_ms());
    let entry = json!({
      "id": id,
      "createdAt": ts_ms(),
      "payload": payload,
    });
    arr.push(entry);
    write_queue(path, &arr)?;
    Ok(json!({
      "queued": true,
      "id": id,
      "stub": false,
      "echo": payload,
    }))
}

fn list_at_path(path: &Path, payload: &Value) -> Result<Value, String> {
    let mut arr = read_queue(path)?;
    arr.reverse();
    let limit = payload
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(20)
        .clamp(1, 100) as usize;
    let items: Vec<Value> = arr.into_iter().take(limit).collect();
    Ok(json!({
      "items": items,
      "total": items.len(),
      "stub": false,
      "echo": payload,
    }))
}

fn remove_at_path(path: &Path, payload: &Value) -> Result<Value, String> {
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "id is required".to_string())?;
    let mut arr = read_queue(path)?;
    let before = arr.len();
    arr.retain(|item| item.get("id").and_then(|v| v.as_str()) != Some(id));
    let removed = before.saturating_sub(arr.len());
    if removed == 0 {
        return Err("Queue item not found".to_string());
    }
    write_queue(path, &arr)?;
    Ok(json!({
      "removed": true,
      "id": id,
      "remaining": arr.len(),
      "stub": false,
      "echo": payload,
    }))
}

fn retry_at_path(path: &Path, payload: &Value) -> Result<Value, String> {
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "id is required".to_string())?;
    let arr = read_queue(path)?;
    let original = arr
        .iter()
        .find(|item| item.get("id").and_then(|v| v.as_str()) == Some(id))
        .ok_or_else(|| "Queue item not found".to_string())?;
    let mut next_payload = original
        .get("payload")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(obj) = next_payload.as_object_mut() {
        obj.insert("retried_from".to_string(), json!(id));
    }
    let saved = append_at_path(path, &next_payload)?;
    Ok(json!({
      "retried": true,
      "fromId": id,
      "item": saved,
      "stub": false,
      "echo": payload,
    }))
}

pub fn append(payload: &Value) -> Result<Value, String> {
    let path = paths::app_data_dir()?.join("crm_update_queue.json");
    let result = append_at_path(&path, payload)?;
    crate::app_events::emit_action_layer_refresh("queue.crm_updates.append", Some(result.clone()));
    Ok(result)
}

pub fn list(payload: &Value) -> Result<Value, String> {
    let path = paths::app_data_dir()?.join("crm_update_queue.json");
    list_at_path(&path, payload)
}

pub fn remove(payload: &Value) -> Result<Value, String> {
    let path = paths::app_data_dir()?.join("crm_update_queue.json");
    let result = remove_at_path(&path, payload)?;
    crate::app_events::emit_action_layer_refresh("queue.crm_updates.remove", Some(result.clone()));
    Ok(result)
}

pub fn retry(payload: &Value) -> Result<Value, String> {
    let path = paths::app_data_dir()?.join("crm_update_queue.json");
    let result = retry_at_path(&path, payload)?;
    crate::app_events::emit_action_layer_refresh("queue.crm_updates.retry", Some(result.clone()));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{append_at_path, list_at_path, remove_at_path, retry_at_path};
    use serde_json::json;

    #[test]
    fn append_list_and_remove_round_trip() {
        let mut path = std::env::temp_dir();
        path.push(format!("shogun-crm-queue-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let saved = append_at_path(&path, &json!({ "title": "CRM update" })).expect("append");
        let id = saved["id"].as_str().expect("id").to_string();

        let listed = list_at_path(&path, &json!({ "limit": 5 })).expect("list");
        assert_eq!(listed["total"].as_u64(), Some(1));

        let removed = remove_at_path(&path, &json!({ "id": id })).expect("remove");
        assert_eq!(removed["removed"].as_bool(), Some(true));

        let listed_after = list_at_path(&path, &json!({ "limit": 5 })).expect("list");
        assert_eq!(listed_after["total"].as_u64(), Some(0));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn retry_requeues_existing_payload() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "shogun-crm-queue-retry-test-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        let saved = append_at_path(&path, &json!({ "title": "CRM Retry" })).expect("append");
        let id = saved["id"].as_str().expect("id").to_string();
        let retried = retry_at_path(&path, &json!({ "id": id })).expect("retry");
        assert_eq!(retried["retried"].as_bool(), Some(true));

        let listed = list_at_path(&path, &json!({ "limit": 5 })).expect("list");
        assert_eq!(listed["total"].as_u64(), Some(2));

        let _ = std::fs::remove_file(&path);
    }
}
