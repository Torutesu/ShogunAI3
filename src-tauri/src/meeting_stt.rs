//! Speech-to-text: Deepgram prerecorded (linear16 mono @ 16kHz). BYOK via settings or env.

use crate::settings_store;
use serde_json::Value;

const DEEPGRAM_LISTEN: &str = "https://api.deepgram.com/v1/listen";

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
