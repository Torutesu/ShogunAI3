//! Import past audio/video recordings as meetings.
//! Reads a local file, sends it to Deepgram's prerecorded endpoint for
//! transcription, then inserts a new meeting row + one transcript segment per
//! utterance (speaker-labeled via Deepgram diarization) via `meeting_store`.

use crate::{meeting_store, meeting_stt};
use serde_json::{json, Value};
use std::path::Path;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_started_at_ms(path: &Path) -> u64 {
    // Prefer file mtime so the imported meeting lands on the timeline at the
    // moment the recording was actually taken.
    let fallback = now_ms();
    let Ok(meta) = std::fs::metadata(path) else {
        return fallback;
    };
    let Ok(modified) = meta.modified() else {
        return fallback;
    };
    modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(fallback)
}

fn mime_hint_for(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp3" => Some("audio/mpeg"),
        "m4a" | "mp4" | "mov" => Some("audio/mp4"),
        "wav" => Some("audio/wav"),
        "webm" => Some("audio/webm"),
        "ogg" | "oga" => Some("audio/ogg"),
        "aac" => Some("audio/aac"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

/// Reads `path`, transcribes with Deepgram (utterances + diarization), and
/// inserts a new meeting with one transcript segment per utterance.
pub async fn import_recording_file(path_str: &str) -> Result<Value, String> {
    let path = Path::new(path_str);
    if !path.is_file() {
        return Err(format!("Not a file: {}", path_str));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Read failed: {}", e))?;
    if bytes.is_empty() {
        return Err("Empty file".to_string());
    }

    let mime = mime_hint_for(path);
    let result = meeting_stt::deepgram_transcribe_bytes(&bytes, mime).await?;

    let started_at = file_started_at_ms(path);
    let duration_ms = (result.duration_seconds.max(0.0) * 1000.0) as u64;
    let ended_at = started_at.saturating_add(duration_ms);

    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Imported recording".to_string());

    let meeting_id = format!("mt_{}_{}", started_at, now_ms() % 100000);
    meeting_store::meeting_insert(
        &meeting_id,
        started_at,
        None,
        Some("com.shogun.import"),
        Some(&title),
        None,
    )?;

    let mut segments_inserted: u32 = 0;
    let mut distinct_speakers = std::collections::BTreeSet::<String>::new();

    if !result.utterances.is_empty() {
        for (i, u) in result.utterances.iter().enumerate() {
            let seg_id = format!("{}_seg{}", meeting_id, i);
            meeting_store::insert_transcript_segment(
                &meeting_id,
                &seg_id,
                u.start_ms,
                u.end_ms,
                &u.speaker,
                &u.text,
                Some(u.confidence),
                true,
            )?;
            distinct_speakers.insert(u.speaker.clone());
            segments_inserted += 1;
        }
    } else if !result.transcript.is_empty() {
        // Fallback when Deepgram didn't return utterances: store the whole thing
        // as a single segment so Memory search still hits it.
        let seg_id = format!("{}_seg0", meeting_id);
        meeting_store::insert_transcript_segment(
            &meeting_id,
            &seg_id,
            0,
            duration_ms,
            "speaker_0",
            &result.transcript,
            Some(result.confidence),
            true,
        )?;
        distinct_speakers.insert("speaker_0".to_string());
        segments_inserted = 1;
    }

    meeting_store::meeting_stop(&meeting_id, ended_at)?;

    Ok(json!({
      "meetingId": meeting_id,
      "title": title,
      "startedAt": started_at,
      "endedAt": ended_at,
      "durationSeconds": result.duration_seconds,
      "language": result.language,
      "transcriptChars": result.transcript.chars().count(),
      "segments": segments_inserted,
      "speakers": distinct_speakers.len(),
      "confidence": result.confidence,
      "filePath": path_str,
      "stub": false,
    }))
}
