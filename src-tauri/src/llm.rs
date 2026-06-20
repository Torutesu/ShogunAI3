//! OpenAI-compatible Chat Completions (HTTPS from Rust only).

use crate::{context_assembly, secrets, settings_store};
use serde_json::{json, Value};
use url::Url;

/// Extract the first JSON object from LLM text (markdown fences or prose wrappers).
pub fn extract_json_object_from_llm_text(raw: &str) -> Result<Value, String> {
    let t = raw.trim();
    let json_part = if let Some(i) = t.find('{') {
        if let Some(j) = t.rfind('}') {
            &t[i..=j]
        } else {
            t
        }
    } else {
        t
    };
    serde_json::from_str(json_part).map_err(|e| format!("Invalid JSON from model: {e}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn provenance_counts_from_hits(
    hits: &[context_assembly::Hit],
) -> crate::memory_debug::ProvenanceCounts {
    let mut c = crate::memory_debug::ProvenanceCounts::default();
    for h in hits {
        match h.provenance.as_str() {
            "screen" => c.screen += 1,
            "connector" => c.connector += 1,
            "meeting" => c.meeting += 1,
            _ => c.user += 1,
        }
    }
    c
}

fn privacy_allows_chat_server_memory_assembly() -> bool {
    settings_store::load()
        .ok()
        .and_then(|doc| {
            doc.pointer("/sections/privacy/allowChatServerMemoryAssembly")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true)
}

fn payload_allows_live_screen_context(payload: &Value) -> bool {
    payload
        .get("includeScreenContext")
        .or_else(|| payload.get("screenContext"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn value_string<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value
        .pointer(pointer)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn format_live_screen_context_for_prompt(ctx: &Value, max_ax_chars: usize) -> Option<String> {
    if ctx
        .get("enabled")
        .and_then(|v| v.as_bool())
        .map(|enabled| !enabled)
        .unwrap_or(false)
    {
        return None;
    }

    let frontmost_app =
        value_string(ctx, "/frontmostApp").or_else(|| value_string(ctx, "/frontmostFocus/appName"));
    let frontmost_bundle = value_string(ctx, "/frontmostBundleId")
        .or_else(|| value_string(ctx, "/frontmostFocus/bundleId"));
    let window_title = value_string(ctx, "/frontmostWindowTitle")
        .or_else(|| value_string(ctx, "/frontmostFocus/windowTitle"));
    let ax_snapshot = value_string(ctx, "/axSnapshot").unwrap_or("");
    if frontmost_app.is_none() && window_title.is_none() && ax_snapshot.is_empty() {
        return None;
    }

    let ax_source = value_string(ctx, "/axSnapshotSource");
    let ax_quality = value_string(ctx, "/axTextSignalQuality");
    let ax_chars = ctx.pointer("/axTextChars").and_then(|v| v.as_u64());
    let ax_keys = ctx
        .pointer("/axTextSignalKeys")
        .and_then(|v| v.as_array())
        .map(|keys| {
            keys.iter()
                .filter_map(|key| key.as_str().map(str::trim).filter(|s| !s.is_empty()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut out = String::new();
    if let Some(app) = frontmost_app {
        out.push_str(&format!("- frontmost_app: {app}\n"));
    }
    if let Some(bundle) = frontmost_bundle {
        out.push_str(&format!("- bundle_id: {bundle}\n"));
    }
    if let Some(title) = window_title {
        out.push_str(&format!("- window_title: {title}\n"));
    }
    if let Some(source) = ax_source {
        out.push_str(&format!("- ax_source: {source}\n"));
    }
    if let Some(quality) = ax_quality {
        out.push_str(&format!("- ax_text_signal_quality: {quality}\n"));
    }
    if !ax_keys.is_empty() {
        out.push_str(&format!("- ax_text_signal_keys: {}\n", ax_keys.join(", ")));
    }
    if let Some(chars) = ax_chars {
        out.push_str(&format!("- ax_text_chars: {chars}\n"));
    }
    if !ax_snapshot.is_empty() {
        let clipped: String = ax_snapshot.chars().take(max_ax_chars).collect();
        out.push_str("\nAX text snapshot:\n");
        out.push_str(&clipped);
    }
    Some(out)
}

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

fn invalid_llm_url_message(
    provider: crate::llm_providers::LlmProvider,
    base_override: &str,
    url: &str,
) -> String {
    if provider == crate::llm_providers::LlmProvider::Custom && base_override.trim().is_empty() {
        return "Invalid LLM URL: custom / local keys need a Base URL in Settings → Model & API."
            .to_string();
    }
    format!(
        "Invalid LLM URL: {}. Check Settings → Model & API → Base URL.",
        url
    )
}

fn resolve_chat_endpoint(
    provider: crate::llm_providers::LlmProvider,
    base_override: &str,
    extra_hosts: &[String],
) -> Result<String, String> {
    fn resolve_with_base(
        provider: crate::llm_providers::LlmProvider,
        base_override: &str,
        extra_hosts: &[String],
    ) -> Result<String, String> {
        let base = if base_override.trim().is_empty() {
            crate::llm_providers::default_base_url(provider).to_string()
        } else {
            base_override.trim().to_string()
        };
        let url = crate::llm_providers::chat_url(provider, &base);
        let host = Url::parse(&url)
            .ok()
            .and_then(|u| u.host_str().map(|s| s.to_string()))
            .ok_or_else(|| invalid_llm_url_message(provider, base_override, &url))?;
        crate::llm_providers::validate_host_for_provider(provider, &host, extra_hosts)?;
        Ok(url)
    }

    let override_trimmed = base_override.trim();
    if override_trimmed.is_empty() || provider == crate::llm_providers::LlmProvider::Custom {
        return resolve_with_base(provider, override_trimmed, extra_hosts);
    }

    match resolve_with_base(provider, override_trimmed, extra_hosts) {
        Ok(url) => Ok(url),
        Err(override_err) => {
            let default_base = crate::llm_providers::default_base_url(provider);
            if default_base.is_empty() {
                return Err(override_err);
            }
            resolve_with_base(provider, "", extra_hosts).map_err(|default_err| {
                format!(
                    "{}; default {} endpoint also failed: {}",
                    override_err,
                    provider.as_str(),
                    default_err
                )
            })
        }
    }
}

#[derive(Debug, Clone)]
struct ChatCandidate {
    key: String,
    provider: crate::llm_providers::LlmProvider,
    model: String,
    url: String,
}

fn provider_rank(provider: crate::llm_providers::LlmProvider) -> usize {
    match provider {
        crate::llm_providers::LlmProvider::Gemini => 0,
        crate::llm_providers::LlmProvider::Anthropic => 1,
        crate::llm_providers::LlmProvider::OpenAI => 2,
        crate::llm_providers::LlmProvider::Custom => 3,
    }
}

fn provider_for_key_and_model(
    key: &str,
    requested_model: &str,
    has_base_override: bool,
) -> crate::llm_providers::LlmProvider {
    let detected = crate::llm_providers::detect_provider(key);
    if detected != crate::llm_providers::LlmProvider::Custom || has_base_override {
        return detected;
    }
    for provider in [
        crate::llm_providers::LlmProvider::Gemini,
        crate::llm_providers::LlmProvider::Anthropic,
        crate::llm_providers::LlmProvider::OpenAI,
    ] {
        if crate::llm_providers::model_matches_provider(provider, requested_model) {
            return provider;
        }
    }
    detected
}

fn chat_candidates_from_keys(
    requested_model: &str,
    keys: Vec<String>,
) -> Result<Vec<ChatCandidate>, String> {
    if keys.is_empty() {
        return Err(
            "LLM API key is not set. Open Settings → Model & API and save your key.".to_string(),
        );
    }
    let (base_override, _, _) = read_llm_prefs()?;
    let extra_hosts = read_extra_llm_hosts();
    let has_base_override = !base_override.trim().is_empty();
    let mut keyed: Vec<(usize, String)> = keys
        .into_iter()
        .enumerate()
        .map(|(idx, key)| {
            let provider = provider_for_key_and_model(&key, requested_model, has_base_override);
            let model_match =
                crate::llm_providers::model_matches_provider(provider, requested_model);
            let score = if model_match { 0 } else { 100 } + provider_rank(provider) * 10 + idx;
            (score, key)
        })
        .collect();
    keyed.sort_by_key(|(score, _)| *score);

    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    for (_, key) in keyed {
        let provider = provider_for_key_and_model(&key, requested_model, has_base_override);
        let model = crate::llm_providers::chat_model_for_provider(provider, requested_model);
        if model.trim().is_empty() {
            skipped.push(format!("{}: no model configured", provider.as_str()));
            continue;
        }
        match resolve_chat_endpoint(provider, &base_override, &extra_hosts) {
            Ok(url) => candidates.push(ChatCandidate {
                key,
                provider,
                model,
                url,
            }),
            Err(e) => skipped.push(format!("{}: {}", provider.as_str(), e)),
        }
    }
    if candidates.is_empty() {
        Err(format!(
            "No usable LLM provider candidates. {}",
            skipped.join(" | ")
        ))
    } else {
        Ok(candidates)
    }
}

fn chat_candidates(requested_model: &str) -> Result<Vec<ChatCandidate>, String> {
    chat_candidates_from_keys(requested_model, secrets::get_llm_api_keys()?)
}

async fn post_chat_candidate(
    candidate: &ChatCandidate,
    messages: &[Value],
    max_tokens: u64,
) -> Result<String, String> {
    let body =
        crate::llm_providers::chat_body(candidate.provider, &candidate.model, messages, max_tokens);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&candidate.url);
    for (name, value) in crate::llm_providers::chat_headers(candidate.provider, &candidate.key) {
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
        return Err(format!(
            "LLM API error {} provider={} model={}: {}",
            status,
            candidate.provider.as_str(),
            candidate.model,
            snippet
        ));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "Invalid JSON from LLM: {} — body: {}",
            e,
            text.chars().take(200).collect::<String>()
        )
    })?;
    crate::llm_providers::extract_chat_text(candidate.provider, &v)
}

async fn post_chat_with_fallback(
    candidates: &[ChatCandidate],
    messages_for: impl Fn(crate::llm_providers::LlmProvider) -> Vec<Value>,
    max_tokens: u64,
    has_images: bool,
) -> Result<(String, ChatCandidate), String> {
    let mut errors = Vec::new();
    for candidate in candidates {
        if has_images
            && !crate::llm_providers::model_supports_vision(candidate.provider, &candidate.model)
        {
            errors.push(format!(
                "{}:{} does not support image input",
                candidate.provider.as_str(),
                candidate.model
            ));
            continue;
        }
        let messages = messages_for(candidate.provider);
        match post_chat_candidate(candidate, &messages, max_tokens).await {
            Ok(text) => return Ok((text, candidate.clone())),
            Err(e) => {
                crate::memory_obs::emit(
                    "llm_provider_attempt_failed",
                    &[
                        ("provider", candidate.provider.as_str().to_string()),
                        ("model", candidate.model.clone()),
                        ("error", crate::memory_obs::clip_preview(&e)),
                    ],
                );
                errors.push(e);
            }
        }
    }
    Err(format!(
        "All LLM provider attempts failed: {}",
        errors.join(" | ")
    ))
}

fn anthropic_api_key() -> Result<String, String> {
    secrets::get_llm_api_keys()?
        .into_iter()
        .find(|key| {
            crate::llm_providers::detect_provider(key)
                == crate::llm_providers::LlmProvider::Anthropic
        })
        .ok_or_else(|| "Anthropic API key not configured".to_string())
}

pub fn chat_request_preflight() -> Result<(), String> {
    let (_, model, _) = read_llm_prefs()?;
    let _ = chat_candidates(&model)?;
    Ok(())
}

pub fn chat_request_preflight_cached_or_env() -> Result<(), String> {
    let (_, model, _) = read_llm_prefs()?;
    let keys = secrets::get_cached_or_env_llm_api_keys();
    if keys.is_empty() {
        secrets::load_llm_api_keys_in_background();
        return Err(
            "LLM key is locked or not loaded. Allow the macOS Keychain prompt, open Settings → Model & API once, or set GEMINI_API_KEY / ANTHROPIC_API_KEY."
                .to_string(),
        );
    }
    let _ = chat_candidates_from_keys(&model, keys)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonChatResult {
    pub input: Value,
    pub resolved_model: String,
}

/// Provider-routed JSON completion used by internal structured tasks that do
/// not need Anthropic tool_use. The prompt asks for JSON-only output and the
/// parser tolerates fenced/prose-wrapped JSON via `extract_json_object_from_llm_text`.
pub async fn json_chat_complete(
    system: &str,
    user: &str,
    model_override: Option<&str>,
    max_tokens_override: Option<u64>,
) -> Result<JsonChatResult, String> {
    let (_, settings_model, settings_max_tokens) = read_llm_prefs()?;
    let requested_model = model_override
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            let trimmed = settings_model.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .unwrap_or_default();
    let max_tokens = max_tokens_override.unwrap_or(settings_max_tokens);
    let candidates = chat_candidates(&requested_model)?;
    let messages_for = |_provider: crate::llm_providers::LlmProvider| {
        vec![
            json!({ "role": "system", "content": system }),
            json!({ "role": "user", "content": user }),
        ]
    };
    let (content, used) =
        post_chat_with_fallback(&candidates, messages_for, max_tokens, false).await?;
    let input = extract_json_object_from_llm_text(&content)?;
    Ok(JsonChatResult {
        input,
        resolved_model: used.model,
    })
}

pub async fn chat_complete(
    payload: &Value,
    chat_ring: Option<&crate::memory_debug::RingBuffer>,
) -> Result<Value, String> {
    let chat_start = std::time::Instant::now();
    let (_, model_override, max_tokens) = read_llm_prefs()?;
    let candidates = chat_candidates(&model_override)?;
    let messages_in = payload
        .get("messages")
        .and_then(|m| m.as_array())
        .ok_or_else(|| "messages array is required".to_string())?;
    if messages_in.is_empty() {
        return Err("messages must not be empty".to_string());
    }
    let has_images = messages_in.iter().any(|m| {
        m.get("role").and_then(|r| r.as_str()) == Some("user")
            && m.get("images")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false)
    });
    let mut prefix_messages: Vec<Value> = Vec::new();
    let mut memory_assembly_hits: Vec<context_assembly::Hit> = Vec::new();
    let mut live_screen_context_block: Option<String> = None;
    // Phase 2 Stage 3 (T8.3): user-defined KIOKU rules ride at the very top of
    // every system prompt so the model can't override them via later context.
    // Returns None when no rules are configured — quiet no-op for fresh installs.
    if let Some(rules_msg) = crate::kioku_rules::leading_system_message() {
        prefix_messages.push(rules_msg);
    }
    if let Some(ctx) = payload.get("memoryContext").and_then(|v| v.as_str()) {
        let ctx = ctx.trim();
        if !ctx.is_empty() {
            let clipped: String = ctx.chars().take(12_000).collect();
            prefix_messages.push(json!({
        "role": "system",
        "content": format!(
          "Relevant entries from the user's local SHOGUN memory index:\n\n{}\n\nUse this context when it helps answer.",
          clipped
        ),
      }));
        }
    }
    if privacy_allows_chat_server_memory_assembly() {
        if let Some(ma) = payload.get("memoryAssembly").and_then(|x| x.as_object()) {
            let q = ma
                .get("query")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim();
            let limit = ma
                .get("limit")
                .and_then(|x| x.as_u64())
                .unwrap_or(12)
                .clamp(1, 80);
            let semantic = ma
                .get("semantic")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
                query: q,
                limit,
                semantic,
                excluded_provenances: None,
            })
            .await?;
            memory_assembly_hits = hits.clone();
            let block = context_assembly::format_hits_draft_context(
                &hits,
                context_assembly::SYSTEM_PROMPT_BUDGET_CHARS,
            );
            let manual_ctx = payload
                .get("memoryContext")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            crate::memory_obs::emit(
                "chat_memory_block",
                &[
                    ("block_chars", block.chars().count().to_string()),
                    ("hits", hits.len().to_string()),
                    ("manual_ctx", manual_ctx.to_string()),
                    ("semantic", semantic.to_string()),
                    ("mode", context_assembly::current_read_path().to_string()),
                ],
            );
            if let Some(ring) = chat_ring {
                ring.push(crate::memory_debug::CallTrace {
                    ts_ms: now_ms(),
                    route: "chat.complete",
                    query_preview: crate::memory_obs::clip_preview(q),
                    query_len: q.chars().count(),
                    limit,
                    semantic,
                    hits_count: hits.len(),
                    provenance_counts: provenance_counts_from_hits(&hits),
                    block_chars: block.chars().count(),
                    elapsed_ms: chat_start.elapsed().as_millis() as u64,
                    status: crate::memory_debug::CallStatus::Ok,
                    assembled_block: Some(block.clone()),
                });
            }
            if !block.is_empty() {
                prefix_messages.push(json!({
          "role": "system",
          "content": format!(
            "Additional context assembled from the local memory index (provenance tags in brackets):\n\n{}\n\nUse when helpful.",
            block
          ),
        }));
            }
        }
    }
    if privacy_allows_chat_server_memory_assembly() && payload_allows_live_screen_context(payload) {
        let ctx = crate::hummingbird::capture_context();
        if let Some(block) = format_live_screen_context_for_prompt(&ctx, 4_000) {
            crate::memory_obs::emit(
                "chat_live_screen_context",
                &[
                    ("block_chars", block.chars().count().to_string()),
                    (
                        "ax_quality",
                        value_string(&ctx, "/axTextSignalQuality")
                            .unwrap_or("unknown")
                            .to_string(),
                    ),
                    (
                        "ax_source",
                        value_string(&ctx, "/axSnapshotSource")
                            .unwrap_or("unknown")
                            .to_string(),
                    ),
                ],
            );
            prefix_messages.push(json!({
              "role": "system",
              "content": format!(
                "Current screen text context captured through macOS Accessibility (text only, no screenshot). It may be partial; use it as immediate context when relevant and do not infer beyond it.\n\n{}",
                block
              ),
            }));
            live_screen_context_block = Some(block);
        }
    }
    if payload
        .get("webSearch")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        prefix_messages.push(json!({
      "role": "system",
      "content": "The user enabled web-research mode. This runtime does not perform live HTTP browsing: answer from training knowledge, pasted URLs, and memory context above. If freshness matters, state that you cannot verify live web results and suggest the user paste a link or check a source.",
    }));
    }
    // Lessons retrieval (KIOKU Sub-spec A): top-K rules embedded against
    // the user's latest message, appended as a leading system message so
    // the model honors past corrections. Silent fallback throughout.
    let latest_user_text = messages_in
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .and_then(|m| m.get("content").and_then(|c| c.as_str()))
        .unwrap_or("")
        .to_string();
    let (lessons_addendum, applied_lesson_ids) =
        crate::lessons::retrieve_for_chat(&latest_user_text).await;
    if !lessons_addendum.is_empty() {
        prefix_messages.push(serde_json::json!({
          "role": "system",
          "content": lessons_addendum,
        }));
    }
    let prefix_messages_for_attempt = prefix_messages.clone();
    let messages_for = |provider: crate::llm_providers::LlmProvider| {
        let mut messages = prefix_messages_for_attempt.clone();
        for m in messages_in {
            let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
            if role == "user" {
                if let Some(imgs) = m
                    .get("images")
                    .and_then(|v| v.as_array())
                    .filter(|a| !a.is_empty())
                {
                    messages.push(crate::llm_providers::user_message_with_images(
                        provider, content, imgs,
                    ));
                    continue;
                }
            }
            messages.push(json!({ "role": role, "content": content }));
        }
        messages
    };
    let (content, _used) =
        post_chat_with_fallback(&candidates, messages_for, max_tokens, has_images).await?;
    if !applied_lesson_ids.is_empty() {
        if let Ok(conn) = crate::memory_store::open_conn() {
            if let Err(e) = crate::lessons::increment_applies(&conn, &applied_lesson_ids) {
                log::warn!("lessons::increment_applies failed: {}", e);
            }
        }

        // Sub-spec E: async verifier — fire-and-forget. Increments prevented_n
        // for lessons the assistant reply respected. Does not block this response.
        let applied_ids_for_verify = applied_lesson_ids.clone();
        let user_msg_for_verify = latest_user_text.clone();
        let assistant_msg_for_verify = content.clone();
        tauri::async_runtime::spawn(async move {
            crate::lessons_verifier::verify_and_increment(
                applied_ids_for_verify,
                user_msg_for_verify,
                assistant_msg_for_verify,
            )
            .await;
        });
    }
    Ok(json!({
      "message": content,
      "memoryAssemblyHits": context_assembly::hits_to_json(&memory_assembly_hits),
      "memoryReadPath": context_assembly::current_read_path(),
      "liveScreenContextIncluded": live_screen_context_block.is_some(),
      "liveScreenContextChars": live_screen_context_block
        .as_ref()
        .map(|block| block.chars().count())
        .unwrap_or(0),
      "echo": payload,
      "stub": false,
    }))
}

/// One-shot Markdown draft from UI payload (`target`, `prompt`, `source`, …).
pub async fn draft_from_payload(
    payload: &Value,
    ring: Option<&crate::memory_debug::RingBuffer>,
) -> Result<Value, String> {
    let target = payload
        .get("target")
        .and_then(|t| t.as_str())
        .unwrap_or("document");
    let start = std::time::Instant::now();
    let prompt = payload.get("prompt").and_then(|p| p.as_str()).unwrap_or("");
    let source = payload.get("source").and_then(|s| s.as_str()).unwrap_or("");
    let mut memory_block = String::new();
    let mut hits_count: usize = 0;
    let mut draft_hits: Vec<context_assembly::Hit> = Vec::new();
    let mut draft_q = String::new();
    let mut draft_limit: u64 = 8;
    let mut draft_semantic = false;
    if privacy_allows_chat_server_memory_assembly() {
        if let Some(ma) = payload.get("memoryAssembly").and_then(|x| x.as_object()) {
            let q = ma
                .get("query")
                .and_then(|x| x.as_str())
                .unwrap_or(prompt)
                .trim();
            let limit = ma
                .get("limit")
                .and_then(|x| x.as_u64())
                .unwrap_or(8)
                .clamp(1, 40);
            let semantic = ma
                .get("semantic")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
                query: q,
                limit,
                semantic,
                excluded_provenances: None,
            })
            .await
            .unwrap_or_else(|_| Vec::new());
            hits_count = hits.len();
            memory_block = context_assembly::format_hits_draft_context(
                &hits,
                context_assembly::DRAFT_PROMPT_BUDGET_CHARS,
            );
            draft_q = q.to_string();
            draft_limit = limit;
            draft_semantic = semantic;
            draft_hits = hits;
        }
    }
    let user = if memory_block.is_empty() {
        format!(
      "Produce a concise Markdown draft for this request.\nTarget: {}\nIntent / prompt: {}\nContext source: {}\n\nOutput only Markdown (headings and bullets allowed). No preamble or closing remarks.",
      target, prompt, source
    )
    } else {
        format!(
      "Produce a concise Markdown draft for this request.\nTarget: {}\nIntent / prompt: {}\nContext source: {}\n\n## Local memory\n{}\n\nOutput only Markdown (headings and bullets allowed). No preamble or closing remarks.",
      target, prompt, source, memory_block
    )
    };
    let wrapped = json!({
      "messages": [
        {
          "role": "system",
          "content": "You are SHOGUN's drafting assistant. Reply with Markdown only."
        },
        { "role": "user", "content": user }
      ]
    });
    let out = chat_complete(&wrapped, None).await?;
    let content = out
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let title = payload
        .get("title")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Draft · {}", target));
    let memory_used = !memory_block.is_empty();
    let block_chars = memory_block.chars().count();
    crate::memory_obs::emit(
        "draft_from_payload_done",
        &[
            ("memory_used", memory_used.to_string()),
            ("hits", hits_count.to_string()),
            ("block_chars", block_chars.to_string()),
            ("content_len", content.chars().count().to_string()),
            (
                "elapsed_ms",
                (start.elapsed().as_millis() as u64).to_string(),
            ),
        ],
    );
    if memory_used {
        if let Some(r) = ring {
            r.push(crate::memory_debug::CallTrace {
                ts_ms: now_ms(),
                route: "draft_from_payload",
                query_preview: crate::memory_obs::clip_preview(&draft_q),
                query_len: draft_q.chars().count(),
                limit: draft_limit,
                semantic: draft_semantic,
                hits_count,
                provenance_counts: provenance_counts_from_hits(&draft_hits),
                block_chars,
                elapsed_ms: start.elapsed().as_millis() as u64,
                status: crate::memory_debug::CallStatus::Ok,
                assembled_block: Some(memory_block.clone()),
            });
        }
    }
    Ok(json!({
      "content": content,
      "title": title,
      "stub": false,
      "echo": payload,
    }))
}

pub async fn brief_generate(
    payload: &Value,
    ring: Option<&crate::memory_debug::RingBuffer>,
) -> Result<Value, String> {
    let start = std::time::Instant::now();
    let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
        query: "",
        limit: 15,
        semantic: false,
        // T7 polish: brief never contains raw screen captures, regardless of
        // which retrieval path produced the hits.
        excluded_provenances: Some(vec!["screen".to_string()]),
    })
    .await?;
    let hits_count = hits.len();
    let block = context_assembly::format_hits_brief_json_prompt(
        &hits,
        context_assembly::SYSTEM_PROMPT_BUDGET_CHARS,
    );
    let user_prompt = format!(
    "From these local memory items, output ONLY valid JSON with shape {{\"sections\":[{{\"title\":string,\"body\":string}}]}}. No markdown code fences. If there are no items, use {{\"sections\":[]}}.\n\nMemories:\n{}",
    block
  );
    let synthetic = json!({
      "messages": [{ "role": "user", "content": user_prompt }],
    });
    let out = chat_complete(&synthetic, None).await?;
    let message = out.get("message").and_then(|m| m.as_str()).unwrap_or("{}");
    let sections_val: Value = serde_json::from_str(message).unwrap_or(json!({ "sections": [] }));
    let sections = sections_val.get("sections").cloned().unwrap_or(json!([]));
    let sections_count = sections.as_array().map(|a| a.len()).unwrap_or(0);
    let generated = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    crate::memory_obs::emit(
        "brief_generate_done",
        &[
            ("hits", hits_count.to_string()),
            ("sections", sections_count.to_string()),
            (
                "elapsed_ms",
                (start.elapsed().as_millis() as u64).to_string(),
            ),
        ],
    );
    if let Some(r) = ring {
        let block_chars = block.chars().count();
        r.push(crate::memory_debug::CallTrace {
            ts_ms: now_ms(),
            route: "brief.get",
            query_preview: String::new(),
            query_len: 0,
            limit: 15,
            semantic: false,
            hits_count,
            provenance_counts: provenance_counts_from_hits(&hits),
            block_chars,
            elapsed_ms: start.elapsed().as_millis() as u64,
            status: crate::memory_debug::CallStatus::Ok,
            assembled_block: Some(block.clone()),
        });
    }
    let lang = payload.get("lang").and_then(|v| v.as_str()).unwrap_or("en");
    let memory_digest = crate::brief::build_memory_digest(lang);
    Ok(json!({
      "sections": sections,
      "memory_digest": memory_digest,
      "memoryReadPath": context_assembly::current_read_path(),
      "generatedAt": generated,
      "echo": payload,
      "stub": false,
    }))
}

/// Draft a paste-ready reply from a Morning Brief item + local Memory (requires LLM API key).
pub async fn draft_reply_for_brief(
    payload: &Value,
    ring: Option<&crate::memory_debug::RingBuffer>,
) -> Result<Value, String> {
    let item = payload.get("brief_item");
    let start = std::time::Instant::now();
    let what = item
        .and_then(|i| i.get("what"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let why = item
        .and_then(|i| i.get("why_now"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let mut linked = String::new();
    if let Some(rc) = item
        .and_then(|i| i.get("related_context"))
        .and_then(|x| x.as_array())
    {
        for x in rc {
            let t = x.get("title").and_then(|v| v.as_str()).unwrap_or("");
            linked.push_str(&format!("- {}\n", t));
        }
    }
    let q: String = what.chars().take(160).collect();
    let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
        query: &q,
        limit: 12,
        semantic: true,
        // T7 polish: reply drafts must never quote raw screen captures.
        excluded_provenances: Some(vec!["screen".to_string()]),
    })
    .await
    .unwrap_or_else(|_| Vec::new());
    let mem_block = context_assembly::format_hits_reply_draft(&hits);
    let user = format!(
    "Prepare the operator's **next concrete message** (email, chat, or meeting talking points — infer from context).\n\n\
## Brief\n**What:** {}\n**Why now:** {}\n**Linked:**\n{}\n\n## Local memory (top FTS hits)\n{}\n\n\
Reply with **Markdown only**: tight bullets or one short paragraph they can paste. No preamble.\n",
    what,
    why,
    if linked.is_empty() { "—\n".to_string() } else { linked },
    if mem_block.is_empty() {
      "—\n".to_string()
    } else {
      mem_block.clone()
    }
  );
    let wrapped = json!({
      "messages": [
        {
          "role": "system",
          "content": "You are SHOGUN's reply-drafting assistant. Output Markdown only; concise and professional."
        },
        { "role": "user", "content": user }
      ]
    });
    let out = chat_complete(&wrapped, None).await?;
    let content = out
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let title = format!(
        "Reply draft · {}",
        what.chars().take(40).collect::<String>()
    );
    crate::memory_obs::emit(
        "draft_reply_done",
        &[
            ("hits", hits.len().to_string()),
            ("content_len", content.chars().count().to_string()),
            (
                "elapsed_ms",
                (start.elapsed().as_millis() as u64).to_string(),
            ),
        ],
    );
    if let Some(r) = ring {
        r.push(crate::memory_debug::CallTrace {
            ts_ms: now_ms(),
            route: "draft_reply",
            query_preview: crate::memory_obs::clip_preview(&q),
            query_len: q.chars().count(),
            limit: 12,
            semantic: true,
            hits_count: hits.len(),
            provenance_counts: provenance_counts_from_hits(&hits),
            block_chars: mem_block.chars().count(),
            elapsed_ms: start.elapsed().as_millis() as u64,
            status: crate::memory_debug::CallStatus::Ok,
            assembled_block: Some(mem_block.clone()),
        });
    }
    Ok(json!({
      "content": content,
      "title": title,
      "stub": false,
      "echo": payload,
    }))
}

/// Anthropic Messages API を tool_choice 強制モードで呼び出し、tool_use の入力 JSON を返す。
/// Phase 1 summarizer 専用: emit_memory_summary のような structured output ツールを使う想定。
///
/// - `system`: System prompt。短ければキャッシュ効果小、長ければ ephemeral cache_control を付ける (v1 は付けない)。
/// - `user`: ユーザーメッセージ本文 (LLM に渡す本編のデータ)。
/// - `tool`: JSON schema (`{"name": ..., "description": ..., "input_schema": ...}` の中身)。
/// - `model`: 例 "claude-sonnet-4-6"。
///
/// 注: Phase 1 では Anthropic エンドポイント (`https://api.anthropic.com/v1/messages`) に固定。
/// `chat_complete` と異なり `llm_providers` を経由せず baseUrl override や host allowlist 検証を行わない。
/// Phase 2 で `llm_providers` 経由に refactor 予定。
///
/// 複数 tool_use が返った場合は最初に一致したものを採用。tool_choice 強制モードでは通常 1 件のみ。
///
/// 戻り値: LLM が emit したツールの input JSON (= summary の構造化データ)。
/// Output of `anthropic_tool_complete_with_usage`. Mirrors what KIOKU's cost
/// ledger needs without leaking the raw Anthropic envelope.
#[derive(Debug, Clone)]
pub struct AnthropicToolResult {
    pub input: serde_json::Value,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Tokens written to the prompt cache on this call (1.25× normal price per
    /// Anthropic). 0 when prompt caching is disabled or below threshold.
    pub cache_creation_input_tokens: i64,
    /// Tokens served from the prompt cache (0.10× normal price). The bulk of
    /// the savings.
    pub cache_read_input_tokens: i64,
    /// Resolved model id from the API response (Anthropic may serve a snapshot
    /// alias under a more specific id; we record what actually billed).
    pub resolved_model: String,
}

/// Knobs for `anthropic_tool_complete_with_usage` / the body builder.
/// `Default` keeps every Anthropic feature off so existing callers stay on
/// the legacy code path until they explicitly opt in.
#[derive(Debug, Clone, Copy, Default)]
pub struct AnthropicToolRequestOptions {
    /// When true, attach `cache_control: { type: "ephemeral" }` to the system
    /// prompt and the (single) tool definition. KIOKU extraction sets this so
    /// the static system + tool schema sit in Anthropic's prompt cache and the
    /// 30s-tick worker pays cached-read prices on every call after the first.
    pub enable_prompt_cache: bool,
}

/// Pure helper that builds the `/v1/messages` request body for tool_use mode.
/// Lives in its own function so we can unit-test prompt caching without
/// hitting the network. Mirrors what `anthropic_tool_complete_with_usage`
/// sends on the wire.
pub fn build_anthropic_tool_request_body(
    model: &str,
    system: &str,
    user: &str,
    tool: &serde_json::Value,
    max_tokens: i64,
    opts: AnthropicToolRequestOptions,
) -> serde_json::Value {
    let system_field = if opts.enable_prompt_cache {
        json!([{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }])
    } else {
        json!(system)
    };
    let mut tool_value = tool.clone();
    if opts.enable_prompt_cache {
        if let Some(obj) = tool_value.as_object_mut() {
            obj.insert("cache_control".into(), json!({ "type": "ephemeral" }));
        }
    }
    json!({
      "model": model,
      "max_tokens": max_tokens,
      "system": system_field,
      "messages": [{ "role": "user", "content": user }],
      "tools": [tool_value],
      "tool_choice": { "type": "tool", "name": tool.get("name").and_then(|v| v.as_str()).unwrap_or("") },
    })
}

/// Pure helper that turns a parsed Anthropic Messages response into an
/// `AnthropicToolResult`. Extracted from `anthropic_tool_complete_with_usage`
/// so tests can exercise usage / cache token parsing without HTTP.
pub fn parse_anthropic_tool_response(
    parsed: &serde_json::Value,
    tool_name: &str,
    fallback_model: &str,
) -> Result<AnthropicToolResult, String> {
    let usage = parsed.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let cache_creation_input_tokens = usage
        .and_then(|u| u.get("cache_creation_input_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let cache_read_input_tokens = usage
        .and_then(|u| u.get("cache_read_input_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let resolved_model = parsed
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(fallback_model)
        .to_string();

    let content = parsed
        .get("content")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Anthropic response missing content array".to_string())?;

    for item in content {
        if item.get("type").and_then(|t| t.as_str()) == Some("tool_use")
            && item.get("name").and_then(|n| n.as_str()) == Some(tool_name)
        {
            let input = item
                .get("input")
                .cloned()
                .ok_or_else(|| "tool_use missing input".to_string())?;
            return Ok(AnthropicToolResult {
                input,
                input_tokens,
                output_tokens,
                cache_creation_input_tokens,
                cache_read_input_tokens,
                resolved_model,
            });
        }
    }
    Err(format!(
        "Anthropic response has no tool_use for {}",
        tool_name
    ))
}

/// Like `anthropic_tool_complete` but also returns `usage` token counts so the
/// caller can write a faithful `cost_ledger` row. Behaviorally identical to
/// the legacy function for the success path; the legacy function stays in
/// place to avoid touching every existing call site.
#[allow(dead_code)]
pub async fn anthropic_tool_complete_with_usage(
    system: &str,
    user: &str,
    tool: &serde_json::Value,
    model: &str,
) -> Result<AnthropicToolResult, String> {
    anthropic_tool_complete_with_usage_opts(
        system,
        user,
        tool,
        model,
        AnthropicToolRequestOptions::default(),
    )
    .await
}

/// Same as `anthropic_tool_complete_with_usage` but lets the caller toggle
/// prompt caching. KIOKU extraction sets `enable_prompt_cache=true` so the
/// static system prompt + tool schema get cached.
pub async fn anthropic_tool_complete_with_usage_opts(
    system: &str,
    user: &str,
    tool: &serde_json::Value,
    model: &str,
    opts: AnthropicToolRequestOptions,
) -> Result<AnthropicToolResult, String> {
    let key = anthropic_api_key()?;

    let tool_name = tool
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tool.name required".to_string())?
        .to_string();

    let body = build_anthropic_tool_request_body(model, system, user, tool, 1024, opts);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("reqwest build: {}", e))?;

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key.trim())
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic tool_use network error: {}", e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Anthropic tool_use body: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "Anthropic tool_use {}: {}",
            status,
            text.chars().take(300).collect::<String>(),
        ));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Anthropic tool_use JSON parse: {}", e))?;

    parse_anthropic_tool_response(&parsed, &tool_name, model)
        .map_err(|e| format!("{}: {}", e, text.chars().take(300).collect::<String>(),))
}

pub async fn anthropic_tool_complete(
    system: &str,
    user: &str,
    tool: &serde_json::Value,
    model: &str,
) -> Result<serde_json::Value, String> {
    let key = anthropic_api_key()?;

    let tool_name = tool
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tool.name required".to_string())?
        .to_string();

    let body = serde_json::json!({
      "model": model,
      "max_tokens": 1024,
      "system": system,
      "messages": [{ "role": "user", "content": user }],
      "tools": [tool],
      "tool_choice": { "type": "tool", "name": tool_name },
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("reqwest build: {}", e))?;

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key.trim())
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic tool_use network error: {}", e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Anthropic tool_use body: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "Anthropic tool_use {}: {}",
            status,
            text.chars().take(300).collect::<String>()
        ));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Anthropic tool_use JSON parse: {}", e))?;

    // Expect content = [{ type: "tool_use", name: tool_name, input: { ... } }, ...]
    let content = parsed
        .get("content")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Anthropic response missing content array".to_string())?;

    for item in content {
        if item.get("type").and_then(|t| t.as_str()) == Some("tool_use")
            && item.get("name").and_then(|n| n.as_str()) == Some(tool_name.as_str())
        {
            return item
                .get("input")
                .cloned()
                .ok_or_else(|| "tool_use missing input".to_string());
        }
    }

    Err(format!(
        "Anthropic response has no tool_use for {}: {}",
        tool_name,
        text.chars().take(300).collect::<String>()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_tool() -> Value {
        json!({
          "name": "emit_facts",
          "description": "test tool",
          "input_schema": { "type": "object", "properties": {} },
        })
    }

    #[test]
    fn build_body_without_cache_uses_string_system_and_plain_tool() {
        let body = build_anthropic_tool_request_body(
            "claude-haiku-4-5",
            "sys",
            "user",
            &dummy_tool(),
            1024,
            AnthropicToolRequestOptions::default(),
        );
        assert_eq!(body["model"], "claude-haiku-4-5");
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["system"], "sys");
        let tools = body["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert!(tools[0].get("cache_control").is_none(), "no cache on tool");
    }

    #[test]
    fn build_body_with_prompt_cache_uses_content_blocks_for_system() {
        let opts = AnthropicToolRequestOptions {
            enable_prompt_cache: true,
        };
        let body = build_anthropic_tool_request_body(
            "claude-haiku-4-5",
            "sys",
            "user",
            &dummy_tool(),
            1024,
            opts,
        );
        let sys = body["system"].as_array().expect("system as content blocks");
        assert_eq!(sys.len(), 1);
        assert_eq!(sys[0]["type"], "text");
        assert_eq!(sys[0]["text"], "sys");
        assert_eq!(sys[0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn build_body_with_prompt_cache_marks_last_tool() {
        let opts = AnthropicToolRequestOptions {
            enable_prompt_cache: true,
        };
        let body = build_anthropic_tool_request_body(
            "claude-haiku-4-5",
            "sys",
            "user",
            &dummy_tool(),
            1024,
            opts,
        );
        let tools = body["tools"].as_array().expect("tools array");
        assert_eq!(tools[0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn invalid_llm_url_message_custom_missing_base_mentions_base_url() {
        let err = invalid_llm_url_message(
            crate::llm_providers::LlmProvider::Custom,
            "",
            "/chat/completions",
        );
        assert!(err.contains("Base URL"));
        assert!(err.contains("custom / local"));
    }

    #[test]
    fn resolve_chat_endpoint_falls_back_to_vendor_default_when_override_mismatches_provider() {
        let url = resolve_chat_endpoint(
            crate::llm_providers::LlmProvider::Gemini,
            "https://api.openai.com/v1",
            &[],
        )
        .expect("gemini default endpoint");
        assert!(url.contains("generativelanguage.googleapis.com"));
        assert!(url.ends_with("/chat/completions"));
    }

    #[test]
    fn resolve_chat_endpoint_custom_still_requires_base_url() {
        let err =
            resolve_chat_endpoint(crate::llm_providers::LlmProvider::Custom, "", &[]).unwrap_err();
        assert!(err.contains("custom / local"));
    }

    #[test]
    fn provider_for_custom_key_infers_vendor_from_requested_model_without_base_override() {
        assert_eq!(
            provider_for_key_and_model("not-a-prefixed-key", "gemini-2.5-flash", false),
            crate::llm_providers::LlmProvider::Gemini
        );
        assert_eq!(
            provider_for_key_and_model("not-a-prefixed-key", "claude-sonnet-4-5", false),
            crate::llm_providers::LlmProvider::Anthropic
        );
    }

    #[test]
    fn provider_for_custom_key_respects_explicit_base_override() {
        assert_eq!(
            provider_for_key_and_model("not-a-prefixed-key", "gemini-2.5-flash", true),
            crate::llm_providers::LlmProvider::Custom
        );
    }

    #[test]
    fn payload_allows_live_screen_context_defaults_on_and_honors_false() {
        assert!(payload_allows_live_screen_context(&json!({})));
        assert!(!payload_allows_live_screen_context(
            &json!({ "includeScreenContext": false })
        ));
        assert!(!payload_allows_live_screen_context(
            &json!({ "screenContext": false })
        ));
    }

    #[test]
    fn format_live_screen_context_for_prompt_includes_text_only_ax_context() {
        let ctx = json!({
          "enabled": true,
          "frontmostApp": "Notes",
          "frontmostBundleId": "com.apple.Notes",
          "frontmostWindowTitle": "Project plan",
          "axSnapshotSource": "focused_window_tree",
          "axTextSignalQuality": "strong",
          "axTextSignalKeys": ["text", "value"],
          "axTextChars": 120,
          "axSnapshot": "title=Project plan\ntext=Ship context pipeline",
        });
        let block = format_live_screen_context_for_prompt(&ctx, 1_000).expect("context block");
        assert!(block.contains("frontmost_app: Notes"));
        assert!(block.contains("window_title: Project plan"));
        assert!(block.contains("ax_text_signal_quality: strong"));
        assert!(block.contains("ax_text_signal_keys: text, value"));
        assert!(block.contains("AX text snapshot:"));
        assert!(block.contains("Ship context pipeline"));
    }

    #[test]
    fn format_live_screen_context_for_prompt_clips_ax_snapshot() {
        let ctx = json!({
          "enabled": true,
          "frontmostApp": "Notes",
          "axSnapshot": "abcdef",
        });
        let block = format_live_screen_context_for_prompt(&ctx, 3).expect("context block");
        assert!(block.contains("abc"));
        assert!(!block.contains("abcdef"));
    }

    #[test]
    fn format_live_screen_context_for_prompt_omits_disabled_or_empty_context() {
        assert_eq!(
            format_live_screen_context_for_prompt(&json!({ "enabled": false }), 100),
            None
        );
        assert_eq!(format_live_screen_context_for_prompt(&json!({}), 100), None);
    }

    #[test]
    fn anthropic_tool_result_carries_cache_token_fields() {
        let r = AnthropicToolResult {
            input: json!({}),
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 800,
            cache_read_input_tokens: 2_700,
            resolved_model: "claude-haiku-4-5".into(),
        };
        assert_eq!(r.cache_creation_input_tokens, 800);
        assert_eq!(r.cache_read_input_tokens, 2_700);
    }

    #[test]
    fn parse_usage_reads_cache_tokens_when_present() {
        let resp = json!({
          "model": "claude-haiku-4-5-20251001",
          "content": [{ "type": "tool_use", "name": "emit_facts", "input": {} }],
          "usage": {
            "input_tokens": 50,
            "output_tokens": 12,
            "cache_creation_input_tokens": 800,
            "cache_read_input_tokens": 2_700,
          },
        });
        let parsed =
            parse_anthropic_tool_response(&resp, "emit_facts", "claude-haiku-4-5").expect("ok");
        assert_eq!(parsed.input_tokens, 50);
        assert_eq!(parsed.output_tokens, 12);
        assert_eq!(parsed.cache_creation_input_tokens, 800);
        assert_eq!(parsed.cache_read_input_tokens, 2_700);
        assert_eq!(parsed.resolved_model, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn parse_usage_defaults_cache_tokens_to_zero_when_absent() {
        let resp = json!({
          "model": "claude-haiku-4-5",
          "content": [{ "type": "tool_use", "name": "emit_facts", "input": {} }],
          "usage": { "input_tokens": 50, "output_tokens": 12 },
        });
        let parsed =
            parse_anthropic_tool_response(&resp, "emit_facts", "claude-haiku-4-5").expect("ok");
        assert_eq!(parsed.cache_creation_input_tokens, 0);
        assert_eq!(parsed.cache_read_input_tokens, 0);
    }
}
