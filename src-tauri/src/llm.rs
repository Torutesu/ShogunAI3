//! OpenAI-compatible Chat Completions (HTTPS from Rust only).

use crate::{context_assembly, secrets, settings_store};
use serde_json::{json, Value};
use url::Url;

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
    .unwrap_or("https://api.openai.com/v1")
    .trim()
    .to_string();
  let model = llm
    .and_then(|l| l.get("model"))
    .and_then(|v| v.as_str())
    .unwrap_or("gpt-4o-mini")
    .to_string();
  let max_tokens = llm
    .and_then(|l| l.get("maxTokens"))
    .and_then(|v| v.as_u64())
    .unwrap_or(2048);
  Ok((base, model, max_tokens))
}

fn chat_completions_url(base: &str) -> String {
  let s = base.trim().trim_end_matches('/').to_string();
  let root = if s.ends_with("/v1") {
    s
  } else if s.is_empty() {
    "https://api.openai.com/v1".to_string()
  } else {
    format!("{}/v1", s)
  };
  format!("{}/chat/completions", root)
}

fn validate_llm_base_url(base: &str) -> Result<(), String> {
  let trimmed = base.trim();
  if trimmed.is_empty() {
    return Ok(());
  }
  let parsed =
    Url::parse(trimmed).map_err(|_| "Invalid LLM base URL. Use a full URL (e.g. https://api.openai.com/v1).".to_string())?;
  match parsed.scheme() {
    "https" => Ok(()),
    "http" => {
      let host = parsed.host_str().unwrap_or("");
      if host == "localhost" || host == "127.0.0.1" || host == "::1" {
        Ok(())
      } else {
        Err("Insecure LLM base URL. Use HTTPS (HTTP is allowed only for localhost).".to_string())
      }
    }
    _ => Err("Unsupported LLM base URL scheme. Use HTTPS (or localhost HTTP).".to_string()),
  }
}

pub async fn chat_complete(payload: &Value) -> Result<Value, String> {
  let key = secrets::get_llm_api_key()?
    .filter(|k| !k.trim().is_empty())
    .ok_or_else(|| {
      "LLM API key is not set. Open Settings → Model & API and save your key.".to_string()
    })?;
  let (base, default_model, max_tokens) = read_llm_prefs()?;
  validate_llm_base_url(&base)?;
  let model = payload
    .get("model")
    .and_then(|m| m.as_str())
    .unwrap_or(&default_model)
    .to_string();
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
      let block = context_assembly::format_hits_draft_context(&hits, 10_000);
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
  let body = json!({
    "model": model,
    "messages": messages,
    "max_tokens": max_tokens,
    "temperature": 0.7,
  });
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(120))
    .build()
    .map_err(|e| e.to_string())?;
  let url = chat_completions_url(&base);
  let resp = client
    .post(&url)
    .header("Authorization", format!("Bearer {}", key.trim()))
    .header("Content-Type", "application/json")
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
  let v: Value = serde_json::from_str(&text)
    .map_err(|e| format!("Invalid JSON from LLM: {} — body: {}", e, text.chars().take(200).collect::<String>()))?;
  let content = v
    .get("choices")
    .and_then(|c| c.as_array())
    .and_then(|a| a.first())
    .and_then(|c| c.get("message"))
    .and_then(|m| m.get("content"))
    .and_then(|c| c.as_str())
    .ok_or_else(|| "Unexpected LLM response (no choices[0].message.content)".to_string())?;
  Ok(json!({
    "message": content,
    "echo": payload,
    "stub": false,
  }))
}

/// One-shot Markdown draft from UI payload (`target`, `prompt`, `source`, …).
pub async fn draft_from_payload(payload: &Value) -> Result<Value, String> {
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
      memory_block = context_assembly::format_hits_draft_context(&hits, 6000);
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
  let out = chat_complete(&wrapped).await?;
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
      ("block_chars", block_chars.to_string()),
      ("content_len", content.chars().count().to_string()),
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
    ],
  );
  Ok(json!({
    "content": content,
    "title": title,
    "stub": false,
    "echo": payload,
  }))
}

pub async fn brief_generate(payload: &Value) -> Result<Value, String> {
  let start = std::time::Instant::now();
  let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
    query: "",
    limit: 15,
    semantic: false,
  })
  .await?;
  let hits_count = hits.len();
  let block = context_assembly::format_hits_brief_json_prompt(&hits, 10_000);
  let user_prompt = format!(
    "From these local memory items, output ONLY valid JSON with shape {{\"sections\":[{{\"title\":string,\"body\":string}}]}}. No markdown code fences. If there are no items, use {{\"sections\":[]}}.\n\nMemories:\n{}",
    block
  );
  let synthetic = json!({
    "messages": [{ "role": "user", "content": user_prompt }],
  });
  let out = chat_complete(&synthetic).await?;
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
      ("hits_used", hits_count.to_string()),
      ("sections", sections_count.to_string()),
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
    ],
  );
  Ok(json!({
    "sections": sections,
    "generatedAt": generated,
    "echo": payload,
    "stub": false,
  }))
}

/// Draft a paste-ready reply from a Morning Brief item + local Memory (requires LLM API key).
pub async fn draft_reply_for_brief(payload: &Value) -> Result<Value, String> {
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
      mem_block
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
  let out = chat_complete(&wrapped).await?;
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
      ("hits_used", hits.len().to_string()),
      ("content_len", content.chars().count().to_string()),
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
    ],
  );
  Ok(json!({
    "content": content,
    "title": title,
    "stub": false,
    "echo": payload,
  }))
}
