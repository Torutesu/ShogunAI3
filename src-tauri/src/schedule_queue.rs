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
      "stub": false,
      "echo": payload,
    }))
}
