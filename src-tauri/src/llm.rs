//! OpenAI-compatible Chat Completions (HTTPS from Rust only).

use crate::{context_assembly, secrets, settings_store};
use serde_json::{json, Value};
use url::Url;

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
      doc
        .pointer("/sections/privacy/allowChatServerMemoryAssembly")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true)
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
          arr
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
        })
    })
    .unwrap_or_default()
}

pub async fn chat_complete(
  payload: &Value,
  chat_ring: Option<&crate::memory_debug::RingBuffer>,
) -> Result<Value, String> {
  let chat_start = std::time::Instant::now();
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
  let messages_in = payload
    .get("messages")
    .and_then(|m| m.as_array())
    .ok_or_else(|| "messages array is required".to_string())?;
  if messages_in.is_empty() {
    return Err("messages must not be empty".to_string());
  }
  let mut messages: Vec<Value> = Vec::new();
  if let Some(ctx) = payload.get("memoryContext").and_then(|v| v.as_str()) {
    let ctx = ctx.trim();
    if !ctx.is_empty() {
      let clipped: String = ctx.chars().take(12_000).collect();
      messages.push(json!({
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
      let semantic = ma.get("semantic").and_then(|x| x.as_bool()).unwrap_or(false);
      let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
        query: q,
        limit,
        semantic,
      })
      .await?;
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
        messages.push(json!({
          "role": "system",
          "content": format!(
            "Additional context assembled from the local memory index (provenance tags in brackets):\n\n{}\n\nUse when helpful.",
            block
          ),
        }));
      }
    }
  }
  if payload
    .get("webSearch")
    .and_then(|v| v.as_bool())
    .unwrap_or(false)
  {
    messages.push(json!({
      "role": "system",
      "content": "The user enabled web-research mode. This runtime does not perform live HTTP browsing: answer from training knowledge, pasted URLs, and memory context above. If freshness matters, state that you cannot verify live web results and suggest the user paste a link or check a source.",
    }));
  }
  for m in messages_in {
    let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
    let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
    messages.push(json!({ "role": role, "content": content }));
  }
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
  let prompt = payload
    .get("prompt")
    .and_then(|p| p.as_str())
    .unwrap_or("");
  let source = payload
    .get("source")
    .and_then(|s| s.as_str())
    .unwrap_or("");
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
      let semantic = ma.get("semantic").and_then(|x| x.as_bool()).unwrap_or(false);
      let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
        query: q,
        limit,
        semantic,
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
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
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
  let sections = sections_val
    .get("sections")
    .cloned()
    .unwrap_or(json!([]));
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
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
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
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en");
  let memory_digest = crate::brief::build_memory_digest(lang);
  Ok(json!({
    "sections": sections,
    "memory_digest": memory_digest,
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
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
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
pub async fn anthropic_tool_complete(
  system: &str,
  user: &str,
  tool: &serde_json::Value,
  model: &str,
) -> Result<serde_json::Value, String> {
  let key = crate::secrets::get_llm_api_key()?
    .ok_or_else(|| "LLM API key not configured".to_string())?;

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
    return Err(format!("Anthropic tool_use {}: {}", status, text.chars().take(300).collect::<String>()));
  }

  let parsed: serde_json::Value = serde_json::from_str(&text)
    .map_err(|e| format!("Anthropic tool_use JSON parse: {}", e))?;

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
