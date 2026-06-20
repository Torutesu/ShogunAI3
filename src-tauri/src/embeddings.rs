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

fn resolve_embedding_endpoint(
    provider: llm_providers::LlmProvider,
    base_override: &str,
    extra_hosts: &[String],
) -> Result<String, String> {
    let mut bases = Vec::new();
    let override_trimmed = base_override.trim();
    if override_trimmed.is_empty() {
        bases.push(llm_providers::default_base_url(provider).to_string());
    } else {
        bases.push(override_trimmed.to_string());
        if provider != llm_providers::LlmProvider::Custom {
            let default_base = llm_providers::default_base_url(provider);
            if !default_base.is_empty() && default_base != override_trimmed {
                bases.push(default_base.to_string());
            }
        }
    }

    let mut errors = Vec::new();
    for base in bases {
        let url = match llm_providers::embed_url(provider, &base) {
            Ok(url) => url,
            Err(e) => {
                errors.push(e);
                continue;
            }
        };
        let host = match Url::parse(&url)
            .ok()
            .and_then(|u| u.host_str().map(|s| s.to_string()))
        {
            Some(host) => host,
            None => {
                errors.push("Invalid embeddings URL".to_string());
                continue;
            }
        };
        if let Err(e) = llm_providers::validate_host_for_provider(provider, &host, extra_hosts) {
            errors.push(e);
            continue;
        }
        return Ok(url);
    }
    Err(errors.join(" | "))
}

fn provider_for_key_and_embedding_model(
    key: &str,
    model: &str,
    has_base_override: bool,
) -> llm_providers::LlmProvider {
    let detected = llm_providers::detect_provider(key);
    if detected != llm_providers::LlmProvider::Custom || has_base_override {
        return detected;
    }
    if llm_providers::model_matches_provider(llm_providers::LlmProvider::Gemini, model) {
        return llm_providers::LlmProvider::Gemini;
    }
    if llm_providers::model_matches_provider(llm_providers::LlmProvider::OpenAI, model) {
        return llm_providers::LlmProvider::OpenAI;
    }
    detected
}

pub async fn embed_one(text: &str) -> Result<Vec<f32>, String> {
    let (base_override, model_override) = read_embedding_prefs()?;
    let clipped: String = text.trim().chars().take(8000).collect();
    if clipped.is_empty() {
        return Err("empty text for embedding".to_string());
    }
    let keys = secrets::get_llm_api_keys()?;
    if keys.is_empty() {
        return Err("LLM API key is not set. Open Settings and save your key.".to_string());
    }
    let extra_hosts = read_extra_llm_hosts();
    let has_base_override = !base_override.trim().is_empty();
    let mut errors = Vec::new();
    for key in keys {
        let provider =
            provider_for_key_and_embedding_model(&key, &model_override, has_base_override);
        let Some(default_model) = llm_providers::default_embedding_model(provider) else {
            errors.push(format!("{}: no embeddings endpoint", provider.as_str()));
            continue;
        };
        let url = match resolve_embedding_endpoint(provider, &base_override, &extra_hosts) {
            Ok(url) => url,
            Err(e) => {
                errors.push(format!("{}: {}", provider.as_str(), e));
                continue;
            }
        };
        let model = if model_override.is_empty()
            || !llm_providers::model_matches_provider(provider, &model_override)
        {
            default_model.to_string()
        } else {
            model_override.clone()
        };

        let body = json!({
            "model": model,
            "input": clipped,
            "encoding_format": "float",
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", key.trim()))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                errors.push(format!(
                    "{} embeddings network error: {}",
                    provider.as_str(),
                    e
                ));
                continue;
            }
        };
        let status = resp.status();
        let raw = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let snippet: String = raw.chars().take(600).collect();
            errors.push(format!(
                "{} embeddings API error {}: {}",
                provider.as_str(),
                status,
                snippet
            ));
            continue;
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
                .ok_or_else(|| "embedding entry not numeric".to_string())?
                as f32;
            out.push(f);
        }
        l2_normalize(&mut out);
        return Ok(out);
    }
    Err(format!(
        "All embeddings provider attempts failed: {}",
        errors.join(" | ")
    ))
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
    fn provider_for_custom_key_infers_gemini_from_embedding_model_without_base_override() {
        assert_eq!(
            super::provider_for_key_and_embedding_model(
                "not-a-prefixed-key",
                "gemini-embedding-001",
                false
            ),
            crate::llm_providers::LlmProvider::Gemini
        );
    }

    #[test]
    fn provider_for_custom_key_embedding_respects_explicit_base_override() {
        assert_eq!(
            super::provider_for_key_and_embedding_model(
                "not-a-prefixed-key",
                "gemini-embedding-001",
                true
            ),
            crate::llm_providers::LlmProvider::Custom
        );
    }

    #[test]
    fn resolve_embedding_endpoint_falls_back_to_vendor_default_when_override_mismatches_provider() {
        let url = super::resolve_embedding_endpoint(
            crate::llm_providers::LlmProvider::Gemini,
            "https://api.openai.com/v1",
            &[],
        )
        .expect("gemini default embedding endpoint");
        assert!(url.contains("generativelanguage.googleapis.com"));
        assert!(url.ends_with("/embeddings"));
    }

    #[test]
    fn resolve_embedding_endpoint_custom_still_requires_valid_base() {
        let err =
            super::resolve_embedding_endpoint(crate::llm_providers::LlmProvider::Custom, "", &[])
                .unwrap_err();
        assert!(err.contains("Invalid embeddings URL") || err.contains("host is empty"));
    }

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
