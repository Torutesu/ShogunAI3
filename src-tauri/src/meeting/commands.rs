//! Tauri commands: `shogun_meeting_*` (Granola / meetings PRD).

use crate::{
    meeting_enhance, meeting_import, meeting_lifecycle, meeting_mcp, meeting_mic, meeting_recipes,
    meeting_session, meeting_store, meeting_stt, memory_store,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::params;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn shogun_meeting_start(
    state: State<'_, meeting_session::MeetingSessionState>,
    payload: Value,
) -> Result<Value, String> {
    let template_id = payload
        .get("template_id")
        .and_then(|x| x.as_str())
        .map(String::from);
    let app_bundle_id = payload
        .get("app_bundle_id")
        .and_then(|x| x.as_str())
        .map(String::from);
    let title = payload
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("Untitled meeting")
        .to_string();
    let client_storage_key = payload
        .get("client_storage_key")
        .or_else(|| payload.get("storage_key"))
        .or_else(|| payload.get("storageKey"))
        .and_then(|x| x.as_str())
        .map(String::from);
    let id = meeting_store::new_uuid();
    let started = memory_store::now_ms();
    meeting_store::meeting_insert(
        &id,
        started,
        template_id.as_deref(),
        app_bundle_id.as_deref(),
        Some(&title),
        client_storage_key.as_deref(),
    )?;
    if let Some(ref tid) = template_id {
        meeting_store::seed_note_from_template(&id, tid)?;
    }
    state.start(meeting_session::ActiveMeeting {
        id: id.clone(),
        started_at_ms: started,
        template_id: template_id.clone(),
        app_bundle_id: app_bundle_id.clone(),
        title: title.clone(),
        live: Vec::new(),
        last_activity_ms: started,
        last_video_seen_ms: started,
    })?;
    Ok(json!({
      "id": id,
      "started_at": started,
      "app_bundle_id": app_bundle_id,
      "template_id": template_id,
      "title": title,
      "state": "recording",
      "client_storage_key": client_storage_key,
      "stub": false,
      "echo": payload,
    }))
}

#[tauri::command]
pub fn shogun_meeting_link_client_note(payload: Value) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    let key = payload
        .get("storage_key")
        .or_else(|| payload.get("storageKey"))
        .or_else(|| payload.get("client_storage_key"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| "storage_key is required".to_string())?;
    let mut out = meeting_store::link_client_storage_key(meeting_id, key)?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("stub".to_string(), json!(false));
        obj.insert("echo".to_string(), payload);
    }
    Ok(out)
}

#[tauri::command]
pub fn shogun_meeting_resolve_by_storage_key(payload: Value) -> Result<Value, String> {
    let key = payload
        .get("storage_key")
        .or_else(|| payload.get("storageKey"))
        .or_else(|| payload.get("client_storage_key"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| "storage_key is required".to_string())?;
    match meeting_store::meeting_by_client_storage_key(key)? {
        Some(meeting) => {
            let meeting_id = meeting.get("id").cloned().unwrap_or(Value::Null);
            Ok(json!({
              "found": true,
              "meeting_id": meeting_id,
              "meeting": meeting,
              "stub": false,
              "echo": payload,
            }))
        }
        None => Ok(json!({
          "found": false,
          "meeting_id": Value::Null,
          "meeting": Value::Null,
          "stub": false,
          "echo": payload,
        })),
    }
}

#[tauri::command]
pub async fn shogun_meeting_stop(
    app: AppHandle,
    state: State<'_, meeting_session::MeetingSessionState>,
    payload: Value,
) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    meeting_lifecycle::stop_mic_if_running(&app, &meeting_id).await?;
    let mut out = meeting_lifecycle::persist_meeting_stop(&state, &meeting_id).await?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("stub".to_string(), json!(false));
        obj.insert("echo".to_string(), payload);
    }
    Ok(out)
}

#[tauri::command]
pub fn shogun_meeting_note_append_block(payload: Value) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    let text = payload
        .get("text")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "text is required".to_string())?;
    let after = payload.get("after_block_id").and_then(|x| x.as_str());
    let ord = if let Some(after_id) = after {
        let conn = memory_store::open_conn()?;
        let after_ord: i64 = conn
            .query_row(
                "SELECT ord FROM meeting_note_blocks WHERE id = ?1 AND meeting_id = ?2",
                params![after_id, meeting_id],
                |r| r.get(0),
            )
            .map_err(|_| "after_block_id not found".to_string())?;
        conn.execute(
            "UPDATE meeting_note_blocks SET ord = ord + 1 WHERE meeting_id = ?1 AND ord > ?2",
            params![meeting_id, after_ord],
        )
        .map_err(|e| e.to_string())?;
        after_ord + 1
    } else {
        meeting_store::next_block_order(meeting_id)?
    };
    let bid = meeting_store::new_uuid();
    meeting_store::insert_note_block(meeting_id, &bid, ord, text, "user", &[])?;
    meeting_store::get_note_block(&bid)?.ok_or_else(|| "block insert failed".to_string())
}

#[tauri::command]
pub fn shogun_meeting_note_edit_block(payload: Value) -> Result<Value, String> {
    let block_id = payload
        .get("block_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "block_id is required".to_string())?;
    let text = payload
        .get("text")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "text is required".to_string())?;
    let prev =
        meeting_store::get_note_block(block_id)?.ok_or_else(|| "block not found".to_string())?;
    let origin = prev
        .get("origin")
        .and_then(|x| x.as_str())
        .unwrap_or("user");
    let new_origin = match origin {
        "ai" => "ai_edited",
        o => o,
    };
    let segs: Vec<String> = prev
        .get("source_segments")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    meeting_store::update_note_block(block_id, text, new_origin, &segs)?;
    meeting_store::get_note_block(block_id)?.ok_or_else(|| "block missing".to_string())
}

#[tauri::command]
pub fn shogun_meeting_note_delete_block(payload: Value) -> Result<Value, String> {
    let block_id = payload
        .get("block_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "block_id is required".to_string())?;
    meeting_store::delete_note_block(block_id)?;
    Ok(json!({ "ok": true, "echo": payload }))
}

#[tauri::command]
pub async fn shogun_meeting_enhance(payload: Value) -> Result<Value, String> {
    if payload.get("meeting_id").is_none() {
        if payload.get("storageKey").is_some() || payload.get("storage_key").is_some() {
            return meeting_enhance::enhance_granola_notes(&payload).await;
        }
    }
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id or storageKey is required".to_string())?;
    meeting_store::meeting_set_state(meeting_id, "enhancing")?;
    meeting_enhance::enhance_meeting_notes(meeting_id, false).await
}

#[tauri::command]
pub async fn shogun_meeting_re_enhance(payload: Value) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    meeting_store::meeting_set_state(meeting_id, "enhancing")?;
    meeting_enhance::enhance_meeting_notes(meeting_id, true).await
}

#[tauri::command]
pub fn shogun_meeting_transcript_for_block(payload: Value) -> Result<Value, String> {
    let block_id = payload
        .get("block_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "block_id is required".to_string())?;
    let segs = meeting_store::segments_for_block(block_id)?;
    Ok(json!({ "segments": segs, "echo": payload }))
}

#[tauri::command]
pub fn shogun_meeting_transcript_live(
    state: State<'_, meeting_session::MeetingSessionState>,
    payload: Value,
) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    let live = state.live_snapshot(meeting_id)?;
    Ok(json!({ "segments": live, "echo": payload }))
}

#[tauri::command]
pub fn shogun_meeting_purge(payload: Value) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    meeting_store::purge_meeting(meeting_id)?;
    Ok(json!({ "purged": true, "echo": payload }))
}

#[tauri::command]
pub fn shogun_meeting_list(payload: Value) -> Result<Value, String> {
    let from_ms = payload.get("from_ms").and_then(|x| x.as_u64());
    let to_ms = payload.get("to_ms").and_then(|x| x.as_u64());
    let limit = payload.get("limit").and_then(|x| x.as_u64()).unwrap_or(50) as usize;
    let meetings = meeting_store::list_meetings(from_ms, to_ms, limit)?;
    Ok(json!({ "meetings": meetings, "echo": payload }))
}

#[tauri::command]
pub fn shogun_meeting_get(payload: Value) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    let detail = meeting_store::get_meeting_detail(meeting_id)?
        .ok_or_else(|| "meeting not found".to_string())?;
    let transcript = meeting_store::list_transcript_final(meeting_id)?;
    let notes = meeting_store::list_note_blocks(meeting_id)?;
    Ok(json!({
      "meeting": detail,
      "transcript": transcript,
      "notes": notes,
      "echo": payload,
    }))
}

#[tauri::command]
pub fn shogun_meeting_transcript_get(payload: Value) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    let transcript = meeting_store::list_transcript_final(meeting_id)?;
    Ok(json!({ "segments": transcript, "echo": payload }))
}

#[tauri::command]
pub fn shogun_meeting_notes_get(payload: Value) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    let notes = meeting_store::list_note_blocks(meeting_id)?;
    Ok(json!({ "blocks": notes, "echo": payload }))
}

#[tauri::command]
pub fn shogun_meetings_search(payload: Value) -> Result<Value, String> {
    let q = payload
        .get("query")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim();
    let limit = payload.get("limit").and_then(|x| x.as_u64()).unwrap_or(25) as usize;
    let hits = meeting_store::search_meetings_fts(q, limit)?;
    Ok(json!({ "hits": hits, "echo": payload }))
}

#[tauri::command]
pub async fn shogun_meeting_recipe_run(payload: Value) -> Result<Value, String> {
    meeting_recipes::run_recipe(&payload).await
}

#[tauri::command]
pub fn shogun_meeting_templates_list(payload: Value) -> Result<Value, String> {
    let t = meeting_store::list_templates()?;
    Ok(json!({ "templates": t, "echo": payload }))
}

/// Dev / STT bridge: append a final transcript segment (until streaming STT lands).
#[tauri::command]
pub fn shogun_meeting_transcript_push(
    state: State<'_, meeting_session::MeetingSessionState>,
    payload: Value,
) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    let text = payload
        .get("text")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let speaker = payload
        .get("speaker")
        .and_then(|x| x.as_str())
        .unwrap_or("other_1")
        .to_string();
    let start_ms = payload
        .get("start_ms")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let end_ms = payload
        .get("end_ms")
        .and_then(|x| x.as_u64())
        .unwrap_or(start_ms);
    let seg_id = meeting_store::new_uuid();
    let seg = json!({
      "segment_id": seg_id,
      "meeting_id": meeting_id,
      "start_ms": start_ms,
      "end_ms": end_ms,
      "speaker": speaker,
      "text": text,
      "confidence": payload.get("confidence").and_then(|x| x.as_f64()).unwrap_or(1.0),
      "is_final": true,
    });
    state.push_live_segment(meeting_id, seg.clone())?;
    Ok(json!({ "segment": seg, "echo": payload }))
}

#[tauri::command]
pub fn shogun_meeting_audio_status(
    mic: State<'_, meeting_mic::MeetingMicController>,
    payload: Value,
) -> Result<Value, String> {
    let st = mic.status();
    Ok(json!({
      "deepgram_configured": meeting_stt::deepgram_api_key().is_some(),
      "default_input_device": meeting_mic::default_input_device_label(),
      "mic_capture_running": st.get("mic_capture_running").and_then(|x| x.as_bool()).unwrap_or(false),
      "system_audio_running": st.get("system_audio_running").and_then(|x| x.as_bool()).unwrap_or(false),
      "system_mode": st.get("system_mode").cloned().unwrap_or(Value::Null),
      "system_audio_process_tap": st.get("system_audio_running").and_then(|x| x.as_bool()).unwrap_or(false),
      "message": "Mic: cpal default input. System: loopback device or ScreenCaptureKit display audio → PCM16 16kHz.",
      "stub": false,
      "echo": payload,
    }))
}

#[tauri::command]
pub fn shogun_meeting_mic_start(
    mic: State<'_, meeting_mic::MeetingMicController>,
    app: AppHandle,
    payload: Value,
) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .map(String::from);
    let live_stt = payload
        .get("live_stt")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let capture_system = payload
        .get("capture_system")
        .and_then(|x| x.as_bool())
        .unwrap_or(true);
    let mut out = mic.start_with(
        Some(app),
        meeting_mic::StartOptions {
            meeting_id,
            live_stt,
            capture_system,
        },
    )?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("stub".to_string(), json!(false));
        obj.insert("echo".to_string(), payload);
    }
    Ok(out)
}

#[tauri::command]
pub async fn shogun_meeting_mic_stop(
    mic: State<'_, meeting_mic::MeetingMicController>,
    session: State<'_, meeting_session::MeetingSessionState>,
    payload: Value,
) -> Result<Value, String> {
    let transcribe = payload
        .get("transcribe")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|x| x.as_str())
        .map(String::from);

    let stopped = mic.stop()?;

    let mut out = json!({
      "pcm_bytes": stopped.mic_pcm.len(),
      "pcm_base64": B64.encode(&stopped.mic_pcm),
      "system_pcm_bytes": stopped.system_pcm.len(),
      "system_pcm_base64": B64.encode(&stopped.system_pcm),
      "stub": false,
      "echo": payload,
    });

    if transcribe {
        let mut segments: Vec<Value> = Vec::new();
        if !stopped.mic_pcm.is_empty() {
            if let Ok((text, conf)) =
                meeting_stt::deepgram_transcribe_pcm16_16k(&stopped.mic_pcm).await
            {
                if !text.trim().is_empty() {
                    let dur_ms =
                        ((stopped.mic_pcm.len() as u64 / 2).saturating_mul(1000)).max(1) / 16000;
                    let seg = json!({
                      "segment_id": meeting_store::new_uuid(),
                      "meeting_id": meeting_id,
                      "start_ms": 0u64,
                      "end_ms": dur_ms,
                      "speaker": "self",
                      "text": text,
                      "confidence": conf as f64,
                      "is_final": true,
                    });
                    if let Some(ref mid) = meeting_id {
                        let _ = session.push_live_segment(mid.as_str(), seg.clone());
                    }
                    segments.push(seg);
                }
                out["transcript"] = json!(text);
                out["confidence"] = json!(conf);
            }
        }
        if !stopped.system_pcm.is_empty() {
            if let Ok((text, conf)) =
                meeting_stt::deepgram_transcribe_pcm16_16k(&stopped.system_pcm).await
            {
                if !text.trim().is_empty() {
                    let dur_ms =
                        ((stopped.system_pcm.len() as u64 / 2).saturating_mul(1000)).max(1) / 16000;
                    let seg = json!({
                      "segment_id": meeting_store::new_uuid(),
                      "meeting_id": meeting_id,
                      "start_ms": 0u64,
                      "end_ms": dur_ms,
                      "speaker": "other",
                      "text": text,
                      "confidence": conf as f64,
                      "is_final": true,
                    });
                    if let Some(ref mid) = meeting_id {
                        let _ = session.push_live_segment(mid.as_str(), seg.clone());
                    }
                    segments.push(seg);
                    out["system_transcript"] = json!(text);
                }
            }
        }
        if !segments.is_empty() {
            out["segments"] = json!(segments);
        }
    }

    Ok(out)
}

#[tauri::command]
pub async fn shogun_meeting_transcribe_pcm(payload: Value) -> Result<Value, String> {
    let pcm_b64 = payload
        .get("pcm_base64")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "pcm_base64 is required".to_string())?;
    let pcm = B64
        .decode(pcm_b64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;
    let (text, conf) = meeting_stt::deepgram_transcribe_pcm16_16k(&pcm).await?;
    Ok(json!({
      "text": text,
      "confidence": conf,
      "stub": false,
      "echo": payload,
    }))
}

#[tauri::command]
pub fn shogun_meeting_mcp_tools(payload: Value) -> Result<Value, String> {
    Ok(json!({
      "tools": meeting_mcp::tool_definitions(),
      "stub": false,
      "echo": payload,
    }))
}

/// Native file picker that returns selected audio / video file paths.
/// UI asks the user, then invokes `shogun_meeting_import_file` per path.
#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn shogun_meeting_import_pick(payload: Value) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let picked = rfd::FileDialog::new()
            .set_title("Select audio or video recordings to import")
            .add_filter(
                "Audio / Video",
                &[
                    "mp3", "m4a", "mp4", "mov", "wav", "webm", "ogg", "oga", "aac", "flac",
                ],
            )
            .pick_files();
        let paths: Vec<String> = picked
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.display().to_string())
            .collect();
        Ok(json!({
          "cancelled": paths.is_empty(),
          "paths": paths,
          "stub": false,
          "echo": payload,
        }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("File picker is only available on macOS in this build.".to_string())
    }
}

/// Transcribes a single local audio/video file and stores it as a meeting.
#[tauri::command]
pub async fn shogun_meeting_import_file(payload: Value) -> Result<Value, String> {
    let path = payload
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or_else(|| "path is required".to_string())?;
    meeting_import::import_recording_file(path).await
}

/// Merged transcript + screen-capture timeline for one meeting session.
#[tauri::command]
pub async fn shogun_meeting_context_timeline(
    app: AppHandle,
    payload: Value,
) -> Result<Value, String> {
    let meeting_id = payload
        .get("meeting_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    let include_live = payload
        .get("include_live")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let limit = payload.get("limit").and_then(|v| v.as_u64()).unwrap_or(120) as usize;
    crate::meeting_context_timeline::build_context_timeline(
        Some(&app),
        meeting_id,
        include_live,
        limit,
    )
}

// ─── Phase 1 refactor safety net: characterization tests ─────────────────────
// First tests for this module (28 commands previously untested). They call the
// #[tauri::command] fns that take only a JSON payload — commands requiring
// `State<…>` or `AppHandle` (start/stop/mic/live transcript/enhance/import/
// context timeline) cannot be constructed without a Tauri app and are covered
// indirectly through the same `meeting_store` helpers they delegate to.
// Each test redirects memory.db (shared with meetings tables) to a temp file.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory_store::testkit::TestDbGuard;

    fn seed_meeting(id: &str, started_at: u64, title: &str) {
        meeting_store::meeting_insert(id, started_at, None, None, Some(title), None)
            .expect("insert meeting");
    }

    #[test]
    fn meeting_get_locks_meeting_json_shape() {
        let _g = TestDbGuard::new("mtg-get-shape");
        seed_meeting("mtg-1", 1_000_000, "Weekly sync");

        let out = shogun_meeting_get(json!({ "meeting_id": "mtg-1" })).expect("get ok");
        assert!(out.get("echo").is_some());
        assert_eq!(out["transcript"], json!([]));
        assert_eq!(out["notes"], json!([]));

        let m = out.get("meeting").expect("meeting present");
        // Snake_case field names the frontend depends on.
        assert_eq!(m["id"], json!("mtg-1"));
        assert_eq!(m["started_at"], json!(1_000_000));
        assert_eq!(m["ended_at"], json!(null));
        assert_eq!(m["app_bundle_id"], json!(null));
        assert_eq!(m["template_id"], json!(null));
        assert_eq!(m["title"], json!("Weekly sync"));
        assert_eq!(m["participants"], json!([]));
        assert_eq!(m["state"], json!("recording"));
        assert_eq!(m["client_storage_key"], json!(null));
    }

    #[test]
    fn meeting_get_error_strings() {
        let _g = TestDbGuard::new("mtg-get-errors");
        let err = shogun_meeting_get(json!({})).expect_err("missing meeting_id");
        assert_eq!(err, "meeting_id is required");

        let err = shogun_meeting_get(json!({ "meeting_id": "nope" })).expect_err("unknown id");
        assert_eq!(err, "meeting not found");
    }

    #[test]
    fn meeting_list_orders_desc_and_filters_window() {
        let _g = TestDbGuard::new("mtg-list");
        seed_meeting("mtg-old", 1_000, "Old");
        seed_meeting("mtg-mid", 2_000, "Mid");
        seed_meeting("mtg-new", 3_000, "New");

        let out = shogun_meeting_list(json!({})).expect("list ok");
        let meetings = out["meetings"].as_array().expect("meetings");
        let ids: Vec<&str> = meetings.iter().filter_map(|m| m["id"].as_str()).collect();
        assert_eq!(
            ids,
            vec!["mtg-new", "mtg-mid", "mtg-old"],
            "started_at DESC"
        );

        let windowed = shogun_meeting_list(json!({ "from_ms": 1_500, "to_ms": 2_500 }))
            .expect("windowed list ok");
        let ids: Vec<&str> = windowed["meetings"]
            .as_array()
            .expect("meetings")
            .iter()
            .filter_map(|m| m["id"].as_str())
            .collect();
        assert_eq!(ids, vec!["mtg-mid"]);
    }

    #[test]
    fn note_block_append_edit_delete_flow() {
        let _g = TestDbGuard::new("mtg-note-flow");
        seed_meeting("mtg-n", 1_000, "Notes");

        // Append: locks the note block JSON shape (incl. `order`, not `ord`).
        let b1 =
            shogun_meeting_note_append_block(json!({ "meeting_id": "mtg-n", "text": "first" }))
                .expect("append 1");
        assert_eq!(b1["meeting_id"], json!("mtg-n"));
        assert_eq!(b1["order"], json!(0));
        assert_eq!(b1["content"], json!("first"));
        assert_eq!(b1["origin"], json!("user"));
        assert_eq!(b1["source_segments"], json!([]));
        let b1_id = b1["id"].as_str().expect("block id").to_string();

        let b2 =
            shogun_meeting_note_append_block(json!({ "meeting_id": "mtg-n", "text": "second" }))
                .expect("append 2");
        assert_eq!(b2["order"], json!(1));

        // Insert between: after_block_id bumps later blocks' order.
        let mid = shogun_meeting_note_append_block(json!({
          "meeting_id": "mtg-n",
          "text": "in between",
          "after_block_id": b1_id,
        }))
        .expect("append between");
        assert_eq!(mid["order"], json!(1));

        let notes = shogun_meeting_notes_get(json!({ "meeting_id": "mtg-n" })).expect("notes ok");
        let blocks = notes["blocks"].as_array().expect("blocks");
        let contents: Vec<&str> = blocks
            .iter()
            .filter_map(|b| b["content"].as_str())
            .collect();
        assert_eq!(contents, vec!["first", "in between", "second"]);

        // Edit keeps origin 'user' as-is.
        let edited =
            shogun_meeting_note_edit_block(json!({ "block_id": b1_id, "text": "first v2" }))
                .expect("edit ok");
        assert_eq!(edited["content"], json!("first v2"));
        assert_eq!(edited["origin"], json!("user"));

        // Delete.
        let deleted =
            shogun_meeting_note_delete_block(json!({ "block_id": b1_id })).expect("delete ok");
        assert_eq!(deleted["ok"], json!(true));
        let after = shogun_meeting_notes_get(json!({ "meeting_id": "mtg-n" })).expect("notes ok");
        assert_eq!(after["blocks"].as_array().expect("blocks").len(), 2);

        // Error strings.
        let err = shogun_meeting_note_append_block(json!({ "meeting_id": "mtg-n" }))
            .expect_err("text required");
        assert_eq!(err, "text is required");
        let err = shogun_meeting_note_append_block(json!({
          "meeting_id": "mtg-n", "text": "x", "after_block_id": "ghost"
        }))
        .expect_err("unknown after_block_id");
        assert_eq!(err, "after_block_id not found");
        let err = shogun_meeting_note_edit_block(json!({ "block_id": "ghost", "text": "x" }))
            .expect_err("unknown block");
        assert_eq!(err, "block not found");
    }

    #[test]
    fn note_edit_transitions_ai_origin_to_ai_edited() {
        let _g = TestDbGuard::new("mtg-note-ai-edit");
        seed_meeting("mtg-ai", 1_000, "AI notes");
        meeting_store::insert_note_block("mtg-ai", "blk-ai", 0, "ai text", "ai", &[])
            .expect("insert ai block");

        let edited =
            shogun_meeting_note_edit_block(json!({ "block_id": "blk-ai", "text": "tweaked" }))
                .expect("edit ok");
        assert_eq!(edited["origin"], json!("ai_edited"));
        assert_eq!(edited["content"], json!("tweaked"));
    }

    #[test]
    fn transcript_get_locks_segment_json_shape() {
        let _g = TestDbGuard::new("mtg-transcript");
        seed_meeting("mtg-t", 1_000, "Transcribed");
        meeting_store::insert_transcript_segment(
            "mtg-t",
            "seg-1",
            0,
            1500,
            "self",
            "hello world",
            Some(0.95),
            true,
        )
        .expect("insert segment");
        // Non-final segments are excluded from the final transcript.
        meeting_store::insert_transcript_segment(
            "mtg-t", "seg-2", 1500, 2000, "other_1", "partial", None, false,
        )
        .expect("insert partial");

        let out = shogun_meeting_transcript_get(json!({ "meeting_id": "mtg-t" })).expect("get ok");
        let segs = out["segments"].as_array().expect("segments");
        assert_eq!(segs.len(), 1, "only final segments");
        let s = &segs[0];
        assert_eq!(s["segment_id"], json!("seg-1"));
        assert_eq!(s["meeting_id"], json!("mtg-t"));
        assert_eq!(s["start_ms"], json!(0));
        assert_eq!(s["end_ms"], json!(1500));
        assert_eq!(s["speaker"], json!("self"));
        assert_eq!(s["text"], json!("hello world"));
        assert!(s.get("confidence").and_then(|v| v.as_f64()).is_some());
        assert_eq!(s["is_final"], json!(true));
    }

    #[test]
    fn transcript_for_block_resolves_source_segments() {
        let _g = TestDbGuard::new("mtg-block-segs");
        seed_meeting("mtg-bs", 1_000, "Block sources");
        meeting_store::insert_transcript_segment(
            "mtg-bs",
            "seg-a",
            0,
            1000,
            "self",
            "cited text",
            Some(1.0),
            true,
        )
        .expect("insert segment");
        meeting_store::insert_note_block(
            "mtg-bs",
            "blk-1",
            0,
            "summary",
            "ai",
            &["seg-a".to_string()],
        )
        .expect("insert block");

        let out = shogun_meeting_transcript_for_block(json!({ "block_id": "blk-1" })).expect("ok");
        let segs = out["segments"].as_array().expect("segments");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0]["segment_id"], json!("seg-a"));
        assert_eq!(segs[0]["text"], json!("cited text"));

        let err = shogun_meeting_transcript_for_block(json!({})).expect_err("block_id required");
        assert_eq!(err, "block_id is required");
    }

    #[test]
    fn link_and_resolve_client_storage_key() {
        let _g = TestDbGuard::new("mtg-storage-key");
        seed_meeting("mtg-a", 1_000, "A");
        seed_meeting("mtg-b", 2_000, "B");

        // Resolve before linking: found=false with null placeholders.
        let miss = shogun_meeting_resolve_by_storage_key(json!({ "storage_key": "key-1" }))
            .expect("resolve ok");
        assert_eq!(miss["found"], json!(false));
        assert_eq!(miss["meeting_id"], json!(null));
        assert_eq!(miss["meeting"], json!(null));

        // Link, then resolve.
        let linked = shogun_meeting_link_client_note(
            json!({ "meeting_id": "mtg-a", "storage_key": "key-1" }),
        )
        .expect("link ok");
        assert_eq!(linked["ok"], json!(true));
        assert_eq!(linked["meeting_id"], json!("mtg-a"));
        assert_eq!(linked["already_linked"], json!(false));
        assert_eq!(linked["stub"], json!(false));

        let hit = shogun_meeting_resolve_by_storage_key(json!({ "storage_key": "key-1" }))
            .expect("resolve ok");
        assert_eq!(hit["found"], json!(true));
        assert_eq!(hit["meeting_id"], json!("mtg-a"));
        assert_eq!(hit["meeting"]["title"], json!("A"));

        // Relinking the same pair reports already_linked without conflict.
        let again = shogun_meeting_link_client_note(
            json!({ "meeting_id": "mtg-a", "storage_key": "key-1" }),
        )
        .expect("relink ok");
        assert_eq!(again["already_linked"], json!(true));
        assert!(again.get("conflict").is_none());

        // Linking the same key to another meeting reports the conflict and keeps
        // the original owner.
        let conflict = shogun_meeting_link_client_note(
            json!({ "meeting_id": "mtg-b", "storage_key": "key-1" }),
        )
        .expect("conflict link ok");
        assert_eq!(conflict["conflict"], json!(true));
        assert_eq!(conflict["meeting_id"], json!("mtg-a"));
        assert_eq!(conflict["requested_meeting_id"], json!("mtg-b"));

        // Error strings.
        let err = shogun_meeting_link_client_note(json!({ "meeting_id": "mtg-a" }))
            .expect_err("storage_key required");
        assert_eq!(err, "storage_key is required");
        let err =
            shogun_meeting_resolve_by_storage_key(json!({})).expect_err("storage_key required");
        assert_eq!(err, "storage_key is required");
        let err = shogun_meeting_link_client_note(
            json!({ "meeting_id": "ghost", "storage_key": "key-2" }),
        )
        .expect_err("unknown meeting");
        assert_eq!(err, "meeting not found");
    }

    #[test]
    fn meetings_search_matches_title_transcript_and_notes() {
        let _g = TestDbGuard::new("mtg-search");
        seed_meeting("mtg-s1", 1_000, "Quarterly business review");
        seed_meeting("mtg-s2", 2_000, "Untitled meeting");
        meeting_store::insert_transcript_segment(
            "mtg-s2",
            "seg-s",
            0,
            1000,
            "self",
            "discussing zebras",
            Some(1.0),
            true,
        )
        .expect("insert segment");

        // Title match: locks hit shape.
        let out = shogun_meetings_search(json!({ "query": "quarterly" })).expect("search ok");
        let hits = out["hits"].as_array().expect("hits");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["meeting_id"], json!("mtg-s1"));
        assert_eq!(hits[0]["started_at"], json!(1_000));
        assert_eq!(hits[0]["title"], json!("Quarterly business review"));
        assert_eq!(hits[0]["snippet"], json!(""));

        // Transcript text match.
        let out = shogun_meetings_search(json!({ "query": "zebras" })).expect("search ok");
        let hits = out["hits"].as_array().expect("hits");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["meeting_id"], json!("mtg-s2"));

        // Empty query returns no hits (not all meetings).
        let out = shogun_meetings_search(json!({})).expect("search ok");
        assert_eq!(out["hits"].as_array().expect("hits").len(), 0);
    }

    #[test]
    fn templates_list_returns_builtins_sorted_by_name() {
        let _g = TestDbGuard::new("mtg-templates");
        // Opening the DB seeds the builtin templates.
        let out = shogun_meeting_templates_list(json!({})).expect("list ok");
        let templates = out["templates"].as_array().expect("templates");
        let names: Vec<&str> = templates
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "1-on-1",
                "Customer Interview",
                "Design Review",
                "Sales Call",
                "Standup",
                "Weekly Team Meeting",
            ],
            "6 builtins, name ASC"
        );
        let t = &templates[0];
        assert_eq!(t["id"], json!("tmpl-1on1"));
        assert_eq!(t["is_builtin"], json!(true));
        assert!(t["sections"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false));
        assert!(t.get("description").is_some());
        assert!(t.get("enhance_instruction").is_some());
    }

    #[test]
    fn seeded_template_notes_use_markdown_headings() {
        // Locks the note-seeding behavior `shogun_meeting_start` relies on
        // (that command needs State<…> so the seeding path is tested via the
        // store helper it calls).
        let _g = TestDbGuard::new("mtg-template-seed");
        seed_meeting("mtg-tpl", 1_000, "Standup");
        meeting_store::seed_note_from_template("mtg-tpl", "tmpl-standup").expect("seed notes");

        let out = shogun_meeting_notes_get(json!({ "meeting_id": "mtg-tpl" })).expect("notes ok");
        let blocks = out["blocks"].as_array().expect("blocks");
        assert_eq!(blocks.len(), 3, "one block per template section");
        let first = blocks[0]["content"].as_str().expect("content");
        assert!(first.starts_with("## Yesterday"), "got {first:?}");
        assert_eq!(blocks[0]["origin"], json!("user"));
    }

    #[test]
    fn purge_cascades_to_transcript_and_notes() {
        let _g = TestDbGuard::new("mtg-purge");
        seed_meeting("mtg-p", 1_000, "Doomed");
        meeting_store::insert_transcript_segment(
            "mtg-p", "seg-p", 0, 1000, "self", "bye", None, true,
        )
        .expect("insert segment");
        meeting_store::insert_note_block("mtg-p", "blk-p", 0, "note", "user", &[])
            .expect("insert block");

        let out = shogun_meeting_purge(json!({ "meeting_id": "mtg-p" })).expect("purge ok");
        assert_eq!(out["purged"], json!(true));

        let err = shogun_meeting_get(json!({ "meeting_id": "mtg-p" })).expect_err("gone");
        assert_eq!(err, "meeting not found");
        // ON DELETE CASCADE wipes children (FKs are enabled per connection).
        let notes = shogun_meeting_notes_get(json!({ "meeting_id": "mtg-p" })).expect("notes ok");
        assert_eq!(notes["blocks"].as_array().expect("blocks").len(), 0);
        let transcript =
            shogun_meeting_transcript_get(json!({ "meeting_id": "mtg-p" })).expect("ok");
        assert_eq!(
            transcript["segments"].as_array().expect("segments").len(),
            0
        );

        let err = shogun_meeting_purge(json!({})).expect_err("meeting_id required");
        assert_eq!(err, "meeting_id is required");
    }

    #[test]
    fn mcp_tools_lists_tool_definitions() {
        // Pure command: no DB. Locks the response envelope.
        let out = shogun_meeting_mcp_tools(json!({})).expect("ok");
        assert_eq!(out["stub"], json!(false));
        let tools = out["tools"].as_array().expect("tools array");
        assert!(!tools.is_empty(), "tool definitions should not be empty");
        assert!(tools[0].get("name").is_some(), "each tool has a name");
    }
}
