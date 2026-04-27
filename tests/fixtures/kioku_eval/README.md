# KIOKU eval fixtures

Stage 1.2 deliverable. JSONL files used by `src-tauri/src/kioku_eval.rs` for
retrieval / decay / `is_same_fact` evaluation.

| File | Records | Schema (Rust struct) |
|------|---------|----------------------|
| `nodes.jsonl` | 50+ `mem_items`-shape rows | `kioku_eval::NodeFixture` |
| `captures.jsonl` | 20+ raw capture samples | `kioku_eval::CaptureFixture` |
| `retrieval_queries.jsonl` | 10 queries with `relevant_ids` / `irrelevant_ids` | `kioku_eval::RetrievalQuery` |
| `is_same_fact_cases.jsonl` | 30 pairs with `expected: bool` | `kioku_eval::IsSameFactCase` |
| `same_entity_different_fact_cases.jsonl` | 15 pairs | `kioku_eval::SameEntityDifferentFactCase` |

## Conventions

- One record per non-empty line. Lines beginning with `#` are comments.
- IDs are stable across files: `nodes.jsonl::id` and `retrieval_queries.jsonl::relevant_ids` share a namespace.
- `created_at` / `captured_at` are epoch milliseconds. The corpus uses a 7-day window ending 2026-04-25 so recency tests have realistic spread.
- All textual content is synthetic but plausible (project codenames, calendar events, AX dumps). No real PII.

## How to refresh

When adding nodes, keep counts at or above the lower bounds in the table above (the CI sanity test in `kioku_eval::tests::fixtures_load_with_expected_counts` enforces them). Edit the file in-place; the loader skips blank / comment lines so reorganization is safe.
