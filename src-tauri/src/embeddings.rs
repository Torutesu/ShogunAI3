//! OpenAI-compatible `/v1/embeddings`. Provider routing (OpenAI / Gemini /
//! Custom) goes through `llm_providers`. Anthropic has no embeddings API,
//! so `embed_one` returns an `Err` that the caller (memory ingest) treats
//! as a silent failure — the row is still inserted without an embedding
//! and FTS continues to work.

use crate::{llm_providers, secrets, settings_store};
use serde_json::{json, Value};
use url::Url;

fn read_embedding_prefs() -> Result<(String, String), String> {
    let doc = settings_store::load()?;
    let llm = doc.pointer("/sections/llm");
    let base = llm
        .and_then(|l| l.get("baseUrl"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let model = llm
        .and_then(|l| l.get("embeddingModel"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok((base, model))
}

fn read_extra_llm_hosts() -> Vec<String> {
    settings_store::load()
        .ok()
        .and_then(|d| {
            d.pointer("/sections/security/extraLlmHosts")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                })
        })
        .unwrap_or_default()
}

pub async fn embed_one(text: &str) -> Result<Vec<f32>, String> {
    let key = secrets::get_llm_api_key()?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "LLM API key is not set. Open Settings and save your key.".to_string())?;
    let (base_override, model_override) = read_embedding_prefs()?;
    let provider = llm_providers::resolve_provider(&key, &model_override);
    let extra_hosts = read_extra_llm_hosts();
    let base = llm_providers::resolve_llm_base(provider, &base_override, &extra_hosts)?;
    let url = llm_providers::embed_url(provider, &base)?;
    let host = Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .ok_or_else(|| format!("Invalid embeddings URL \"{}\"", url))?;
    llm_providers::validate_host_for_provider(provider, &host, &extra_hosts)?;
    let model = if model_override.is_empty() {
        llm_providers::default_embedding_model(provider)
            .map(|s| s.to_string())
            .ok_or_else(|| "No default embedding model for this provider".to_string())?
    } else {
        model_override
    };

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
