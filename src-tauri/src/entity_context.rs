use crate::{ai_fields, context_actions, summarizer_store};
use serde_json::{json, Value};

pub(crate) fn get_entity_context(payload: &Value) -> Result<Value, String> {
    let entity_id = payload
        .get("entityId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "entityId is required".to_string())?;
    let entity_label = payload
        .get("entityLabel")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(entity_id);
    let lang = payload
        .get("lang")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("en");
    let limit = payload
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(6)
        .clamp(1, 20) as usize;

    let rollup = summarizer_store::get_cached("entity_rollup", entity_id, lang)?
        .map(|summary| summary.to_json())
        .unwrap_or(Value::Null);
    let recent_summaries = summarizer_store::get_summaries_for_entity(entity_id, lang, limit)?
        .into_iter()
        .map(|summary| summary.to_json())
        .collect::<Vec<_>>();
    let ai_fields = ai_fields::list_ai_fields(&json!({
      "ownerEntityId": entity_id,
      "limit": limit,
    }))?;
    let actions = context_actions::list_context_actions(&json!({
      "ownerEntityId": entity_id,
      "limit": limit,
    }))?;

    Ok(json!({
      "entityId": entity_id,
      "entityLabel": entity_label,
      "lang": lang,
      "rollup": rollup,
      "recentSummaries": recent_summaries,
      "aiFields": ai_fields.get("items").cloned().unwrap_or_else(|| json!([])),
      "actions": actions.get("items").cloned().unwrap_or_else(|| json!([])),
    }))
}
