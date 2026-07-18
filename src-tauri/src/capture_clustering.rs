//! Periodic semantic clustering of recent capture rows in `mem_items`.
//!
//! At ingest time the sampler (`capture_sampler.rs`) drops near-duplicates
//! against a small ring buffer, but over a long session the stored history
//! still accumulates many similar-but-not-identical rows (e.g. the same Slack
//! channel re-captured 20 times). This module groups those rows after the
//! fact: within a sliding window (default last 24h) we compute a simhash for
//! each capture, find connected components on the Hamming-distance graph (edge
//! iff distance <= `CLUSTER_HAMMING_THRESHOLD`), and write a stable
//! `cluster_id` back to each row. Retrieval can then return one representative
//! per cluster instead of all the near-duplicates.
//!
//! The simhash logic is intentionally a private copy of the one in
//! `capture_sampler.rs` rather than a shared dependency: keeping it duplicated
//! keeps this module decoupled (`capture_sampler` can evolve its dedup
//! strategy without breaking history clustering) and the function body is
//! only ~25 lines.

use rusqlite::{params, Connection};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

/// Sources we consider "captures" for clustering. Other rows (calendar
/// imports, gmail sync, etc.) are skipped so we don't accidentally merge
/// semantically-distinct provenance.
const CAPTURE_SOURCE_PREFIXES: &[&str] = &["capture_"];

/// Maximum Hamming distance (in bits) between two 64-bit simhashes to be
/// linked into the same cluster. 8/64 (~12.5%) is looser than the ingest-time
/// near-dup threshold (4) on purpose: we want to gather variants that drifted
/// over a session, not just exact reprints.
pub const CLUSTER_HAMMING_THRESHOLD: u32 = 8;

/// Seconds between background clustering passes.
pub const CLUSTER_INTERVAL_SECS: u64 = 300;

/// Default sliding window scanned per pass.
const DEFAULT_WINDOW_SECS: i64 = 24 * 60 * 60;

/// Spawn a background thread that runs `cluster_recent_captures` every
/// `CLUSTER_INTERVAL_SECS`. The thread opens its own connection via
/// `memory_store::open_conn` on each tick so a crash mid-pass does not
/// poison long-lived state. The integrator decides whether to call this
/// (not auto-started from `lib.rs`).
pub fn spawn_background_clusterer() {
  std::thread::spawn(|| {
    loop {
      let result = std::panic::catch_unwind(|| match crate::memory_store::open_conn() {
        Ok(conn) => match cluster_recent_captures(&conn, DEFAULT_WINDOW_SECS) {
          Ok((scanned, clusters)) => {
            log::info!(
              "capture_clustering: scanned {} rows, formed {} clusters",
              scanned,
              clusters
            );
          }
          Err(e) => log::warn!("capture_clustering: pass failed: {}", e),
        },
        Err(e) => log::warn!("capture_clustering: open_conn failed: {}", e),
      });
      if let Err(panic) = result {
        let msg = match panic.downcast_ref::<&'static str>() {
          Some(s) => (*s).to_string(),
          None => panic
            .downcast_ref::<String>()
            .cloned()
            .unwrap_or_else(|| "<non-string panic>".to_string()),
        };
        log::warn!("capture_clustering: pass panicked, continuing: {}", msg);
      }
      std::thread::sleep(Duration::from_secs(CLUSTER_INTERVAL_SECS));
    }
  });
}

/// Ensure the `cluster_id INTEGER` column exists on `mem_items`. No-op when
/// the column is already present.
fn ensure_cluster_id_column(conn: &Connection) -> Result<(), String> {
  let mut stmt = conn
    .prepare("PRAGMA table_info(mem_items)")
    .map_err(|e| e.to_string())?;
  let names: Vec<String> = stmt
    .query_map([], |r| r.get::<_, String>(1))
    .map_err(|e| e.to_string())?
    .filter_map(|x| x.ok())
    .collect();
  drop(stmt);
  if !names.iter().any(|n| n == "cluster_id") {
    conn
      .execute("ALTER TABLE mem_items ADD COLUMN cluster_id INTEGER", [])
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// Scan recent capture rows in `conn`, cluster by simhash Hamming distance,
/// and write `cluster_id` back. Returns `(rows_scanned, clusters_formed)`.
///
/// "Recent" = rows whose `created_at` is within `window_secs` of the most
/// recent row in the table. Using max(created_at) instead of wall-clock
/// `now` keeps tests deterministic and matches the natural "last activity"
/// notion.
///
/// Migration: lazily adds the `cluster_id` column on first call. Subsequent
/// calls are no-ops at the schema level.
pub fn cluster_recent_captures(
  conn: &Connection,
  window_secs: i64,
) -> Result<(usize, usize), String> {
  ensure_cluster_id_column(conn)?;

  // Pick the window upper bound from the data itself: the newest row's
  // created_at. Empty table → nothing to do.
  let max_created_at: Option<i64> = conn
    .query_row("SELECT MAX(created_at) FROM mem_items", [], |r| r.get(0))
    .map_err(|e| e.to_string())?;
  let Some(max_ts) = max_created_at else {
    return Ok((0, 0));
  };
  let lower_bound = max_ts.saturating_sub(window_secs.saturating_mul(1000));

  // Pull capture rows in the window. We filter to `source LIKE 'capture_%'`
  // so we don't cluster unrelated ingestion (calendar, gmail, etc.).
  let mut stmt = conn
    .prepare(
      "SELECT id, snippet FROM mem_items \
       WHERE created_at >= ?1 AND source LIKE 'capture_%' \
       ORDER BY created_at ASC, id ASC",
    )
    .map_err(|e| e.to_string())?;
  let rows: Vec<(String, String)> = stmt
    .query_map(params![lower_bound], |r| {
      Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })
    .map_err(|e| e.to_string())?
    .filter_map(|x| x.ok())
    .collect();
  drop(stmt);

  if rows.is_empty() {
    return Ok((0, 0));
  }

  // We also need snippet length per row for representative selection.
  let snippet_lens: Vec<usize> = rows.iter().map(|(_, s)| s.chars().count()).collect();
  let simhashes: Vec<u64> = rows.iter().map(|(_, s)| simhash64(s)).collect();

  // Drop the prefix; CAPTURE_SOURCE_PREFIXES is documentation for future
  // tightening. The SQL filter above already enforces the same constraint.
  let _ = CAPTURE_SOURCE_PREFIXES;

  let local_clusters = cluster_simhashes(&simhashes, CLUSTER_HAMMING_THRESHOLD);

  // Reserve a stable monotonic id space: each cluster index gets
  // `next_id + idx`. `next_id` = max(existing cluster_id) + 1.
  let existing_max: Option<i64> = conn
    .query_row(
      "SELECT MAX(cluster_id) FROM mem_items WHERE cluster_id IS NOT NULL",
      [],
      |r| r.get(0),
    )
    .map_err(|e| e.to_string())?;
  let next_id_base: i64 = existing_max.map(|m| m + 1).unwrap_or(0);

  // Number of distinct clusters in this pass.
  let mut max_local: i64 = -1;
  for c in &local_clusters {
    if *c as i64 > max_local {
      max_local = *c as i64;
    }
  }
  let clusters_formed = (max_local + 1) as usize;

  // Write back in a single transaction.
  let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
  {
    let mut update = tx
      .prepare("UPDATE mem_items SET cluster_id = ?1 WHERE id = ?2")
      .map_err(|e| e.to_string())?;
    for (i, (id, _snippet)) in rows.iter().enumerate() {
      let global_id = next_id_base + local_clusters[i] as i64;
      update
        .execute(params![global_id, id])
        .map_err(|e| e.to_string())?;
    }
  }
  tx.commit().map_err(|e| e.to_string())?;

  // Representative is implicit: rows in the same cluster share an id; callers
  // can `ORDER BY length(snippet) DESC LIMIT 1` per cluster. We expose
  // snippet_lens here only so future callers can extend with an explicit
  // "is_representative" column without re-reading snippets.
  let _ = snippet_lens;

  Ok((rows.len(), clusters_formed))
}

/// Group `simhashes` into clusters via connected components on the graph
/// `(i, j) ∈ E  iff  hamming(simhashes[i], simhashes[j]) <= max_dist`.
/// Cluster indices are 0..N and assigned in first-touch order so the result
/// is deterministic for a given input ordering.
///
/// Algorithm: union-find with path compression and union-by-rank. Chosen
/// over BFS because:
///   1. We need final cluster labels, not traversal order — union-find
///      naturally produces equivalence classes in one O(N² · α(N)) pass.
///   2. Union-find is single-pass over the edge set, so we never have to
///      build an adjacency list (cheaper memory).
///   3. For the expected workload (a few hundred to a few thousand rows
///      per pass) the O(N²) pairwise scan dominates everything anyway —
///      a simple algorithm wins on clarity.
pub fn cluster_simhashes(simhashes: &[u64], max_dist: u32) -> Vec<usize> {
  let n = simhashes.len();
  if n == 0 {
    return Vec::new();
  }

  // Union-find scaffolding.
  let mut parent: Vec<usize> = (0..n).collect();
  let mut rank: Vec<u8> = vec![0; n];

  fn find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
      parent[x] = parent[parent[x]]; // path halving
      x = parent[x];
    }
    x
  }
  fn union(parent: &mut [usize], rank: &mut [u8], a: usize, b: usize) {
    let ra = find(parent, a);
    let rb = find(parent, b);
    if ra == rb {
      return;
    }
    if rank[ra] < rank[rb] {
      parent[ra] = rb;
    } else if rank[ra] > rank[rb] {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra] = rank[ra].saturating_add(1);
    }
  }

  for i in 0..n {
    for j in (i + 1)..n {
      let d = (simhashes[i] ^ simhashes[j]).count_ones();
      if d <= max_dist {
        union(&mut parent, &mut rank, i, j);
      }
    }
  }

  // Relabel roots to dense 0..K in first-touch order so output is stable.
  let mut label_of_root: std::collections::HashMap<usize, usize> =
    std::collections::HashMap::with_capacity(n);
  let mut next_label = 0usize;
  let mut out = vec![0usize; n];
  for i in 0..n {
    let r = find(&mut parent, i);
    let label = *label_of_root.entry(r).or_insert_with(|| {
      let l = next_label;
      next_label += 1;
      l
    });
    out[i] = label;
  }
  out
}

// ---------------------------------------------------------------------------
// simhash (private copy of capture_sampler::simhash64, see module docstring)
// ---------------------------------------------------------------------------

fn fnv_hash(s: &str) -> u64 {
  let mut h = DefaultHasher::new();
  s.hash(&mut h);
  h.finish()
}

/// 64-bit simhash over whitespace-separated, lowercased word tokens. Returns
/// 0 for empty / whitespace-only input. Matches the behaviour of
/// `capture_sampler::simhash64` exactly so cluster decisions here align with
/// ingest-time dedup decisions.
fn simhash64(text: &str) -> u64 {
  let mut sums: [i32; 64] = [0; 64];
  let mut tokens = 0u32;
  for token in text.split_whitespace() {
    let lower = token.to_ascii_lowercase();
    if lower.is_empty() {
      continue;
    }
    tokens += 1;
    let h = fnv_hash(&lower);
    for (bit, sum) in sums.iter_mut().enumerate() {
      if (h >> bit) & 1 == 1 {
        *sum += 1;
      } else {
        *sum -= 1;
      }
    }
  }
  if tokens == 0 {
    return 0;
  }
  let mut out: u64 = 0;
  for (bit, sum) in sums.iter().enumerate() {
    if *sum > 0 {
      out |= 1u64 << bit;
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::Connection;

  // ---- cluster_simhashes ------------------------------------------------

  #[test]
  fn cluster_simhashes_empty_input() {
    let out = cluster_simhashes(&[], 4);
    assert!(out.is_empty());
  }

  #[test]
  fn cluster_simhashes_single_element() {
    let out = cluster_simhashes(&[0x1234], 4);
    assert_eq!(out, vec![0]);
  }

  #[test]
  fn cluster_simhashes_all_identical() {
    let out = cluster_simhashes(&[42, 42, 42, 42], 0);
    assert_eq!(out, vec![0, 0, 0, 0]);
  }

  #[test]
  fn cluster_simhashes_threshold_zero_separates_distinct() {
    // Threshold 0 = exact match only. Two distinct values → two clusters.
    let out = cluster_simhashes(&[1, 2, 3], 0);
    assert_eq!(out, vec![0, 1, 2]);
  }

  #[test]
  fn cluster_simhashes_spec_example() {
    // From the task spec: 0xAAAA / 0xAAAB differ by 1 bit; 0xFFFF0000 is far
    // from both at threshold 4.
    let out = cluster_simhashes(&[0xAAAA, 0xAAAB, 0xFFFF_0000], 4);
    assert_eq!(out, vec![0, 0, 1]);
  }

  #[test]
  fn cluster_simhashes_larger_threshold_groups_more_aggressively() {
    let inputs = [0b0000_0000u64, 0b0000_1111, 0b0011_1111];
    // dist(0, 1) = 4, dist(1, 2) = 2, dist(0, 2) = 6.
    let tight = cluster_simhashes(&inputs, 1);
    assert_eq!(tight, vec![0, 1, 2]);
    let medium = cluster_simhashes(&inputs, 3);
    // 1↔2 connect (dist 2), 0 stays alone.
    assert_eq!(medium, vec![0, 1, 1]);
    let loose = cluster_simhashes(&inputs, 10);
    assert_eq!(loose, vec![0, 0, 0]);
  }

  #[test]
  fn cluster_simhashes_transitive_chain_via_threshold() {
    // a—b distance 4, b—c distance 4, a—c distance 8. At threshold 4 all
    // three should still be one cluster via transitivity.
    let a: u64 = 0;
    let b: u64 = 0b1111;
    let c: u64 = 0b1111_0000;
    let out = cluster_simhashes(&[a, b, c], 4);
    assert_eq!(out[0], out[1]);
    assert_eq!(out[1], out[2]);
  }

  // ---- simhash sanity ---------------------------------------------------

  #[test]
  fn simhash_matches_sampler_semantics_on_near_dups() {
    // Pure whitespace change must not move the simhash at all (same token
    // multiset). This mirrors how the sampler dedup uses simhash at ingest.
    let a = simhash64("Hello world foo bar");
    let b = simhash64("Hello world foo bar ");
    assert_eq!(a, b);
  }


  // ---- cluster_recent_captures (DB integration with in-memory sqlite) --

  /// Build a stripped-down `mem_items` schema that exercises the migration
  /// path: deliberately omit `cluster_id` so the test verifies the ALTER
  /// branch fires.
  fn make_test_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory");
    conn
      .execute_batch(
        r#"
          CREATE TABLE mem_items (
            id TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            snippet TEXT NOT NULL,
            source TEXT NOT NULL,
            kinds_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
        "#,
      )
      .expect("create mem_items");
    conn
  }

  fn insert_row(conn: &Connection, id: &str, snippet: &str, source: &str, ts: i64) {
    conn
      .execute(
        "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, "t", snippet, source, "[]", ts],
      )
      .expect("insert row");
  }

  fn cluster_id_of(conn: &Connection, id: &str) -> Option<i64> {
    conn
      .query_row(
        "SELECT cluster_id FROM mem_items WHERE id = ?1",
        params![id],
        |r| r.get::<_, Option<i64>>(0),
      )
      .expect("query")
  }

  #[test]
  fn cluster_recent_captures_migrates_and_assigns_ids() {
    let conn = make_test_db();
    let base = 1_700_000_000_000i64;
    // 3 near-duplicates: a fairly long shared corpus (so a single-word swap
    // is a small fraction of the token set, keeping simhash distance low),
    // with one trivial variation per row. The "Hello world foo bar" header
    // is part of each snippet per the task spec.
    let base_text = "Hello world foo bar the quick brown fox jumps over the lazy dog \
                     pack my box with five dozen liquor jugs sphinx of black quartz \
                     judge my vow the five boxing wizards jump quickly";
    insert_row(&conn, "n1", base_text, "capture_ax", base);
    insert_row(
      &conn,
      "n2",
      &format!("{} extra", base_text),
      "capture_ax",
      base + 1,
    );
    insert_row(
      &conn,
      "n3",
      &format!("{} additional", base_text),
      "capture_ax",
      base + 2,
    );
    // 2 distinct rows — fully unrelated token sets.
    insert_row(
      &conn,
      "d1",
      "completely unrelated lorem ipsum dolor sit amet consectetur adipiscing elit",
      "capture_ocr",
      base + 3,
    );
    insert_row(
      &conn,
      "d2",
      "yet another distinct topic about deployment pipelines continuous integration release engineering",
      "capture_strategy_chrome",
      base + 4,
    );

    // Verify cluster_id column does not yet exist.
    let pre_cols: Vec<String> = conn
      .prepare("PRAGMA table_info(mem_items)")
      .unwrap()
      .query_map([], |r| r.get::<_, String>(1))
      .unwrap()
      .filter_map(|x| x.ok())
      .collect();
    assert!(!pre_cols.iter().any(|c| c == "cluster_id"));

    let (scanned, clusters) =
      cluster_recent_captures(&conn, 24 * 60 * 60).expect("cluster pass");
    assert_eq!(scanned, 5);
    // 3 near-dups + 2 distinct = 3 clusters.
    assert_eq!(clusters, 3);

    // Column was added by the migration.
    let post_cols: Vec<String> = conn
      .prepare("PRAGMA table_info(mem_items)")
      .unwrap()
      .query_map([], |r| r.get::<_, String>(1))
      .unwrap()
      .filter_map(|x| x.ok())
      .collect();
    assert!(post_cols.iter().any(|c| c == "cluster_id"));

    // All five rows have a non-null cluster_id.
    let ids = ["n1", "n2", "n3", "d1", "d2"];
    let cids: Vec<i64> = ids
      .iter()
      .map(|id| cluster_id_of(&conn, id).expect("non-null cluster_id"))
      .collect();

    // n1, n2, n3 share a cluster.
    assert_eq!(cids[0], cids[1]);
    assert_eq!(cids[1], cids[2]);
    // d1 and d2 each in their own cluster, distinct from the near-dup group.
    assert_ne!(cids[3], cids[0]);
    assert_ne!(cids[4], cids[0]);
    assert_ne!(cids[3], cids[4]);
  }

  #[test]
  fn cluster_recent_captures_migration_is_noop_when_column_present() {
    let conn = make_test_db();
    // Pre-add the column.
    conn
      .execute("ALTER TABLE mem_items ADD COLUMN cluster_id INTEGER", [])
      .unwrap();
    insert_row(&conn, "a", "hello world", "capture_ax", 1_700_000_000_000);
    // Should not error or duplicate the column.
    let (scanned, clusters) = cluster_recent_captures(&conn, 60).expect("pass");
    assert_eq!(scanned, 1);
    assert_eq!(clusters, 1);
    let cols: Vec<String> = conn
      .prepare("PRAGMA table_info(mem_items)")
      .unwrap()
      .query_map([], |r| r.get::<_, String>(1))
      .unwrap()
      .filter_map(|x| x.ok())
      .collect();
    let count_cluster_id = cols.iter().filter(|c| c.as_str() == "cluster_id").count();
    assert_eq!(count_cluster_id, 1);
  }

  #[test]
  fn cluster_recent_captures_handles_empty_table() {
    let conn = make_test_db();
    let (scanned, clusters) = cluster_recent_captures(&conn, 60).expect("pass");
    assert_eq!(scanned, 0);
    assert_eq!(clusters, 0);
    // Migration must still have added the column.
    let cols: Vec<String> = conn
      .prepare("PRAGMA table_info(mem_items)")
      .unwrap()
      .query_map([], |r| r.get::<_, String>(1))
      .unwrap()
      .filter_map(|x| x.ok())
      .collect();
    assert!(cols.iter().any(|c| c == "cluster_id"));
  }

  #[test]
  fn cluster_recent_captures_skips_non_capture_sources() {
    let conn = make_test_db();
    let base = 1_700_000_000_000i64;
    insert_row(&conn, "c1", "hello world foo", "capture_ax", base);
    insert_row(&conn, "x1", "hello world foo", "gmail", base + 1);
    let (scanned, _) = cluster_recent_captures(&conn, 60).expect("pass");
    assert_eq!(scanned, 1);
    assert!(cluster_id_of(&conn, "c1").is_some());
    assert!(cluster_id_of(&conn, "x1").is_none());
  }

  #[test]
  fn cluster_recent_captures_monotonic_ids_across_passes() {
    let conn = make_test_db();
    let base = 1_700_000_000_000i64;
    insert_row(&conn, "a", "hello world foo", "capture_ax", base);
    insert_row(&conn, "b", "hello world bar", "capture_ax", base + 1);
    cluster_recent_captures(&conn, 60).expect("pass 1");
    let first_a = cluster_id_of(&conn, "a").unwrap();
    // Add a new row and re-run; ids assigned this pass must be strictly
    // greater than anything from the previous pass.
    insert_row(&conn, "c", "completely different topic", "capture_ax", base + 2);
    cluster_recent_captures(&conn, 60).expect("pass 2");
    let new_c = cluster_id_of(&conn, "c").unwrap();
    assert!(new_c > first_a, "expected monotonic id allocation");
  }
}
