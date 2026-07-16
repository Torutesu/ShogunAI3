//! Append-only local schedule queue (no OS calendar sync in v1).

use crate::paths;
use serde_json::{json, Value};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn ts_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn append(payload: &Value) -> Result<Value, String> {
    let path = paths::app_data_dir()?.join("schedule_queue.json");
    let mut arr: Vec<Value> = if path.exists() {
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let id = format!("sch-{}", ts_ms());
    let entry = json!({
      "id": id,
      "createdAt": ts_ms(),
      // No execution engine in v1 — entries sit here until surfaced. Stamp the
      // state honestly so the UI never implies these actions ran.
      "status": "pending",
      "payload": payload,
    });
    arr.push(entry);
    fs::write(
        &path,
        serde_json::to_string_pretty(&arr).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({
      "scheduled": true,
      "id": id,
      "status": "pending",
      "stub": false,
      "echo": payload,
    }))
}

/// Read all queued entries (newest first). The queue is not auto-executed in
/// v1; this makes it readable so the UI/Brief can surface pending actions
/// instead of them being a write-only sink.
pub fn list() -> Result<Vec<Value>, String> {
    let path = paths::app_data_dir()?.join("schedule_queue.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut arr: Vec<Value> = serde_json::from_str(
        &fs::read_to_string(&path).map_err(|e| e.to_string())?,
    )
    .unwrap_or_default();
    arr.reverse();
    Ok(arr)
}

/// Count of pending (never-executed) queued actions.
pub fn pending_count() -> usize {
    list()
        .map(|items| {
            items
                .iter()
                .filter(|e| {
                    e.get("status")
                        .and_then(|s| s.as_str())
                        // Legacy entries predate the status field — treat as pending.
                        .map(|s| s == "pending")
                        .unwrap_or(true)
                })
                .count()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_then_list_round_trips_with_pending_status() {
        // Point app_data_dir at a temp dir via the same override tests use.
        let tmp = std::env::temp_dir().join(format!("shogun-schedq-{}", ts_ms()));
        std::fs::create_dir_all(&tmp).unwrap();
        crate::paths::set_test_app_data_dir(tmp.clone());

        assert_eq!(pending_count(), 0);
        append(&json!({ "kind": "follow_up", "who": "Tanaka" })).expect("append");
        append(&json!({ "kind": "reply", "who": "Sato" })).expect("append");

        let items = list().expect("list");
        assert_eq!(items.len(), 2);
        // Newest first.
        assert_eq!(items[0]["payload"]["who"], json!("Sato"));
        assert_eq!(items[0]["status"], json!("pending"));
        assert_eq!(pending_count(), 2);

        crate::paths::clear_test_app_data_dir();
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
