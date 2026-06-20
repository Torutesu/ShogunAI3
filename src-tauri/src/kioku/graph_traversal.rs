//! Graph traversal for the KIOKU read path. Phase 2 Stage 3 (T7.1).
//!
//! Two-step retrieval:
//!   1. `pick_entry_nodes` — top-K cosine-similar nodes that pass the decay
//!      threshold (Layer 3 entry).
//!   2. `traverse_subgraph` — recursive CTE on `mem_edges` from those entries
//!      out to `max_depth`, restricted to permitted edge types.
//! Plus a pure ranker that combines path / decay / similarity into one score.
//!
//! Spec: `docs/memory-architecture/target-design.md` §1.3, §4.

#![allow(dead_code)]

use rusqlite::{params_from_iter, Connection};
use std::collections::{HashMap, HashSet};

/// Default decay floor for vector entry: nodes below this don't seed retrieval
/// (they may still be reached via traversal). Mirrors `decay::DECAY_THRESHOLD`.
pub const ENTRY_DECAY_FLOOR: f64 = 0.05;

/// Default depth budget for the recursive CTE. Per target-design §4.1 we
/// traverse 2–3 hops; 3 is the upper bound for chat/draft, 2 for tighter
/// brief/draft_reply paths.
pub const DEFAULT_MAX_DEPTH: u32 = 3;

/// Edge types that participate in default retrieval. Excluded edges
/// (e.g. `derives_from`, `supersedes`) connect graph machinery rather than
/// user-meaningful relations.
pub const DEFAULT_EDGE_TYPES: &[&str] = &[
    "decided_in",
    "follows_up",
    "mentions",
    "attended",
    "blocks",
    "co_occurs_with",
];

/// Layer 3 entry: a node whose embedding is closest to the query, ranked.
#[derive(Debug, Clone, PartialEq)]
pub struct EntryNode {
    pub id: String,
    pub similarity: f64,
    pub decay_score: f64,
}

/// One node visited during the recursive CTE walk.
#[derive(Debug, Clone, PartialEq)]
pub struct TraversalNode {
    pub id: String,
    pub depth: u32,
    pub path_score: f64,
}

/// Decoded blob → Vec<f32>. Mirrors `memory_store::decode_embedding_blob`
/// (kept private over there) so this module is self-contained for tests.
fn decode_blob(b: &[u8]) -> Option<Vec<f32>> {
    if b.is_empty() || b.len() % 4 != 0 {
        return None;
    }
    Some(
        b.chunks_exact(4)
            .filter_map(|c| c.try_into().ok().map(f32::from_le_bytes))
            .collect(),
    )
}

/// Cosine similarity for L2-normalized vectors. Same shape as the helper in
/// `kioku_extraction::cosine_sim`; duplicated here to avoid inter-module dep.
fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    for i in 0..a.len() {
        dot += a[i] as f64 * b[i] as f64;
    }
    dot
}

/// Choose the top-`limit` nodes by cosine similarity to `query_embedding`.
/// Filters: `valid_to IS NULL`, `decay_score >= ENTRY_DECAY_FLOOR`, embedding
/// present. NULL `decay_score` is treated as 0.0.
pub fn pick_entry_nodes(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
) -> Result<Vec<EntryNode>, String> {
    if query_embedding.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, embedding, COALESCE(decay_score, 0.0)
       FROM mem_items
       WHERE valid_to IS NULL
         AND embedding IS NOT NULL
         AND COALESCE(decay_score, 0.0) >= ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![ENTRY_DECAY_FLOOR], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut scored: Vec<EntryNode> = Vec::new();
    for row in rows {
        let (id, blob, decay) = row.map_err(|e| e.to_string())?;
        let Some(emb) = decode_blob(&blob) else {
            continue;
        };
        if emb.len() != query_embedding.len() {
            continue;
        }
        let sim = cosine(query_embedding, &emb);
        scored.push(EntryNode {
            id,
            similarity: sim,
            decay_score: decay,
        });
    }
    scored.sort_by(|a, b| {
        b.similarity
            .partial_cmp(&a.similarity)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(limit);
    Ok(scored)
}

/// Recursive CTE walking out from `entry_node_ids` along permitted edge types,
/// up to `max_depth` hops. `path_score` is the product of edge weights × the
/// decay factor for traversal-discovered (vs. seeded) nodes; entry nodes
/// score 1.0. Each node appears once with its minimum-depth (best-score)
/// occurrence kept.
pub fn traverse_subgraph(
    conn: &Connection,
    entry_node_ids: &[String],
    max_depth: u32,
    allowed_edge_types: &[&str],
) -> Result<Vec<TraversalNode>, String> {
    if entry_node_ids.is_empty() {
        return Ok(Vec::new());
    }
    let entry_placeholders = (0..entry_node_ids.len())
        .map(|_| "?".to_string())
        .collect::<Vec<_>>()
        .join(",");
    let edge_placeholders = (0..allowed_edge_types.len())
        .map(|_| "?".to_string())
        .collect::<Vec<_>>()
        .join(",");
    let edge_filter = if allowed_edge_types.is_empty() {
        "1=1".to_string()
    } else {
        format!("e.edge_type IN ({})", edge_placeholders)
    };
    let sql = format!(
        "WITH RECURSIVE walk(id, depth, path_score) AS (
       SELECT id, 0, 1.0 FROM mem_items
       WHERE id IN ({entries}) AND valid_to IS NULL
       UNION ALL
       SELECT e.to_node, w.depth + 1, w.path_score * COALESCE(e.weight, 0.7)
       FROM walk w
       JOIN mem_edges e ON e.from_node = w.id
       JOIN mem_items m ON m.id = e.to_node AND m.valid_to IS NULL
       WHERE w.depth < ?
         AND e.valid_to IS NULL
         AND {edge_filter}
     )
     SELECT id, MIN(depth) AS d, MAX(path_score) AS s
     FROM walk
     GROUP BY id",
        entries = entry_placeholders,
        edge_filter = edge_filter,
    );

    // Bind in SQL placeholder order: entry IDs first (in IN(...) of the
    // anchor), then `max_depth` (matches `w.depth < ?`), then edge types.
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for id in entry_node_ids {
        params.push(Box::new(id.clone()));
    }
    params.push(Box::new(max_depth as i64));
    for et in allowed_edge_types {
        params.push(Box::new(et.to_string()));
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(params.iter().map(|p| p.as_ref())), |r| {
            Ok(TraversalNode {
                id: r.get::<_, String>(0)?,
                depth: r.get::<_, i64>(1)? as u32,
                path_score: r.get::<_, f64>(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<TraversalNode> = rows.filter_map(|x| x.ok()).collect();
    out.sort_by(|a, b| {
        a.depth.cmp(&b.depth).then_with(|| {
            b.path_score
                .partial_cmp(&a.path_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    Ok(out)
}

/// Final ranker: combines path / decay / similarity per target-design §4.1.
/// `score = path_score * max(decay_score, 0.05) * max(similarity, 0.05)`.
/// The 0.05 floors keep good-shape entries with NULL decay or unseeded
/// similarity from collapsing to zero; tune via the const below.
pub const RANKER_FLOOR: f64 = 0.05;

#[derive(Debug, Clone, PartialEq)]
pub struct RankedHit {
    pub id: String,
    pub score: f64,
    pub depth: u32,
}

pub fn rank_subgraph_hits(
    nodes: &[TraversalNode],
    decay_lookup: &HashMap<String, f64>,
    similarity_lookup: &HashMap<String, f64>,
) -> Vec<RankedHit> {
    let mut out: Vec<RankedHit> = nodes
        .iter()
        .map(|n| {
            let decay = decay_lookup
                .get(&n.id)
                .copied()
                .unwrap_or(0.0)
                .max(RANKER_FLOOR);
            let sim = similarity_lookup
                .get(&n.id)
                .copied()
                .unwrap_or(0.0)
                .max(RANKER_FLOOR);
            RankedHit {
                id: n.id.clone(),
                score: n.path_score * decay * sim,
                depth: n.depth,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// Look up `decay_score` for a batch of node ids in one query. Used by
/// `assemble_via_graph` to feed the ranker without N round-trips.
pub fn fetch_decay_scores(
    conn: &Connection,
    ids: &[String],
) -> Result<HashMap<String, f64>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = (0..ids.len())
        .map(|_| "?".to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, COALESCE(decay_score, 0.0) FROM mem_items WHERE id IN ({})",
        placeholders
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for id in ids {
        params.push(Box::new(id.clone()));
    }
    let rows = stmt
        .query_map(params_from_iter(params.iter().map(|p| p.as_ref())), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, d) = row.map_err(|e| e.to_string())?;
        out.insert(id, d);
    }
    Ok(out)
}

/// On-access decay update. For each hit id, bump `access_count`, update
/// `last_accessed_at`, and recompute `decay_score` per `decay::decay_score`
/// with recency = 1.0 (just touched). Wraps the work in a transaction so
/// either all rows are updated or none. Returns the number of rows updated.
pub fn bump_access_for_hits(
    conn: &mut Connection,
    hit_ids: &[String],
    now_ms: i64,
) -> Result<usize, String> {
    if hit_ids.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut updated = 0usize;
    for id in hit_ids {
        // Pull current scoring inputs.
        let row: Option<(i64, Option<f64>, Option<f64>)> = tx
            .query_row(
                "SELECT access_count, COALESCE(centrality_score, 0.0), confidence
         FROM mem_items WHERE id = ?1 AND valid_to IS NULL",
                rusqlite::params![id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<f64>>(1)?,
                        r.get::<_, Option<f64>>(2)?,
                    ))
                },
            )
            .ok();
        let Some((access_count, centrality_opt, confidence_opt)) = row else {
            continue;
        };
        let new_access = access_count + 1;
        let access_term =
            crate::decay::access_boost(new_access, crate::decay::DECAY_ACCESS_COUNT_CAP);
        let centrality_term = crate::decay::clamp01(centrality_opt.unwrap_or(0.0));
        let confidence_term = crate::decay::confidence_term(confidence_opt);
        let new_decay = crate::decay::decay_score(
            1.0, // recency = 1.0 because we're touching it right now
            access_term,
            centrality_term,
            confidence_term,
            crate::decay::DECAY_W1 as f64,
            crate::decay::DECAY_W2 as f64,
            crate::decay::DECAY_W3 as f64,
            crate::decay::DECAY_W4 as f64,
        );
        let n = tx
            .execute(
                "UPDATE mem_items
         SET access_count = ?1,
             last_accessed_at = ?2,
             decay_score = ?3
         WHERE id = ?4",
                rusqlite::params![new_access, now_ms, new_decay, id],
            )
            .map_err(|e| e.to_string())?;
        updated += n;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(updated)
}

/// Filter helper: collect node ids from `nodes` whose `node_kind` matches the
/// allowed set. Useful for retrieval filters that exclude `capture_summary`
/// (target-design §4 `WHERE node_kind != 'capture_summary'`).
pub fn filter_node_ids_by_kind(
    conn: &Connection,
    ids: &[String],
    allowed_kinds: &[&str],
) -> Result<HashSet<String>, String> {
    if ids.is_empty() || allowed_kinds.is_empty() {
        return Ok(HashSet::new());
    }
    let id_placeholders = (0..ids.len())
        .map(|_| "?".to_string())
        .collect::<Vec<_>>()
        .join(",");
    let kind_placeholders = (0..allowed_kinds.len())
        .map(|_| "?".to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id FROM mem_items
     WHERE id IN ({}) AND COALESCE(node_kind, '') IN ({})",
        id_placeholders, kind_placeholders
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for id in ids {
        params.push(Box::new(id.clone()));
    }
    for k in allowed_kinds {
        params.push(Box::new(k.to_string()));
    }
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(params.iter().map(|p| p.as_ref())), |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn open_test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys=ON;").expect("FK");
        conn.execute_batch(
            "CREATE TABLE mem_items (
           id TEXT PRIMARY KEY NOT NULL,
           title TEXT NOT NULL,
           snippet TEXT NOT NULL,
           source TEXT NOT NULL,
           kinds_json TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           embedding BLOB,
           provenance TEXT,
           entity_id TEXT,
           confidence REAL,
           redaction TEXT
         );",
        )
        .expect("phase1");
        crate::kioku_graph_schema::ensure_kioku_graph_schema(&conn).expect("phase2");
        conn
    }

    fn encode_blob(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|f| f.to_le_bytes()).collect()
    }

    fn seed_node(
        conn: &Connection,
        id: &str,
        embedding: Option<&[f32]>,
        decay_score: f64,
        valid_to: Option<i64>,
        node_kind: &str,
    ) {
        let blob = embedding.map(encode_blob);
        conn.execute(
            "INSERT INTO mem_items
           (id, title, snippet, source, kinds_json, created_at,
            embedding, valid_from, recorded_at, last_accessed_at,
            access_count, decay_score, node_kind, valid_to)
         VALUES (?1, 'T', 'S', 'extraction', '[]', 1000,
                 ?2, 1000, 1000, 1000, 0, ?3, ?4, ?5)",
            params![id, blob, decay_score, node_kind, valid_to],
        )
        .expect("seed");
    }

    fn seed_edge(conn: &Connection, from: &str, to: &str, edge_type: &str, weight: f64) {
        conn.execute(
            "INSERT INTO mem_edges
           (from_node, to_node, edge_type, weight, valid_from, recorded_at)
         VALUES (?1, ?2, ?3, ?4, 1000, 1000)",
            params![from, to, edge_type, weight],
        )
        .expect("edge");
    }

    // ── decode_blob / cosine sanity ────────────────────────────────────────
    #[test]
    fn decode_blob_round_trips_floats() {
        let v = vec![0.1f32, -0.2, 0.7];
        let b = encode_blob(&v);
        let d = decode_blob(&b).expect("decode");
        for (a, e) in d.iter().zip(v.iter()) {
            assert!((a - e).abs() < 1e-6);
        }
    }

    #[test]
    fn cosine_aligned_unit_vectors_returns_one() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert!((cosine(&a, &b) - 1.0).abs() < 1e-9);
    }

    // ── pick_entry_nodes ───────────────────────────────────────────────────
    #[test]
    fn pick_entry_returns_empty_for_empty_query() {
        let conn = open_test_conn();
        seed_node(&conn, "m_1", Some(&[1.0, 0.0]), 0.5, None, "entity");
        let r = pick_entry_nodes(&conn, &[], 5).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn pick_entry_orders_by_cosine_similarity() {
        let conn = open_test_conn();
        seed_node(&conn, "m_a", Some(&[1.0, 0.0]), 0.6, None, "entity");
        seed_node(&conn, "m_b", Some(&[0.6, 0.8]), 0.6, None, "entity");
        seed_node(&conn, "m_c", Some(&[0.0, 1.0]), 0.6, None, "entity");
        let q = vec![1.0_f32, 0.0];
        let r = pick_entry_nodes(&conn, &q, 3).unwrap();
        assert_eq!(r[0].id, "m_a");
        assert_eq!(r[1].id, "m_b");
        assert_eq!(r[2].id, "m_c");
        // f32 round-trip: tolerance loose enough to absorb the BLOB encode/decode.
        assert!((r[0].similarity - 1.0).abs() < 1e-6);
        assert!((r[1].similarity - 0.6).abs() < 1e-6);
        assert!((r[2].similarity - 0.0).abs() < 1e-6);
    }

    #[test]
    fn pick_entry_excludes_below_decay_floor() {
        let conn = open_test_conn();
        seed_node(&conn, "m_strong", Some(&[1.0, 0.0]), 0.6, None, "entity");
        seed_node(&conn, "m_weak", Some(&[1.0, 0.0]), 0.01, None, "entity");
        let q = vec![1.0_f32, 0.0];
        let r = pick_entry_nodes(&conn, &q, 5).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "m_strong");
    }

    #[test]
    fn pick_entry_excludes_retired_nodes() {
        let conn = open_test_conn();
        seed_node(
            &conn,
            "m_old",
            Some(&[1.0, 0.0]),
            0.6,
            Some(2_000),
            "entity",
        );
        seed_node(&conn, "m_live", Some(&[1.0, 0.0]), 0.6, None, "entity");
        let q = vec![1.0_f32, 0.0];
        let r = pick_entry_nodes(&conn, &q, 5).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "m_live");
    }

    #[test]
    fn pick_entry_excludes_nodes_without_embedding() {
        let conn = open_test_conn();
        seed_node(&conn, "m_nemb", None, 0.6, None, "entity");
        seed_node(&conn, "m_emb", Some(&[1.0, 0.0]), 0.6, None, "entity");
        let q = vec![1.0_f32, 0.0];
        let r = pick_entry_nodes(&conn, &q, 5).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "m_emb");
    }

    #[test]
    fn pick_entry_truncates_to_limit() {
        let conn = open_test_conn();
        for i in 0..5 {
            let val = 1.0_f32 - (i as f32) * 0.1;
            seed_node(
                &conn,
                &format!("m_{i}"),
                Some(&[val, 0.0]),
                0.6,
                None,
                "entity",
            );
        }
        let q = vec![1.0_f32, 0.0];
        let r = pick_entry_nodes(&conn, &q, 3).unwrap();
        assert_eq!(r.len(), 3);
    }

    // ── traverse_subgraph ──────────────────────────────────────────────────
    #[test]
    fn traverse_returns_only_entries_when_no_edges() {
        let conn = open_test_conn();
        seed_node(&conn, "m_a", None, 0.6, None, "entity");
        let r = traverse_subgraph(&conn, &["m_a".into()], 3, DEFAULT_EDGE_TYPES).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "m_a");
        assert_eq!(r[0].depth, 0);
        assert!((r[0].path_score - 1.0).abs() < 1e-9);
    }

    #[test]
    fn traverse_walks_to_max_depth_and_no_further() {
        let conn = open_test_conn();
        seed_node(&conn, "m_a", None, 0.6, None, "entity");
        seed_node(&conn, "m_b", None, 0.6, None, "entity");
        seed_node(&conn, "m_c", None, 0.6, None, "entity");
        seed_node(&conn, "m_d", None, 0.6, None, "entity");
        seed_edge(&conn, "m_a", "m_b", "mentions", 0.7);
        seed_edge(&conn, "m_b", "m_c", "mentions", 0.7);
        seed_edge(&conn, "m_c", "m_d", "mentions", 0.7);
        let r = traverse_subgraph(&conn, &["m_a".into()], 2, DEFAULT_EDGE_TYPES).unwrap();
        let ids: Vec<String> = r.iter().map(|n| n.id.clone()).collect();
        assert!(ids.contains(&"m_a".to_string()));
        assert!(ids.contains(&"m_b".to_string()));
        assert!(ids.contains(&"m_c".to_string()));
        assert!(
            !ids.contains(&"m_d".to_string()),
            "depth-3 node leaked into depth-2 walk"
        );
    }

    #[test]
    fn traverse_filters_by_edge_type() {
        let conn = open_test_conn();
        seed_node(&conn, "m_a", None, 0.6, None, "entity");
        seed_node(&conn, "m_b", None, 0.6, None, "entity");
        seed_node(&conn, "m_excluded", None, 0.6, None, "capture_summary");
        seed_edge(&conn, "m_a", "m_b", "mentions", 0.7);
        seed_edge(&conn, "m_a", "m_excluded", "derives_from", 1.0);
        let r = traverse_subgraph(&conn, &["m_a".into()], 3, &["mentions"]).unwrap();
        let ids: Vec<String> = r.iter().map(|n| n.id.clone()).collect();
        assert!(ids.contains(&"m_b".to_string()));
        assert!(!ids.contains(&"m_excluded".to_string()));
    }

    #[test]
    fn traverse_skips_retired_edges_and_nodes() {
        let conn = open_test_conn();
        seed_node(&conn, "m_a", None, 0.6, None, "entity");
        seed_node(&conn, "m_live", None, 0.6, None, "entity");
        seed_node(&conn, "m_dead_node", None, 0.6, Some(1_500), "entity");
        seed_edge(&conn, "m_a", "m_live", "mentions", 0.7);
        seed_edge(&conn, "m_a", "m_dead_node", "mentions", 0.7);
        // Retire one edge
        conn.execute(
            "INSERT INTO mem_edges
           (from_node, to_node, edge_type, weight, valid_from, recorded_at, valid_to)
         VALUES ('m_a', 'm_live', 'follows_up', 0.9, 1000, 1000, 2000)",
            [],
        )
        .unwrap();
        let r = traverse_subgraph(&conn, &["m_a".into()], 3, DEFAULT_EDGE_TYPES).unwrap();
        let ids: Vec<String> = r.iter().map(|n| n.id.clone()).collect();
        assert!(ids.contains(&"m_a".to_string()));
        assert!(ids.contains(&"m_live".to_string()));
        assert!(
            !ids.contains(&"m_dead_node".to_string()),
            "retired node leaked"
        );
    }

    #[test]
    fn traverse_propagates_path_score_via_edge_weight() {
        let conn = open_test_conn();
        seed_node(&conn, "m_a", None, 0.6, None, "entity");
        seed_node(&conn, "m_b", None, 0.6, None, "entity");
        seed_node(&conn, "m_c", None, 0.6, None, "entity");
        seed_edge(&conn, "m_a", "m_b", "mentions", 0.5);
        seed_edge(&conn, "m_b", "m_c", "mentions", 0.4);
        let r = traverse_subgraph(&conn, &["m_a".into()], 3, DEFAULT_EDGE_TYPES).unwrap();
        let m_b = r.iter().find(|n| n.id == "m_b").expect("m_b");
        let m_c = r.iter().find(|n| n.id == "m_c").expect("m_c");
        assert!((m_b.path_score - 0.5).abs() < 1e-9);
        assert!((m_c.path_score - 0.5 * 0.4).abs() < 1e-9);
    }

    // ── rank_subgraph_hits ─────────────────────────────────────────────────
    #[test]
    fn ranker_orders_by_combined_score() {
        let nodes = vec![
            TraversalNode {
                id: "lo".into(),
                depth: 0,
                path_score: 1.0,
            },
            TraversalNode {
                id: "hi".into(),
                depth: 1,
                path_score: 0.6,
            },
        ];
        let mut decay = HashMap::new();
        decay.insert("lo".to_string(), 0.1);
        decay.insert("hi".to_string(), 0.9);
        let mut sim = HashMap::new();
        sim.insert("lo".to_string(), 0.8);
        sim.insert("hi".to_string(), 0.95);
        let r = rank_subgraph_hits(&nodes, &decay, &sim);
        // hi: 0.6 * 0.9 * 0.95 = 0.513
        // lo: 1.0 * 0.1 * 0.8 = 0.08
        assert_eq!(r[0].id, "hi");
        assert_eq!(r[1].id, "lo");
    }

    #[test]
    fn ranker_floor_protects_unseeded_similarity() {
        let nodes = vec![TraversalNode {
            id: "ok".into(),
            depth: 1,
            path_score: 1.0,
        }];
        let decay = HashMap::new();
        let sim = HashMap::new();
        let r = rank_subgraph_hits(&nodes, &decay, &sim);
        // floor * floor = 0.05 * 0.05 = 0.0025
        assert!((r[0].score - (RANKER_FLOOR * RANKER_FLOOR)).abs() < 1e-9);
    }

    // ── bump_access_for_hits ───────────────────────────────────────────────
    #[test]
    fn bump_access_increments_count_and_sets_last_accessed_at() {
        let mut conn = open_test_conn();
        seed_node(&conn, "m_1", None, 0.5, None, "entity");
        let n = bump_access_for_hits(&mut conn, &vec!["m_1".into()], 5_000).unwrap();
        assert_eq!(n, 1);
        let (count, last): (i64, Option<i64>) = conn
            .query_row(
                "SELECT access_count, last_accessed_at FROM mem_items WHERE id = 'm_1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(last, Some(5_000));
    }

    #[test]
    fn bump_access_recomputes_decay_score_with_recency_one() {
        let mut conn = open_test_conn();
        seed_node(&conn, "m_1", None, 0.0, None, "entity");
        bump_access_for_hits(&mut conn, &vec!["m_1".into()], 5_000).unwrap();
        let new_decay: Option<f64> = conn
            .query_row(
                "SELECT decay_score FROM mem_items WHERE id = 'm_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let v = new_decay.expect("decay set");
        // recency=1.0 dominates with default w1=0.4 → score should be at least 0.4.
        assert!(v >= 0.4, "got decay {}", v);
        // Plus the confidence default 0.5 contribution = 0.05.
        assert!(v <= 1.0);
    }

    #[test]
    fn bump_access_skips_retired_nodes() {
        let mut conn = open_test_conn();
        seed_node(&conn, "m_old", None, 0.5, Some(2_000), "entity");
        let n = bump_access_for_hits(&mut conn, &vec!["m_old".into()], 5_000).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn bump_access_handles_empty_input() {
        let mut conn = open_test_conn();
        let n = bump_access_for_hits(&mut conn, &Vec::new(), 5_000).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn bump_access_handles_unknown_ids_silently() {
        let mut conn = open_test_conn();
        seed_node(&conn, "m_1", None, 0.5, None, "entity");
        let ids = vec!["m_1".into(), "m_unknown".into()];
        let n = bump_access_for_hits(&mut conn, &ids, 5_000).unwrap();
        assert_eq!(n, 1, "only m_1 should have been updated");
    }

    // ── filter_node_ids_by_kind ────────────────────────────────────────────
    #[test]
    fn filter_kind_excludes_capture_summary() {
        let conn = open_test_conn();
        seed_node(&conn, "m_e", None, 0.6, None, "entity");
        seed_node(&conn, "m_n", None, 0.6, None, "note");
        seed_node(&conn, "m_cs", None, 0.6, None, "capture_summary");
        let kept = filter_node_ids_by_kind(
            &conn,
            &vec!["m_e".into(), "m_n".into(), "m_cs".into()],
            &["entity", "note", "event", "decision", "task"],
        )
        .unwrap();
        assert!(kept.contains("m_e"));
        assert!(kept.contains("m_n"));
        assert!(!kept.contains("m_cs"));
    }
}
