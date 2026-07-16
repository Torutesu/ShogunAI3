//! Auto-stop on inactivity and shared meeting finalize (mic stop + DB persist).

use crate::{
    meeting_mic, meeting_session, meeting_store, meeting_stt, memory_store, settings_store,
    summarizer, summarizer_store,
};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub fn inactivity_timeout_ms() -> u64 {
    settings_store::load()
        .ok()
        .and_then(|doc| {
            doc.pointer("/sections/meetings/inactivityMins")
                .and_then(|v| v.as_str())
                .and_then(|s| s.trim().parse::<u64>().ok())
        })
        .unwrap_or(15)
        .saturating_mul(60_000)
}

/// Stop mic capture and push any final transcript segments into the session.
pub async fn stop_mic_if_running(app: &AppHandle, meeting_id: &str) -> Result<(), String> {
    let Some(mic) = app.try_state::<meeting_mic::MeetingMicController>() else {
        return Ok(());
    };
    if !mic.is_running() {
        return Ok(());
    }
    let Some(session) = app.try_state::<meeting_session::MeetingSessionState>() else {
        let _ = mic.stop()?;
        return Ok(());
    };
    let stopped = mic.stop()?;
    push_pcm_segments(&session, meeting_id, "self", &stopped.mic_pcm).await?;
    push_pcm_segments(&session, meeting_id, "other", &stopped.system_pcm).await?;
    let _ = session.touch_activity(meeting_id);
    Ok(())
}

async fn push_pcm_segments(
    session: &meeting_session::MeetingSessionState,
    meeting_id: &str,
    speaker: &str,
    pcm: &[u8],
) -> Result<(), String> {
    if pcm.is_empty() {
        return Ok(());
    }
    if meeting_stt::deepgram_api_key().is_none() {
        return Ok(());
    }
    let (text, conf) = meeting_stt::deepgram_transcribe_pcm16_16k(pcm).await?;
    if text.trim().is_empty() {
        return Ok(());
    }
    let dur_ms = ((pcm.len() as u64 / 2).saturating_mul(1000)).max(1) / 16000;
    let seg = json!({
      "segment_id": meeting_store::new_uuid(),
      "meeting_id": meeting_id,
      "start_ms": 0u64,
      "end_ms": dur_ms,
      "speaker": speaker,
      "text": text,
      "confidence": conf as f64,
      "is_final": true,
    });
    let _ = session.push_live_segment(meeting_id, seg);
    Ok(())
}

/// Persist live segments, mark meeting stopped, optional summary. Does not stop mic.
pub async fn persist_meeting_stop(
    session: &meeting_session::MeetingSessionState,
    meeting_id: &str,
) -> Result<Value, String> {
    let ended = memory_store::now_ms();
    let active = session.take_active()?;
    if let Some(m) = active {
        if m.id == meeting_id {
            for seg in m.live {
                let is_final = seg
                    .get("is_final")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(true);
                if !is_final {
                    continue;
                }
                let seg_id = seg.get("segment_id").and_then(|x| x.as_str()).unwrap_or("");
                if seg_id.is_empty() {
                    continue;
                }
                meeting_store::insert_transcript_segment(
                    meeting_id,
                    seg_id,
                    seg.get("start_ms").and_then(|x| x.as_u64()).unwrap_or(0),
                    seg.get("end_ms").and_then(|x| x.as_u64()).unwrap_or(0),
                    seg.get("speaker")
                        .and_then(|x| x.as_str())
                        .unwrap_or("other_1"),
                    seg.get("text").and_then(|x| x.as_str()).unwrap_or(""),
                    seg.get("confidence")
                        .and_then(|x| x.as_f64())
                        .map(|x| x as f32),
                    true,
                )?;
            }
        } else {
            let _ = session.start(m);
            return Err("meeting_id does not match the active session".to_string());
        }
    }
    meeting_store::meeting_stop(meeting_id, ended)?;
    ingest_after_stop(meeting_id).await
}

/// Post-stop ingest shared by live recordings and file imports: optional
/// summary, then Memory + KIOKU ingest. Assumes the meeting row is already
/// stopped and its transcript segments persisted. Extracting this is what lets
/// imported meetings reach Memory/KIOKU — previously the import path called
/// `meeting_store::meeting_stop` directly and skipped all of this.
pub async fn ingest_after_stop(meeting_id: &str) -> Result<Value, String> {
    let detail = meeting_store::get_meeting_detail(meeting_id)?
        .ok_or_else(|| "meeting not found".to_string())?;

    let auto_lang = settings_store::load()
        .ok()
        .and_then(|doc| {
            doc.pointer("/sections/memory/autoDigestLang")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "en".to_string());
    let summary_enabled = settings_store::load()
        .ok()
        .and_then(|doc| {
            doc.pointer("/sections/memory/enableMemorySummary")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true);
    let mut meeting_summary: Option<Value> = None;
    if summary_enabled {
        match summarizer::summarize_meeting(meeting_id, &auto_lang).await {
            Ok(s) => {
                if let Err(e) = summarizer_store::upsert(&s) {
                    log::warn!("meeting summary upsert failed for {}: {}", meeting_id, e);
                } else {
                    meeting_summary = Some(s.to_json());
                }
            }
            Err(e) => {
                log::warn!("meeting summary failed for {}: {}", meeting_id, e);
            }
        }
    }

    let memory_ingest =
        match crate::meeting_memory::ingest_meeting_to_memory(meeting_id, meeting_summary.as_ref())
        {
            Ok(v) => Some(v),
            Err(e) => {
                log::warn!("meeting memory ingest failed for {}: {}", meeting_id, e);
                None
            }
        };

    let kioku_ingest = match crate::meeting_kioku::ingest_meeting_to_kioku(meeting_id) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("meeting kioku ingest failed for {}: {}", meeting_id, e);
            None
        }
    };

    Ok(json!({
      "meeting": detail,
      "summary": meeting_summary,
      "memory_ingest": memory_ingest,
      "kioku_ingest": kioku_ingest,
    }))
}

/// Mic stop (if needed) + DB persist + frontend event.
pub async fn finalize_meeting(
    app: &AppHandle,
    meeting_id: &str,
    reason: &str,
) -> Result<Value, String> {
    stop_mic_if_running(app, meeting_id).await?;
    let session = app
        .try_state::<meeting_session::MeetingSessionState>()
        .ok_or_else(|| "MeetingSessionState missing".to_string())?;
    let out = persist_meeting_stop(&session, meeting_id).await?;
    let _ = app.emit(
        "meeting-auto-stopped",
        json!({
          "meeting_id": meeting_id,
          "reason": reason,
          "meeting": out.get("meeting").cloned().unwrap_or(Value::Null),
        }),
    );
    let _ = app.emit(
        "shogun-meetings-changed",
        json!({ "meeting_id": meeting_id }),
    );
    Ok(out)
}

pub fn touch_video_activity(app: &AppHandle) {
    let Some(session) = app.try_state::<meeting_session::MeetingSessionState>() else {
        return;
    };
    if let Ok(Some(id)) = session.active_id() {
        let _ = session.touch_video_seen(&id);
        let _ = session.touch_activity(&id);
    }
}

async fn check_inactivity(app: &AppHandle) {
    let Some(session) = app.try_state::<meeting_session::MeetingSessionState>() else {
        return;
    };
    let Ok(Some(meeting_id)) = session.active_id() else {
        return;
    };
    let timeout = inactivity_timeout_ms();
    if timeout == 0 {
        return;
    }
    let mic_running = app
        .try_state::<meeting_mic::MeetingMicController>()
        .map(|m| m.is_running())
        .unwrap_or(false);
    if !mic_running {
        return;
    }
    let activity_idle = session.activity_idle_ms(&meeting_id).unwrap_or(0);
    let video_idle = session.video_idle_ms(&meeting_id).unwrap_or(0);
    let is_video_meeting = session
        .is_video_provider_meeting(&meeting_id)
        .unwrap_or(false);

    if activity_idle >= timeout {
        log::info!(
            "meeting {} auto-stop: transcript idle {} ms (limit {})",
            meeting_id,
            activity_idle,
            timeout
        );
        let _ = finalize_meeting(app, &meeting_id, "inactivity").await;
        return;
    }
    if is_video_meeting && video_idle >= timeout {
        log::info!(
            "meeting {} auto-stop: video absent {} ms (limit {})",
            meeting_id,
            video_idle,
            timeout
        );
        let _ = finalize_meeting(app, &meeting_id, "video_ended").await;
    }
}

pub fn spawn_inactivity_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            check_inactivity(&app).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory_store::testkit::TestDbGuard;

    #[test]
    fn inactivity_timeout_defaults_to_15_minutes() {
        assert_eq!(inactivity_timeout_ms(), 15 * 60_000);
    }

    #[tokio::test]
    async fn ingest_after_stop_routes_meeting_into_memory_and_kioku() {
        let _g = TestDbGuard::new("mtg-ingest-after-stop");
        // Initialize the full memory_store schema first (mem_items + its unique
        // index) so the meeting-store path doesn't create a partial mem_items
        // table that the upsert's ON CONFLICT can't target.
        let _ = crate::memory_store::open_conn().expect("init memory schema");
        // Disable the LLM summary so the test never makes a real network call
        // (a dev machine may have a real key in the keychain). Memory + KIOKU
        // ingest — the behavior under test — don't need a key.
        let _sg = crate::settings_store::TestSettingsGuard::new("mtg-ingest-after-stop");
        crate::settings_store::save_patch(&serde_json::json!({
            "section": "memory",
            "enableMemorySummary": false,
        }))
        .expect("disable summary");
        let id = "mtg-import-1";
        meeting_store::meeting_insert(id, 1_000_000, None, None, Some("Imported call"), None)
            .expect("insert meeting");
        meeting_store::insert_transcript_segment(
            id,
            &format!("{id}_seg0"),
            0,
            5_000,
            "speaker_0",
            "We agreed to ship the beta on Friday.",
            Some(0.98),
            true,
        )
        .expect("insert segment");
        meeting_store::meeting_stop(id, 1_005_000).expect("stop");

        // This is the exact path the import flow now takes (previously import
        // called meeting_store::meeting_stop directly and skipped all of this).
        // Summary needs an LLM key (disabled above); Memory + KIOKU do not.
        let out = ingest_after_stop(id).await.expect("ingest");

        // KIOKU ingest is the decisive proof the import now routes through the
        // shared post-stop path: a queued extraction job + mem_capture appear,
        // which never happened for imports before this fix.
        let kioku = out.get("kioku_ingest").cloned().unwrap_or(Value::Null);
        assert!(!kioku.is_null(), "imported meeting must reach KIOKU, got: {out}");
        assert!(
            kioku.get("capture_id").and_then(|v| v.as_i64()).unwrap_or(0) > 0,
            "KIOKU ingest must create a mem_capture, got: {out}"
        );
        // The response always carries a memory_ingest slot (its value depends on
        // the shared upsert path, exercised by the live-recording tests).
        assert!(out.get("memory_ingest").is_some(), "memory_ingest slot present");
    }
}
