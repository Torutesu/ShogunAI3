# 4 つの欠陥チェック (four-flaws)

更新: 2026-06-16（再監査）
前回: 2026-04-26
監査対象: `/Users/torutano/ShogunAI3/ShogunAI3`

Phase 2 KIOKU（`kioku/graph_schema.rs`, `decay.rs`, `graph_traversal.rs`, `decision_graph.rs`）導入後の**差分更新**。2026-04 版の「完全に無し」表現は、スキーマ／コード存在と**本番経路への配線**を分けて再評価する。

---

## 1. 一覧表（2026-06-16 再評価）

| 欠陥 | 2026-04 評価 | 2026-06 現状 | 深刻度 | 主な該当箇所 |
|---|---|---|---|---|
| **重複除去** | 部分的のみ | **改善（capture upsert）＋未完了（意味的重複）** | **high** | `memory_store.rs:1229` (`ingest_capture_upsert`); `capture_sampler.rs:418`; `kioku/capture.rs` (SimHash, **flag OFF 既定**); `idx_mem_items_entity_unique` |
| **減衰** | 完全に無し | **スキーマあり・配線部分的** | **mid→high** | `graph_schema.rs:37–48` (列追加); `decay.rs` (純関数); `graph_traversal.rs:285+` (`bump_access_for_hits`); `context_assembly.rs:243` (`assemble_via_graph` 経路のみ) |
| **ランキング** | FTS + cosine のみ | **グラフ経路は複合スコア、レガシー経路は薄いまま** | **mid** | `graph_traversal.rs:212` (`rank_subgraph_hits`); `memory_store.rs` FTS/cosine; `brief.get` は依然 `created_at DESC` 系 |
| **関係性追跡** | 完全に無し | **スキーマ＋抽出パイプライン着手、UI/Brief 本番未接続** | **mid→high** | `graph_schema.rs:81` (`mem_edges`); `decision_graph.rs:50`; `commands/kioku.rs`; `extraction.rs` |

---

## 2. 2026-04 → 2026-06 の主な変化

### 2.1 重複除去 — 部分解決

**新規／改善:**
- `ingest_capture_upsert` — `(source, entity_id)` で `ON CONFLICT DO UPDATE`（`memory_store.rs:1229+`）。capture 系は **entity_id 必須**の upsert 経路に移行。
- `capture_sampler` / `macos_input` / `meeting/memory` が upsert 経由に接続。

**残課題:**
- `entity_id` 無しの自由入力 ingest は append-only のまま。
- `kioku/capture.rs` の SimHash シグネチャリングは **`capture_to_mem_captures` フラグ OFF 既定** — 本番 capture フローには未接線。
- 意味的重複（言い回し違い・同一事実）は未対応。KIOKU supersession（Phase 2 Stage 4+）待ち。

### 2.2 減衰 — スキーマ完成、本番 search への全面適用は未了

**追加済み列** (`graph_schema.rs`):
`valid_from`, `valid_to`, `recorded_at`, `decay_score`, `centrality_score`, `access_count`, `last_accessed_at`, …

**配線状況:**
| 経路 | decay 利用 |
|---|---|
| `assemble_via_graph` (chat / graph retrieval) | ✅ entry ノード decay 閾値、`bump_access_for_hits` |
| `memory.search` / FTS5 / semantic rerank | ❌ 時間項・decay 項なし |
| `brief.get` 直近 15 件 | ❌ `created_at DESC` のみ |
| MCP `kioku_search` | ✅ graph traversal + ranker |

`decay.rs` は Stage 1 純関数モジュール。日次 centrality バッチ等は migration-plan Stage 3 残。

### 2.3 ランキング — 二系統

- **KIOKU graph 経路:** `path_score × decay × similarity`（`graph_traversal.rs:212–241`）。
- **レガシー経路:** FTS5 BM25 + optional cosine。provenance bias / confidence bias は graph ranker 外。

Morning Brief の AMC 入力は `commands/kioku.rs` 経由で `decision_graph_hits` / `kioku_hits` を返せるが、**Brief 生成のデフォルト経路が graph 経路に切り替わったかは要確認**（2026-06 時点: `brief_generate` は依然 context_assembly のレガシー assemble が主）。

### 2.4 関係性追跡 — 基盤あり、エンドツーエンド未完了

**存在するもの:**
- `mem_edges` テーブル + FK（`graph_schema.rs:81–92`）
- `decision_graph.rs` — AMC `DecisionGraphHitSchema` 互換の Rust producer（2026-04 の「0 件」は解消）
- `extraction.rs` — 抽出ジョブから edge 挿入
- Meeting Phase 4 — transcript → extraction enqueue

**未完了:**
- Brief / Morning Brief UI が `decision_graph_hits` を**常時**消費しているわけではない
- `mem_items ↔ meetings` の明示リンクは meeting 列 (`meeting_id`) 程度
- `mem_summaries.target_id` は依然文字列参照（FK 無し）

---

## 3. 二次的欠陥（2026-06 追記）

| 項目 | 2026-04 | 2026-06 |
|---|---|---|
| bi-temporal | ナシ | **列追加済**（valid_from/valid_to/recorded_at）— 書き込み経路は段階的 |
| TTL / retention | ナシ | capture 30 日 cleanup（MVP blocker 対応済）— graph ノード全体の TTL は未 |
| vector index | ナシ | 変更なし（wide-net cosine） |
| 抽出層 | ナシ | **extraction_jobs + mem_captures** 着手 — flag / ジョブ完了率は要計測 |
| spatial | ナシ | `spatial_context` 列のみ — Phase 3 待ち |

---

## 4. 優先改善（2026-06 版 top 3）

1. **レガシー retrieval → graph retrieval の切替** — chat / brief / pack で `assemble_via_graph` を既定化し、decay / edges をユーザー価値に接続。
2. **capture 意味的重複 + supersession** — upsert 後も残る screen ノイズを KIOKU Stage 4 で圧縮。
3. **decision_graph → Brief 配線** — ✅ `brief.rs` が `morning_brief_v2_*` で KIOKU signals を merge。`shogun_kioku_brief_signals` は共通 helper 経由。

---

## 5. 検証コマンド

```bash
npm run check:rust
cargo test --manifest-path src-tauri/Cargo.toml kioku
npm run test:unit   # entitlement, graph pure fns
npm run test:e2e    # entitlement-gate, mcp-setup-gate specs
```

関連: [`current-retrieval.md`](./current-retrieval.md)（注入経路）、[`../memory-architecture/migration-plan.md`](../memory-architecture/migration-plan.md)
