# Multi-Provider LLM Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `llm::chat_complete` and `embeddings::embed_one` to OpenAI / Anthropic / Gemini based on auto-detected provider (from API key prefix), with host allowlist and key-to-host consistency enforcement. Anthropic has no embeddings, so embedding calls fail gracefully and FTS-only retrieval keeps working.

**Architecture:** New pure module `src-tauri/src/llm_providers.rs` owns provider detection, per-provider defaults, allowlist, request/response shape construction. `llm.rs` and `embeddings.rs` become thin network wrappers that delegate shape decisions to the module. No schema changes. No new runtime dependencies.

**Tech Stack:** Rust 2021 / Tauri v2 / `reqwest` (already used) / `serde_json`.

**Spec:** `docs/superpowers/specs/2026-04-23-multi-provider-llm-design.md`

---

## File Structure

**New files:**
- `src-tauri/src/llm_providers.rs` — enum, detection, defaults, allowlist, request/response adapters, 23 unit tests

**Modified files:**
- `src-tauri/src/lib.rs` — `mod llm_providers;`
- `src-tauri/src/llm.rs` — use provider adapter, replace OpenAI-hardcoded bits
- `src-tauri/src/embeddings.rs` — use provider adapter, return `Err` for Anthropic
- `src-tauri/src/commands.rs` — `shogun_llm_api_key_status` (if it exists) / `app_llm_api_key_status` to return `provider` + `keyPreview`
- `hifi/settings-modal.jsx` — show provider label under API key input (minimal 1-block addition)

---

## Task 1: Create `llm_providers` module with detection + defaults

**Files:**
- Create: `src-tauri/src/llm_providers.rs`
- Modify: `src-tauri/src/lib.rs`

### Step 1.1: Create the module

- [ ] **Create `src-tauri/src/llm_providers.rs` with exactly this content:**

```rust
//! Provider routing for LLM calls. Detects which vendor an API key belongs
//! to from its prefix and maps each provider to its canonical base URL,
//! default chat model, default embedding model (if any), authentication
//! header, request body shape, and response extraction path.
//!
//! Spec: `docs/superpowers/specs/2026-04-23-multi-provider-llm-design.md`.

use serde_json::{json, Value};

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

/// Identify the vendor from the raw key. Anthropic and Gemini have strict
/// prefixes; OpenAI-style keys (`sk-*`) are the fallback; anything else is
/// `Custom` (meant for local LLMs or explicit proxies).
pub fn detect_provider(key: &str) -> LlmProvider {
    let k = key.trim();
    if k.starts_with("sk-ant-") {
        return LlmProvider::Anthropic;
    }
    if k.starts_with("AIza") && k.len() >= 35 {
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
            let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
            if role == "system" {
                if !content.is_empty() {
                    system_parts.push(content.to_string());
                }
            } else {
                user_assistant.push(json!({
                    "role": if role == "assistant" { "assistant" } else { "user" },
                    "content": content,
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
        // Fewer than 35 chars with AIza prefix is not considered Gemini.
        assert_eq!(detect_provider("AIza-short"), LlmProvider::Custom);
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
```

### Step 1.2: Declare module

- [ ] **In `src-tauri/src/lib.rs`, add in alphabetical order (between `mod llm;` and `mod macos_ax;` or similar — verify by reading):**

```rust
mod llm_providers;
```

### Step 1.3: Verify

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo test --lib llm_providers`
  **Expected:** All 23 tests pass.

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo build`
  **Expected:** Clean (dead_code warnings for unused pub fns are OK — later tasks wire them in).

### Step 1.4: Commit

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/llm_providers.rs src-tauri/src/lib.rs
git commit -m "feat(llm): add provider detection + adapter module (openai/anthropic/gemini)"
```

---

## Task 2: Rewire `llm::chat_complete` through the provider adapter

**Files:**
- Modify: `src-tauri/src/llm.rs`

### Step 2.1: Replace OpenAI-hardcoded pieces

- [ ] **Open `src-tauri/src/llm.rs`. Fully replace the `read_llm_prefs`, `chat_completions_url`, `validate_llm_base_url`, and the top of `chat_complete` (everything before the `messages_in` extraction) with the following. Keep the middle-to-end of `chat_complete` (memory block assembly, message construction, B-1 emits, ring-buffer push, response parsing) identical where noted:**

Replace the existing `read_llm_prefs`:

```rust
pub fn read_llm_prefs() -> Result<(String, String, u64), String> {
  let doc = settings_store::load()?;
  let llm = doc.pointer("/sections/llm");
  let base = llm
    .and_then(|l| l.get("baseUrl"))
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim()
    .to_string();
  let model = llm
    .and_then(|l| l.get("model"))
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .to_string();
  let max_tokens = llm
    .and_then(|l| l.get("maxTokens"))
    .and_then(|v| v.as_u64())
    .unwrap_or(2048);
  Ok((base, model, max_tokens))
}
```

**(Removed: the hardcoded `"https://api.openai.com/v1"` and `"gpt-4o-mini"` fallbacks — provider-specific defaults are applied later.)**

Remove `chat_completions_url` and `validate_llm_base_url` helper functions (the logic moves to `llm_providers`).

Replace the top of `chat_complete` — from the function opening through just before `let messages_in = payload.get("messages")...` — with:

```rust
pub async fn chat_complete(payload: &Value) -> Result<Value, String> {
  let key = secrets::get_llm_api_key()?
    .filter(|k| !k.trim().is_empty())
    .ok_or_else(|| {
      "LLM API key is not set. Open Settings → Model & API and save your key.".to_string()
    })?;
  let provider = crate::llm_providers::detect_provider(&key);
  let (base_override, model_override, max_tokens) = read_llm_prefs()?;
  let base = if base_override.is_empty() {
    crate::llm_providers::default_base_url(provider).to_string()
  } else {
    base_override
  };
  let model = if model_override.is_empty() {
    crate::llm_providers::default_chat_model(provider).to_string()
  } else {
    model_override
  };
  let url = crate::llm_providers::chat_url(provider, &base);
  let host = Url::parse(&url)
    .ok()
    .and_then(|u| u.host_str().map(|s| s.to_string()))
    .ok_or_else(|| "Invalid LLM URL".to_string())?;
  let extra_hosts = read_extra_llm_hosts();
  crate::llm_providers::validate_host_for_provider(provider, &host, &extra_hosts)?;
```

Add this helper near the top of the file (below the `use` statements, next to the existing `privacy_allows_chat_server_memory_assembly` helper):

```rust
fn read_extra_llm_hosts() -> Vec<String> {
  settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/security/extraLlmHosts")
        .and_then(|v| v.as_array())
        .map(|arr| {
          arr
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
        })
    })
    .unwrap_or_default()
}
```

### Step 2.2: Replace the HTTP call block with provider-aware headers + body

- [ ] **Inside `chat_complete`, find the block that builds the reqwest POST. Currently it uses a hardcoded `Authorization: Bearer {}` header and JSON body. Replace with:**

```rust
  let body = crate::llm_providers::chat_body(provider, &model, &messages, max_tokens);
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(120))
    .build()
    .map_err(|e| e.to_string())?;
  let mut req = client.post(&url);
  for (name, value) in crate::llm_providers::chat_headers(provider, &key) {
    req = req.header(name, value);
  }
  let resp = req
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("Network error: {}", e))?;
  let status = resp.status();
  let text = resp.text().await.map_err(|e| e.to_string())?;
  if !status.is_success() {
    let snippet: String = text.chars().take(800).collect();
    return Err(format!("LLM API error {}: {}", status, snippet));
  }
  let v: Value = serde_json::from_str(&text).map_err(|e| {
    format!(
      "Invalid JSON from LLM: {} — body: {}",
      e,
      text.chars().take(200).collect::<String>()
    )
  })?;
  let content = crate::llm_providers::extract_chat_text(provider, &v)?;
  Ok(json!({
    "message": content,
    "echo": payload,
    "stub": false,
  }))
}
```

This replaces the tail from `let body = json!({...})` through `Ok(json!({ "message": content, ... }))`.

### Step 2.3: Verify

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo build`
  **Expected:** Clean build. `Url` import may need adjusting — `use url::Url;` is already at top of file.

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo test --lib`
  **Expected:** All existing tests pass.

### Step 2.4: Commit

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/llm.rs
git commit -m "feat(llm): route chat_complete through provider adapter + host allowlist"
```

---

## Task 3: Rewire `embeddings::embed_one` through the provider adapter

**Files:**
- Modify: `src-tauri/src/embeddings.rs`

### Step 3.1: Replace body with provider-aware version

- [ ] **Replace the entire file contents of `src-tauri/src/embeddings.rs` with:**

```rust
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
    let provider = llm_providers::detect_provider(&key);
    let (base_override, model_override) = read_embedding_prefs()?;
    let base = if base_override.is_empty() {
        llm_providers::default_base_url(provider).to_string()
    } else {
        base_override
    };
    let url = llm_providers::embed_url(provider, &base)?;
    let host = Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .ok_or_else(|| "Invalid embeddings URL".to_string())?;
    let extra_hosts = read_extra_llm_hosts();
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
```

### Step 3.2: Verify

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo test --lib embeddings`
  **Expected:** 2 tests pass (same as before).

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo build`
  **Expected:** Clean.

### Step 3.3: Commit

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/embeddings.rs
git commit -m "feat(embeddings): route through provider adapter; anthropic returns Err"
```

---

## Task 4: Extend `app_llm_api_key_status` to return `provider` + `keyPreview`

**Files:**
- Modify: `src-tauri/src/commands.rs`

### Step 4.1: Locate the handler and extend it

- [ ] **Find the existing `app_llm_api_key_status` handler in `src-tauri/src/commands.rs` (around line 292). Current shape returns just `{"configured": bool}`. Replace it with:**

```rust
#[tauri::command]
pub fn app_llm_api_key_status(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  match secrets::get_llm_api_key()? {
    Some(k) if !k.trim().is_empty() => {
      let provider = crate::llm_providers::detect_provider(&k);
      Ok(serde_json::json!({
        "configured": true,
        "provider": provider.as_str(),
        "keyPreview": crate::llm_providers::key_preview(&k),
      }))
    }
    _ => Ok(serde_json::json!({
      "configured": false,
      "provider": null,
      "keyPreview": null,
    })),
  }
}
```

If the current handler does NOT take a `payload` argument, adjust the signature to match the existing pattern in this file. If it takes `()`, don't add one.

### Step 4.2: Verify

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo build`
  **Expected:** Clean.

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo test --lib`
  **Expected:** All tests pass.

### Step 4.3: Commit

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs
git commit -m "feat(api-key): include provider and masked preview in status response"
```

---

## Task 5: Frontend — show provider under API key field

**Files:**
- Modify: `hifi/settings-modal.jsx`

### Step 5.1: Locate the API key input and add provider badge

- [ ] **Read `hifi/settings-modal.jsx`. Find the section that renders the LLM API key input field (search for `llm.api_key_status` or `apiKey` or similar). Just below the input, add a span that reads the `provider` from the last status response.**

Example addition (adapt to the actual component state names in the file):

```jsx
{apiKeyStatus?.provider && apiKeyStatus?.configured && (
  <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
    Provider: {
      apiKeyStatus.provider === 'openai' ? 'OpenAI' :
      apiKeyStatus.provider === 'anthropic' ? 'Anthropic (Claude)' :
      apiKeyStatus.provider === 'gemini' ? 'Google Gemini' :
      'Custom / Local'
    } {apiKeyStatus.keyPreview ? `(${apiKeyStatus.keyPreview})` : ''}
  </div>
)}
```

If the file does not currently track an `apiKeyStatus` state object, wire it up by mirroring whatever other status fields (`configured` checkmark, etc.) are already doing — do not restructure the component.

### Step 5.2: Verify

- [ ] **Manual check:** Reload the Tauri app (Cmd+R), open Settings → API Key, and confirm:
  - When no key is set, no provider line shows.
  - When a key is set, the line reads "Provider: X (sk-...xyz)".

### Step 5.3: Commit

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/settings-modal.jsx
git commit -m "feat(settings): show detected LLM provider under API key input"
```

---

## Task 6: Final build + manual smoke test handoff

### Step 6.1: Full build and tests

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo build --all-targets 2>&1 | tail -5`
  **Expected:** Clean.

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri && cargo test --lib 2>&1 | tail -5`
  **Expected:** Previous test count + 23 new `llm_providers` tests. All pass.

### Step 6.2: Manual smoke (user-driven)

- [ ] **User provides an Anthropic key:** ask the user to paste it via Settings UI or via:
  ```bash
  security add-generic-password -s "ai.shogun.desktop" -a "llm_openai_compatible_api_key" -w "sk-ant-..." -U
  ```

- [ ] **Restart the Tauri app** (kill + `npm run tauri dev`).

- [ ] **In DevTools Console** of the Tauri native window (not Safari):
  ```js
  await window.__TAURI_INTERNALS__.invoke('app_llm_api_key_status', { payload: {} })
  ```
  Expected: `{ configured: true, provider: 'anthropic', keyPreview: 'sk-ant-a...xyz' }`.

- [ ] **Send a chat message** in the app's Chat screen. Watch `tail -f ~/Library/Logs/ai.shogun.desktop/Shogun\ AI.log | grep memory_obs` — a `chat_memory_block` or no event depending on whether memoryAssembly is sent, but no 4xx error should appear.

- [ ] **Trigger a Morning Brief**. Watch for `event=brief_generate_done`.

- [ ] **Open Memory → verify full result** (real data now, not mock).

### Step 6.3: No key-in-log regression guard

- [ ] **Run:**
  ```bash
  grep -rn "log::info\|log::warn\|log::error" src-tauri/src/llm.rs src-tauri/src/llm_providers.rs src-tauri/src/embeddings.rs
  ```
  **Verify:** None of the matching lines include a raw `key` variable value in their format args. Allowed: `key_preview`, length counts, provider names.

---

## Coverage Check (self-review)

Against the spec's Completion Criteria:

- [x] `llm_providers.rs` exists, 23 unit tests (Task 1)
- [x] `chat_complete` uses provider adapter (Task 2)
- [x] `embed_one` uses provider adapter, Anthropic returns Err (Task 3)
- [x] Host allowlist enforced at call time (Tasks 2, 3)
- [x] Key-prefix ⇄ Host consistency enforced (Task 1 validate_host + Tasks 2, 3)
- [x] `app_llm_api_key_status` returns `provider` + `keyPreview` (Task 4)
- [x] Settings UI shows provider (Task 5)
- [x] Existing OpenAI-key users see no behavior change (verified by Task 1 detect_provider tests + default fallbacks)
- [x] `cargo build` / `cargo test --lib` pass (Task 6)
- [x] No raw key in logs (Task 6.3 grep)

## Non-goals confirmation

- No Azure / Vertex / Bedrock
- No tool-use / function-calling provider diffs
- No embedding-provider-split from chat-provider (Anthropic chat + OpenAI embed simultaneously) — deferred
- No backfill UI for existing embeddings after provider switch — `memory.embed_backfill` already exists, user triggers manually if needed
- No SecretString wrapper — deferred; current audit confirms no raw key in logs
