//! Builtin recipes (LLM prompts over meeting transcript ± memory).

use crate::context_assembly::{
  assemble_memory_hits, format_hits_draft_context, AssembleParams, Hit,
  DRAFT_PROMPT_BUDGET_CHARS, MEETING_DIGEST_BUDGET_CHARS,
};
use crate::{llm, meeting_store};
use serde_json::{json, Value};

#[derive(Clone, Copy)]
pub enum RecipeId {
  CoachMe,
  FollowUpEmail,
  ActionItems,
  FeatureDigest,
  PrdDraft,
  DecisionLog,
}

impl RecipeId {
  fn slug(self) -> &'static str {
    match self {
      RecipeId::CoachMe => "rec-coach-me",
      RecipeId::FollowUpEmail => "rec-follow-up-email",
      RecipeId::ActionItems => "rec-action-items",
      RecipeId::FeatureDigest => "rec-feature-digest",
      RecipeId::PrdDraft => "rec-prd-draft",
      RecipeId::DecisionLog => "rec-decision-log",
    }
  }
}

fn resolve_recipe_id(raw: &str) -> Option<RecipeId> {
  match raw {
    "rec-coach-me" | "coach" | "Coach Me" => Some(RecipeId::CoachMe),
    "rec-follow-up-email" | "follow_up" => Some(RecipeId::FollowUpEmail),
    "rec-action-items" | "actions" => Some(RecipeId::ActionItems),
    "rec-feature-digest" | "features" => Some(RecipeId::FeatureDigest),
    "rec-prd-draft" | "prd" => Some(RecipeId::PrdDraft),
    "rec-decision-log" | "decisions" => Some(RecipeId::DecisionLog),
    _ => None,
  }
}

fn inline_notes(payload: &Value) -> String {
  payload
    .get("notes")
    .or_else(|| payload.get("body"))
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .to_string()
}

fn inline_transcript(payload: &Value) -> String {
  payload
    .get("transcript")
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .to_string()
}

pub async fn run_recipe(payload: &Value) -> Result<Value, String> {
  let recipe_raw = payload
    .get("recipe_id")
    .and_then(|x| x.as_str())
    .unwrap_or("");
  let rid = resolve_recipe_id(recipe_raw).ok_or_else(|| "unknown recipe_id".to_string())?;

  let meeting_id = payload
    .get("meeting_id")
    .and_then(|x| x.as_str())
    .map(|s| s.trim())
    .filter(|s| !s.is_empty());

  let (tr_text, notes_text) = if let Some(mid) = meeting_id {
    let transcript = meeting_store::list_transcript_final(mid)?;
    let tr: String = transcript
      .iter()
      .filter_map(|s| {
        let t = s.get("text").and_then(|x| x.as_str())?;
        Some(t.to_string())
      })
      .collect::<Vec<_>>()
      .join("\n");
    let notes = meeting_store::list_note_blocks(mid)?;
    let nt: String = notes
      .iter()
      .filter_map(|b| b.get("content").and_then(|x| x.as_str()))
      .collect::<Vec<_>>()
      .join("\n---\n");
    (tr, nt)
  } else {
    let tr = inline_transcript(payload);
    let nt = inline_notes(payload);
    if tr.trim().is_empty() && nt.trim().is_empty() {
      return Err("meeting_id or notes/transcript is required".to_string());
    }
    (tr, nt)
  };

  let memory_hits: Vec<Hit> = if matches!(
    rid,
    RecipeId::FollowUpEmail | RecipeId::FeatureDigest | RecipeId::PrdDraft
  ) {
    let q: String = tr_text.chars().take(120).collect();
    if q.is_empty() {
      Vec::new()
    } else {
      assemble_memory_hits(AssembleParams {
        query: &q,
        limit: 8,
        semantic: false,
        // Recipes (FollowUpEmail / FeatureDigest / PrdDraft) keep meeting +
        // user context but drop raw screen captures.
        excluded_provenances: Some(vec!["screen".to_string()]),
      })
      .await
      .unwrap_or_default()
    }
  } else {
    Vec::new()
  };

  let (system, user) = match rid {
    RecipeId::CoachMe => (
      "You are a meeting coach. Output concise Markdown.",
      format!(
        "## Transcript\n{}\n\n## Notes\n{}\n\nList: estimated talk balance hints, open questions count, filler words to reduce. Markdown bullets only.",
        tr_text.chars().take(16_000).collect::<String>(),
        notes_text.chars().take(8000).collect::<String>()
      ),
    ),
    RecipeId::FollowUpEmail => (
      "You draft professional follow-up emails. Markdown only.",
      format!(
        "## Transcript\n{}\n\n## Notes\n{}\n\n## Related memory\n{}\n\nDraft a short follow-up email (greeting, thanks, commitments, next step).",
        tr_text.chars().take(14_000).collect::<String>(),
        notes_text.chars().take(6000).collect::<String>(),
        format_hits_draft_context(&memory_hits, DRAFT_PROMPT_BUDGET_CHARS)
      ),
    ),
    RecipeId::ActionItems => (
      "Extract actionable items. Markdown checklist.",
      format!(
        "## Transcript\n{}\n\n## Notes\n{}\n\nOutput `- [ ] owner — task — due` lines only.",
        tr_text.chars().take(16_000).collect::<String>(),
        notes_text.chars().take(8000).collect::<String>()
      ),
    ),
    RecipeId::FeatureDigest => (
      "Summarize product feedback. Markdown.",
      format!(
        "## Transcript\n{}\n\n## Memory\n{}\n\nSummarize feature requests as bullets with customer pain.",
        tr_text.chars().take(14_000).collect::<String>(),
        format_hits_draft_context(&memory_hits, MEETING_DIGEST_BUDGET_CHARS)
      ),
    ),
    RecipeId::PrdDraft => (
      "You write PRD sections from evidence. Markdown.",
      format!(
        "## Transcript\n{}\n\n## Notes\n{}\n\n## Memory\n{}\n\nDraft Problem, Goals, Non-goals, Success metrics — cite transcript only.",
        tr_text.chars().take(12_000).collect::<String>(),
        notes_text.chars().take(6000).collect::<String>(),
        format_hits_draft_context(&memory_hits, DRAFT_PROMPT_BUDGET_CHARS)
      ),
    ),
    RecipeId::DecisionLog => (
      "Decision log. Markdown table or bullets.",
      format!(
        "## Transcript\n{}\n\n## Notes\n{}\n\nList decisions with owner and date if stated; mark open questions.",
        tr_text.chars().take(16_000).collect::<String>(),
        notes_text.chars().take(8000).collect::<String>()
      ),
    ),
  };

  let wrapped = json!({
    "messages": [
      { "role": "system", "content": system },
      { "role": "user", "content": user }
    ]
  });
  let out = llm::chat_complete(&wrapped, None).await?;
  let text = out
    .get("message")
    .and_then(|m| m.as_str())
    .unwrap_or("")
    .to_string();
  Ok(json!({
    "recipe_id": rid.slug(),
    "meeting_id": meeting_id.unwrap_or(""),
    "text": text,
    "stub": false,
    "echo": payload,
  }))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn assert_resolves_to(raw: &str, expected_slug: &str) {
    let id = resolve_recipe_id(raw)
      .unwrap_or_else(|| panic!("expected resolve for {raw:?}"));
    assert_eq!(id.slug(), expected_slug, "raw={raw:?}");
  }

  #[test]
  fn canonical_ids_resolve_to_themselves() {
    assert_resolves_to("rec-coach-me", "rec-coach-me");
    assert_resolves_to("rec-follow-up-email", "rec-follow-up-email");
    assert_resolves_to("rec-action-items", "rec-action-items");
    assert_resolves_to("rec-feature-digest", "rec-feature-digest");
    assert_resolves_to("rec-prd-draft", "rec-prd-draft");
    assert_resolves_to("rec-decision-log", "rec-decision-log");
  }

  #[test]
  fn aliases_resolve_to_canonical_slugs() {
    assert_resolves_to("coach", "rec-coach-me");
    assert_resolves_to("Coach Me", "rec-coach-me");
    assert_resolves_to("follow_up", "rec-follow-up-email");
    assert_resolves_to("actions", "rec-action-items");
    assert_resolves_to("features", "rec-feature-digest");
    assert_resolves_to("prd", "rec-prd-draft");
    assert_resolves_to("decisions", "rec-decision-log");
  }

  #[test]
  fn unknown_id_returns_none() {
    assert!(resolve_recipe_id("rec-nonexistent").is_none());
    assert!(resolve_recipe_id("not-a-recipe").is_none());
  }

  #[test]
  fn empty_string_returns_none() {
    assert!(resolve_recipe_id("").is_none());
  }
}
