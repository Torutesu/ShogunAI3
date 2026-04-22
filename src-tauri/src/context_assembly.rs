//! Shared helpers that pull hits from the Memory index and format them as
//! prompt-ready text blocks for chat, draft, brief, and reply flows.
//!
//! All callers route through [`assemble_memory_hits`] so provenance, limits, and
//! optional semantic re-ranking stay consistent across commands.

use serde_json::{json, Value};

use crate::memory_store;

pub struct AssembleParams<'a> {
  pub query: &'a str,
  pub limit: u64,
  pub semantic: bool,
}

/// Run a Memory search (optionally semantic re-ranked) and return the raw hit
/// array. Empty queries resolve to recent rows, matching `memory_store::search`.
pub async fn assemble_memory_hits(params: AssembleParams<'_>) -> Result<Vec<Value>, String> {
  let payload = json!({
    "query": params.query,
    "limit": params.limit,
    "semantic": params.semantic,
  });
  let result = memory_store::search_with_semantics(&payload).await?;
  let hits = result
    .get("hits")
    .and_then(|h| h.as_array())
    .cloned()
    .unwrap_or_default();
  Ok(hits)
}

fn hit_parts(hit: &Value) -> (String, String, String, Vec<String>) {
  let title = hit
    .get("title")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim()
    .to_string();
  let snippet = hit
    .get("snippet")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim()
    .to_string();
  let source = hit
    .get("source")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim()
    .to_string();
  let kinds: Vec<String> = hit
    .get("kinds")
    .and_then(|v| v.as_array())
    .map(|arr| {
      arr
        .iter()
        .filter_map(|k| k.as_str().map(str::to_string))
        .collect()
    })
    .unwrap_or_default();
  (title, snippet, source, kinds)
}

fn provenance_tag(source: &str, kinds: &[String]) -> String {
  if !source.is_empty() {
    if let Some(first) = kinds.first() {
      return format!("[{source} · {first}]");
    }
    return format!("[{source}]");
  }
  if let Some(first) = kinds.first() {
    return format!("[{first}]");
  }
  String::from("[memory]")
}

fn push_within_budget(buf: &mut String, chunk: &str, max_chars: usize) -> bool {
  if max_chars == 0 {
    buf.push_str(chunk);
    return true;
  }
  if buf.len() + chunk.len() > max_chars {
    return false;
  }
  buf.push_str(chunk);
  true
}

/// Compact bullet list suitable for the chat / draft "additional context" block.
/// Budgets characters so the prompt stays under `max_chars` (0 = unlimited).
pub fn format_hits_draft_context(hits: &[Value], max_chars: usize) -> String {
  let mut out = String::new();
  for hit in hits {
    let (title, snippet, source, kinds) = hit_parts(hit);
    if title.is_empty() && snippet.is_empty() {
      continue;
    }
    let tag = provenance_tag(&source, &kinds);
    let headline = if title.is_empty() {
      snippet.chars().take(80).collect::<String>()
    } else {
      title.clone()
    };
    let body = if snippet.is_empty() || snippet == title {
      String::new()
    } else {
      format!(" — {}", snippet)
    };
    let line = format!("- {tag} {headline}{body}\n");
    if !push_within_budget(&mut out, &line, max_chars) {
      break;
    }
  }
  out
}

/// JSON-prompt variant used by the Morning Brief generator; includes id so the
/// model can cite back into Memory.
pub fn format_hits_brief_json_prompt(hits: &[Value], max_chars: usize) -> String {
  let mut out = String::new();
  for hit in hits {
    let id = hit
      .get("id")
      .and_then(|v| v.as_str())
      .unwrap_or("")
      .to_string();
    let (title, snippet, source, kinds) = hit_parts(hit);
    if title.is_empty() && snippet.is_empty() {
      continue;
    }
    let tag = provenance_tag(&source, &kinds);
    let mut piece = format!("- {tag}");
    if !id.is_empty() {
      piece.push_str(&format!(" id={id}"));
    }
    if !title.is_empty() {
      piece.push_str(&format!(" title=\"{}\"", title.replace('"', "'")));
    }
    if !snippet.is_empty() {
      let clipped: String = snippet.chars().take(280).collect();
      piece.push_str(&format!(" snippet=\"{}\"", clipped.replace('"', "'")));
    }
    piece.push('\n');
    if !push_within_budget(&mut out, &piece, max_chars) {
      break;
    }
  }
  out
}

/// Reply-drafting variant: keep it short (no char budget — caller supplies a
/// pre-trimmed limit via `assemble_memory_hits`).
pub fn format_hits_reply_draft(hits: &[Value]) -> String {
  let mut out = String::new();
  for hit in hits {
    let (title, snippet, source, kinds) = hit_parts(hit);
    if title.is_empty() && snippet.is_empty() {
      continue;
    }
    let tag = provenance_tag(&source, &kinds);
    let headline = if title.is_empty() {
      snippet.chars().take(80).collect::<String>()
    } else {
      title
    };
    let clipped_snippet: String = snippet.chars().take(200).collect();
    if clipped_snippet.is_empty() {
      out.push_str(&format!("- {tag} {headline}\n"));
    } else {
      out.push_str(&format!("- {tag} {headline} — {clipped_snippet}\n"));
    }
  }
  out
}
