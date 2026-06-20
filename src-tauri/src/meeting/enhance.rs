//! LLM-based note enhancement (User / Ai / AiEdited model).

use crate::{llm, meeting_store, memory_store};
use serde_json::{json, Value};

/// Deletes prior `ai` blocks, then inserts new AI blocks per model output. User + `ai_edited` preserved.
pub async fn enhance_meeting_notes(meeting_id: &str, re_enhance: bool) -> Result<Value, String> {
    let _ = re_enhance;
    let blocks = meeting_store::list_note_blocks(meeting_id)?;
    let transcript = meeting_store::list_transcript_final(meeting_id)?;
    let transcript_text: String = transcript
        .iter()
        .filter_map(|s| {
            let text = s.get("text").and_then(|x| x.as_str())?;
            let sp = s.get("speaker").and_then(|x| x.as_str()).unwrap_or("?");
            Some(format!("[{}] {}", sp, text))
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut user_lines = String::new();
    for b in &blocks {
        let origin = b.get("origin").and_then(|x| x.as_str()).unwrap_or("");
        if origin == "ai" {
            continue;
        }
        let id = b.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let content = b.get("content").and_then(|x| x.as_str()).unwrap_or("");
        user_lines.push_str(&format!(
            "- block_id={} origin={}\n{}\n\n",
            id, origin, content
        ));
    }

    let detail = meeting_store::get_meeting_detail(meeting_id)?
        .ok_or_else(|| "meeting not found".to_string())?;
    let mut template_hint = String::new();
    if let Some(tid) = detail.get("template_id").and_then(|x| x.as_str()) {
        let templates = meeting_store::list_templates()?;
        if let Some(t) = templates
            .iter()
            .find(|v| v.get("id").and_then(|x| x.as_str()) == Some(tid))
        {
            let inst = t
                .get("enhance_instruction")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            template_hint = format!("Template instructions:\n{}\n", inst);
        }
    }

    let system = "You are SHOGUN meeting enhancement. Output ONLY a JSON object with shape {\"supplements\":[{\"after_block_id\":string,\"content\":string,\"segment_ids\":string[]}]}. \
Each supplement is inserted after the user/ai_edited block with that id. Use transcript segment UUIDs from the transcript list only. \
If nothing to add, return {\"supplements\":[]}. Never hallucinate facts not in the transcript. Preserve numbers verbatim when citing transcript.";
    let user_msg = format!(
    "{template_hint}## Transcript (verbatim segments)\n{transcript}\n\n## User / locked blocks (do not rewrite these; only add supplements)\n{user_lines}\n\n\
Respond with JSON only.",
    template_hint = template_hint,
    transcript = transcript_text.chars().take(24_000).collect::<String>(),
    user_lines = user_lines.chars().take(12_000).collect::<String>(),
  );

    let payload = json!({
      "messages": [
        { "role": "system", "content": system },
        { "role": "user", "content": user_msg }
      ]
    });
    let out = llm::chat_complete(&payload, None).await?;
    let message = out
        .get("message")
        .and_then(|m| m.as_str())
        .ok_or_else(|| "empty LLM response".to_string())?;
    let parsed = llm::extract_json_object_from_llm_text(message)?;
    let supplements = parsed
        .get("supplements")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();

    let conn = memory_store::open_conn()?;
    conn.execute(
        "DELETE FROM meeting_note_blocks WHERE meeting_id = ?1 AND origin = 'ai'",
        rusqlite::params![meeting_id],
    )
    .map_err(|e| e.to_string())?;

    let mut with_ord: Vec<(i64, Value)> = Vec::new();
    for sup in supplements {
        let after_id = sup
            .get("after_block_id")
            .and_then(|x| x.as_str())
            .ok_or_else(|| "supplement missing after_block_id".to_string())?;
        let after_ord: i64 = conn
            .query_row(
                "SELECT ord FROM meeting_note_blocks WHERE id = ?1 AND meeting_id = ?2",
                rusqlite::params![after_id, meeting_id],
                |r| r.get(0),
            )
            .map_err(|_| format!("unknown after_block_id {after_id}"))?;
        with_ord.push((after_ord, sup));
    }
    with_ord.sort_by_key(|(o, _)| *o);

    for (_, sup) in with_ord {
        let after_id = sup
            .get("after_block_id")
            .and_then(|x| x.as_str())
            .ok_or_else(|| "supplement missing after_block_id".to_string())?;
        let content = sup
            .get("content")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        if content.is_empty() {
            continue;
        }
        let segment_ids: Vec<String> = sup
            .get("segment_ids")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if segment_ids.is_empty() {
            return Err("AI supplement must cite at least one transcript segment_id".to_string());
        }

        let after_ord: i64 = conn
            .query_row(
                "SELECT ord FROM meeting_note_blocks WHERE id = ?1 AND meeting_id = ?2",
                rusqlite::params![after_id, meeting_id],
                |r| r.get(0),
            )
            .map_err(|_| format!("unknown after_block_id {after_id}"))?;

        conn.execute(
            "UPDATE meeting_note_blocks SET ord = ord + 1 WHERE meeting_id = ?1 AND ord > ?2",
            rusqlite::params![meeting_id, after_ord],
        )
        .map_err(|e| e.to_string())?;
        let new_ord = after_ord + 1;
        let new_id = meeting_store::new_uuid();
        meeting_store::insert_note_block(
            meeting_id,
            &new_id,
            new_ord,
            content,
            "ai",
            &segment_ids,
        )?;
    }

    meeting_store::meeting_set_state(meeting_id, "done")?;
    let note = json!({
      "meeting_id": meeting_id,
      "blocks": meeting_store::list_note_blocks(meeting_id)?,
      "updated_at": memory_store::now_ms(),
    });
    Ok(note)
}

/// Granola / localStorage meeting notes — LLM minutes without a SQLite meeting row.
pub async fn enhance_granola_notes(payload: &Value) -> Result<Value, String> {
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Meeting");
    let notes = payload.get("notes").and_then(|v| v.as_str()).unwrap_or("");
    let transcript = payload
        .get("transcript")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let summary = payload
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let storage_key = payload
        .get("storageKey")
        .or_else(|| payload.get("storage_key"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let system = "You are SHOGUN meeting notes assistant. Produce clear meeting minutes in Markdown. \
Include: title, date line, attendees (if known), summary, decisions, action items with owners when stated, and open questions. \
Use only facts from the provided notes and transcript — do not invent attendees or decisions.";
    let user_msg = format!(
    "# Meeting: {title}\n\n## User notes\n{notes}\n\n## Transcript\n{transcript}\n\n## Prior summary\n{summary}\n\nWrite minutes in Markdown.",
    title = title,
    notes = notes.chars().take(8_000).collect::<String>(),
    transcript = transcript.chars().take(12_000).collect::<String>(),
    summary = summary.chars().take(4_000).collect::<String>(),
  );
    let llm_payload = json!({
      "messages": [
        { "role": "system", "content": system },
        { "role": "user", "content": user_msg }
      ]
    });
    let out = llm::chat_complete(&llm_payload, None).await?;
    let md = out
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if md.is_empty() {
        return Err("LLM returned empty minutes".to_string());
    }
    Ok(json!({
      "minutesMarkdown": md,
      "minutes": md,
      "markdown": md,
      "storageKey": storage_key,
      "stub": false,
    }))
}
