# 移行計画 (migration-plan) — 確定版

更新: 2026-04-26 (確定版)
監査対象: `/Users/torutano/ShogunAI3/ShogunAI3`
前提: `docs/memory-architecture/{target-design,proposed-schema.sql}.md`、`docs/memory-audit/`

このドキュメントは設計のみ。実装はしない。

5 stage 構成。Phase 2 内で **Stage 5 (screen 行 retire + physical-delete + VACUUM) まで完結**させる。

---

## §0 ガード（全 stage 共通）

| 項目 | 値 |
|------|----|
| 切替フラグ | `settings.sections.kioku_graph.stage` (`1`〜`5`) と `kioku_graph.read_path` (`legacy` / `graph`) |
| 観測 | `memory_obs::emit` に新キー追加（`extracted_count` / `superseded_count` / `dedup_skipped_count` / `entry_nodes_count` / `traversal_visited_count` / `traversal_depth_max` / `node_kind_counts.*` / `cost_usd_today` / `extraction_queue_pending` 等） |
| ロールバック原則 | Stage 1〜3 は flag/ALTER で戻せる。Stage 2 の capture 経路切替は実質不可（ただし旧コード分岐を残せばロールバック可）。Stage 5 は不可逆。 |
| 既存テスト | `npm run test:e2e` / `cargo test` / `cargo check` / `npm run check:actions` / `npm run check:ipc-mock` を **全 stage の出荷ゲート**にする |

---

## Stage 1 — スキーマ追加 + 評価基盤整備（副作用ゼロ）

**ゴール**: 新スキーマを `memory.db` に展開し、Stage 2 着手前の eval 基盤と decay 重みを確定する。

### Stage 1.1 — DDL 追加

- `mem_items` への ALTER: `valid_from` / `valid_to` / `recorded_at` / `decay_score` / `centrality_score` / `access_count` / `last_accessed_at` / `spatial_context` / `source_capture_id` / `node_kind`
  （`confidence` は Phase 1 で追加済みのため再追加しない）
- 新規テーブル CREATE: `mem_edges` / `mem_captures` / `edge_type_proposals` / `extraction_jobs` / `cost_ledger`
- 追加インデックス: `idx_mem_items_valid_active` / `idx_mem_items_decay` / `idx_mem_items_kind` / `idx_mem_items_recent` / `idx_mem_items_capture` / `idx_mem_edges_*` / `idx_mem_captures_status` / `idx_mem_captures_ttl` / `idx_edge_type_proposals_freq` / `idx_extraction_jobs_*` / `idx_cost_ledger_*`
- 既存行の最低限バックフィル:
  - `node_kind`: `provenance + source` から推定（capture_sampler/capture_ax → `capture_summary`、google_calendar → `event`、gmail → `note`、その他 → `note`）
  - `valid_from = recorded_at = created_at`、`valid_to = NULL`
  - `access_count = 0`、`last_accessed_at = created_at`、`decay_score`/`centrality_score = NULL`（Stage 1.3 で計算）

### Stage 1.2 — fixture セット作成

`tests/fixtures/kioku_eval/` を新設し 50–100 件のサンプル:

- 入力: 既存 `mem_items` の代表的サンプル（screen / connector / meeting / user の各 provenance）+ 合成 capture（AX dump、calendar event、meeting transcript chunk）
- ground truth:
  - 各クエリ（10 件想定）に対する「正しいヒット ID リスト」「不適切なヒット ID リスト」
  - `is_same_fact` テスト用 30 ケース（表記揺れ / 同義表現 / 矛盾 / 別 entity）
  - `same_entity_different_fact` テスト用 15 ケース
- フォーマット: JSONL、1 行 1 サンプル。`tools/amc-pipeline/fixtures/` の既存スタイルに準拠

### Stage 1.3 — decay 重み再調整

- `(w1, w2, w3, w4)` をグリッド探索（各 0.1 刻み、和 = 1.0 制約）
- 評価指標: precision@N / recall@N / NDCG（fixture 上で）
- 確定値を Rust の `pub const DECAY_W1..W4: f32` として `src-tauri/src/decay.rs`（新設）に固定
- 当面の重みは初期値 `(0.4, 0.2, 0.3, 0.1)` のまま、Stage 1 末に確定

### 動くもの / まだ動かないもの

| 動くもの | まだ動かないもの |
|----------|------------------|
| 既存 ingest / search / chat / brief / pack（**完全に従来通り**） | graph traversal（read path 未変更） |
| 新列が NULL またはバックフィル値で埋まっている `mem_items` | 抽出ジョブ（未実装） |
| 新規テーブルが空のまま存在 | decay の継続更新（重みは確定するが算出はまだ） |

### ロールバック

`mem_items` の ALTER 取消 + 新規テーブル DROP。SQLite の ALTER TABLE DROP COLUMN（3.35 以降）対応の前提で書ける。**SQLite バージョン要件確認必須**（rusqlite が bundle する SQLite を確認）。

### 完了条件

- 既存 E2E (`npm run test:e2e`) と Rust テスト（`cargo test` 緑）。
- 既存 `memory.db` を持つ dev / 内部ユーザーで起動エラーが出ない。
- fixture セット 50–100 件が `tests/fixtures/kioku_eval/` に存在し、CI で読み込めることを確認。
- decay 重みの確定値が `decay.rs` に const として存在。

---

## Stage 2 — 抽出 agent + capture 経路切替

**ゴール**: capture 直書きを廃止し、BYOK cloud 抽出ジョブ経由で `mem_items` / `mem_edges` を作る。

### Stage 2.1 — capture 経路切替（不可逆）

- `mem_captures::record(payload)` を実装
  - `(app_bundle_id, window_title, url, raw_text, raw_path, captured_at, ttl_expires_at, spatial_context, filter_meta_json)` を INSERT
  - **§3 §4** の significance filter / batched dedup を経由してから INSERT
- `capture_sampler.rs` / `macos_ax.rs` を **書き換え**:
  - 旧: `memory_store::ingest({source: "capture_sampler" or "capture_ax", ...})`
  - 新: `mem_captures::record(...)` → 必要なら `extraction_jobs::enqueue(capture_id)`
- `LAST_SIG` を **`SigRing`**（in-memory 256 件 + 起動時 `mem_captures` から復元）に置換
- Connector 系（gmail / google_calendar / etc）の `memory_store::ingest` は据え置き（§target-design §3.1 後段の「edge 補完」ジョブのみ enqueue）

### Stage 2.2 — significance filter & batched dedup

- a11y tree diff: 前回 `(app_bundle_id, window_title)` の AX dump と diff 行 < 3 行ならスキップ
- perceptual hash: `simhash64(snippet)`、Hamming 距離 ≤ 4 でスキップ
- dwell_ms 閾値: 5,000 ms 未満ならスキップ
- 30 秒 sliding window で同一 `(app_bundle_id, window_title or url)` を集約

### Stage 2.3 — BYOK cloud 抽出 agent

- 既存 `llm::anthropic_tool_complete`（`llm.rs:553`）を再利用して構造化抽出
- 既定モデル: `claude-haiku-4-5`（`settings.sections.llm.extractionModel` で上書き可）
- tool schema: `ExtractedFactSchema`（fields: `entity_id?` / `entity_name` / `fact_type` / `claim` / `confidence` / `node_kind` / `related_ids?[]` / `edge_type_for_each_related?[]`）
- 出力: `Vec<ExtractedFact>`、各 fact に対して §3.4 conflict resolution

### Stage 2.4 — extraction_jobs ワーカー

- tokio タスク or `tauri::async_runtime::spawn` で `status='queued'` を 1 件ずつ pull
- ネット切断検知: 試行が `reqwest::Error::Connect` 等で連続 3 回失敗したら 60 秒バックオフ後再試行
- リトライ: `attempts < max_attempts` の失敗は `next_attempt_at` を exponential backoff で更新
- `cost_ledger` 記録: 各 API 呼び出し成功時に `(model, input_tokens, output_tokens, cost_usd, purpose='extraction', job_id)` を INSERT
- 月次上限到達時の挙動分岐（§target-design §6.3、§3.6）

### Stage 2.5 — conflict resolution（`is_same_fact` / `same_entity_different_fact`）

- 三段判定（§target-design §3.4）を実装
- Stage 1 fixture の 30 + 15 ケースで unit test 緑
- supersede レート観測: `superseded_count / day` を `memory_obs` で集計

### Stage 2.6 — `decision_graph_hits` 実体化

- `node_kind='decision'` を起点に depth=1〜2 の `follows_up` / `blocks` traversal
- AMC pipeline へは既存 `KiokuHitSchema` / `DecisionGraphHitSchema` の serialization で投入（**`schemas.js` は変更しない**）
- `shogun_brief_get` Rust 実装で `decision_graph_hits` を空配列でなくなるよう供給

### Stage 2 着手前の事前ゲート (Select 確認用)

→ 後段「§Select 確認チェックリスト」参照

### 動くもの / まだ動かないもの

| 動くもの | まだ動かないもの |
|----------|------------------|
| 新 capture 経路（`capture_sampler` → `mem_captures` → `extraction_jobs`） | graph 経由 retrieval（`context_assembly` は legacy のまま） |
| graph 書き込み（`mem_items` upsert + `mem_edges` 生成） | `kioku_rules` の常時注入（Stage 3） |
| `decision_graph_hits` 実体化 | `format_hits_pack_markdown` のクリップ（Stage 3） |
| `cost_ledger` 蓄積、月次上限制御 | screen 行の retire（Stage 5） |
| オフライン耐性 + queue ドレイン | centrality の継続バッチ（Stage 3 と並行で投入） |

### ロールバック

不可（capture 経路の不可逆変更）。ただし `capture_sampler.rs` 内に `kioku_graph.stage <= 1` の分岐を残せば旧経路に戻せる。Stage 2 出荷判定で flag-gate を残す方針を取るか、不可逆として割り切るかは別判断。**本設計では flag-gate を残す**（コード保守コストよりロールバック可能性を優先）。

### 最大リスク

- 抽出 quality の不足 → graph が荒れる（fixture eval で precision/recall ≥ 0.80 を出荷ゲートに）
- `is_same_fact` 誤判定で `valid_to` 爆発 → supersede レート ≤ 5%（新ノード生成数比）を観測
- BYOK コスト想定外 → 典型ユーザー 1 日のキャプチャ量で月額試算（後述）

---

## Stage 3 — read path 切替（A/B フラグ付き）

**ゴール**: graph traversal 経由で context が組まれ、`kioku_rules` が常時注入され、raw が retrieval から消える。

### Stage 3.1 — `context_assembly` の graph 経由パス

- `context_assembly::assemble_via_graph(params)` を新設
  1. Layer 3: vector + lexical で entry nodes 5–10 個
  2. Layer 2: recursive CTE で depth 2–3 traversal
  3. ranker: `path_score * decay_score * relevance` で並べ替え
  4. 上位 N 件の `mem_summaries.title + key_points` を出力
- `assemble_memory_hits` の中で `kioku_graph.read_path == "graph"` なら新パスを呼ぶ
- 既定は `legacy`（A/B 切替の安全側）

### Stage 3.2 — `kioku_rules` 常時注入

- 起動時に `settings.sections.kioku_rules` を in-memory cache（`KiokuRules` static）
- `settings.save` で `kioku_rules` 変更を検知 → reload
- 全 LLM 経路（`chat_complete` / `brief_generate` / `draft_*` / `open_pack` / meeting_recipes）の system prompt 先頭に固定注入
- 文字予算 2,000 chars（超過分は truncated でログ警告）

### Stage 3.3 — `format_hits_pack_markdown` のクリップ

- snippet を 500 chars でクリップ（既存テスト `format_hits_pack_markdown_matches_open_pack_legacy_format` を **更新**: 期待値を新フォーマットに差し替え）
- 旧 Pack ファイルとの byte-for-byte parity は破棄。新規 Pack のみ適用
- 既存ファイルへの後方互換は不要（Pack はその場で生成・参照され配布されないため）

### Stage 3.4 — `brief_generate` の screen 行混入停止

- `assemble_memory_hits` 呼出側で `node_kind != 'capture_summary'` フィルタを既定 ON
- `brief_generate` (`llm.rs:371`) は graph 経由 retrieval を使うよう書き換え
- 直近 15 件固定の挙動は廃止し、graph traversal の上位 N を使う

### Stage 3.5 — decay の継続更新

- on-access: `search` / graph traversal のヒット側で `access_count++ / last_accessed_at=now / decay_score=recompute`
- 1 日 1 回バッチ: dirty ノード周辺の centrality を再計算 + 全現行有効ノードの decay_score を再計算（`embed_backfill.rs` と同様の async タスクで実装）

### 動くもの / まだ動かないもの

| 動くもの | まだ動かないもの |
|----------|------------------|
| graph 経由 retrieval（フラグ ON 時） | 旧 read path 削除（Stage 4） |
| decay フィルタ（entry 抽出） | edge_type の CHECK 制約化（Stage 4） |
| `kioku_rules` の常時注入 | screen 行の retire（Stage 5） |
| Pack の snippet クリップ | physical-delete + VACUUM（Stage 5） |

### ロールバック

flag を `legacy` に切替で即時復帰。最も安全な切戻し点。

### 完了条件

- `kioku_graph.read_path = "graph"` の dev / 内部ユーザーで eval 緑
- `provenance_counts.screen` 比率（traversal 後のヒット）が **20% 以下**
- AMC pipeline で `decision_graph_hits` が空でない brief が出力される
- 既存 E2E + 新規 graph traversal テストが緑

---

## Stage 4 — 旧経路 deprecate + edge_type 値域固定

**ゴール**: legacy read path を削除、`edge_type` を CHECK で固定。

### Stage 4.1 — legacy read path 削除

- `kioku_graph.read_path` フラグを既定 `graph` に
- `assemble_via_graph` 以外のヒット供給ルートを削除
- `chat.complete` の `memoryContext` 文字列直渡しは互換のため残す（クライアントが自前で組んだ場合）

### Stage 4.2 — edge_type の CHECK 制約化

- `edge_type_proposals` を集計し、頻出 top-N + 既知の 8 型（`decided_in` / `follows_up` / `mentions` / `attended` / `blocks` / `derives_from` / `co_occurs_with` / `supersedes`）を採用候補に
- human review: `edge_type_proposals.reviewed = 0` の上位 30 件を Settings UI に出して「採用 / 却下」を選ばせる（簡易レビュー UI）
- 採用された edge_type 集合で `mem_edges` 再構築（`mem_edges` を新テーブル `mem_edges_new` で作り、`edge_type IN (...)` の CHECK を入れて INSERT、SWAP）。`ensure_redaction_nullable` 同様の手法。
- 却下された edge_type を持つ既存 edge は `valid_to=now` で soft-retire（physical-delete はしない）

### Stage 4.3 — 運用ガイドライン

- どの edge_type をどの場面で使うかを `docs/kioku-edge-types.md` に記述（新設、本マイグレーション計画とは別 doc）
- 抽出 agent への system prompt に「採用済み edge_type のみ使え、新型を発明するな」と明記

### 動くもの / まだ動かないもの

| 動くもの | まだ動かないもの |
|----------|------------------|
| graph-only 運用 | screen 行はまだ DB に残存（Stage 5） |
| edge_type の値域固定 | physical-delete + VACUUM（Stage 5） |
| `decision_graph_hits` の安定供給 | — |

### ロールバック

旧 read path コード削除済み → Stage 3 に戻すには git revert + 再ビルド。`edge_type` の CHECK は drop 可能だが、却下された edge_type の生 INSERT を再開しない限り影響なし。

### 完了条件

- `edge_type_proposals` の reviewed 比率 ≥ 90%
- `mem_edges` への新規 INSERT で CHECK 制約違反が起きない（CI で抽出 agent の出力が CHECK を通ることを確認）
- 全 LLM 経路の `provenance_counts.screen = 0`（traversal 後のヒット）が 7 日連続観測

---

## Stage 5 — screen 行 retire + physical-delete + VACUUM (Phase 2 内完結)

**ゴール**: 旧 capture 由来の `mem_items` 行を physical-delete し、`memory.db` のサイズを縮める。

### Stage 5.1 — dry-run バッチ（**Select 確認ゲート**）

実行**前**に必ず dry-run を回し、**Select が結果を確認**するまで本実行に進まない。

- 対象: `mem_items WHERE source IN ('capture_sampler','capture_ax')` と `mem_captures WHERE ttl_expires_at < now`
- 出力（§Stage 5 dry-run 出力項目仕様 参照）

### Stage 5.2 — soft-retire

- 対象 `mem_items` 行に `valid_to = now` を一括 UPDATE
- これだけでも graph traversal / vector entry / Brief 注入から完全に消える（read path はすでに `WHERE valid_to IS NULL` でフィルタしている）
- 1 週間の観測期間を取り、ユーザーフィードバックなしを確認

### Stage 5.3 — `mem_captures` の TTL 経過分の raw 削除

- `WHERE ttl_expires_at < now AND extraction_status = 'done'` の `raw_path` を unlink、`raw_text = NULL`
- `extraction_status = 'expired'` に更新（派生ノードは残す）
- 行自体は削除しない（メタを保持）

### Stage 5.4 — physical-delete

- soft-retire から 30 日経過した行を `DELETE FROM mem_items WHERE valid_to IS NOT NULL AND source IN ('capture_sampler','capture_ax') AND valid_to < (now - 30d)`
- FTS5 トリガーが `mem_items_fts` 側も自動削除
- `mem_edges` は `ON DELETE CASCADE` で連動

### Stage 5.5 — VACUUM

- `VACUUM` 実行で空きページ回収。10〜30% のサイズ削減見込み（実測値は Stage 5.1 dry-run で出す）
- WAL を `PRAGMA wal_checkpoint(TRUNCATE)` で truncate

### 動くもの / まだ動かないもの

| 動くもの | まだ動かないもの |
|----------|------------------|
| クリーンな KIOKU graph | — |
| 縮小した `memory.db` | — |
| 14 日経過 raw の自動削除 | — |

### ロールバック

**不可**（physical-delete のため）。バックアップ推奨 UI を Stage 5 着手前に追加する（`Settings > Memory > Backup`）。

### 完了条件

- dry-run 結果を Select が確認・承認
- 削除後の `memory.db` サイズが想定範囲内（dry-run 見積もり ±10%）
- 全 E2E + cargo test 緑
- 1 週間の観測でユーザー不具合 0 件

---

## §11 リスクと検証項目（stage 横断）

| リスク | 検証 | 判定基準 |
|--------|------|----------|
| SQLite recursive CTE のパフォーマンス（capture 物量 1 日数千件想定） | 合成 fixture で `mem_edges` 10K / 100K / 500K でレイテンシ実測 | 10K で graph traversal ≤ 200 ms、100K で ≤ 600 ms |
| embedding 次元数 × ノード数の latency（10 万ノード） | wide-net を `decay_score >= 0.05` で絞った場合の cosine 計算時間 | entry 抽出 ≤ 300 ms（50K ノード） |
| BYOK 抽出 quality の eval | fixture 50–100 件で precision / recall / F1 計測 | entity F1 ≥ 0.75、relation precision ≥ 0.7（出荷ゲート 0.80） |
| `is_same_fact` 誤判定 | fixture 30 ケース + 観測 supersede レート | unit test 28/30 以上、supersede レート ≤ 5%（新ノード比） |
| BYOK コスト想定外 | Stage 1 末に典型ユーザー 1 日のキャプチャ量で月額試算 | 既定 cap $10/月 内に収まる試算が出ること |
| spatial_context のストレージ膨張 | 1 万ノードでの DB ファイル増加量実測 | ノードあたり overhead ≤ 500 bytes 平均 |
| 既存ユーザーの起動互換 | 旧 `memory.db` を fixture に置き Stage 1 ビルドで `open_conn` 緑 | 起動エラーゼロ、Brief 経路動作確認 |
| graph 化での chat レイテンシ悪化 | フラグ ON/OFF の elapsed_ms 比較 | `chat.complete` P95 増加 ≤ 400 ms |
| オフライン → 復帰の queue ドレイン | 機内モード切替で extraction_jobs 滞留 → 復帰で消化 | 滞留行が復帰後 5 分以内に処理開始 |
| Stage 5 physical-delete の事故 | dry-run 結果を Select が承認するまで本実行しない | dry-run 出力に削除対象 ID 全リスト + storage 削減見込み |

---

## §Select 確認チェックリスト（Stage 2 着手前）

Stage 1 完了時点で以下を **Select に確認**してから Stage 2 に進む。

### A. fixture eval 結果

- [ ] `tests/fixtures/kioku_eval/` に 50–100 件のサンプルが存在
- [ ] **retrieval eval**: `precision@10 ≥ 0.80`、`recall@10 ≥ 0.75`、`NDCG@10 ≥ 0.70`
- [ ] **抽出 quality eval**: `entity F1 ≥ 0.80`、`relation precision ≥ 0.75`、`relation recall ≥ 0.60`
- [ ] eval を回す手順 (`scripts/run-kioku-eval.sh` 等) が CI に組み込まれている

### B. `is_same_fact` テスト

- [ ] **30 ケース**の表記揺れ / 同義表現 / 矛盾 / 別 entity サンプルが unit test 化されている
- [ ] **28/30 以上**で正解（Stage 2 出荷ゲート）
- [ ] **15 ケース**の `same_entity_different_fact` 判定で 13/15 以上
- [ ] 閾値（embedding cosine 0.92 / Levenshtein 0.85 / 0.5）が fixture で再調整され、`decay.rs` 兄弟ファイル `is_same_fact.rs` の const に確定

### C. BYOK コスト試算

- [ ] **典型ユーザー 1 日の capture 量**を観測（既存 dev / 内部ユーザーの `mem_items` 直近 7 日から逆算）
- [ ] significance filter の dedup 率を fixture で実測（dedup 後の抽出ジョブ件数 / 日）
- [ ] **Haiku 4.5 の単価** × 抽出ジョブ件数 / 日 × 30 日 = **月額試算**
- [ ] 試算が `settings.sections.kioku_cost.monthly_cap_usd` の既定値（$10/月想定）内に収まる
- [ ] 上限超過時の `cap_action` 既定値（`pause_extraction` 推奨）を Select が確認
- [ ] 試算結果を `docs/kioku-cost-budget.md`（新設）に保存し PR レビューで承認

### D. Stage 1 出荷確認

- [ ] 全 E2E (`npm run test:e2e`) 緑
- [ ] `cargo test` / `cargo check` 緑
- [ ] 既存 dev / 内部ユーザーの `memory.db` で起動 + Brief 動作確認
- [ ] decay 重み `(w1, w2, w3, w4)` の確定値が `decay.rs` の const に存在
- [ ] 観測項目（`memory_obs::emit` の新キー）が `screens-memory-debug.jsx` で可視化されている

---

## §Stage 5 dry-run 出力項目仕様

`scripts/kioku-stage5-dryrun.sh`（または Rust CLI `cargo run --bin stage5_dryrun`）が**実行ログとして出力**すべき項目。Select は以下の出力を見て本実行を承認する。

### Stage 5 dry-run 出力フォーマット

```
=== KIOKU Stage 5 dry-run ===
generated_at: 2026-MM-DD HH:MM:SS
memory.db path: <abs path>
memory.db size before: 1.23 GB

[1] mem_items soft-retire 対象 (source IN ('capture_sampler','capture_ax')):
    対象行数: N1
    最古 created_at: YYYY-MM-DD
    最新 created_at: YYYY-MM-DD
    provenance 内訳: screen=N (100% 想定)
    embedding を持つ行: 0 (Phase 1 で skip 済の確認)
    既に valid_to が打たれている行: M (これは対象外)

[2] mem_captures TTL 経過 raw 削除対象 (ttl_expires_at < now AND extraction_status='done'):
    対象行数: N2
    raw_path 削除対象 (ファイルシステム上): N2a
    raw_text 削除対象 (NULL 化): N2b
    合計 raw_path のディスク占有: X MB

[3] physical-delete 対象 (valid_to IS NOT NULL AND source IN (...) AND valid_to < now-30d):
    対象行数: N3
    関連する mem_edges (ON DELETE CASCADE で消える): E3
    関連する mem_summaries (target_id 一致): S3 (これらは別テーブルなので残るが UI から見えなくなる)

[4] storage 削減見込み:
    DELETE 後の概算サイズ: 0.85 GB
    VACUUM 後の概算サイズ: 0.72 GB
    削減見込み: 0.51 GB (41%)

[5] 副作用チェック:
    現行有効 mem_items への影響: なし
    mem_summaries への影響: target_id 孤立 = K 件 (UI でフィルタ済み想定)
    AMC pipeline への影響: None (decision_graph_hits は node_kind='decision' から、screen 行は使っていない)

[6] バックアップ推奨:
    本実行前に Settings > Memory > Backup から memory.db のコピーを取ってください
    バックアップ先案: ~/Library/Application Support/ai.Shogun.ShogunAI3/memory.db.pre-stage5-${YYYY-MM-DD}

[警告] 物理削除はロールバック不可です。バックアップなしで実行しないでください。

=== END dry-run ===
```

### 出力項目の意味

| ブロック | 意味 |
|---------|------|
| [1] | Stage 5.2 soft-retire 対象。`valid_to=now` で隠すだけなので可逆 |
| [2] | Stage 5.3 raw 削除。ファイル削除 + 列 NULL 化、行は残る |
| [3] | Stage 5.4 physical-delete 対象。CASCADE で edges も消える。**ロールバック不可** |
| [4] | Stage 5.5 VACUUM 後の見込み。実測値の精度は ±10% |
| [5] | 副作用の事前確認。`mem_summaries` の孤立 target_id は UI 側でフィルタ済みであることを確認 |
| [6] | バックアップ手順。Stage 5 着手前に `Settings > Memory > Backup` を実装する前提 |

### 承認フロー

1. dry-run 出力を `docs/kioku-stage5-${YYYY-MM-DD}-dryrun.txt` として commit
2. Select が PR レビューで承認
3. 本実行は flag `kioku_graph.stage5_apply = true` で gate（既定 false）
4. 本実行後、`memory.db` の実サイズを dry-run 見積もりと比較し ±10% 内であることを確認

---

## §実装 ticket 粒度提案

5 stage を **8〜10 ticket** に分解するのが妥当（1 stage = 1〜3 ticket）。各 ticket は **1 PR**（300〜800 行 diff 想定）で済むサイズに区切る。

| ticket | 対応 stage | スコープ | サイズ目安 |
|--------|-----------|----------|-----------|
| **T1** スキーマ拡張 | Stage 1.1 | `mem_items` ALTER + 5 テーブル CREATE + インデックス + バックフィル | M (400 行) |
| **T2** fixture セット作成 | Stage 1.2 | `tests/fixtures/kioku_eval/` 整備 + eval ハーネス | M (500 行) |
| **T3** decay 確定 + コスト試算 | Stage 1.3 + Select C | grid search スクリプト、`decay.rs` const 確定、コスト試算 doc | S (200 行) |
| **T4** capture 経路切替 | Stage 2.1 + 2.2 | `mem_captures::record`、`SigRing`、batched dedup、`capture_sampler` 書き換え | L (800 行) |
| **T5** 抽出 agent + ジョブワーカー | Stage 2.3 + 2.4 + 2.5 | tool schema、worker、conflict resolution、`is_same_fact` テスト、`cost_ledger` | L (1,000 行) |
| **T6** decision_graph 実体化 | Stage 2.6 | `node_kind='decision'` traversal、AMC `decision_graph_hits` 供給 | M (300 行) |
| **T7** read path 切替 | Stage 3.1 + 3.4 + 3.5 | `assemble_via_graph`、`brief_generate` 改修、decay 継続更新 | L (700 行) |
| **T8** kioku_rules + Pack クリップ | Stage 3.2 + 3.3 | `KiokuRules` cache、Settings UI textarea、`format_hits_pack_markdown` 更新、テスト差替 | M (500 行) |
| **T9** edge_type 固定 + legacy 削除 | Stage 4 | review UI、`edge_type_proposals` 集計、CHECK 制約、legacy パス削除 | M (400 行) |
| **T10** Stage 5 dry-run + 本実行 | Stage 5 全部 | dry-run CLI、`Settings > Memory > Backup`、soft-retire、physical-delete、VACUUM | M (500 行) |

合計 **10 ticket** = 約 5,300 行 diff。1 ticket あたり 1〜3 日 / 1 reviewer の粒度。

### ticket 間依存

```
T1 ─┬─ T2 ─ T3 ─┬─ T4 ─ T5 ─ T6 ─┬─ T7 ─ T8 ─┬─ T9 ─ T10
    │            │                │            │
    └─ Stage 1 ─┘                └ Stage 2 ──┘ └ Stage 3 ─┘ └ S4 ─ S5
```

- T1 → T2 → T3 は順序固定（Stage 1 内）
- T4 → T5 → T6 は順序固定（Stage 2 内、T4 は capture 経路の根本変更で T5/T6 の前提）
- T7 と T8 は並行可能（read path と rules/Pack は独立）
- T9 は Stage 3 完了後（legacy 削除前提）
- T10 は最後（Stage 4 完了 + 30 日 soft-retire 観測期間後）

### 出荷タイミング

- T1〜T3 完了で **Stage 1 内部リリース**（dev / 内部ユーザー）
- T4〜T6 完了で **Stage 2 内部リリース**（出荷ゲート: §Select 確認チェックリスト）
- T7〜T8 完了で **Stage 3 A/B リリース**（フラグ既定 OFF）
- T9 完了で **Stage 4 GA**（フラグ既定 ON）
- T10 完了で **Stage 5 + Phase 2 完了**

---

## §ロールバック総覧

```
Stage 1  →  Stage 2  →  Stage 3  →  Stage 4  →  Stage 5
  ↓          ↓           ↓           ↓           ↓
 ALTER     coderef      flag       git         不可
 取消      残せば可    1 つで戻せる revert       (バックアップ前提)
```

最も安全な切戻し点は **Stage 3 の flag `kioku_graph.read_path = legacy`**。Stage 4 以降に進む前に Stage 3 で十分な観測期間を取ること。
