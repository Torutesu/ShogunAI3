//! Push finished meetings into `mem_items` for unified Memory search.

use crate::{meeting_store, memory_store, settings_store};
use serde_json::{json, Value};

pub fn auto_ingest_enabled() -> bool {
    settings_store::load()
        .ok()
        .and_then(|doc| {
            doc.pointer("/sections/meetings/autoIngestToMemory")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true)
}

fn build_snippet(
    meeting_id: &str,
    title: &str,
    summary_text: Option<&str>,
) -> Result<String, String> {
    let segs = meeting_store::list_transcript_final(meeting_id)?;
    let mut lines: Vec<String> = Vec::new();
    if let Some(sum) = summary_text {
        let t = sum.trim();
        if !t.is_empty() {
            lines.push(format!(
                "Summary: {}",
                t.chars().take(600).collect::<String>()
            ));
        }
    }
    for seg in segs.iter().take(24) {
        let sp = seg
            .get("speaker")
            .and_then(|x| x.as_str())
            .unwrap_or("Speaker");
        let tx = seg
            .get("text")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        if tx.is_empty() {
            continue;
        }
        lines.push(format!("{}: {}", sp, tx));
        if lines.join("\n").len() > 3500 {
            break;
        }
    }
    if lines.is_empty() {
        lines.push(format!(
            "Meeting \"{}\" (no transcript segments yet).",
            title
        ));
    }
    Ok(lines.join("\n").chars().take(4000).collect())
}

/// Upsert a Memory row keyed by `(source=meeting, entity_id=meeting_id)`.
pub fn ingest_meeting_to_memory(
    meeting_id: &str,
    summary: Option<&Value>,
) -> Result<Value, String> {
    if !auto_ingest_enabled() {
        return Ok(json!({ "skipped": true, "reason": "autoIngestToMemory disabled" }));
    }
    let detail = meeting_store::get_meeting_detail(meeting_id)?
        .ok_or_else(|| "meeting not found".to_string())?;
    let title = detail
        .get("title")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Meeting");
    let summary_text = summary
        .and_then(|s| s.get("summary").and_then(|x| x.as_str()))
        .or_else(|| summary.and_then(|s| s.get("text").and_then(|x| x.as_str())));
    let snippet = build_snippet(meeting_id, title, summary_text)?;
    let client_key = detail
        .get("client_storage_key")
        .and_then(|x| x.as_str())
        .map(String::from);
    let mut payload = json!({
      "title": title,
      "snippet": snippet,
      "source": "meeting",
      "provenance": "meeting",
      "entity_id": meeting_id,
      "kinds": ["note", "meeting"],
    });
    if let Some(ref sk) = client_key {
        payload["client_storage_key"] = json!(sk);
    }
    memory_store::ingest_capture_upsert(&payload)
}
