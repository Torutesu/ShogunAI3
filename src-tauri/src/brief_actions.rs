//! Morning Brief CTAs: material packs, focus sessions, draft replies — real filesystem + Memory hooks.

use crate::{context_assembly, memory_store, paths};
use serde_json::{json, Value};
use std::fs;

fn sanitize_pack_token(s: &str) -> String {
  s.chars()
    .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
    .take(80)
    .collect::<String>()
}

/// Build a folder of Markdown (+ related Memory hits) and reveal it in Finder / file manager.
pub async fn open_pack(payload: &Value) -> Result<Value, String> {
  let pack_id = payload
    .get("pack_id")
    .and_then(|x| x.as_str())
    .unwrap_or("pack");
  let safe = sanitize_pack_token(pack_id);
  let token = if safe.is_empty() { "pack".to_string() } else { safe };
  let dir = paths::app_data_dir()?
    .join("packs")
    .join(format!("{}_{}", token, memory_store::now_ms()));
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

  let mut readme = String::from("# SHOGUN material pack\n\n");
  if let Some(item) = payload.get("brief_item") {
    if let Some(w) = item.get("what").and_then(|x| x.as_str()) {
      readme.push_str("## Task / event\n\n");
      readme.push_str(w);
      readme.push_str("\n\n");
    }
    if let Some(w) = item.get("why_now").and_then(|x| x.as_str()) {
      readme.push_str("## Why now\n\n");
      readme.push_str(w);
      readme.push_str("\n\n");
    }
    if let Some(rc) = item.get("related_context").and_then(|x| x.as_array()) {
      readme.push_str("## Linked context\n\n");
      for x in rc {
        let title = x.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let uri = x.get("uri").and_then(|t| t.as_str()).unwrap_or("");
        readme.push_str(&format!("- {} (`{}`)\n", title, uri));
      }
      readme.push_str("\n");
    }
  }

  let q = payload
    .get("brief_item")
    .and_then(|i| i.get("what"))
    .and_then(|x| x.as_str())
    .unwrap_or(pack_id)
    .chars()
    .take(240)
    .collect::<String>();
  let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
    query: &q,
    limit: 16,
    semantic: false,
    // T7 polish: pack markdown never includes raw screen captures.
    excluded_provenances: Some(vec!["screen".to_string()]),
  })
  .await
  .unwrap_or_default();
  let mem_md = context_assembly::format_hits_pack_markdown(&hits);

  fs::write(dir.join("README.md"), readme).map_err(|e| e.to_string())?;
  fs::write(dir.join("memory_hits.md"), mem_md).map_err(|e| e.to_string())?;

  #[cfg(target_os = "macos")]
  {
    let _ = std::process::Command::new("open").arg(dir.as_path()).status();
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = open::that(dir.join("README.md"));
  }

  Ok(json!({
    "opened": true,
    "path": dir.display().to_string(),
    "stub": false,
    "echo": payload
  }))
}

/// Persist an active focus session and open a working note; log start to Memory.
pub fn start_focus_session(payload: &Value) -> Result<Value, String> {
  let duration = payload
    .get("duration_minutes")
    .and_then(|x| x.as_u64())
    .or_else(|| payload.get("duration_minutes").and_then(|x| x.as_f64()).map(|f| f as u64))
    .unwrap_or(25)
    .clamp(1, 720);
  let task = payload
    .get("task")
    .and_then(|x| x.as_str())
    .unwrap_or("focus");
  let task_safe = sanitize_pack_token(task);
  let task_label = if task_safe.is_empty() { "focus".to_string() } else { task_safe };

  let start = memory_store::now_ms();
  let end = start.saturating_add(duration.saturating_mul(60_000));

  let state = json!({
    "task": task,
    "duration_minutes": duration,
    "started_at_ms": start,
    "ends_at_ms": end,
    "brief_item": payload.get("brief_item"),
  });
  let state_path = paths::app_data_dir()?.join("active_focus.json");
  fs::write(
    &state_path,
    serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?,
  )
  .map_err(|e| e.to_string())?;

  let pack_dir = paths::app_data_dir()?.join("packs").join(format!(
    "focus_{}_{}",
    task_label,
    start
  ));
  fs::create_dir_all(&pack_dir).map_err(|e| e.to_string())?;
  let md = format!(
    r#"# Focus session

- **Task:** {task}
- **Duration:** {duration} minutes
- **Started (epoch ms):** {start}
- **Target end (epoch ms):** {end}

## Notes

(SHOGUN — stay on task. Session state is also in `active_focus.json` in app data.)

## Brief context

{brief}
"#,
    task = task,
    duration = duration,
    start = start,
    end = end,
    brief = payload
      .get("brief_item")
      .and_then(|v| serde_json::to_string_pretty(v).ok())
      .unwrap_or_else(|| "—".to_string()),
  );
  let focus_file = pack_dir.join("FOCUS.md");
  fs::write(&focus_file, md).map_err(|e| e.to_string())?;

  let _ = memory_store::ingest(&json!({
    "title": format!("Focus session · {} ({}m)", task, duration),
    "snippet": format!("Started {} — ends {}", start, end),
    "source": "focus_session",
    "kinds": ["note"]
  }));

  #[cfg(target_os = "macos")]
  {
    let _ = std::process::Command::new("open")
      .arg(focus_file.as_path())
      .status();
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = open::that(&focus_file);
  }

  Ok(json!({
    "started": true,
    "ends_at_ms": end,
    "state_path": state_path.display().to_string(),
    "focus_markdown": focus_file.display().to_string(),
    "stub": false,
    "echo": payload
  }))
}
