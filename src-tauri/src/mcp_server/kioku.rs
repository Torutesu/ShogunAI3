//! Kioku tool handlers. `kioku_debug_stats` (no args) and `kioku_related`
//! (graph traversal — Task 8).

use super::content_text;
use crate::{kioku_debug_stats, kioku_edge_types, kioku_graph_traversal, memory_store, settings_store};
use serde_json::{json, Value};
use std::collections::HashMap;

pub(super) fn handle_debug_stats(_args: &Value) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    let settings = settings_store::load()?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let stats = kioku_debug_stats::assemble_debug_stats(&conn, &settings, now_ms)?;
    Ok(content_text(&serde_json::to_string(&stats).map_err(|e| e.to_string())?))
}

pub(super) fn handle_related(args: &Value) -> Result<Value, String> {
    // Extract args.
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let seed_ids: Vec<String> = args
        .get("seed_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if query.is_none() && seed_ids.is_empty() {
        return Err("either query or seed_ids is required".to_string());
    }
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(10);
    let max_depth_raw = args
        .get("max_depth")
        .and_then(|v| v.as_u64())
        .unwrap_or(2);
    let max_depth = max_depth_raw.clamp(1, 3) as u32;
    let kinds_owned: Vec<String> = args
        .get("kinds")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let conn = memory_store::open_conn()?;

    // Resolve entry node IDs.
    let entry_ids: Vec<String> = if !seed_ids.is_empty() {
        seed_ids
    } else {
        // Lexical-search-as-entry-pick (sync; avoids the embedding requirement
        // of `kioku_graph_traversal::pick_entry_nodes`).
        let q = query.expect("checked above");
        let search_args = json!({"query": q, "limit": 5});
        let search_result = memory_store::search(&search_args)?;
        search_result
            .get("hits")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|h| h.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };

    if entry_ids.is_empty() {
        return Ok(content_text(&serde_json::to_string(&json!({"hits": []})).map_err(|e| e.to_string())?));
    }

    // Traverse.
    let nodes = kioku_graph_traversal::traverse_subgraph(
        &conn,
        &entry_ids,
        max_depth,
        kioku_edge_types::CANONICAL_EDGE_TYPES,
    )?;

    // Optional kind filter (returns a HashSet — reduce nodes to those whose
    // ids appear in the allowed set).
    let nodes = if !kinds_owned.is_empty() {
        let kinds_ref: Vec<&str> = kinds_owned.iter().map(String::as_str).collect();
        let node_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
        let allowed = kioku_graph_traversal::filter_node_ids_by_kind(&conn, &node_ids, &kinds_ref)?;
        nodes
            .into_iter()
            .filter(|n| allowed.contains(&n.id))
            .collect()
    } else {
        nodes
    };

    if nodes.is_empty() {
        return Ok(content_text(&serde_json::to_string(&json!({"hits": []})).map_err(|e| e.to_string())?));
    }

    // Decay lookup for ranking. Similarity is empty (we don't compute
    // embeddings synchronously); the ranker uses RANKER_FLOOR for both
    // missing similarity and missing decay.
    let node_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let decay_lookup = kioku_graph_traversal::fetch_decay_scores(&conn, &node_ids)?;
    let similarity_lookup: HashMap<String, f64> = HashMap::new();
    let ranked = kioku_graph_traversal::rank_subgraph_hits(&nodes, &decay_lookup, &similarity_lookup);

    // Take top N.
    let top_ids: Vec<String> = ranked.iter().take(limit).map(|r| r.id.clone()).collect();
    if top_ids.is_empty() {
        return Ok(content_text(&serde_json::to_string(&json!({"hits": []})).map_err(|e| e.to_string())?));
    }

    // Inline bodies. memory_store::fetch takes a payload {"ids": [...]}.
    let fetch_args = json!({"ids": top_ids});
    let fetch_result = memory_store::fetch(&fetch_args)?;
    let items = fetch_result
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Index ranked-hit metadata by id so we can zip score + depth onto items.
    let meta: HashMap<String, (f64, u32)> = ranked
        .iter()
        .take(limit)
        .map(|r| (r.id.clone(), (r.score, r.depth)))
        .collect();
    let hits: Vec<Value> = items
        .into_iter()
        .map(|mut item| {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                if let Some((score, depth)) = meta.get(&id) {
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert("score".to_string(), json!(*score));
                        obj.insert("depth".to_string(), json!(*depth));
                    }
                }
            }
            item
        })
        .collect();

    Ok(content_text(&serde_json::to_string(&json!({"hits": hits})).map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::super::dispatch;
    use serde_json::json;

    #[test]
    fn kioku_debug_stats_dispatch_routes_to_handler() {
        // We don't call the handler (it would touch the prod DB).
        // Just confirm the tool name is routed and not an "unknown tool" error.
        let result = dispatch("shogun.kioku_debug_stats", &json!({}));
        // Two acceptable outcomes:
        //   Ok(_)  → the handler ran end-to-end (DB available, settings loaded).
        //   Err(e) → an error came from the handler itself, NOT from dispatch.
        // The forbidden outcome is `Err("unknown tool: …")`.
        if let Err(e) = result {
            assert!(
                !e.starts_with("unknown tool"),
                "dispatch must route shogun.kioku_debug_stats; got: {e}"
            );
        }
    }

    #[test]
    fn kioku_related_requires_query_or_seed_ids() {
        let err = dispatch("shogun.kioku_related", &json!({})).unwrap_err();
        assert!(
            err.contains("query") && err.contains("seed_ids"),
            "got: {err}"
        );
    }

    #[test]
    fn kioku_related_rejects_empty_seed_ids_with_no_query() {
        let err = dispatch("shogun.kioku_related", &json!({"seed_ids": []})).unwrap_err();
        assert!(
            err.contains("query") && err.contains("seed_ids"),
            "got: {err}"
        );
    }
}
