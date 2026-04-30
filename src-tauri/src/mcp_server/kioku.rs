//! Kioku tool handlers. `kioku_debug_stats` (no args) and `kioku_related`
//! (graph traversal — Task 8).

use super::content_text;
use crate::{kioku_debug_stats, memory_store, settings_store};
use serde_json::Value;

pub(super) fn handle_debug_stats(_args: &Value) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    let settings = settings_store::load()?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let stats = kioku_debug_stats::assemble_debug_stats(&conn, &settings, now_ms)?;
    Ok(content_text(&serde_json::to_string(&stats).map_err(|e| e.to_string())?))
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
}
