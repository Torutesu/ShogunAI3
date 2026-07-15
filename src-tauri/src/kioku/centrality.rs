//! KIOKU node centrality (audit F-7).
//!
//! The decay score weights centrality at `w3 = 0.3`, but no code ever wrote
//! `mem_items.centrality_score`, so 30% of the decay signal was dead weight
//! (always `COALESCE(centrality_score, 0) = 0`). This module computes a
//! degree-based centrality from the active edge set and stores the normalized
//! value.
//!
//! Gated by `settings.kioku_graph.centrality_enabled` (default **off**): the
//! decay weights were fixture-tuned before centrality was live, so turning it on
//! changes retrieval ranking and should follow a re-validation on the eval
//! fixtures. Off by default keeps behavior identical while making the signal
//! available (visible in KIOKU debug stats) and one flag away.

use rusqlite::{params, Connection};
use std::collections::HashMap;

/// Normalize a node's degree into `[0, 1]` against the busiest node. A graph
/// with no edges yields 0 for every node. Pure — unit-tested.
pub fn normalized_degree(degree: i64, max_degree: i64) -> f64 {
    if max_degree <= 0 {
        0.0
    } else {
        (degree.max(0) as f64 / max_degree as f64).clamp(0.0, 1.0)
    }
}

/// Recompute `centrality_score` for every active node from the active edge set.
/// Degree = number of active edges (`valid_to IS NULL`) touching the node in
/// either direction, normalized against the busiest node. Returns the number of
/// connected nodes scored. Idempotent.
pub fn recompute_centrality(conn: &Connection) -> Result<usize, String> {
    let degrees = active_degrees(conn)?;
    let max_degree = degrees.values().copied().max().unwrap_or(0);

    // Clear stale scores on active nodes, then set the connected ones. Isolated
    // active nodes correctly settle at 0.
    conn.execute(
        "UPDATE mem_items SET centrality_score = 0.0 WHERE valid_to IS NULL",
        [],
    )
    .map_err(|e| e.to_string())?;

    let mut scored = 0usize;
    for (node, deg) in &degrees {
        let c = normalized_degree(*deg, max_degree);
        let n = conn
            .execute(
                "UPDATE mem_items SET centrality_score = ?1 WHERE id = ?2 AND valid_to IS NULL",
                params![c, node],
            )
            .map_err(|e| e.to_string())?;
        scored += n;
    }
    Ok(scored)
}

fn active_degrees(conn: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT node, COUNT(*) AS deg FROM (
               SELECT from_node AS node FROM mem_edges WHERE valid_to IS NULL
               UNION ALL
               SELECT to_node AS node FROM mem_edges WHERE valid_to IS NULL
             ) GROUP BY node",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut degrees = HashMap::new();
    for row in rows {
        let (node, deg) = row.map_err(|e| e.to_string())?;
        degrees.insert(node, deg);
    }
    Ok(degrees)
}

/// Whether the centrality signal is enabled (default off, see module docs).
pub fn centrality_enabled() -> bool {
    crate::settings_store::load()
        .ok()
        .and_then(|d| {
            d.pointer("/sections/kioku_graph/centrality_enabled")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false)
}

/// Best-effort recompute driven by the flag. Called from the patterns batch.
pub fn recompute_centrality_if_enabled() {
    if !centrality_enabled() {
        return;
    }
    match crate::memory_store::open_conn() {
        Ok(conn) => match recompute_centrality(&conn) {
            Ok(n) => crate::memory_obs::emit("centrality_recompute_done", &[("scored", n.to_string())]),
            Err(e) => log::warn!("centrality recompute failed: {}", e),
        },
        Err(e) => log::warn!("centrality open_conn failed: {}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_degree_maps_to_unit_range() {
        assert_eq!(normalized_degree(0, 0), 0.0); // empty graph
        assert_eq!(normalized_degree(5, 0), 0.0); // no max => 0
        assert_eq!(normalized_degree(0, 4), 0.0);
        assert_eq!(normalized_degree(2, 4), 0.5);
        assert_eq!(normalized_degree(4, 4), 1.0);
        assert_eq!(normalized_degree(-3, 4), 0.0); // clamped
    }

    fn graph_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE mem_items (id TEXT PRIMARY KEY, valid_to INTEGER, centrality_score REAL);
             CREATE TABLE mem_edges (from_node TEXT, to_node TEXT, valid_to INTEGER);",
        )
        .expect("schema");
        conn
    }

    #[test]
    fn recompute_scores_hub_highest_and_isolated_zero() {
        let conn = graph_conn();
        // hub connected to a,b,c; d isolated. All active.
        for id in ["hub", "a", "b", "c", "d"] {
            conn.execute(
                "INSERT INTO mem_items (id, valid_to, centrality_score) VALUES (?1, NULL, NULL)",
                params![id],
            )
            .unwrap();
        }
        for (f, t) in [("hub", "a"), ("hub", "b"), ("hub", "c")] {
            conn.execute(
                "INSERT INTO mem_edges (from_node, to_node, valid_to) VALUES (?1, ?2, NULL)",
                params![f, t],
            )
            .unwrap();
        }
        let scored = recompute_centrality(&conn).expect("recompute");
        assert_eq!(scored, 4, "hub + a + b + c are connected");

        let get = |id: &str| -> f64 {
            conn.query_row(
                "SELECT COALESCE(centrality_score, -1) FROM mem_items WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(get("hub"), 1.0, "hub has max degree");
        assert!((get("a") - 1.0 / 3.0).abs() < 1e-9, "leaf = 1/maxdeg");
        assert_eq!(get("d"), 0.0, "isolated node scores 0");
    }

    #[test]
    fn recompute_ignores_retired_edges() {
        let conn = graph_conn();
        conn.execute(
            "INSERT INTO mem_items (id, valid_to, centrality_score) VALUES ('x', NULL, NULL), ('y', NULL, NULL)",
            [],
        )
        .unwrap();
        // Only a retired edge exists.
        conn.execute(
            "INSERT INTO mem_edges (from_node, to_node, valid_to) VALUES ('x', 'y', 123)",
            [],
        )
        .unwrap();
        let scored = recompute_centrality(&conn).expect("recompute");
        assert_eq!(scored, 0, "retired edges contribute no degree");
    }
}
