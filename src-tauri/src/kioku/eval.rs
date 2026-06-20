//! Eval harness for the KIOKU graph layer.
//!
//! Phase 2 Stage 1 deliverable: pure scoring utilities + JSONL fixture loaders.
//! Live retrieval eval (vs. graph traversal) lands in Stage 3 / Stage 4.
//!
//! Spec: `docs/memory-architecture/migration-plan.md` §Stage 1.2.

// Used by tests + future Stage 3 retrieval eval; production read paths don't
// import these utilities yet. Mirror the policy in `decay.rs`.
#![allow(dead_code)]

use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path;

/// A `mem_items`-shaped fixture row used to seed an in-memory `memory.db` for
/// retrieval / decay eval.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct NodeFixture {
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub source: String,
    #[serde(default)]
    pub kinds: Vec<String>,
    pub created_at: i64,
    #[serde(default)]
    pub provenance: Option<String>,
    #[serde(default)]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub node_kind: Option<String>,
}

/// A `mem_captures`-shaped fixture row.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct CaptureFixture {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub raw_text: Option<String>,
    #[serde(default)]
    pub raw_path: Option<String>,
    #[serde(default)]
    pub app_bundle_id: Option<String>,
    #[serde(default)]
    pub window_title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    pub captured_at: i64,
}

/// A retrieval query with annotated relevant / irrelevant node IDs.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RetrievalQuery {
    pub query: String,
    #[serde(default)]
    pub relevant_ids: Vec<String>,
    #[serde(default)]
    pub irrelevant_ids: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// Minimal "fact" representation used by `is_same_fact` / `same_entity_*`
/// fixtures. Mirrors the structured-extraction contract sketched in
/// `target-design.md` §3.4 without depending on the live LLM.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FactFixture {
    #[serde(default)]
    pub entity_id: Option<String>,
    pub entity_name: String,
    pub fact_type: String,
    pub claim: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct IsSameFactCase {
    pub id: String,
    pub left: FactFixture,
    pub right: FactFixture,
    pub expected: bool,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SameEntityDifferentFactCase {
    pub id: String,
    pub left: FactFixture,
    pub right: FactFixture,
    pub expected: bool,
    #[serde(default)]
    pub category: Option<String>,
}

/// Parse a JSONL document (one record per non-empty line, `#`-prefixed lines
/// treated as comments). Used by every fixture loader.
pub fn parse_jsonl<T: for<'de> Deserialize<'de>>(contents: &str) -> Result<Vec<T>, String> {
    let mut out = Vec::new();
    for (idx, raw) in contents.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let record: T = serde_json::from_str(line)
            .map_err(|e| format!("kioku_eval JSONL parse error on line {}: {}", idx + 1, e))?;
        out.push(record);
    }
    Ok(out)
}

/// Read a JSONL fixture from disk and parse each line into `T`.
pub fn load_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Vec<T>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("kioku_eval read {}: {}", path.display(), e))?;
    parse_jsonl(&contents)
}

/// Path to the on-disk fixture directory, resolved relative to `CARGO_MANIFEST_DIR`.
pub fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("kioku_eval")
}

/// Fraction of the top-`k` retrieved IDs that are in `relevant`.
///
/// `k = 0` returns 0.0 by convention. If `retrieved.len() < k` the denominator
/// is still `k` (missing slots count as misses), matching standard IR usage.
/// Normalized Discounted Cumulative Gain at `k` with binary relevance.
///
/// Definition:
///   DCG@k  = sum_{i=1..k} rel_i / log2(i + 1), where rel_i ∈ {0, 1}.
///   IDCG@k = DCG of the ideal ranking (relevant items at top, capped at k).
///   NDCG@k = DCG@k / IDCG@k, with IDCG@k = 0 ⇒ NDCG = 1.0 (no work to do).
///
/// Duplicates in `retrieved` only count their first occurrence.
pub fn ndcg_at_k(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if relevant.is_empty() {
        return 1.0;
    }
    if k == 0 {
        return 0.0;
    }
    // DCG of the retrieved order, deduped.
    let mut seen: HashSet<&str> = HashSet::new();
    let mut dcg = 0.0f64;
    for (idx, id) in retrieved.iter().take(k).enumerate() {
        if !seen.insert(id.as_str()) {
            continue;
        }
        if relevant.contains(id) {
            // Position 1-based: i = idx + 1 ⇒ denominator = log2(idx + 2).
            dcg += 1.0 / ((idx as f64 + 2.0).log2());
        }
    }
    // IDCG: relevant items packed at the top, capped at k.
    let ideal_count = relevant.len().min(k);
    let mut idcg = 0.0f64;
    for idx in 0..ideal_count {
        idcg += 1.0 / ((idx as f64 + 2.0).log2());
    }
    if idcg == 0.0 {
        1.0
    } else {
        dcg / idcg
    }
}

/// Fraction of `relevant` recovered in the top-`k` retrieved IDs.
///
/// `relevant.is_empty()` returns 1.0 by convention (no items to recover, so
/// "all" of zero are recovered). Duplicates in `retrieved` only count once.
pub fn recall_at_k(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if relevant.is_empty() {
        return 1.0;
    }
    if k == 0 {
        return 0.0;
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut hits = 0usize;
    for id in retrieved.iter().take(k) {
        if !seen.insert(id.as_str()) {
            continue;
        }
        if relevant.contains(id) {
            hits += 1;
        }
    }
    hits as f64 / relevant.len() as f64
}

pub fn precision_at_k(retrieved: &[String], relevant: &HashSet<String>, k: usize) -> f64 {
    if k == 0 {
        return 0.0;
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut hits = 0usize;
    for id in retrieved.iter().take(k) {
        if !seen.insert(id.as_str()) {
            continue;
        }
        if relevant.contains(id) {
            hits += 1;
        }
    }
    hits as f64 / k as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }
    fn rel(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn precision_at_k_zero_when_k_is_zero() {
        let retrieved = ids(&["a", "b", "c"]);
        let relevant = rel(&["a"]);
        assert_eq!(precision_at_k(&retrieved, &relevant, 0), 0.0);
    }

    #[test]
    fn precision_at_k_full_match_returns_one() {
        let retrieved = ids(&["a", "b", "c"]);
        let relevant = rel(&["a", "b", "c", "d"]);
        assert!((precision_at_k(&retrieved, &relevant, 3) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn precision_at_k_no_match_returns_zero() {
        let retrieved = ids(&["x", "y", "z"]);
        let relevant = rel(&["a", "b"]);
        assert_eq!(precision_at_k(&retrieved, &relevant, 3), 0.0);
    }

    #[test]
    fn precision_at_k_partial_match() {
        // Top 4 retrieved: a (rel), x, b (rel), y → 2 / 4 = 0.5
        let retrieved = ids(&["a", "x", "b", "y", "c"]);
        let relevant = rel(&["a", "b", "c"]);
        assert!((precision_at_k(&retrieved, &relevant, 4) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn precision_at_k_truncates_to_first_k() {
        // Same retrieved as before but k=2 → only "a" and "x" → 1 / 2 = 0.5
        let retrieved = ids(&["a", "x", "b", "y", "c"]);
        let relevant = rel(&["a", "b", "c"]);
        assert!((precision_at_k(&retrieved, &relevant, 2) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn precision_at_k_when_retrieved_shorter_than_k_treats_missing_as_misses() {
        // Only 2 retrieved, k = 5. Numerator = hits among first 5 (= first 2) = 1.
        // Denominator = 5. Score = 0.2.
        let retrieved = ids(&["a", "x"]);
        let relevant = rel(&["a", "b", "c"]);
        assert!((precision_at_k(&retrieved, &relevant, 5) - 0.2).abs() < 1e-9);
    }

    #[test]
    fn fixture_dir_resolves_under_repo_root() {
        let p = fixture_dir();
        assert!(
            p.ends_with("tests/fixtures/kioku_eval"),
            "got {}",
            p.display()
        );
    }

    /// CI sanity: every JSONL fixture loads cleanly and meets the lower-bound
    /// counts documented in `tests/fixtures/kioku_eval/README.md`.
    #[test]
    fn fixtures_load_with_expected_counts() {
        let base = fixture_dir();

        let nodes: Vec<NodeFixture> =
            load_jsonl(&base.join("nodes.jsonl")).expect("nodes.jsonl loads");
        assert!(
            nodes.len() >= 50,
            "nodes.jsonl must contain ≥50 records, got {}",
            nodes.len()
        );
        // IDs are unique.
        let mut ids: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        ids.sort();
        let dedup_len = {
            let mut v = ids.clone();
            v.dedup();
            v.len()
        };
        assert_eq!(dedup_len, ids.len(), "nodes.jsonl has duplicate ids");

        let captures: Vec<CaptureFixture> =
            load_jsonl(&base.join("captures.jsonl")).expect("captures.jsonl loads");
        assert!(
            captures.len() >= 20,
            "captures.jsonl must contain ≥20 records, got {}",
            captures.len()
        );

        let queries: Vec<RetrievalQuery> = load_jsonl(&base.join("retrieval_queries.jsonl"))
            .expect("retrieval_queries.jsonl loads");
        assert!(
            queries.len() >= 10,
            "retrieval_queries.jsonl must contain ≥10 records, got {}",
            queries.len()
        );
        // Every relevant_id and irrelevant_id must reference a node we know about.
        let known_node_ids: HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        for q in &queries {
            for rel_id in &q.relevant_ids {
                assert!(
                    known_node_ids.contains(rel_id.as_str()),
                    "query {:?} relevant id {:?} not in nodes.jsonl",
                    q.query,
                    rel_id,
                );
            }
            for irr_id in &q.irrelevant_ids {
                assert!(
                    known_node_ids.contains(irr_id.as_str()),
                    "query {:?} irrelevant id {:?} not in nodes.jsonl",
                    q.query,
                    irr_id,
                );
            }
        }

        let same_fact: Vec<IsSameFactCase> = load_jsonl(&base.join("is_same_fact_cases.jsonl"))
            .expect("is_same_fact_cases.jsonl loads");
        assert!(
            same_fact.len() >= 30,
            "is_same_fact_cases.jsonl must contain ≥30 records, got {}",
            same_fact.len()
        );
        // Both `expected: true` and `expected: false` cases present so the
        // judgment isn't trivially passable by always returning one or the other.
        assert!(
            same_fact.iter().any(|c| c.expected),
            "no expected:true cases"
        );
        assert!(
            same_fact.iter().any(|c| !c.expected),
            "no expected:false cases"
        );

        let same_ent: Vec<SameEntityDifferentFactCase> =
            load_jsonl(&base.join("same_entity_different_fact_cases.jsonl"))
                .expect("same_entity_different_fact_cases.jsonl loads");
        assert!(
            same_ent.len() >= 15,
            "same_entity_different_fact_cases.jsonl must contain ≥15 records, got {}",
            same_ent.len()
        );
        assert!(same_ent.iter().any(|c| c.expected));
        assert!(same_ent.iter().any(|c| !c.expected));
    }

    #[test]
    fn parse_jsonl_returns_empty_for_empty_input() {
        let out: Vec<NodeFixture> = parse_jsonl("").expect("ok");
        assert_eq!(out.len(), 0);
    }

    #[test]
    fn parse_jsonl_parses_node_records() {
        let jsonl = r#"{"id":"m_1","title":"T1","snippet":"S1","source":"google_calendar","kinds":["event"],"created_at":100,"provenance":"connector","entity_id":"cal_1","node_kind":"event"}
{"id":"m_2","title":"T2","snippet":"S2","source":"capture_sampler","kinds":["screen"],"created_at":200,"node_kind":"capture_summary"}
"#;
        let nodes: Vec<NodeFixture> = parse_jsonl(jsonl).expect("ok");
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].id, "m_1");
        assert_eq!(nodes[0].provenance.as_deref(), Some("connector"));
        assert_eq!(nodes[0].entity_id.as_deref(), Some("cal_1"));
        assert_eq!(nodes[1].id, "m_2");
        assert_eq!(nodes[1].entity_id, None);
        assert_eq!(nodes[1].node_kind.as_deref(), Some("capture_summary"));
    }

    #[test]
    fn parse_jsonl_skips_blank_lines_and_comments() {
        let jsonl = "# header comment\n\n{\"id\":\"m_1\",\"title\":\"T\",\"snippet\":\"S\",\"source\":\"capture\",\"kinds\":[],\"created_at\":1}\n# trailing comment\n";
        let nodes: Vec<NodeFixture> = parse_jsonl(jsonl).expect("ok");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "m_1");
    }

    #[test]
    fn parse_jsonl_reports_lineno_on_parse_error() {
        // Three lines: comment, valid, malformed. Error must mention line 3.
        let jsonl = "# hi\n{\"id\":\"m_ok\",\"title\":\"T\",\"snippet\":\"S\",\"source\":\"capture\",\"kinds\":[],\"created_at\":1}\n{not json\n";
        let err = parse_jsonl::<NodeFixture>(jsonl).expect_err("must error");
        assert!(
            err.contains("line 3"),
            "error did not mention line 3: {err}"
        );
    }

    #[test]
    fn parse_jsonl_handles_retrieval_query_records() {
        let jsonl = r#"{"query":"deploy plan","relevant_ids":["m_3","m_5"],"irrelevant_ids":["m_2"]}
{"query":"q2 launch date","relevant_ids":["m_8"],"irrelevant_ids":[],"note":"date conflict"}
"#;
        let queries: Vec<RetrievalQuery> = parse_jsonl(jsonl).expect("ok");
        assert_eq!(queries.len(), 2);
        assert_eq!(queries[0].relevant_ids, vec!["m_3", "m_5"]);
        assert_eq!(queries[1].note.as_deref(), Some("date conflict"));
    }

    #[test]
    fn parse_jsonl_handles_is_same_fact_cases() {
        let jsonl = r#"{"id":"sf_1","left":{"entity_name":"Alex Chen","fact_type":"works_at","claim":"Alex works at Acme"},"right":{"entity_name":"alex chen","fact_type":"works_at","claim":"Alex Chen works for Acme Inc"},"expected":true,"category":"name_normalization"}
"#;
        let cases: Vec<IsSameFactCase> = parse_jsonl(jsonl).expect("ok");
        assert_eq!(cases.len(), 1);
        assert_eq!(cases[0].id, "sf_1");
        assert!(cases[0].expected);
        assert_eq!(cases[0].left.entity_name, "Alex Chen");
        assert_eq!(cases[0].right.fact_type, "works_at");
    }

    #[test]
    fn ndcg_at_k_perfect_ranking_returns_one() {
        // All relevant items appear at the top, so DCG = IDCG, NDCG = 1.
        let retrieved = ids(&["a", "b", "x", "y"]);
        let relevant = rel(&["a", "b"]);
        assert!((ndcg_at_k(&retrieved, &relevant, 4) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn ndcg_at_k_no_relevant_returns_one_by_convention() {
        let retrieved = ids(&["x", "y"]);
        let relevant = rel(&[]);
        assert_eq!(ndcg_at_k(&retrieved, &relevant, 5), 1.0);
    }

    #[test]
    fn ndcg_at_k_zero_when_no_overlap() {
        let retrieved = ids(&["x", "y", "z"]);
        let relevant = rel(&["a"]);
        assert_eq!(ndcg_at_k(&retrieved, &relevant, 3), 0.0);
    }

    #[test]
    fn ndcg_at_k_penalizes_late_hits() {
        // Hit at position 1 should score higher than a hit at position 3.
        let early = ids(&["a", "x", "y"]);
        let late = ids(&["x", "y", "a"]);
        let relevant = rel(&["a"]);
        let s_early = ndcg_at_k(&early, &relevant, 3);
        let s_late = ndcg_at_k(&late, &relevant, 3);
        assert!(
            s_early > s_late,
            "early {} should beat late {}",
            s_early,
            s_late
        );
        // Specific values: ideal DCG = 1/log2(2) = 1.0.
        // Early DCG = 1/log2(2) = 1.0 → NDCG = 1.0.
        // Late  DCG = 1/log2(4) = 0.5 → NDCG = 0.5.
        assert!((s_early - 1.0).abs() < 1e-9);
        assert!((s_late - 0.5).abs() < 1e-9);
    }

    #[test]
    fn ndcg_at_k_known_value_for_two_hits() {
        // retrieved = [a, x, b, y], relevant = {a, b, c}.
        // DCG@4  = 1/log2(2) + 0 + 1/log2(4) + 0 = 1.0 + 0.5 = 1.5
        // IDCG@4 = 1/log2(2) + 1/log2(3) + 1/log2(4) + 0
        //        = 1.0 + 1/log2(3) + 0.5  (only 3 relevant total, slot 4 empty)
        let retrieved = ids(&["a", "x", "b", "y"]);
        let relevant = rel(&["a", "b", "c"]);
        let dcg = 1.0 / (2.0f64).log2() + 1.0 / (4.0f64).log2();
        let idcg = 1.0 / (2.0f64).log2() + 1.0 / (3.0f64).log2() + 1.0 / (4.0f64).log2();
        let expected = dcg / idcg;
        assert!((ndcg_at_k(&retrieved, &relevant, 4) - expected).abs() < 1e-9);
    }

    #[test]
    fn ndcg_at_k_truncates_to_k() {
        // Same retrieved as known-value test, but k = 1: only "a" considered.
        // DCG@1 = 1.0, IDCG@1 = 1.0, NDCG = 1.0.
        let retrieved = ids(&["a", "x", "b"]);
        let relevant = rel(&["a", "b"]);
        assert!((ndcg_at_k(&retrieved, &relevant, 1) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn ndcg_at_k_dedups_retrieved() {
        // Duplicate "a" must not double-credit. retrieved = [a, a, b], relevant = {a, b}.
        // After de-dup, effective sequence at positions 1..3 is [a, _, b]
        // (slot 2 is a duplicate ⇒ counts as miss for position-2).
        // DCG@3  = 1/log2(2) + 0 + 1/log2(4) = 1.0 + 0.5 = 1.5
        // IDCG@3 = 1/log2(2) + 1/log2(3) (2 relevant only)
        let retrieved = ids(&["a", "a", "b"]);
        let relevant = rel(&["a", "b"]);
        let dcg = 1.0 / (2.0f64).log2() + 1.0 / (4.0f64).log2();
        let idcg = 1.0 / (2.0f64).log2() + 1.0 / (3.0f64).log2();
        let expected = dcg / idcg;
        assert!(
            (ndcg_at_k(&retrieved, &relevant, 3) - expected).abs() < 1e-9,
            "got {}, expected {}",
            ndcg_at_k(&retrieved, &relevant, 3),
            expected,
        );
    }

    #[test]
    fn recall_at_k_empty_relevant_set_returns_one() {
        let retrieved = ids(&["a", "b"]);
        let relevant = rel(&[]);
        assert_eq!(recall_at_k(&retrieved, &relevant, 5), 1.0);
    }

    #[test]
    fn recall_at_k_full_recall() {
        let retrieved = ids(&["a", "b", "c", "d"]);
        let relevant = rel(&["a", "b"]);
        assert!((recall_at_k(&retrieved, &relevant, 4) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn recall_at_k_zero_when_no_overlap() {
        let retrieved = ids(&["x", "y", "z"]);
        let relevant = rel(&["a", "b"]);
        assert_eq!(recall_at_k(&retrieved, &relevant, 3), 0.0);
    }

    #[test]
    fn recall_at_k_partial_recovery() {
        // Top 3 of retrieved = a, x, b → 2 of 3 relevant recovered → 2/3.
        let retrieved = ids(&["a", "x", "b", "y"]);
        let relevant = rel(&["a", "b", "c"]);
        assert!((recall_at_k(&retrieved, &relevant, 3) - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn recall_at_k_truncates_window() {
        // k=2 means only first 2 retrieved are considered; only "a" is in relevant
        // there, so 1 of 3 relevant recovered = 1/3.
        let retrieved = ids(&["a", "x", "b", "c"]);
        let relevant = rel(&["a", "b", "c"]);
        assert!((recall_at_k(&retrieved, &relevant, 2) - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn recall_at_k_zero_when_k_is_zero_with_relevant_present() {
        let retrieved = ids(&["a"]);
        let relevant = rel(&["a"]);
        assert_eq!(recall_at_k(&retrieved, &relevant, 0), 0.0);
    }

    #[test]
    fn recall_at_k_dedups_retrieved() {
        // Duplicates in retrieved must not double-count toward recovered.
        let retrieved = ids(&["a", "a", "x"]);
        let relevant = rel(&["a", "b"]);
        assert!((recall_at_k(&retrieved, &relevant, 3) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn precision_at_k_ignores_duplicates_in_retrieved() {
        // If the same ID appears twice in retrieved (which shouldn't happen in
        // production but might in synthetic fixtures), the second occurrence does
        // not double-count toward precision: 1 unique hit / k = 4 → 0.25.
        let retrieved = ids(&["a", "a", "x", "y"]);
        let relevant = rel(&["a", "b", "c"]);
        assert!((precision_at_k(&retrieved, &relevant, 4) - 0.25).abs() < 1e-9);
    }
}
