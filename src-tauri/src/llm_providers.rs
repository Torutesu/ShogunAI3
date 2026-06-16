//! Provider routing for LLM calls. Detects which vendor an API key belongs
//! to from its prefix and maps each provider to its canonical base URL,
//! default chat model, default embedding model (if any), authentication
//! header, request body shape, and response extraction path.
//!
//! Spec: `docs/superpowers/specs/2026-04-23-multi-provider-llm-design.md`.

use serde_json::{json, Value};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmProvider {
    OpenAI,
    Anthropic,
    Gemini,
    Custom,
}

impl LlmProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmProvider::OpenAI => "openai",
            LlmProvider::Anthropic => "anthropic",
            LlmProvider::Gemini => "gemini",
            LlmProvider::Custom => "custom",
        }
    }
}

/// Strip common wrappers so pasted keys still match provider prefixes.
pub fn normalize_api_key(raw: &str) -> String {
  let mut k = raw.trim().to_string();
  if k.len() >= 7 && k[..7].eq_ignore_ascii_case("bearer ") {
    k = k[7..].trim().to_string();
  }
  k.trim_matches('"').trim_matches('\'').trim().to_string()
}

/// Identify the vendor from the raw key. Anthropic and Gemini have strict
/// prefixes; OpenAI-style keys (`sk-*`) are the fallback; anything else is
/// `Custom` (meant for local LLMs or explicit proxies).
pub fn detect_provider(key: &str) -> LlmProvider {
    let k = normalize_api_key(key);
    if k.starts_with("sk-ant-") {
        return LlmProvider::Anthropic;
    }
    if k.starts_with("AIza") && k.len() >= 10 {
        return LlmProvider::Gemini;
    }
    if k.starts_with("sk-") {
        // OpenRouter keys start with `sk-or-v1-`; route those as Custom so
        // the allowlist can be tightened independently of OpenAI's.
        if k.starts_with("sk-or-") {
            return LlmProvider::Custom;
        }
        return LlmProvider::OpenAI;
    }
    LlmProvider::Custom
}

/// When the key prefix is ambiguous (Custom), infer vendor from the configured
/// chat model in settings (e.g. gemini-2.5-flash → Gemini).
pub fn infer_provider_from_model(model: &str) -> Option<LlmProvider> {
    let m = model.trim().to_lowercase();
    if m.is_empty() {
        return None;
    }
    if m.contains("gemini") {
        return Some(LlmProvider::Gemini);
    }
    if m.contains("claude") {
        return Some(LlmProvider::Anthropic);
    }
    if m.contains("gpt")
        || m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
    {
        return Some(LlmProvider::OpenAI);
    }
    None
}

/// Prefer key-prefix detection; fall back to the configured model name.
pub fn resolve_provider(key: &str, model_override: &str) -> LlmProvider {
    let from_key = detect_provider(key);
    if from_key != LlmProvider::Custom {
        return from_key;
    }
    infer_provider_from_model(model_override).unwrap_or(from_key)
}

pub fn default_base_url(provider: LlmProvider) -> &'static str {
    match provider {
        LlmProvider::OpenAI => "https://api.openai.com/v1",
        LlmProvider::Anthropic => "https://api.anthropic.com/v1",
        LlmProvider::Gemini => "https://generativelanguage.googleapis.com/v1beta/openai",
        LlmProvider::Custom => "",
    }
}

pub fn default_chat_model(provider: LlmProvider) -> &'static str {
    match provider {
        LlmProvider::OpenAI => "gpt-4o-mini",
        LlmProvider::Anthropic => "claude-sonnet-4-5-20250929",
        LlmProvider::Gemini => "gemini-2.5-flash",
        LlmProvider::Custom => "",
    }
}

/// None when the provider has no embedding API (Anthropic).
pub fn default_embedding_model(provider: LlmProvider) -> Option<&'static str> {
    match provider {
        LlmProvider::OpenAI => Some("text-embedding-3-small"),
        LlmProvider::Anthropic => None,
        LlmProvider::Gemini => Some("gemini-embedding-001"),
        LlmProvider::Custom => Some("text-embedding-3-small"),
    }
}

/// Heuristic: whether the configured chat model accepts image blocks.
pub fn model_supports_vision(provider: LlmProvider, model: &str) -> bool {
    let m = model.trim().to_lowercase();
    if m.is_empty() {
        return false;
    }
    if m.contains("embedding") || m.contains("whisper") || m.contains("tts") {
        return false;
    }
    match provider {
        LlmProvider::Anthropic => {
            m.contains("claude-3")
                || m.contains("claude-sonnet")
                || m.contains("claude-opus")
                || m.contains("claude-haiku")
        }
        LlmProvider::OpenAI => {
            m.contains("gpt-4o")
                || m.contains("gpt-4-turbo")
                || m.contains("gpt-4.1")
                || m.contains("gpt-5")
                || m.starts_with("o1")
                || m.starts_with("o3")
                || m.starts_with("o4")
        }
        LlmProvider::Gemini => m.contains("gemini"),
        LlmProvider::Custom => true,
    }
}

/// Trusted hosts known to belong to each provider. Localhost is always
/// allowed (for local LLMs / self-hosted proxies).
pub fn allowlist() -> &'static [&'static str] {
    &[
        "api.openai.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "openrouter.ai",
        "localhost",
        "127.0.0.1",
    ]
}

/// Verify that a given host is permitted for the detected provider.
/// The allowlist check and the key<->host consistency check are combined:
/// - Anthropic keys must go to `api.anthropic.com` (or localhost for proxies)
/// - Gemini keys must go to `generativelanguage.googleapis.com` (or localhost)
/// - OpenAI keys must go to `api.openai.com` (or localhost)
/// - Custom keys may use any allowlisted host (typically localhost / user extras)
pub fn validate_host_for_provider(
    provider: LlmProvider,
    host: &str,
    extra_hosts: &[String],
) -> Result<(), String> {
    let h = host.trim().to_ascii_lowercase();
    if h.is_empty() {
        return Err("LLM base URL host is empty".to_string());
    }
    let localhost = h == "localhost" || h == "127.0.0.1" || h == "::1";
    if localhost {
        return Ok(());
    }
    if extra_hosts.iter().any(|eh| eh.eq_ignore_ascii_case(&h)) {
        return Ok(());
    }
    let in_allow = allowlist().iter().any(|a| a.eq_ignore_ascii_case(&h));
    if !in_allow {
        return Err(format!(
            "Host '{}' is not in the LLM allowlist. Add it under settings.sections.security.extraLlmHosts if you trust it.",
            host
        ));
    }
    let ok = match provider {
        LlmProvider::Anthropic => h == "api.anthropic.com",
        LlmProvider::Gemini => h == "generativelanguage.googleapis.com",
        LlmProvider::OpenAI => h == "api.openai.com" || h == "openrouter.ai",
        LlmProvider::Custom => true,
    };
    if !ok {
        return Err(format!(
            "Key prefix does not match host '{}' for provider {}. Check the API key or baseUrl.",
            host,
            provider.as_str()
        ));
    }
    Ok(())
}

/// Normalize a user-entered OpenAI-compatible base URL (settings → Model & API).
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(String::new());
    }
    if !s.contains("://") && !s.contains('/') && !s.contains('.') {
        return Err(format!(
            "Base URL \"{}\" does not look like a URL. Leave it blank to use the default for your API key.",
            s
        ));
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else if s.starts_with("localhost") || s.starts_with("127.0.0.1") {
        format!("http://{}", s.trim_start_matches('/'))
    } else {
        format!("https://{}", s.trim_start_matches('/'))
    };
    let parsed = Url::parse(&with_scheme)
        .map_err(|e| format!("Invalid Base URL \"{}\": {}", s, e))?;
    if parsed.host_str().is_none() {
        return Err(format!(
            "Base URL \"{}\" has no host. Example for Gemini: https://generativelanguage.googleapis.com/v1beta/openai",
            s
        ));
    }
    Ok(with_scheme.trim_end_matches('/').to_string())
}

/// Resolve the OpenAI-compatible base URL for the detected provider, falling
/// back to vendor defaults when the saved override is empty or mismatched.
pub fn resolve_llm_base(
    provider: LlmProvider,
    base_override: &str,
    extra_hosts: &[String],
) -> Result<String, String> {
    let trimmed = base_override.trim();
    let default = default_base_url(provider);

    let mut base = if trimmed.is_empty() {
        if default.is_empty() {
            return Err(
                "Could not detect LLM provider from your API key. Use a Gemini key (AIza…), set model to gemini-2.5-flash, or enter a Base URL for custom endpoints."
                    .to_string(),
            );
        }
        default.to_string()
    } else {
        normalize_base_url(trimmed)?
    };

    let probe = chat_url(provider, &base);
    match Url::parse(&probe) {
        Ok(parsed) => {
            if let Some(host) = parsed.host_str() {
                if validate_host_for_provider(provider, host, extra_hosts).is_err() {
                    if !default.is_empty() {
                        base = default.to_string();
                    } else {
                        return Err(format!(
                            "Base URL host \"{}\" does not match your {} API key. Clear Base URL and save again.",
                            host,
                            provider.as_str()
                        ));
                    }
                }
            } else if !default.is_empty() {
                base = default.to_string();
            } else {
                return Err(format!(
                    "Invalid LLM URL \"{}\". Check Base URL in Settings → Model & API.",
                    probe
                ));
            }
        }
        Err(_) if !default.is_empty() => {
            base = default.to_string();
        }
        Err(e) => {
            return Err(format!(
                "Invalid LLM URL \"{}\": {}. Clear Base URL in Settings → Model & API.",
                probe, e
            ));
        }
    }

    Ok(base)
}

/// Resolve base + full chat/completions URL with host validation.
pub fn resolve_chat_url(
    provider: LlmProvider,
    base_override: &str,
    extra_hosts: &[String],
) -> Result<(String, String), String> {
    let base = resolve_llm_base(provider, base_override, extra_hosts)?;
    let url = chat_url(provider, &base);
    let host = Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .ok_or_else(|| {
            format!(
                "Invalid LLM URL \"{}\". Clear Base URL in Settings → Model & API and save again.",
                url
            )
        })?;
    validate_host_for_provider(provider, &host, extra_hosts)?;
    Ok((base, url))
}

/// Build the HTTP headers for a chat completion request. Each `(name, value)`
/// is returned as an owned string pair so call sites can feed it into
/// reqwest's builder without lifetime gymnastics.
pub fn chat_headers(provider: LlmProvider, key: &str) -> Vec<(&'static str, String)> {
    match provider {
        LlmProvider::Anthropic => vec![
            ("x-api-key", key.trim().to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
            ("content-type", "application/json".to_string()),
        ],
        _ => vec![
            ("Authorization", format!("Bearer {}", key.trim())),
            ("content-type", "application/json".to_string()),
        ],
    }
}

/// Build multimodal user content blocks when `images` is non-empty.
pub fn user_message_with_images(
  provider: LlmProvider,
  text: &str,
  images: &[Value],
) -> Value {
  if images.is_empty() {
    return json!({ "role": "user", "content": text });
  }
  if provider == LlmProvider::Anthropic {
    let mut parts: Vec<Value> = Vec::new();
    if !text.trim().is_empty() {
      parts.push(json!({ "type": "text", "text": text }));
    }
    for img in images {
      let mime = img
        .get("mimeType")
        .or_else(|| img.get("mime"))
        .and_then(|v| v.as_str())
        .unwrap_or("image/jpeg");
      let b64 = img.get("base64").and_then(|v| v.as_str()).unwrap_or("");
      if b64.is_empty() {
        continue;
      }
      parts.push(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": mime, "data": b64 }
      }));
    }
    if parts.is_empty() {
      return json!({ "role": "user", "content": text });
    }
    json!({ "role": "user", "content": parts })
  } else {
    let mut parts: Vec<Value> = Vec::new();
    if !text.trim().is_empty() {
      parts.push(json!({ "type": "text", "text": text }));
    }
    for img in images {
      let mime = img
        .get("mimeType")
        .or_else(|| img.get("mime"))
        .and_then(|v| v.as_str())
        .unwrap_or("image/jpeg");
      let b64 = img.get("base64").and_then(|v| v.as_str()).unwrap_or("");
      if b64.is_empty() {
        continue;
      }
      parts.push(json!({
        "type": "image_url",
        "image_url": { "url": format!("data:{};base64,{}", mime, b64) }
      }));
    }
    if parts.is_empty() {
      return json!({ "role": "user", "content": text });
    }
    json!({ "role": "user", "content": parts })
  }
}

/// Build the request body for chat completion. Anthropic has a distinct
/// shape (`system` lifted to top-level, no `temperature` default, no
/// `messages[role=system]`), so we split here. For OpenAI / Gemini / Custom
/// we pass the OpenAI standard body.
pub fn chat_body(
    provider: LlmProvider,
    model: &str,
    messages: &[Value],
    max_tokens: u64,
) -> Value {
    if provider == LlmProvider::Anthropic {
        let mut system_parts: Vec<String> = Vec::new();
        let mut user_assistant: Vec<Value> = Vec::new();
        for m in messages {
            let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let content_val = m.get("content").cloned().unwrap_or(json!(""));
            if role == "system" {
                if let Some(content) = content_val.as_str() {
                    if !content.is_empty() {
                        system_parts.push(content.to_string());
                    }
                } else if let Some(arr) = content_val.as_array() {
                    for block in arr {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    system_parts.push(t.to_string());
                                }
                            }
                        }
                    }
                }
            } else {
                user_assistant.push(json!({
                    "role": if role == "assistant" { "assistant" } else { "user" },
                    "content": content_val,
                }));
            }
        }
        let mut body = json!({
            "model": model,
            "max_tokens": max_tokens,
            "messages": user_assistant,
        });
        if !system_parts.is_empty() {
            body["system"] = json!(system_parts.join("\n\n"));
        }
        body
    } else {
        json!({
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0.7,
        })
    }
}

/// Full chat completion URL for this provider / base URL combination.
pub fn chat_url(provider: LlmProvider, base: &str) -> String {
    let base_t = base.trim().trim_end_matches('/').to_string();
    let base_use = if base_t.is_empty() {
        default_base_url(provider).trim_end_matches('/').to_string()
    } else {
        base_t
    };
    match provider {
        LlmProvider::Anthropic => format!("{}/messages", base_use),
        _ => format!("{}/chat/completions", base_use),
    }
}

/// Pull the assistant text out of the provider's response body.
pub fn extract_chat_text(provider: LlmProvider, body: &Value) -> Result<String, String> {
    if provider == LlmProvider::Anthropic {
        let arr = body
            .get("content")
            .and_then(|c| c.as_array())
            .ok_or_else(|| "Anthropic response missing content array".to_string())?;
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    return Ok(t.to_string());
                }
            }
        }
        Err("Anthropic response had no text block".to_string())
    } else {
        body.get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "Response missing choices[0].message.content".to_string())
    }
}

/// Full embeddings URL. `Err` if provider does not offer embeddings.
pub fn embed_url(provider: LlmProvider, base: &str) -> Result<String, String> {
    if provider == LlmProvider::Anthropic {
        return Err("Anthropic does not provide an embeddings endpoint".to_string());
    }
    let base_t = base.trim().trim_end_matches('/').to_string();
    let base_use = if base_t.is_empty() {
        default_base_url(provider).trim_end_matches('/').to_string()
    } else {
        base_t
    };
    Ok(format!("{}/embeddings", base_use))
}

/// Mask a raw API key for UI display. Shows the first 8 chars, an ellipsis,
/// and the last 3 chars. Short keys are replaced entirely with "***".
pub fn key_preview(key: &str) -> String {
    let k = key.trim();
    let n = k.chars().count();
    if n < 14 {
        return "***".to_string();
    }
    let head: String = k.chars().take(8).collect();
    let tail: String = k.chars().skip(n - 3).collect();
    format!("{}...{}", head, tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_anthropic() {
        assert_eq!(detect_provider("sk-ant-api03-ABC"), LlmProvider::Anthropic);
    }

    #[test]
    fn detect_gemini() {
        assert_eq!(
            detect_provider("AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6"),
            LlmProvider::Gemini
        );
    }

    #[test]
    fn detect_gemini_short_rejects() {
        assert_eq!(detect_provider("AIza"), LlmProvider::Custom);
    }

    #[test]
    fn resolve_provider_from_model_when_key_custom() {
        assert_eq!(
            resolve_provider("not-a-known-prefix", "gemini-2.5-flash"),
            LlmProvider::Gemini
        );
    }

    #[test]
    fn resolve_llm_base_gemini_ignores_stale_anthropic_url() {
        let base = resolve_llm_base(
            LlmProvider::Gemini,
            "https://api.anthropic.com/v1",
            &[],
        )
        .expect("fallback");
        assert!(base.contains("generativelanguage.googleapis.com"));
    }

    #[test]
    fn detect_openai_proj() {
        assert_eq!(detect_provider("sk-proj-xyz123"), LlmProvider::OpenAI);
    }

    #[test]
    fn detect_openai_legacy() {
        assert_eq!(detect_provider("sk-abc123"), LlmProvider::OpenAI);
    }

    #[test]
    fn detect_openrouter_as_custom() {
        assert_eq!(detect_provider("sk-or-v1-xyz"), LlmProvider::Custom);
    }

    #[test]
    fn detect_unknown_as_custom() {
        assert_eq!(detect_provider("hf_abcdef"), LlmProvider::Custom);
        assert_eq!(detect_provider(""), LlmProvider::Custom);
        assert_eq!(detect_provider("  sk-ant-trimmed  "), LlmProvider::Anthropic);
    }

    #[test]
    fn default_base_urls() {
        assert_eq!(default_base_url(LlmProvider::OpenAI), "https://api.openai.com/v1");
        assert_eq!(default_base_url(LlmProvider::Anthropic), "https://api.anthropic.com/v1");
        assert!(default_base_url(LlmProvider::Gemini).contains("generativelanguage"));
        assert_eq!(default_base_url(LlmProvider::Custom), "");
    }

    #[test]
    fn default_embedding_model_anthropic_is_none() {
        assert!(default_embedding_model(LlmProvider::Anthropic).is_none());
        assert!(default_embedding_model(LlmProvider::OpenAI).is_some());
        assert!(default_embedding_model(LlmProvider::Gemini).is_some());
    }

    #[test]
    fn validate_host_allowlist_rejects_unknown() {
        let err = validate_host_for_provider(LlmProvider::OpenAI, "evil.example", &[]).unwrap_err();
        assert!(err.contains("not in the LLM allowlist"));
    }

    #[test]
    fn validate_host_localhost_always_ok() {
        assert!(validate_host_for_provider(LlmProvider::Anthropic, "localhost", &[]).is_ok());
        assert!(validate_host_for_provider(LlmProvider::Custom, "127.0.0.1", &[]).is_ok());
    }

    #[test]
    fn validate_host_extra_hosts_ok() {
        let extras = vec!["my-corp-proxy.example".to_string()];
        assert!(
            validate_host_for_provider(LlmProvider::Custom, "my-corp-proxy.example", &extras)
                .is_ok()
        );
    }

    #[test]
    fn validate_host_mismatched_provider_rejects() {
        // Anthropic key sent to openai host must be rejected.
        let err = validate_host_for_provider(LlmProvider::Anthropic, "api.openai.com", &[])
            .unwrap_err();
        assert!(err.contains("does not match host"));
    }

    #[test]
    fn validate_host_provider_correct_ok() {
        assert!(validate_host_for_provider(LlmProvider::Anthropic, "api.anthropic.com", &[]).is_ok());
        assert!(validate_host_for_provider(LlmProvider::Gemini, "generativelanguage.googleapis.com", &[]).is_ok());
        assert!(validate_host_for_provider(LlmProvider::OpenAI, "api.openai.com", &[]).is_ok());
    }

    #[test]
    fn chat_headers_openai_uses_bearer() {
        let h = chat_headers(LlmProvider::OpenAI, "sk-abc");
        assert!(h.iter().any(|(k, v)| *k == "Authorization" && v == "Bearer sk-abc"));
    }

    #[test]
    fn chat_headers_anthropic_uses_api_key() {
        let h = chat_headers(LlmProvider::Anthropic, "sk-ant-xyz");
        assert!(h.iter().any(|(k, v)| *k == "x-api-key" && v == "sk-ant-xyz"));
        assert!(h.iter().any(|(k, _)| *k == "anthropic-version"));
    }

    #[test]
    fn chat_body_openai_keeps_system_in_messages() {
        let msgs = vec![
            json!({"role": "system", "content": "be concise"}),
            json!({"role": "user", "content": "hi"}),
        ];
        let body = chat_body(LlmProvider::OpenAI, "gpt-4o-mini", &msgs, 1000);
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert!(body.get("system").is_none());
        assert_eq!(body["temperature"], json!(0.7));
    }

    #[test]
    fn chat_body_anthropic_lifts_system_out_of_messages() {
        let msgs = vec![
            json!({"role": "system", "content": "be concise"}),
            json!({"role": "system", "content": "respond in English"}),
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "content": "hello"}),
        ];
        let body = chat_body(LlmProvider::Anthropic, "claude-sonnet-4-5", &msgs, 1000);
        assert_eq!(body["system"], json!("be concise\n\nrespond in English"));
        let ua = body["messages"].as_array().unwrap();
        assert_eq!(ua.len(), 2);
        assert_eq!(ua[0]["role"], "user");
        assert_eq!(ua[1]["role"], "assistant");
        // No temperature default; callers may add if wanted.
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn chat_url_routes_correctly() {
        assert_eq!(
            chat_url(LlmProvider::OpenAI, "https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_url(LlmProvider::Anthropic, "https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            chat_url(LlmProvider::Gemini, ""),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
    }

    #[test]
    fn extract_chat_text_openai() {
        let fixture = json!({
            "choices": [{"message": {"content": "hello world"}}]
        });
        assert_eq!(
            extract_chat_text(LlmProvider::OpenAI, &fixture).unwrap(),
            "hello world"
        );
    }

    #[test]
    fn extract_chat_text_anthropic() {
        let fixture = json!({
            "content": [
                {"type": "text", "text": "hello from Claude"}
            ]
        });
        assert_eq!(
            extract_chat_text(LlmProvider::Anthropic, &fixture).unwrap(),
            "hello from Claude"
        );
    }

    #[test]
    fn extract_chat_text_anthropic_picks_text_block() {
        // The content array can contain non-text blocks (tool_use etc.);
        // we scan for the first text block.
        let fixture = json!({
            "content": [
                {"type": "tool_use", "name": "calc"},
                {"type": "text", "text": "pick me"}
            ]
        });
        assert_eq!(
            extract_chat_text(LlmProvider::Anthropic, &fixture).unwrap(),
            "pick me"
        );
    }

    #[test]
    fn embed_url_anthropic_rejects() {
        assert!(embed_url(LlmProvider::Anthropic, "").is_err());
    }

    #[test]
    fn embed_url_openai_default() {
        assert_eq!(
            embed_url(LlmProvider::OpenAI, "").unwrap(),
            "https://api.openai.com/v1/embeddings"
        );
    }

    #[test]
    fn key_preview_masks_short_keys() {
        assert_eq!(key_preview("sk-abc"), "***");
    }

    #[test]
    fn key_preview_masks_long_keys() {
        let p = key_preview("sk-ant-api03-ABCDEFGHxyz");
        assert!(p.starts_with("sk-ant-a"));
        assert!(p.ends_with("xyz"));
        assert!(p.contains("..."));
    }
}
