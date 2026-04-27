//! Speech-to-text: Deepgram prerecorded (linear16 mono @ 16kHz). BYOK via settings or env.

use crate::settings_store;
use serde_json::Value;

const DEEPGRAM_LISTEN: &str = "https://api.deepgram.com/v1/listen";

/// One speaker utterance in a prerecorded transcription.
#[derive(Debug, Clone)]
pub struct Utterance {
  pub start_ms: u64,
  pub end_ms: u64,
  pub speaker: String,
  pub text: String,
  pub confidence: f32,
}

/// Full prerecorded result: aggregated transcript, metadata, and per-utterance list.
#[derive(Debug, Clone)]
pub struct PrerecordedResult {
  pub transcript: String,
  pub confidence: f32,
  pub language: String,
  pub duration_seconds: f32,
  pub utterances: Vec<Utterance>,
}

pub fn deepgram_api_key() -> Option<String> {
  if let Ok(k) = std::env::var("DEEPGRAM_API_KEY") {
    let t = k.trim().to_string();
    if !t.is_empty() {
      return Some(t);
    }
  }
  let doc = settings_store::load().ok()?;
  doc
    .pointer("/sections/meetings/deepgramApiKey")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(String::from)
}

/// Prerecorded transcription of a container file (mp3/m4a/wav/mp4/webm…).
/// Returns a `PrerecordedResult` with aggregated transcript, metadata, and
/// per-utterance segments (with speaker labels when diarization is available).
pub async fn deepgram_transcribe_bytes(
  bytes: &[u8],
  mime_hint: Option<&str>,
) -> Result<PrerecordedResult, String> {
  if bytes.is_empty() {
    return Err("empty audio buffer".to_string());
  }
  // Deepgram prerecorded upload limit is 2 GB; we cap at 500 MiB to avoid runaway.
  if bytes.len() > 500 * 1024 * 1024 {
    return Err("audio file too large (max 500 MiB)".to_string());
  }
  let key = deepgram_api_key().ok_or_else(|| {
    "Deepgram API key not set. Set DEEPGRAM_API_KEY or settings.sections.meetings.deepgramApiKey"
      .to_string()
  })?;

  // utterances=true → per-utterance turns; diarize=true → speaker labels;
  // smart_format keeps punctuation; detect_language auto-picks ja/en/etc.
  let q = "model=nova-2&smart_format=true&utterances=true&diarize=true&punctuate=true&detect_language=true";
  let url = format!("{DEEPGRAM_LISTEN}?{q}");
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(600))
    .build()
    .map_err(|e| e.to_string())?;
  let mime = mime_hint.unwrap_or("application/octet-stream");
  let resp = client
    .post(url)
    .header("Authorization", format!("Token {}", key.trim()))
    .header("Content-Type", mime)
    .body(bytes.to_vec())
    .send()
    .await
    .map_err(|e| format!("Deepgram network: {e}"))?;
  let status = resp.status();
  let body = resp.text().await.map_err(|e| e.to_string())?;
  if !status.is_success() {
    let clip: String = body.chars().take(400).collect();
    return Err(format!("Deepgram HTTP {}: {}", status, clip));
  }
  let v: Value = serde_json::from_str(&body).map_err(|e| format!("Deepgram JSON: {e}"))?;
  let transcript = v
    .pointer("/results/channels/0/alternatives/0/transcript")
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .trim()
    .to_string();
  let conf = v
    .pointer("/results/channels/0/alternatives/0/confidence")
    .and_then(|x| x.as_f64())
    .unwrap_or(0.0) as f32;
  let lang = v
    .pointer("/results/channels/0/detected_language")
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .to_string();
  let duration = v
    .pointer("/metadata/duration")
    .and_then(|x| x.as_f64())
    .unwrap_or(0.0) as f32;

  // Parse per-utterance segments when present (Deepgram returns these under
  // `results.utterances`). Each utterance carries start/end (seconds), speaker
  // index, transcript, and confidence.
  let mut utterances: Vec<Utterance> = Vec::new();
  if let Some(arr) = v.pointer("/results/utterances").and_then(|u| u.as_array()) {
    for item in arr {
      let start_s = item.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0);
      let end_s = item.get("end").and_then(|x| x.as_f64()).unwrap_or(start_s);
      let speaker_idx = item
        .get("speaker")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
      let text = item
        .get("transcript")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
      if text.is_empty() {
        continue;
      }
      let conf_i = item
        .get("confidence")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0) as f32;
      utterances.push(Utterance {
        start_ms: (start_s.max(0.0) * 1000.0) as u64,
        end_ms: (end_s.max(start_s) * 1000.0) as u64,
        speaker: format!("speaker_{}", speaker_idx),
        text,
        confidence: conf_i,
      });
    }
  }

  Ok(PrerecordedResult {
    transcript,
    confidence: conf,
    language: lang,
    duration_seconds: duration,
    utterances,
  })
}

/// Raw little-endian PCM16 mono, 16 kHz. Returns transcript and best-effort confidence.
pub async fn deepgram_transcribe_pcm16_16k(pcm: &[u8]) -> Result<(String, f32), String> {
  if pcm.is_empty() {
    return Err("empty PCM buffer".to_string());
  }
  if pcm.len() > 25 * 1024 * 1024 {
    return Err("PCM buffer too large (max ~25 MiB)".to_string());
  }
  let key = deepgram_api_key().ok_or_else(|| {
    "Deepgram API key not set. Set DEEPGRAM_API_KEY or settings.sections.meetings.deepgramApiKey"
      .to_string()
  })?;

  let q = "encoding=linear16&sample_rate=16000&channels=1&model=nova-2&smart_format=true";
  let url = format!("{DEEPGRAM_LISTEN}?{q}");
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(120))
    .build()
    .map_err(|e| e.to_string())?;
  let resp = client
    .post(url)
    .header("Authorization", format!("Token {}", key.trim()))
    .header("Content-Type", "application/octet-stream")
    .body(pcm.to_vec())
    .send()
    .await
    .map_err(|e| format!("Deepgram network: {e}"))?;
  let status = resp.status();
  let body = resp.text().await.map_err(|e| e.to_string())?;
  if !status.is_success() {
    let clip: String = body.chars().take(400).collect();
    return Err(format!("Deepgram HTTP {}: {}", status, clip));
  }
  let v: Value = serde_json::from_str(&body).map_err(|e| format!("Deepgram JSON: {e}"))?;
  let transcript = v
    .pointer("/results/channels/0/alternatives/0/transcript")
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .trim()
    .to_string();
  let conf = v
    .pointer("/results/channels/0/alternatives/0/confidence")
    .and_then(|x| x.as_f64())
    .unwrap_or(0.0) as f32;
  Ok((transcript, conf))
}
