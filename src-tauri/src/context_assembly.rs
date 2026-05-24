//! Shared memory-hit assembly / formatting for LLM prompt construction.
//!
//! Single entry point for callers that need local memory as context for a
//! chat / draft / brief / pack. Call sites: `llm::brief_generate`,
//! `llm::draft_reply_for_brief`, `llm::draft_from_payload`, `llm::chat_complete`
//! (when `memoryAssembly` is provided), `brief_actions::open_pack`, and the
//! `meeting_recipes` builtins that surface related memory (`FollowUpEmail`,
//! `FeatureDigest`, `PrdDraft`).
//!
//! Spec: `docs/context-layer-phase-0-1.md` §2.

use crate::memory_store;
use serde_json::{json, Value};

/// Character budget for the chat / brief system-prompt memory block. Large
/// because the model has most of the conversation budget to play with and
/// benefits from a wide candidate set. Shared by `chat_complete` and
/// `brief_generate`.
pub const SYSTEM_PROMPT_BUDGET_CHARS: usize = 10_000;

/// Character budget for in-prompt memory blocks on direct drafts and the
/// narrower meeting recipes (`FollowUpEmail`, `PrdDraft`). Smaller than the
/// system-prompt budget because drafts focus on a specific outcome and the
/// LLM's output slot competes for tokens with the memory block.
pub const DRAFT_PROMPT_BUDGET_CHARS: usize = 6_000;

/// Slightly larger budget for `FeatureDigest` meeting recipe — digests
/// summarize across many topics, so a wider memory window helps catch the
/// full feature surface.
pub const MEETING_DIGEST_BUDGET_CHARS: usize = 8_000;

/// Parameters for `assemble_memory_hits`. `query` borrows from the caller to
/// avoid an allocation for literals like `""`.
pub struct AssembleParams<'a> {
  pub query: &'a str,
  pub limit: u64,
  pub semantic: bool,
  /// Optional post-retrieval filter. Hits whose `provenance` matches any of
  /// the listed values are dropped before formatting. Empty / `None` means
  /// "no filter". Used by `brief_generate` / `draft_reply_for_brief` /
  /// `open_pack` to keep raw screen captures out of LLM context regardless
  /// of which retrieval path produced the hits.
  pub excluded_provenances: Option<Vec<String>>,
}

impl<'a> AssembleParams<'a> {
  /// Convenience: caller-side default with no filter.
  pub fn new(query: &'a str, limit: u64, semantic: bool) -> Self {
    Self {
      query,
      limit,
      semantic,
      excluded_provenances: None,
    }
  }
}

/// Drop hits whose `provenance` appears in `excluded`. `None` / empty list
/// returns the input unchanged. Pure helper; lives at module scope so callers
/// other than `assemble_memory_hits` (e.g. tests, future ad-hoc filters) can
/// reuse it.
pub fn apply_provenance_filter(hits: Vec<Hit>, excluded: Option<&[String]>) -> Vec<Hit> {
  let Some(list) = excluded else {
    return hits;
  };
  if list.is_empty() {
    return hits;
  }
  hits
    .into_iter()
    .filter(|h| !list.iter().any(|x| x == &h.provenance))
    .collect()
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
    .unwrap_or_else(|| memory_store::derive_provenance(&source).to_string());
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

/// Read `settings.sections.kioku_graph.read_path`. Returns `"graph"` when the
/// graph-traversal path is selected, anything else (including absent) ⇒
/// `"legacy"`. Pure helper.
pub fn read_path_mode(settings: &Value) -> &'static str {
  let v = settings
    .pointer("/sections/kioku_graph/read_path")
    .and_then(|x| x.as_str())
    .unwrap_or("legacy");
  if v.eq_ignore_ascii_case("graph") {
    "graph"
  } else {
    "legacy"
  }
}

/// Default node kinds eligible for retrieval on the graph path. Excludes
/// `capture_summary` so screen-derived summaries don't reach LLM context.
pub const RETRIEVAL_ALLOWED_NODE_KINDS: &[&str] =
  &["entity", "event", "decision", "task", "note"];

/// Default depth budget for `assemble_via_graph` traversals. Per
/// `target-design.md` §4.1; chat-grade retrieval can override at the call site.
pub const DEFAULT_GRAPH_DEPTH: u32 = 3;

/// Single-path memory retrieval. Branches on the
/// `settings.sections.kioku_graph.read_path` flag — `"graph"` walks the
/// KIOKU graph, anything else falls back to the legacy
/// `memory_store::search_with_semantics` path that brief-generate has been
/// using since Phase 1. The flag is OFF by default so freshly upgraded users
/// see no behavior change until they (or a settings migration) opt in.
pub async fn assemble_memory_hits(
  params: AssembleParams<'_>,
) -> Result<Vec<Hit>, String> {
  let start = std::time::Instant::now();
  let settings = crate::settings_store::load().unwrap_or_else(|_| json!({}));
  let mode = read_path_mode(&settings);
  crate::memory_obs::emit(
    "assemble_hits_begin",
    &[
      ("query_len", params.query.chars().count().to_string()),
      ("limit", params.limit.to_string()),
      ("semantic", params.semantic.to_string()),
      ("mode", mode.to_string()),
    ],
  );

  let raw = if mode == "graph" {
    match assemble_via_graph(&params).await {
      Ok(h) => h,
      Err(e) => {
        // Graph path failure shouldn't black-hole retrieval. Fall back to the
        // legacy path so chat / brief stay alive while we collect the error.
        crate::memory_obs::emit(
          "assemble_hits_graph_fallback",
          &[("error", crate::memory_obs::clip_preview(&e))],
        );
        assemble_via_legacy(&params).await?
      }
    }
  } else {
    assemble_via_legacy(&params).await?
  };

  // Apply caller-supplied provenance filter to both paths so screen-only
  // exclusion (brief / reply / pack) takes effect regardless of read_path.
  let raw_count = raw.len();
  let hits = apply_provenance_filter(raw, params.excluded_provenances.as_deref());
  if hits.len() != raw_count {
    crate::memory_obs::emit(
      "assemble_hits_filtered",
      &[
        ("dropped", (raw_count - hits.len()).to_string()),
        ("kept", hits.len().to_string()),
      ],
    );
  }

  let elapsed_ms = start.elapsed().as_millis() as u64;
  let (screen, connector, meeting, user) = provenance_counts(&hits);
  crate::memory_obs::emit(
    "assemble_hits_done",
    &[
      ("hits", hits.len().to_string()),
      ("elapsed_ms", elapsed_ms.to_string()),
      ("screen", screen.to_string()),
      ("connector", connector.to_string()),
      ("meeting", meeting.to_string()),
      ("user", user.to_string()),
      ("mode", mode.to_string()),
    ],
  );
  Ok(hits)
}

/// Legacy retrieval path — extracted so the new flag-gated path can fall back
/// to it on error without duplicating the FTS / semantic logic.
async fn assemble_via_legacy(params: &AssembleParams<'_>) -> Result<Vec<Hit>, String> {
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

/// Graph-based retrieval (Layer 3 entry → Layer 2 traversal → ranker).
/// Excludes `capture_summary` nodes so raw a11y / screen summaries can't
/// surface in chat context. Falls back to recent-by-decay when no embedding
/// is available (key not configured, query empty). On success, bumps
/// access_count / last_accessed_at / decay_score for every returned hit
/// (Phase 2 Stage 3 §5).
pub async fn assemble_via_graph(params: &AssembleParams<'_>) -> Result<Vec<Hit>, String> {
  use crate::kioku_graph_traversal::{
    bump_access_for_hits, fetch_decay_scores, filter_node_ids_by_kind, pick_entry_nodes,
    rank_subgraph_hits, traverse_subgraph, DEFAULT_EDGE_TYPES,
  };
  use std::collections::HashMap;

  let mut conn = memory_store::open_conn()?;
  let limit = params.limit.clamp(1, 100) as usize;
  let entry_limit = limit.max(5);

  // Step 1 (Layer 3): pick entry nodes via vector similarity. Empty query or
  // missing key falls back to "recent active nodes" — decay-ordered.
  let mut entries = Vec::new();
  let mut similarity_lookup: HashMap<String, f64> = HashMap::new();
  if !params.query.trim().is_empty() {
    if let Ok(qvec) = crate::embeddings::embed_one(params.query).await {
      entries = pick_entry_nodes(&conn, &qvec, entry_limit)?;
      for e in &entries {
        similarity_lookup.insert(e.id.clone(), e.similarity);
      }
    }
  }
  if entries.is_empty() {
    // No embedding signal — seed with the most recently-accessed valid nodes.
    let fallback = recent_active_nodes(&conn, entry_limit)?;
    for id in &fallback {
      similarity_lookup.insert(id.clone(), 1.0);
    }
    entries = fallback
      .into_iter()
      .map(|id| crate::kioku_graph_traversal::EntryNode {
        id,
        similarity: 1.0,
        decay_score: 0.0,
      })
      .collect();
  }

  let entry_ids: Vec<String> = entries.iter().map(|e| e.id.clone()).collect();
  if entry_ids.is_empty() {
    return Ok(Vec::new());
  }

  // Step 2 (Layer 2): traverse from those entries.
  let visited = traverse_subgraph(&conn, &entry_ids, DEFAULT_GRAPH_DEPTH, DEFAULT_EDGE_TYPES)?;

  // Step 3: filter to retrieval-allowed node_kinds (drops capture_summary).
  let visited_ids: Vec<String> = visited.iter().map(|n| n.id.clone()).collect();
  let allowed = filter_node_ids_by_kind(&conn, &visited_ids, RETRIEVAL_ALLOWED_NODE_KINDS)?;
  let kept: Vec<_> = visited.into_iter().filter(|n| allowed.contains(&n.id)).collect();
  if kept.is_empty() {
    return Ok(Vec::new());
  }

  let kept_ids: Vec<String> = kept.iter().map(|n| n.id.clone()).collect();
  let decay_lookup = fetch_decay_scores(&conn, &kept_ids)?;
  let ranked = rank_subgraph_hits(&kept, &decay_lookup, &similarity_lookup);

  // Step 4: hydrate top-N rows back to Hit shape.
  let top_ids: Vec<String> = ranked.into_iter().take(limit).map(|r| r.id).collect();
  if top_ids.is_empty() {
    return Ok(Vec::new());
  }
  let placeholders = (0..top_ids.len())
    .map(|_| "?".to_string())
    .collect::<Vec<_>>()
    .join(",");
  let sql = format!(
    "SELECT id, title, snippet, source, provenance, created_at
     FROM mem_items WHERE id IN ({})",
    placeholders
  );
  // Scoped statement so the immutable borrow of `conn` is released before
  // `bump_access_for_hits` takes it mutably below.
  let mut by_id: std::collections::HashMap<String, Hit> = std::collections::HashMap::new();
  {
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for id in &top_ids {
      params_vec.push(Box::new(id.clone()));
    }
    let rows = stmt
      .query_map(
        rusqlite::params_from_iter(params_vec.iter().map(|p| p.as_ref())),
        |r| {
          let id: String = r.get(0)?;
          let title: String = r.get(1)?;
          let snippet: String = r.get(2)?;
          let source: String = r.get(3)?;
          let prov_opt: Option<String> = r.get(4)?;
          let created_at: i64 = r.get(5)?;
          let provenance =
            prov_opt.unwrap_or_else(|| memory_store::derive_provenance(&source).to_string());
          Ok(Hit {
            id,
            title,
            snippet,
            source,
            provenance,
            created_at: created_at.max(0) as u64,
          })
        },
      )
      .map_err(|e| e.to_string())?;
    for row in rows {
      let h = row.map_err(|e| e.to_string())?;
      by_id.insert(h.id.clone(), h);
    }
  }
  // Preserve ranker order.
  let out: Vec<Hit> = top_ids
    .into_iter()
    .filter_map(|id| by_id.remove(&id))
    .collect();

  // On-access decay update for every node that survived to the final list.
  let now_ms = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0);
  let bump_ids: Vec<String> = out.iter().map(|h| h.id.clone()).collect();
  if let Err(e) = bump_access_for_hits(&mut conn, &bump_ids, now_ms) {
    crate::memory_obs::emit(
      "assemble_hits_bump_failed",
      &[("error", crate::memory_obs::clip_preview(&e))],
    );
  }

  Ok(out)
}

/// Fallback entry: pull recent valid nodes ordered by decay then last-access.
/// Used by `assemble_via_graph` when no embedding signal is available.
fn recent_active_nodes(
  conn: &rusqlite::Connection,
  limit: usize,
) -> Result<Vec<String>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT id FROM mem_items
       WHERE valid_to IS NULL
         AND (node_kind IS NULL OR node_kind != 'capture_summary')
       ORDER BY COALESCE(decay_score, 0.0) DESC, COALESCE(last_accessed_at, created_at) DESC
       LIMIT ?1",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(rusqlite::params![limit as i64], |r| r.get::<_, String>(0))
    .map_err(|e| e.to_string())?;
  Ok(rows.filter_map(|x| x.ok()).collect())
}

fn provenance_counts(hits: &[Hit]) -> (u32, u32, u32, u32) {
  let mut screen = 0u32;
  let mut connector = 0u32;
  let mut meeting = 0u32;
  let mut user = 0u32;
  for h in hits {
    match h.provenance.as_str() {
      "screen" => screen += 1,
      "connector" => connector += 1,
      "meeting" => meeting += 1,
      _ => user += 1,
    }
  }
  (screen, connector, meeting, user)
}

fn clip_chars(s: &str, max_chars: usize) -> String {
  s.chars().take(max_chars).collect()
}

fn collapse_ws(s: &str) -> String {
  s.replace('\n', " ").replace('\r', " ")
}

/// JSON array for IPC responses (Chat assembly preview).
pub fn hits_to_json(hits: &[Hit]) -> Value {
  let rows: Vec<Value> = hits
    .iter()
    .map(|h| {
      json!({
        "id": h.id,
        "title": h.title,
        "snippet": h.snippet,
        "source": h.source,
        "provenance": h.provenance,
        "created_at": h.created_at,
      })
    })
    .collect();
  json!(rows)
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

/// Maximum characters of a hit's snippet that flow into a pack markdown file.
/// Phase 2 Stage 3 (T8): clip raw a11y dumps so a single capture_ax row can no
/// longer leak its full content through `open_pack`.
pub const PACK_SNIPPET_CHAR_LIMIT: usize = 500;

/// Markdown section for `packs/.../memory_hits.md`. Called by
/// `brief_actions::open_pack`. Snippets longer than `PACK_SNIPPET_CHAR_LIMIT`
/// are truncated in-place with a `…` marker; the empty-state placeholder is
/// preserved.
pub fn format_hits_pack_markdown(hits: &[Hit]) -> String {
  let mut out = String::from("## Related memories (local FTS index)\n\n");
  if hits.is_empty() {
    out.push_str("_No matching memories yet — ingest calendar or captures to populate._\n\n");
    return out;
  }
  for h in hits {
    let clipped = clip_snippet_with_marker(&h.snippet, PACK_SNIPPET_CHAR_LIMIT);
    out.push_str(&format!("### {} (`{}`)\n{}\n\n", h.title, h.id, clipped));
  }
  out
}

/// Take at most `max_chars` characters of `s`. When the input is longer the
/// result ends with `"…"` so readers can tell content was truncated.
pub fn clip_snippet_with_marker(s: &str, max_chars: usize) -> String {
  let count = s.chars().count();
  if count <= max_chars {
    return s.to_string();
  }
  // Reserve one char for the trailing ellipsis marker.
  let take = max_chars.saturating_sub(1);
  let mut out: String = s.chars().take(take).collect();
  out.push('…');
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  // ── apply_provenance_filter ────────────────────────────────────────────
  fn hits_with_provenances(items: &[(&str, &str)]) -> Vec<Hit> {
    items
      .iter()
      .map(|(id, prov)| Hit {
        id: id.to_string(),
        title: "T".into(),
        snippet: "S".into(),
        source: "x".into(),
        provenance: prov.to_string(),
        created_at: 0,
      })
      .collect()
  }

  #[test]
  fn provenance_filter_none_returns_input_unchanged() {
    let hits = hits_with_provenances(&[("a", "screen"), ("b", "user")]);
    let out = apply_provenance_filter(hits.clone(), None);
    assert_eq!(out, hits);
  }

  #[test]
  fn provenance_filter_empty_list_returns_input_unchanged() {
    let hits = hits_with_provenances(&[("a", "screen"), ("b", "user")]);
    let exclude: Vec<String> = Vec::new();
    let out = apply_provenance_filter(hits.clone(), Some(&exclude));
    assert_eq!(out, hits);
  }

  #[test]
  fn provenance_filter_drops_screen_when_listed() {
    let hits = hits_with_provenances(&[
      ("a", "screen"),
      ("b", "user"),
      ("c", "connector"),
      ("d", "screen"),
    ]);
    let exclude = vec!["screen".to_string()];
    let out = apply_provenance_filter(hits, Some(&exclude));
    let ids: Vec<&str> = out.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(ids, vec!["b", "c"]);
  }

  #[test]
  fn provenance_filter_supports_multiple_excluded_values() {
    let hits = hits_with_provenances(&[
      ("a", "screen"),
      ("b", "user"),
      ("c", "connector"),
      ("d", "meeting"),
    ]);
    let exclude = vec!["screen".to_string(), "connector".to_string()];
    let out = apply_provenance_filter(hits, Some(&exclude));
    let ids: Vec<&str> = out.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(ids, vec!["b", "d"]);
  }

  #[test]
  fn assemble_params_new_defaults_no_filter() {
    let p = AssembleParams::new("q", 10, false);
    assert_eq!(p.query, "q");
    assert_eq!(p.limit, 10);
    assert!(!p.semantic);
    assert!(p.excluded_provenances.is_none());
  }

  // ── read_path_mode ─────────────────────────────────────────────────────
  #[test]
  fn read_path_mode_defaults_to_legacy() {
    assert_eq!(read_path_mode(&json!({})), "legacy");
    assert_eq!(read_path_mode(&json!({ "sections": {} })), "legacy");
  }

  #[test]
  fn read_path_mode_returns_graph_when_explicitly_set() {
    let s = json!({ "sections": { "kioku_graph": { "read_path": "graph" } } });
    assert_eq!(read_path_mode(&s), "graph");
  }

  #[test]
  fn read_path_mode_is_case_insensitive() {
    let s = json!({ "sections": { "kioku_graph": { "read_path": "GRAPH" } } });
    assert_eq!(read_path_mode(&s), "graph");
  }

  #[test]
  fn read_path_mode_rejects_unknown_string() {
    let s = json!({ "sections": { "kioku_graph": { "read_path": "neural" } } });
    assert_eq!(read_path_mode(&s), "legacy");
  }

  fn mk_hit(id: &str, title: &str, snippet: &str, source: &str) -> Hit {
    Hit {
      id: id.to_string(),
      title: title.to_string(),
      snippet: snippet.to_string(),
      source: source.to_string(),
      provenance: memory_store::derive_provenance(source).to_string(),
      created_at: 0,
    }
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
  fn format_hits_pack_markdown_clips_long_snippet_with_marker() {
    // 1,200-char synthetic AX dump — what capture_ax could legitimately
    // produce before T4 swept screen rows out of mem_items.
    let big = "x".repeat(1_200);
    let hits = vec![mk_hit("ax_long", "AX dump", &big, "capture_ax")];
    let out = format_hits_pack_markdown(&hits);
    // The body line for this hit should be exactly PACK_SNIPPET_CHAR_LIMIT
    // characters long (499 'x's + a single ellipsis) — no other framing on
    // that line per the legacy format.
    let body_line = out
      .lines()
      .find(|l| l.starts_with('x'))
      .expect("body line should start with x");
    assert_eq!(body_line.chars().count(), PACK_SNIPPET_CHAR_LIMIT);
    assert!(body_line.ends_with('…'));
  }

  #[test]
  fn format_hits_pack_markdown_short_snippet_unchanged() {
    // Snippets at or below the limit must round-trip exactly so connector
    // and meeting hits keep their full content.
    let body = "Draft sent — agreed on the staging cut window";
    assert!(body.chars().count() <= PACK_SNIPPET_CHAR_LIMIT);
    let hits = vec![mk_hit("m_1", "Kickoff", body, "user")];
    let out = format_hits_pack_markdown(&hits);
    assert!(out.contains(body));
    assert!(!out.contains('…'));
  }

  #[test]
  fn clip_snippet_with_marker_preserves_short_input() {
    assert_eq!(clip_snippet_with_marker("hello", 10), "hello");
    assert_eq!(clip_snippet_with_marker("", 10), "");
  }

  #[test]
  fn clip_snippet_with_marker_caps_long_input_with_ellipsis() {
    let out = clip_snippet_with_marker("abcdefghij", 5);
    assert_eq!(out, "abcd…");
    assert_eq!(out.chars().count(), 5);
  }

  #[test]
  fn clip_snippet_with_marker_handles_multibyte_chars() {
    // 6 Japanese characters; cap at 4 → keep 3 + ellipsis = 4 char count
    let out = clip_snippet_with_marker("あいうえおか", 4);
    assert_eq!(out.chars().count(), 4);
    assert!(out.ends_with('…'));
    // Underlying byte length must be valid UTF-8 (just sanity).
    assert!(out.is_char_boundary(out.len()));
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

  #[test]
  fn provenance_counts_tallies_by_category() {
    let hits = vec![
      mk_hit("m1", "A", "x", "google_calendar"),
      mk_hit("m2", "B", "y", "capture_ax"),
      mk_hit("m3", "C", "z", "capture_sampler"),
      mk_hit("m4", "D", "w", "meeting"),
      mk_hit("m5", "E", "v", "user_note"),
    ];
    let (screen, connector, meeting, user) = provenance_counts(&hits);
    assert_eq!(screen, 2);
    assert_eq!(connector, 1);
    assert_eq!(meeting, 1);
    assert_eq!(user, 1);
  }
}
