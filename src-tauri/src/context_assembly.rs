//! Single path for turning an operator intent (query + limit + semantic flag)
//! into formatted blocks that get injected into LLM prompts. All callers
//! (`chat.complete`'s `memoryAssembly`, `brief.get`, `draft.create`, and
//! `shogun.draft_reply`) go through [`assemble_memory_hits`] so retention,
//! capping, and redaction of local memory context stays centralised.
//!
//! See `docs/context-layer-phase-0-1.md` for the schema rationale.

use crate::memory_store;
use serde_json::{json, Value};

/// Per-call knobs for [`assemble_memory_hits`].
pub struct AssembleParams<'a> {
  pub query: &'a str,
  pub limit: u64,
  pub semantic: bool,
}

/// Extracted fields from one `mem_items` row. We keep the
/// crate-internal representation small and normalised so the
/// formatters never touch raw rows directly.
#[derive(Clone, Debug)]
pub struct MemoryHit {
  pub id: String,
  pub title: String,
  pub snippet: String,
  pub source: String,
  pub provenance: String,
}

fn derive_provenance(source: &str) -> &'static str {
  match source {
    "capture_sampler" | "capture_ax" | "capture" => "screen",
    "gmail" | "google_calendar" => "connector",
    s if s.starts_with("meetings") || s == "meeting" => "meeting",
    _ => "user",
  }
}

fn hit_from_value(v: &Value) -> Option<MemoryHit> {
  let id = v.get("id").and_then(|x| x.as_str())?.to_string();
  let title = v
    .get("title")
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .to_string();
  let snippet = v
    .get("snippet")
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .to_string();
  let source = v
    .get("source")
    .and_then(|x| x.as_str())
    .unwrap_or("user")
    .to_string();
  let provenance = v
    .get("provenance")
    .and_then(|x| x.as_str())
    .map(str::to_string)
    .unwrap_or_else(|| derive_provenance(&source).to_string());
  Some(MemoryHit {
    id,
    title,
    snippet,
    source,
    provenance,
  })
}

/// Run the canonical memory lookup for a given intent. Semantic
/// rerank is delegated to [`memory_store::search_with_semantics`] when
/// `semantic` is true and a query is present; otherwise lexical only.
pub async fn assemble_memory_hits(p: AssembleParams<'_>) -> Result<Vec<MemoryHit>, String> {
  let payload = json!({
    "query": p.query,
    "limit": p.limit,
    "semantic": p.semantic,
  });
  let resp = if p.semantic && !p.query.trim().is_empty() {
    memory_store::search_with_semantics(&payload).await?
  } else {
    memory_store::search(&payload)?
  };
  let hits = resp
    .get("hits")
    .and_then(|v| v.as_array())
    .cloned()
    .unwrap_or_default();
  Ok(hits.iter().filter_map(hit_from_value).collect())
}

fn truncate_to_chars(s: &str, max_chars: usize) -> String {
  s.chars().take(max_chars).collect()
}

fn push_capped(out: &mut String, segment: &str, max_chars: usize) -> bool {
  if max_chars == 0 {
    return false;
  }
  let current = out.chars().count();
  if current >= max_chars {
    return false;
  }
  let remaining = max_chars.saturating_sub(current);
  out.push_str(&truncate_to_chars(segment, remaining));
  true
}

/// Bullet block for draft / chat context: one hit per line with
/// `[provenance] title — snippet`. Cut off at `max_chars` total.
pub fn format_hits_draft_context(hits: &[MemoryHit], max_chars: usize) -> String {
  let mut out = String::new();
  for h in hits {
    let line = format!(
      "- [{}] {} — {}\n",
      h.provenance,
      h.title,
      truncate_to_chars(&h.snippet, 240),
    );
    if !push_capped(&mut out, &line, max_chars) {
      break;
    }
  }
  out.trim_end().to_string()
}

/// JSON-prompt flavour: the LLM will be asked to emit
/// `{sections: [{title, body}]}`, so we feed one `TITLE\nBODY` block
/// per memory and let the composer group them. Provenance is omitted
/// here because the brief composer already tags the output source.
pub fn format_hits_brief_json_prompt(hits: &[MemoryHit], max_chars: usize) -> String {
  let mut out = String::new();
  for h in hits {
    let title = if h.title.is_empty() { "(untitled)" } else { h.title.as_str() };
    let block = format!(
      "TITLE: {}\nBODY: {}\n\n",
      title,
      truncate_to_chars(&h.snippet, 600),
    );
    if !push_capped(&mut out, &block, max_chars) {
      break;
    }
  }
  out.trim_end().to_string()
}

/// Compact reply-drafting format: `- title [source]` with the top
/// of the snippet attached. No per-call cap — the reply prompt is
/// short and the hit list is already limited upstream.
pub fn format_hits_reply_draft(hits: &[MemoryHit]) -> String {
  let mut out = String::new();
  for h in hits.iter().take(12) {
    let title = if h.title.is_empty() { "(untitled)" } else { h.title.as_str() };
    out.push_str(&format!(
      "- {} [{}]\n  {}\n",
      title,
      h.source,
      truncate_to_chars(&h.snippet, 180),
    ));
  }
  out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn hit(id: &str, title: &str, snippet: &str, source: &str) -> MemoryHit {
    MemoryHit {
      id: id.into(),
      title: title.into(),
      snippet: snippet.into(),
      source: source.into(),
      provenance: derive_provenance(source).into(),
    }
  }

  #[test]
  fn derives_provenance_for_known_sources() {
    assert_eq!(derive_provenance("capture_sampler"), "screen");
    assert_eq!(derive_provenance("capture_ax"), "screen");
    assert_eq!(derive_provenance("gmail"), "connector");
    assert_eq!(derive_provenance("google_calendar"), "connector");
    assert_eq!(derive_provenance("meetings_granola"), "meeting");
    assert_eq!(derive_provenance("meeting"), "meeting");
    assert_eq!(derive_provenance("custom_thing"), "user");
  }

  #[test]
  fn hit_from_value_reads_explicit_provenance_when_present() {
    let v = json!({
      "id": "m_1",
      "title": "T",
      "snippet": "S",
      "source": "user",
      "provenance": "meeting",
    });
    let h = hit_from_value(&v).unwrap();
    assert_eq!(h.provenance, "meeting");
  }

  #[test]
  fn hit_from_value_falls_back_to_derived_provenance() {
    let v = json!({ "id": "m_1", "title": "T", "snippet": "S", "source": "gmail" });
    let h = hit_from_value(&v).unwrap();
    assert_eq!(h.provenance, "connector");
  }

  #[test]
  fn format_draft_context_respects_total_cap() {
    let hits = (0..10)
      .map(|i| {
        hit(
          &format!("m_{i}"),
          &format!("t{i}"),
          "snippet body goes here",
          "user",
        )
      })
      .collect::<Vec<_>>();
    let out = format_hits_draft_context(&hits, 50);
    assert!(out.chars().count() <= 50, "out was {} chars", out.chars().count());
  }

  #[test]
  fn format_brief_prompt_emits_title_body_blocks() {
    let hits = vec![hit("m_1", "first", "body", "user")];
    let out = format_hits_brief_json_prompt(&hits, 1000);
    assert!(out.contains("TITLE: first"));
    assert!(out.contains("BODY: body"));
  }

  #[test]
  fn format_reply_draft_truncates_per_snippet_not_total() {
    let long = "x".repeat(1000);
    let hits = vec![hit("m_1", "t", &long, "user")];
    let out = format_hits_reply_draft(&hits);
    // Per-snippet cap is 180 chars; title line adds overhead.
    assert!(out.chars().count() < 300, "out was {} chars", out.chars().count());
  }

  #[test]
  fn empty_title_substitutes_untitled() {
    let hits = vec![hit("m_1", "", "body", "user")];
    let out = format_hits_brief_json_prompt(&hits, 1000);
    assert!(out.contains("(untitled)"));
  }

  #[test]
  fn max_chars_zero_returns_empty() {
    let hits = vec![hit("m_1", "t", "body", "user")];
    assert!(format_hits_draft_context(&hits, 0).is_empty());
    assert!(format_hits_brief_json_prompt(&hits, 0).is_empty());
  }
}
