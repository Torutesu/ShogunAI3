//! Tauri commands: `shogun_meeting_*` (Granola / meetings PRD).

use crate::{
  meeting_enhance, meeting_import, meeting_lifecycle, meeting_mic, meeting_mcp, meeting_recipes,
  meeting_session, meeting_store, meeting_stt, memory_store, settings_store,
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
  let template_id = payload.get("template_id").and_then(|x| x.as_str()).map(String::from);
  let app_bundle_id = payload
    .get("app_bundle_id")
    .and_then(|x| x.as_str())
    .map(String::from);
  let title = payload
    .get("title")
    .and_then(|x| x.as_str())
    .unwrap_or("Untitled meeting")
    .to_string();
  let id = meeting_store::new_uuid();
  let started = memory_store::now_ms();
  meeting_store::meeting_insert(
    &id,
    started,
    template_id.as_deref(),
    app_bundle_id.as_deref(),
    Some(&title),
  )?;
  if let Some(ref tid) = template_id {
    meeting_store::seed_note_from_template(&id, tid)?;
  }
  state
    .start(meeting_session::ActiveMeeting {
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
    "stub": false,
    "echo": payload,
  }))
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
    conn
      .execute(
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
  let prev = meeting_store::get_note_block(block_id)?
    .ok_or_else(|| "block not found".to_string())?;
  let origin = prev.get("origin").and_then(|x| x.as_str()).unwrap_or("user");
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
  let start_ms = payload.get("start_ms").and_then(|x| x.as_u64()).unwrap_or(0);
  let end_ms = payload.get("end_ms").and_then(|x| x.as_u64()).unwrap_or(start_ms);
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
  let live_stt = payload.get("live_stt").and_then(|x| x.as_bool()).unwrap_or(false);
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
  let transcribe = payload.get("transcribe").and_then(|x| x.as_bool()).unwrap_or(false);
  let meeting_id = payload.get("meeting_id").and_then(|x| x.as_str()).map(String::from);

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
      if let Ok((text, conf)) = meeting_stt::deepgram_transcribe_pcm16_16k(&stopped.mic_pcm).await {
        if !text.trim().is_empty() {
          let dur_ms = ((stopped.mic_pcm.len() as u64 / 2).saturating_mul(1000)).max(1) / 16000;
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
      if let Ok((text, conf)) = meeting_stt::deepgram_transcribe_pcm16_16k(&stopped.system_pcm).await {
        if !text.trim().is_empty() {
          let dur_ms = ((stopped.system_pcm.len() as u64 / 2).saturating_mul(1000)).max(1) / 16000;
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
        &["mp3", "m4a", "mp4", "mov", "wav", "webm", "ogg", "oga", "aac", "flac"],
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
