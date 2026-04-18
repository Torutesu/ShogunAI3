//! OpenAI-compatible Chat Completions (HTTPS from Rust only).

use crate::{memory_store, secrets, settings_store};
use serde_json::{json, Value};

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

pub async fn chat_complete(payload: &Value) -> Result<Value, String> {
  let key = secrets::get_llm_api_key()?
    .filter(|k| !k.trim().is_empty())
    .ok_or_else(|| {
      "LLM API key is not set. Open Settings → Model & API and save your key.".to_string()
    })?;
  let (base, default_model, max_tokens) = read_llm_prefs()?;
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
  let prompt = payload
    .get("prompt")
    .and_then(|p| p.as_str())
    .unwrap_or("");
  let source = payload
    .get("source")
    .and_then(|s| s.as_str())
    .unwrap_or("");
  let user = format!(
    "Produce a concise Markdown draft for this request.\nTarget: {}\nIntent / prompt: {}\nContext source: {}\n\nOutput only Markdown (headings and bullets allowed). No preamble or closing remarks.",
    target, prompt, source
  );
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
  Ok(json!({
    "content": content,
    "title": title,
    "stub": false,
    "echo": payload,
  }))
}

pub async fn brief_generate(payload: &Value) -> Result<Value, String> {
  let search_payload = json!({ "query": "", "limit": 15 });
  let mem = memory_store::search(&search_payload)?;
  let hits = mem
    .get("hits")
    .and_then(|h| h.as_array())
    .cloned()
    .unwrap_or_default();
  let mut lines = Vec::new();
  for h in hits.iter().take(15) {
    let title = h.get("title").and_then(|t| t.as_str()).unwrap_or("");
    let snippet = h.get("snippet").and_then(|s| s.as_str()).unwrap_or("");
    lines.push(format!("- {}: {}", title, snippet));
  }
  let block: String = lines.join("\n").chars().take(10_000).collect();
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
  let generated = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  Ok(json!({
    "sections": sections,
    "generatedAt": generated,
    "echo": payload,
    "stub": false,
  }))
}
