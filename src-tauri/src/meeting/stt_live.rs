//! Deepgram live WebSocket STT — lower latency than batched prerecorded chunks.

use crate::meeting_mic::{resample_f32_mono_to_pcm16_16k, SampleTrack};
use crate::meeting_store;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio_tungstenite::{
  connect_async,
  tungstenite::{client::IntoClientRequest, Message},
};

const SYSTEM_SAMPLE_RATE: u32 = 48_000;
const FLUSH_MS: u64 = 400;

pub fn streaming_enabled() -> bool {
  crate::settings_store::load()
    .ok()
    .and_then(|doc| {
      doc
        .pointer("/sections/meetings/liveSttStreaming")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true)
}

pub fn spawn_mic_stream(
  app: AppHandle,
  meeting_id: String,
  mic_track: Arc<Mutex<SampleTrack>>,
  stop: Arc<AtomicBool>,
) {
  tauri::async_runtime::spawn(async move {
    if let Err(e) = run_pcm_stream(
      &app,
      &meeting_id,
      "self",
      stop,
      move || {
        mic_track
          .lock()
          .ok()
          .map(|mut t| t.take_chunk_pcm16())
          .unwrap_or_default()
      },
    )
    .await
    {
      log::warn!("live STT mic stream ended: {}", e);
    }
  });
}

pub fn spawn_system_stream(
  app: AppHandle,
  meeting_id: String,
  system_buf: Arc<Mutex<Vec<f32>>>,
  stop: Arc<AtomicBool>,
) {
  let consumed = Arc::new(Mutex::new(0usize));
  tauri::async_runtime::spawn(async move {
    let consumed = consumed;
    if let Err(e) = run_pcm_stream(
      &app,
      &meeting_id,
      "other",
      stop,
      move || {
        let mut buf = match system_buf.lock() {
          Ok(b) => b,
          Err(_) => return Vec::new(),
        };
        let mut at = match consumed.lock() {
          Ok(c) => c,
          Err(_) => return Vec::new(),
        };
        if *at >= buf.len() {
          return Vec::new();
        }
        let chunk = buf[*at..].to_vec();
        *at = buf.len();
        resample_f32_mono_to_pcm16_16k(&chunk, SYSTEM_SAMPLE_RATE)
      },
    )
    .await
    {
      log::warn!("live STT system stream ended: {}", e);
    }
  });
}

async fn run_pcm_stream<F>(
  app: &AppHandle,
  meeting_id: &str,
  speaker: &str,
  stop: Arc<AtomicBool>,
  mut next_pcm: F,
) -> Result<(), String>
where
  F: FnMut() -> Vec<u8>,
{
  let key = crate::meeting_stt::deepgram_api_key()
    .ok_or_else(|| "Deepgram API key not configured".to_string())?;
  let url = "wss://api.deepgram.com/v1/listen?\
encoding=linear16&sample_rate=16000&channels=1&model=nova-2&\
smart_format=true&interim_results=true&punctuate=true&endpointing=300";
  let mut req = url.into_client_request().map_err(|e| e.to_string())?;
  req.headers_mut().insert(
    "Authorization",
    format!("Token {}", key.trim())
      .parse()
      .map_err(|e| format!("auth header: {e}"))?,
  );
  let (ws, _) = connect_async(req).await.map_err(|e| e.to_string())?;
  let (mut write, mut read) = ws.split();

  let app_read = app.clone();
  let meeting_id_read = meeting_id.to_string();
  let speaker_read = speaker.to_string();
  let read_stop = stop.clone();
  let read_task = tauri::async_runtime::spawn(async move {
    while !read_stop.load(Ordering::Relaxed) {
      let msg = tokio::time::timeout(Duration::from_millis(500), read.next()).await;
      match msg {
        Ok(Some(Ok(Message::Text(text)))) => {
          if let Ok(v) = serde_json::from_str::<Value>(&text) {
            handle_deepgram_message(&app_read, &meeting_id_read, &speaker_read, &v);
          }
        }
        Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
        Ok(Some(Err(e))) => {
          log::warn!("deepgram ws read: {}", e);
          break;
        }
        Err(_) => continue,
        _ => {}
      }
    }
  });

  while !stop.load(Ordering::Relaxed) {
    tokio::time::sleep(Duration::from_millis(FLUSH_MS)).await;
    if stop.load(Ordering::Relaxed) {
      break;
    }
    let pcm = next_pcm();
    if pcm.len() < 3200 {
      continue;
    }
    if write.send(Message::Binary(pcm)).await.is_err() {
      break;
    }
  }
  let _ = write
    .send(Message::Text(r#"{"type":"CloseStream"}"#.into()))
    .await;
  let _ = read_task.await;
  Ok(())
}

fn handle_deepgram_message(app: &AppHandle, meeting_id: &str, speaker: &str, msg: &Value) {
  let msg_type = msg.get("type").and_then(|x| x.as_str()).unwrap_or("");
  if msg_type != "Results" {
    return;
  }
  let is_final = msg
    .get("is_final")
    .and_then(|x| x.as_bool())
    .unwrap_or(false);
  if !is_final {
    return;
  }
  let alt = msg.pointer("/channel/alternatives/0");
  let Some(alt) = alt else {
    return;
  };
  let text = alt
    .get("transcript")
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .trim();
  if text.is_empty() {
    return;
  }
  let conf = alt
    .get("confidence")
    .and_then(|x| x.as_f64())
    .unwrap_or(0.0) as f32;
  let start = msg.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0);
  let duration = msg.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0);
  let start_ms = (start * 1000.0) as u64;
  let end_ms = start_ms + (duration * 1000.0).max(1.0) as u64;
  push_live_segment(app, meeting_id, speaker, text, conf, start_ms, end_ms);
}

fn push_live_segment(
  app: &AppHandle,
  meeting_id: &str,
  speaker: &str,
  text: &str,
  conf: f32,
  start_ms: u64,
  end_ms: u64,
) {
  let Some(session) = app.try_state::<crate::meeting_session::MeetingSessionState>() else {
    return;
  };
  let seg_id = meeting_store::new_uuid();
  let seg = serde_json::json!({
    "segment_id": seg_id,
    "meeting_id": meeting_id,
    "start_ms": start_ms,
    "end_ms": end_ms,
    "speaker": speaker,
    "text": text,
    "confidence": conf as f64,
    "is_final": true,
  });
  if let Err(e) = session.push_live_segment(meeting_id, seg) {
    log::warn!("push_live_segment: {}", e);
  }
}
