//! Shared memory-hit assembly / formatting for LLM prompt construction.
//!
//! Single entry point for callers that need local memory as context for a
//! chat / draft / brief / pack. Call sites: `llm::brief_generate`,
//! `llm::draft_reply_for_brief`, `llm::draft_from_payload`, `llm::chat_complete`
//! (when `memoryAssembly` is provided), and eventually
//! `brief_actions::open_pack`.
//!
//! Spec: `docs/context-layer-phase-0-1.md` §2.

use crate::memory_store;
use serde_json::{json, Value};

/// Parameters for `assemble_memory_hits`. `query` borrows from the caller to
/// avoid an allocation for literals like `""`.
pub struct AssembleParams<'a> {
  pub query: &'a str,
  pub limit: u64,
  pub semantic: bool,
}

/// Flat memory item view used by the formatters. `provenance` is read from the
/// row when present and otherwise derived from `source` per the Phase 0 table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
  pub id: String,
  pub title: String,
  pub snippet: String,
  pub source: String,
  pub provenance: String,
  pub created_at: u64,
}

/// Map `source` → `provenance` per the Phase 0 / 1 source table. Used only as a
/// fallback when the row did not carry provenance yet.
fn derive_provenance(source: &str) -> &'static str {
  match source {
    "capture_sampler" | "capture_ax" => "screen",
    "google_calendar" | "gmail" => "connector",
    s if s == "meeting" || s.starts_with("meetings") || s.starts_with("meeting_") => "meeting",
    "" => "user",
    _ => "user",
  }
}

fn hit_from_value(v: &Value) -> Option<Hit> {
  let id = v.get("id").and_then(|x| x.as_str())?.to_string();
  if id.is_empty() {
    return None;
  }
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
    .unwrap_or("")
    .to_string();
  let provenance = v
    .get("provenance")
    .and_then(|x| x.as_str())
    .map(str::to_string)
    .unwrap_or_else(|| derive_provenance(&source).to_string());
  let created_at = v
    .get("created_at")
    .and_then(|x| x.as_u64())
    .unwrap_or(0);
  Some(Hit {
    id,
    title,
    snippet,
    source,
    provenance,
    created_at,
  })
}

/// Single-path memory retrieval. Empty `query` returns recent items (via
/// `memory_store::search`). When `semantic` is true and the LLM key is set, the
/// search fans out to `search_with_semantics` which does a wider lexical fetch
/// + cosine re-rank.
pub async fn assemble_memory_hits(
  params: AssembleParams<'_>,
) -> Result<Vec<Hit>, String> {
  let payload = json!({
    "query": params.query,
    "limit": params.limit,
    "semantic": params.semantic,
  });
  let result = memory_store::search_with_semantics(&payload).await?;
  let arr = result
    .get("hits")
    .and_then(|h| h.as_array())
    .cloned()
    .unwrap_or_default();
  Ok(arr.iter().filter_map(hit_from_value).collect())
}

fn clip_chars(s: &str, max_chars: usize) -> String {
  s.chars().take(max_chars).collect()
}

fn collapse_ws(s: &str) -> String {
  s.replace('\n', " ").replace('\r', " ")
}

/// System-message block for `chat_complete` / `draft_from_payload` when the
/// caller opted into server-side memory assembly. Each hit is one bulletted
/// line tagged with its provenance; the whole block is clipped to
/// `max_chars` characters.
pub fn format_hits_draft_context(hits: &[Hit], max_chars: usize) -> String {
  let mut out = String::new();
  let mut used = 0usize;
  for h in hits {
    let snippet = clip_chars(&collapse_ws(h.snippet.trim()), 400);
    let line = format!("- [{}] {} — {}\n", h.provenance, h.title, snippet);
    let line_chars = line.chars().count();
    if used + line_chars > max_chars {
      break;
    }
    out.push_str(&line);
    used += line_chars;
  }
  out
}

/// Numbered list used inside the `brief_generate` JSON-only user prompt.
/// Kept compact so the model still has budget for the JSON output.
pub fn format_hits_brief_json_prompt(hits: &[Hit], max_chars: usize) -> String {
  let mut out = String::new();
  let mut used = 0usize;
  for (i, h) in hits.iter().enumerate() {
    let snippet = clip_chars(&collapse_ws(h.snippet.trim()), 300);
    let line = format!("{}. ({}) {} — {}\n", i + 1, h.provenance, h.title, snippet);
    let line_chars = line.chars().count();
    if used + line_chars > max_chars {
      break;
    }
    out.push_str(&line);
    used += line_chars;
  }
  out
}

/// Reply-draft memory block. Bolds the title and keeps snippet short so the
/// drafting model focuses on the brief item rather than paraphrasing memory.
pub fn format_hits_reply_draft(hits: &[Hit]) -> String {
  let mut out = String::new();
  for h in hits {
    let snippet = clip_chars(&collapse_ws(h.snippet.trim()), 200);
    out.push_str(&format!("- **{}** — {}\n", h.title, snippet));
  }
  out
}

/// Markdown section for `packs/.../memory_hits.md`. Called by
/// `brief_actions::open_pack`; keeps byte-for-byte parity with the original
/// inline generator (including the empty-state placeholder) so existing packs
/// stay identical on disk.
pub fn format_hits_pack_markdown(hits: &[Hit]) -> String {
  let mut out = String::from("## Related memories (local FTS index)\n\n");
  if hits.is_empty() {
    out.push_str("_No matching memories yet — ingest calendar or captures to populate._\n\n");
    return out;
  }
  for h in hits {
    out.push_str(&format!("### {} (`{}`)\n{}\n\n", h.title, h.id, h.snippet));
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  fn mk_hit(id: &str, title: &str, snippet: &str, source: &str) -> Hit {
    Hit {
      id: id.to_string(),
      title: title.to_string(),
      snippet: snippet.to_string(),
      source: source.to_string(),
      provenance: derive_provenance(source).to_string(),
      created_at: 0,
    }
  }

  #[test]
  fn derive_provenance_covers_spec_table() {
    assert_eq!(derive_provenance("capture_sampler"), "screen");
    assert_eq!(derive_provenance("capture_ax"), "screen");
    assert_eq!(derive_provenance("google_calendar"), "connector");
    assert_eq!(derive_provenance("gmail"), "connector");
    assert_eq!(derive_provenance("meeting"), "meeting");
    assert_eq!(derive_provenance("meetings_granola"), "meeting");
    assert_eq!(derive_provenance("meeting_zoom"), "meeting");
    assert_eq!(derive_provenance("home_attachment"), "user");
    assert_eq!(derive_provenance("capture"), "user");
    assert_eq!(derive_provenance("focus_session"), "user");
    assert_eq!(derive_provenance(""), "user");
    assert_eq!(derive_provenance("unknown_source"), "user");
  }

  #[test]
  fn hit_from_value_reads_full_row() {
    let v = json!({
      "id": "m_1",
      "title": "Title",
      "snippet": "Body",
      "source": "google_calendar",
      "created_at": 12345u64,
    });
    let h = hit_from_value(&v).unwrap();
    assert_eq!(h.id, "m_1");
    assert_eq!(h.title, "Title");
    assert_eq!(h.snippet, "Body");
    assert_eq!(h.source, "google_calendar");
    assert_eq!(h.provenance, "connector");
    assert_eq!(h.created_at, 12345);
  }

  #[test]
  fn hit_from_value_prefers_explicit_provenance() {
    // Once memory_store row_to_item exposes `provenance`, the formatter must
    // use the row value rather than deriving from `source`.
    let v = json!({
      "id": "m_2",
      "source": "capture_sampler",
      "provenance": "user",
    });
    let h = hit_from_value(&v).unwrap();
    assert_eq!(h.provenance, "user");
  }

  #[test]
  fn hit_from_value_rejects_missing_or_empty_id() {
    assert!(hit_from_value(&json!({})).is_none());
    assert!(hit_from_value(&json!({ "id": "" })).is_none());
  }

  #[test]
  fn hit_from_value_tolerates_missing_optional_fields() {
    let v = json!({ "id": "m_3" });
    let h = hit_from_value(&v).unwrap();
    assert_eq!(h.title, "");
    assert_eq!(h.snippet, "");
    assert_eq!(h.source, "");
    assert_eq!(h.provenance, "user");
    assert_eq!(h.created_at, 0);
  }

  #[test]
  fn format_hits_draft_context_emits_one_line_per_hit() {
    let hits = vec![
      mk_hit("m1", "Deploy window", "Prod cut at 19:00", "google_calendar"),
      mk_hit("m2", "AX focus", "role=AXTextField\nvalue=foo", "capture_ax"),
    ];
    let out = format_hits_draft_context(&hits, 10_000);
    assert_eq!(
      out,
      "- [connector] Deploy window — Prod cut at 19:00\n\
       - [screen] AX focus — role=AXTextField value=foo\n",
    );
  }

  #[test]
  fn format_hits_draft_context_respects_max_chars() {
    let hits = vec![
      mk_hit("m1", "First", "alpha", "user"),
      mk_hit("m2", "Second", "beta", "user"),
    ];
    let first_line_len = "- [user] First — alpha\n".chars().count();
    let out = format_hits_draft_context(&hits, first_line_len);
    // Only the first line fits; the second is dropped whole.
    assert_eq!(out, "- [user] First — alpha\n");
  }

  #[test]
  fn format_hits_draft_context_returns_empty_for_empty_hits() {
    assert_eq!(format_hits_draft_context(&[], 1000), "");
  }

  #[test]
  fn format_hits_brief_json_prompt_numbers_items() {
    let hits = vec![
      mk_hit("m1", "A", "one", "user"),
      mk_hit("m2", "B", "two", "user"),
    ];
    let out = format_hits_brief_json_prompt(&hits, 10_000);
    assert_eq!(out, "1. (user) A — one\n2. (user) B — two\n");
  }

  #[test]
  fn format_hits_reply_draft_bolds_titles() {
    let hits = vec![mk_hit(
      "m1",
      "Standup notes",
      "Shipped the exclude list",
      "user",
    )];
    let out = format_hits_reply_draft(&hits);
    assert_eq!(out, "- **Standup notes** — Shipped the exclude list\n");
  }

  #[test]
  fn format_hits_pack_markdown_matches_open_pack_legacy_format() {
    // Must stay byte-identical to the string that was previously built inline
    // in brief_actions::open_pack so existing memory_hits.md files on users'
    // machines stay consistent after the delegation refactor.
    let hits = vec![mk_hit("abc123", "Kickoff", "Draft sent", "user")];
    let out = format_hits_pack_markdown(&hits);
    assert_eq!(
      out,
      "## Related memories (local FTS index)\n\n### Kickoff (`abc123`)\nDraft sent\n\n",
    );
  }

  #[test]
  fn format_hits_pack_markdown_empty_uses_placeholder() {
    let out = format_hits_pack_markdown(&[]);
    assert_eq!(
      out,
      "## Related memories (local FTS index)\n\n_No matching memories yet — ingest calendar or captures to populate._\n\n",
    );
  }

  #[test]
  fn snippet_newlines_are_collapsed_in_single_line_formatters() {
    let hits = vec![mk_hit("m1", "Win", "line1\nline2\rline3", "user")];
    let draft = format_hits_draft_context(&hits, 10_000);
    assert!(!draft.contains('\n') || draft.ends_with('\n'));
    let brief = format_hits_brief_json_prompt(&hits, 10_000);
    assert!(!brief[..brief.len() - 1].contains('\n'));
    let reply = format_hits_reply_draft(&hits);
    assert!(!reply[..reply.len() - 1].contains('\n'));
  }

  #[test]
  fn long_snippet_is_clipped_per_formatter_budget() {
    let long = "x".repeat(1000);
    let hits = vec![mk_hit("m1", "T", &long, "user")];
    let draft = format_hits_draft_context(&hits, 10_000);
    // draft clips snippet to 400 chars.
    assert!(draft.matches('x').count() == 400);
    let brief = format_hits_brief_json_prompt(&hits, 10_000);
    assert!(brief.matches('x').count() == 300);
    let reply = format_hits_reply_draft(&hits);
    assert!(reply.matches('x').count() == 200);
  }
}
