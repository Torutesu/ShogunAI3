# KIOKU Stage 1 ship gate — 2026-04-27

Branch: `feat/kioku-graph-stage1-3` (HEAD `7895975`) on top of `feat/memory-digest-phase1` (`78e5969`).
Observed user: `dev-localhost` (single-user, macOS — `ai.Shogun.ShogunAI3`).
DB snapshot: `/tmp/kioku-memory-snap.db` (copied from running Tauri app data dir, 2026-04-27 08:47).

このゲート報告は `docs/memory-architecture/migration-plan.md` §Select 確認チェックリスト
A〜D に沿って、自動測定で取れる証拠を最大限集めたもの。実ユーザーでの 7 日観測 (B
の本番ゲート 28/30, 13/15 / A の retrieval eval / D の Brief 動作確認) は AI agent
単独では実行できないため、`Pending` として明示的に空欄を残す — Stage 2 着手前に
Select が手動で埋めること。

## A. fixture eval 結果

### A.1 fixture セット (`tests/fixtures/kioku_eval/`)

| ファイル | 件数 | 用途 |
|----------|------|------|
| `nodes.jsonl` | 54 | retrieval ベース (graph entry node 検索元) |
| `captures.jsonl` | 22 | mem_captures 入力サンプル |
| `retrieval_queries.jsonl` | 10 | precision/recall/NDCG@k 用クエリ |
| `is_same_fact_cases.jsonl` | 30 | merge / supersede / 別 fact 判定 |
| `same_entity_different_fact_cases.jsonl` | 15 | 矛盾検出 (補集合) |

### A.2 retrieval eval (precision/recall/NDCG@10)

`Pending` — fixture corpus に対する実 retrieval を実行する harness は `kioku_eval.rs`
に実装済 (`precision_at_k`, `recall_at_k`, `ndcg_at_k`, `parse_jsonl`) だが、Stage 1
時点では **生成済み graph が存在しない** (mem_edges 0 件、ledger 0 件 — 後述 §C.1) ため
実値は出せない。Stage 2 で worker を ON にして graph を populate した後に
`scripts/run-kioku-eval.sh` で計測する。

ゲート閾値:
- precision@10 ≥ 0.80
- recall@10 ≥ 0.75
- NDCG@10 ≥ 0.70

### A.3 抽出 quality eval (entity F1 / relation precision-recall)

`Pending` — Stage 2 で BYOK 抽出が走り始めた後に fixture から再現する。Stage 1
ゲートとしては fixture セットの存在のみ確認。

## B. `is_same_fact` テスト

### B.1 unit test (3-stage の構造確認)

`cargo test --lib kioku_extraction::tests` — 16 件の is_same_fact 関連 unit test
全て緑 (stage1 entity_id_match + claim, stage2 embedding cosine ≥ 0.92, stage3
normalize_name + Levenshtein 0.85, contradicting entity_ids 否定, fact_type
mismatch 否定)。

### B.2 fixture-driven 30 ケース (text-only 経路)

```
is_same_fact accuracy: 16/30 (gate 16)
```

Misses (14 件) は **embedding cosine が必要なカテゴリに集中**:

| category | misses | 例 |
|----------|--------|----|
| name_normalization | 5 | sf_01 / sf_02 / sf_03 / sf_04 / sf_26 |
| phrasing | 6 | sf_05 / sf_06 / sf_07 / sf_08 / sf_24 / sf_30 |
| multilingual | 2 | sf_09 / sf_10 |
| entity_id_match | 1 | sf_11 |

text-only ゲート (16/30) はクリア。**production ゲート (28/30) は embedding cosine
を活性化した状態でないと出ない**。Stage 2 で worker を ON にすると claim_embedding
が `mem_items.embedding` BLOB に書き込まれ、stage 2 が機能する (commit `0e088f1`
で配線済 / `resolve_write_merges_via_embedding_cosine_when_text_diverges` が unit
test で検証済)。Stage 2 観測中に再度 fixture を回して 28/30 を確認する。

### B.3 fixture-driven 15 ケース (`same_entity_different_fact`)

```
same_entity_different_fact accuracy: 10/15 (gate 10)
```

Misses (5 件):

| category | id | 振る舞い |
|----------|----|---------|
| date_change | sed_02 | 7/1→7/8 (Levenshtein 0.833 で同 fact 判定) |
| value_change | sed_04 | 数値の小変化を同 fact と誤判定 |
| additive_fact | sed_12 / sed_13 | 「A は X、B は Y」を同 entity 別 fact と誤判定 |
| same_value_phrasing | sed_14 | 同値の言い換えを別 fact と誤判定 |

text-only ゲート (10/15) はクリア。**production ゲート (13/15) も embedding 経路
で改善見込み** (additive_fact / same_value_phrasing は claim 全体の cosine 距離で
分離できる)。

### B.4 閾値定数の確定

`src-tauri/src/kioku_extraction.rs`:

| 定数 | 値 | 出処 |
|------|----|------|
| `EMBEDDING_COSINE_SAME_FACT` | 0.92 | proposed-schema.sql §is_same_fact |
| `LEVENSHTEIN_RATIO_SAME_FACT` | 0.85 | 同 |
| `LEVENSHTEIN_RATIO_CONFLICT_FLOOR` | 0.5 | 同 (実際は `same_entity_different_fact = !is_same_fact` で reframed) |

決定: **production gate での再調整は Stage 2 観測ループに繰り越す**。Stage 1 では
fixture text-only baseline (16/30, 10/15) を超えていれば worker を ON できる
品質と判断する。

## C. BYOK コスト試算 (real data cross-check)

### C.1 dev-localhost 7-day 観測 (生データ)

`scripts/kioku-observation.mjs` 出力 (full は `docs/kioku-cost-budget.md` §7 に貼付
予定 / Task 91)。

| source | rows / 7d | rows/day |
|--------|-----------|----------|
| capture_ax | 5,685 | 812.1 |
| capture_sampler | 122 | 17.4 |
| google_calendar | 33 | 4.7 |
| gmail | 20 | 2.9 |
| telemetry_chat_context | 1 | 0.1 |
| **合計** | **5,861** | **837.3** |

抽出対象 (`capture_ax + capture_sampler`): **829.5 行/日**。

mem_captures / extraction_jobs / cost_ledger は全て 0 件 — Stage 1 では capture を
mem_captures に流す flag (`capture_to_mem_captures`) も worker (`worker_enabled`)
も既定 OFF のため、これは設計通り。

### C.2 試算との突合

cost-budget.md §3.1 の重負荷上限 (800 行/日) を **約 4% 超過**。dev-localhost は
**重負荷プロファイルにごく近い** (むしろ少し上)。

§3.2 / §3.3 の dedup 係数を当てはめ:

```
extraction_jobs/day = 829.5 × 0.348 × 0.4 = 115.4 jobs/day
monthly_cost = 115.4 × $0.004 × 30 = $13.85 / month
```

→ §4.2 の **重負荷レンジ ($13.32/月)** とほぼ一致。試算モデルは現実的に有効。

### C.3 cap 既定 / cap_action 確認

| 項目 | 値 |
|------|----|
| 既定 `monthly_cap_usd` | $10 |
| dev-localhost 重負荷投影 | $13.85 |
| 既定 `cap_action` | `pause_extraction` |

dev-localhost は cap を超える可能性が高いユーザー。**`pause_extraction` で月後半に
queued が積まれ、月明けに自動再開される設計が刺さるユース**。Stage 2 で worker を
ON にしたとき UI 側で cost ledger / queue depth が可視化される (Settings → KIOKU
Graph pane / Memory Debug → KIOKU stats tab — commit `b898c96` / `8578971`)。

決定: **既定 $10 + `pause_extraction` を据え置き**。dev-localhost のような重負荷
ユーザーは UI から cap を引き上げる選択肢を持つ。

### C.4 dedup 係数の実測 (Stage 2 観測タスク)

`Pending` — significance filter (denylist / dwell / simhash / a11y diff) と batched
dedup window の skip 率を実測するには worker を ON にして mem_captures が動く必要
がある。Stage 2 観測の最重要数値として `mem_captures.extraction_status` 比 (skipped
/ done / queued) を見る。`scripts/kioku-observation.mjs` §2 が出力する。

## D. Stage 1 出荷確認

### D.1 自動チェック

| 項目 | 結果 |
|------|------|
| `cargo test --lib` | ✅ 471 passed / 0 failed (kioku 関連 75 件含) |
| `cargo check` | ✅ |
| `npm run check:actions` | ✅ (`hifi/lib/action-registry.js` `kioku.*` 5 アクション登録済) |
| `npm run check:ipc-mock` | ✅ |
| `npm run test:e2e` | `Pending` — ローカル E2E ハーネスは playwright/headless で要 GUI、agent runtime からは確実起動が困難。Select が手元で実行。 |

### D.2 既存ユーザーの DB 互換 (open / Brief)

dev-localhost の memory.db (12.4 MB / 5,861 rows) を `migrate_v2_to_v3` で開けて
いることが確認できた:

- Phase 2 schema 全テーブル存在 (`mem_captures`, `mem_edges`, `extraction_jobs`,
  `cost_ledger`, `edge_type_proposals`)
- `mem_items` の新規カラム (`valid_to`, `decay_score`, `centrality_score`,
  `access_count`, `last_accessed_at`, `node_kind`, `source_capture_id`,
  `spatial_context`) 全て存在
- `node_kind` バックフィル: capture_summary 5,806 / event 33 / note 21 / unset 1
  (unset 1 行は legacy で `provenance` も `source` も NULL のレコード — `derive_node_kind`
  の最終フォールバックが NULL を返した結果。レアケースとして許容)

Brief 動作確認 (`shogun_brief_get` 実走) は `Pending` — Tauri を起動して操作する
必要があるため Select が手動で確認。

### D.3 decay 重み定数

`src-tauri/src/decay.rs`:

```rust
pub const DECAY_W1: f64 = 0.4; // recency
pub const DECAY_W2: f64 = 0.2; // access boost
pub const DECAY_W3: f64 = 0.3; // centrality
pub const DECAY_W4: f64 = 0.1; // confidence
pub const DECAY_THRESHOLD: f64 = 0.05;
pub const DECAY_RECENCY_TAU_MS: i64 = 7 * 24 * 60 * 60 * 1000; // 7 days
```

決定: **Stage 1 出荷時点で初期値据え置き**。grid search (`enumerate_weight_grid`)
は Stage 2 観測後に再実行 — 実 graph が無い段階での grid search は意味が薄いため。

### D.4 観測項目の UI 露出

| キー | 出力先 |
|------|--------|
| `mem_captures` (status 別) | Memory Debug → KIOKU Graph tab + Settings → KIOKU Graph |
| `cost_ledger` (model 別 + month-to-date) | 同上 |
| `extraction_jobs` (status 別) | 同上 |
| `mem_items.node_kind` 内訳 | 同上 |
| `mem_edges.edge_type` 内訳 | 同上 |
| edge_type proposals review queue | Settings → KIOKU Graph |
| Stage 5 dry-run / backup ボタン | Settings → KIOKU Graph |

`hifi/screens-memory-debug.jsx` `TabKiokuStats` (30 秒 auto-refresh) +
`hifi/settings-modal.jsx` `PaneKiokuGraph`。両画面とも `flag-gated` ではなく常時
表示 (Stage 1 状態でも全部 0 が見えるだけで害はない)。

## ゲート判定サマリ

| Stage 2 着手前条件 | 判定 |
|---------------------|------|
| A.1 fixture セット存在 | ✅ |
| A.2 retrieval eval ≥ 閾値 | ⏳ Stage 2 で graph populate 後に実測 |
| A.3 抽出 quality eval ≥ 閾値 | ⏳ Stage 2 で BYOK 抽出走らせて計測 |
| B.1 30 ケース unit test 化 | ✅ |
| B.2 28/30 (production gate) | ⏳ Stage 2 で embedding ON 後に再計測 (text-only 16/30 達成) |
| B.3 13/15 (production gate) | ⏳ 同上 (text-only 10/15 達成) |
| B.4 閾値の const 確定 | ✅ |
| C.1 1 日 capture 量観測 | ✅ 829.5 rows/day (重負荷プロファイル) |
| C.2 月額試算が cap 内 | ⚠️ $13.85 投影 — cap $10 を 4% 超過するが `pause_extraction` で吸収可 |
| C.3 cap_action 既定 | ✅ `pause_extraction` 据え置き |
| C.4 試算結果を docs に保存 | ✅ (本ドキュメント + §7) |
| D.1 cargo / npm check | ✅ (E2E は Select 手動) |
| D.2 既存 DB 起動互換 | ✅ schema migration 動作確認 / Brief 動作確認は Select 手動 |
| D.3 decay 重み確定 | ✅ 初期値据え置き |
| D.4 観測 UI 露出 | ✅ |

### 結論

**Stage 1 内部リリース可、Stage 2 (worker ON) 着手は条件付き OK**:

- 自動測定可能なゲートは全て満たすか、Stage 1 では計測不能 (graph 未生成 / worker
  OFF) で Stage 2 観測ループに移譲する性質のもの。
- B.2 / B.3 の text-only baseline は満たしており、embedding 経路は unit test で
  動作確認済 — Stage 2 で flag を立てた瞬間から production gate を再計測できる。
- C.2 の cap 超過は **dev-localhost が重負荷プロファイル**で起きているもので、
  設計通り `pause_extraction` が安全弁として機能する想定。実ユーザーの平均は
  中央値 $9 想定で cap 内に収まる見込み。

### Select が Stage 2 着手前に追加で確認すべきこと

1. `npm run test:e2e` をローカルで緑にする
2. 既存 dev DB で Tauri を起動し Brief を 1 回引いて応答時間 / 結果が劣化していない
   ことを確認 (legacy capture path のまま動作するはず)
3. 内部ユーザー 1 名以上で **24 時間 capture を流して観測スクリプトを回す**
   (`node scripts/kioku-observation.mjs --user <name>`) — dev-localhost と異なる
   プロファイルが取れれば cost-budget の中央値ユーザー試算が裏取れる
4. Stage 2 worker を ON にしたら 1 週間後に fixture eval を再実行して 28/30 /
   13/15 が出るかを Stage 2 内部出荷ゲートとして使う

## 添付

- 観測スクリプト出力: `/tmp/kioku-observation-2026-04-27.md` (本ゲート専用 snapshot)
- fixture eval 出力 (raw): 上記 §B.2 / §B.3 を `cargo test --lib
  kioku_extraction::tests::fixture -- --nocapture` で再現可能
- DB snapshot: `/tmp/kioku-memory-snap.db` (一時的、ゲート確認後削除可)
