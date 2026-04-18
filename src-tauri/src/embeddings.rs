//! OpenAI-compatible `/v1/embeddings` (same API key and base URL as chat).

use crate::{secrets, settings_store};
use serde_json::{json, Value};

fn embeddings_url(base: &str) -> String {
  let s = base.trim().trim_end_matches('/').to_string();
  let root = if s.ends_with("/v1") {
    s
  } else if s.is_empty() {
    "https://api.openai.com/v1".to_string()
  } else {
    format!("{}/v1", s)
  };
  format!("{}/embeddings", root)
}

fn read_embedding_model() -> Result<(String, String), String> {
  let doc = settings_store::load()?;
  let llm = doc.pointer("/sections/llm");
  let base = llm
    .and_then(|l| l.get("baseUrl"))
    .and_then(|v| v.as_str())
    .unwrap_or("https://api.openai.com/v1")
    .trim()
    .to_string();
  let model = llm
    .and_then(|l| l.get("embeddingModel"))
    .and_then(|v| v.as_str())
    .unwrap_or("text-embedding-3-small")
    .trim()
    .to_string();
  Ok((base, model))
}

/// Single text to embedding (L2-normalized).
pub async fn embed_one(text: &str) -> Result<Vec<f32>, String> {
  let key = secrets::get_llm_api_key()?
    .filter(|k| !k.trim().is_empty())
    .ok_or_else(|| {
      "LLM API key is not set. Open Settings and save your key.".to_string()
    })?;
  let (base, model) = read_embedding_model()?;
  let clipped: String = text.trim().chars().take(8000).collect();
  if clipped.is_empty() {
    return Err("empty text for embedding".to_string());
  }
  let body = json!({
    "model": model,
    "input": clipped,
    "encoding_format": "float",
  });
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())?;
  let url = embeddings_url(&base);
  let resp = client
    .post(&url)
    .header("Authorization", format!("Bearer {}", key.trim()))
    .header("Content-Type", "application/json")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("Embeddings network error: {}", e))?;
  let status = resp.status();
  let raw = resp.text().await.map_err(|e| e.to_string())?;
  if !status.is_success() {
    let snippet: String = raw.chars().take(600).collect();
    return Err(format!("Embeddings API error {}: {}", status, snippet));
  }
  let v: Value = serde_json::from_str(&raw).map_err(|e| {
    format!(
      "Invalid embeddings JSON: {} — {}",
      e,
      raw.chars().take(120).collect::<String>()
    )
  })?;
  let arr = v
    .get("data")
    .and_then(|d| d.as_array())
    .and_then(|a| a.first())
    .and_then(|d| d.get("embedding"))
    .and_then(|e| e.as_array())
    .ok_or_else(|| "Unexpected embeddings response".to_string())?;
  let mut out: Vec<f32> = Vec::with_capacity(arr.len());
  for x in arr {
    let f = x
      .as_f64()
      .ok_or_else(|| "embedding entry not numeric".to_string())? as f32;
    out.push(f);
  }
  l2_normalize(&mut out);
  Ok(out)
}

fn l2_normalize(v: &mut [f32]) {
  let s: f32 = v.iter().map(|x| x * x).sum();
  let n = s.sqrt().max(1e-8);
  for x in v.iter_mut() {
    *x /= n;
  }
}

#[cfg(test)]
mod tests {
  #[test]
  fn l2_normalize_unit_vector() {
    let mut v = vec![3.0f32, 4.0];
    super::l2_normalize(&mut v);
    let len: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!((len - 1.0).abs() < 1e-5);
    assert!((v[0] - 0.6).abs() < 1e-5 && (v[1] - 0.8).abs() < 1e-5);
  }

  #[test]
  fn l2_normalize_zero_fallback() {
    let mut v = vec![0.0f32, 0.0];
    super::l2_normalize(&mut v);
    assert_eq!(v, vec![0.0, 0.0]);
  }
}
