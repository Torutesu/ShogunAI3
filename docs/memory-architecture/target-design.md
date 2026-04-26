# KIOKU 三層アーキテクチャ — 確定版設計 (target-design)

更新: 2026-04-26 (確定版)
監査対象: `/Users/torutano/ShogunAI3/ShogunAI3`
前提監査: `docs/memory-audit/{vocabulary,persistence-layers,current-state,current-schema.sql,current-retrieval,four-flaws}.md`
前提仕様: `docs/context-layer-phase-0-1.md`（Phase 0/1 実装済）

このドキュメントは**設計と擬似コードのみ**。実装はしない。
語彙はリポジトリの既存語彙（**KIOKU** / `mem_items` / `provenance` / `entity_id` / `decision_graph` / `KiokuHitSchema` / `context_assembly`）で統一する。

---

## §0 確定済み判断 (Select 判断要約)

| 項目 | 判断 |
|------|------|
| 永続化 | **SQLite (rusqlite + WAL + FTS5)**。PGLite / pgvector / Neo4j は使わない |
| 抽出 agent | **BYOK cloud 一本（Haiku 4.5 既定）**。ローカル LLM は採用しない |
| `SHOGUN-AI` (PGLite 別リポ) との統合 | **当面なし**。本設計は ShogunAI3 単独で完結 |
| Stage 5 (screen 行 physical-delete + VACUUM) | **Phase 2 内で完結**。dry-run バッチを必須前段に |
| `kioku_rules` 配置 | `settings.json` の `sections.kioku_rules`、UI は **Settings > Memory > Rules** の textarea |
| `kioku_rules` import/export | Phase 2 では実装しない（ファイル直編集で対応） |
| `edge_type` 値域 | Stage 2 では文字列自由、`edge_type_proposals` で蓄積、Stage 4 末で頻出 top-N を `CHECK` 化 |
| decay 重み初期値 | `w1=0.4, w2=0.2, w3=0.3, w4=0.1`、threshold `< 0.05`、Stage 1 で fixture により再調整 |
| spatial 列 | 単一 `spatial_context TEXT` (JSON) を最初から確保。macOS 2D phase は `display_id` / `window_bounds` / `dwell_ms` のみ populate、他 null 運用 |

---

## §1 三層構造

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1 — KIOKU Rules (file)                                        │
│   place : settings.json の sections.kioku_rules 配列                │
│   schema: YAML frontmatter + markdown body                          │
│   write : ユーザー明示のみ (Settings > Memory > Rules の textarea) │
│   read  : 起動時 + 設定変更時のみ (in-memory cache)                 │
│   inject: 常時 system prompt 先頭                                   │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2 — KIOKU Graph (SQLite, memory.db)                           │
│   nodes : mem_items (既存 + 列追加)                                 │
│   edges : mem_edges (新規)                                          │
│   raw   : mem_captures (新規、抽出前の生キャプチャ)                 │
│   meta  : mem_summaries (Phase 1 既存維持)                          │
│   ops   : edge_type_proposals / extraction_jobs / cost_ledger (新規)│
│   bi-temporal: valid_from / valid_to / recorded_at                  │
│   decay : w1*recency + w2*log(1+access_count) + w3*centrality       │
│           + w4*confidence                                           │
│   spatial: spatial_context TEXT (JSON) — Phase 3 visionOS 布石       │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 3 — Semantic Vectors                                          │
│   place : mem_items.embedding BLOB (Phase 1 既存)                   │
│   role  : graph entry node 特定のみ                                 │
│   skip  : capture 由来は embedding 不要                             │
│           (memory_store.rs:966 の現状維持。capture は mem_captures に隔離) │
└─────────────────────────────────────────────────────────────────────┘
```

### §1.1 Layer 1 — KIOKU Rules

**保存形式（`settings.json`）:**

```jsonc
{
  "sections": {
    "kioku_rules": [
      {
        "id": "rule_${uuid}",
        "yaml": "title: I work in JST\nscope: [chat, brief, draft]\nalways_inject: true",
        "body": "Always interpret bare times as Asia/Tokyo unless explicitly stated.\n...",
        "created_at": 1714152000000,
        "updated_at": 1714152000000
      }
    ]
  }
}
```

UI は **Settings > Memory > Rules** に simple textarea。1 ルール = 1 textarea ブロック。
YAML frontmatter は textarea の最初の `---` ブロック。残りが body。

**注入経路（全 LLM 経路で共通）:**

```
[system] (always honored, do not contradict)
- I work in JST: Always interpret bare times as Asia/Tokyo ...
- ...
```

文字予算: ルール側合計 ≤ 2,000 chars。残りは Layer 2 用。

### §1.2 Layer 2 — KIOKU Graph

`memory.db` 内に：
- ノード = `mem_items`（既存テーブルに新列を ALTER で追加）
- エッジ = `mem_edges`（新規）
- 抽出前の raw = `mem_captures`（新規、screen 由来は mem_items に直書きしない）
- LLM 注入用要約 = `mem_summaries`（Phase 1 既存）
- 運用テーブル = `edge_type_proposals` / `extraction_jobs` / `cost_ledger`

詳細は **§2 と `proposed-schema.sql`** 参照。

### §1.3 Layer 3 — Semantic Vectors

- 既存 `mem_items.embedding` BLOB（f32 LE 連結、L2 正規化、`text-embedding-3-small` の 1536 次元）をそのまま使う。
- 独立した vector store / sqlite-vec 拡張は導入しない。
- vector search の役割は **graph entry node 5–10 個の特定** に限定。
- `capture_sampler` / `capture_ax` の embedding skip（`memory_store.rs:966`）は維持。screen 由来の raw は `mem_captures` に隔離されるため、`mem_items.embedding` は抽出済みノードのみ持つ。

---

## §2 提案スキーマ概要

完全な DDL は `proposed-schema.sql` 参照。

### §2.1 `mem_items` への列追加

`docs/context-layer-phase-0-1.md` で既に追加済の `provenance` / `entity_id` / `confidence` / `redaction` / `embedding` は維持。**Phase 2 で追加**するのは:

| 列 | 役割 |
|----|------|
| `valid_from` | bi-temporal: 事実が真である期間の開始 |
| `valid_to` | bi-temporal: 終端（NULL = 現行有効） |
| `recorded_at` | この行が DB に書かれた時刻（`created_at` と同義に倒してよい） |
| `decay_score` | §5 decay model の合算スコア |
| `centrality_score` | edge weight 込みの degree（バッチ計算） |
| `access_count` | 検索ヒット時 +1 (DEFAULT 0) |
| `last_accessed_at` | アクセス時に更新 |
| `spatial_context` | TEXT (JSON)。display_id / window_bounds / dwell_ms / window_pose / gaze_target を 1 列に集約 |
| `source_capture_id` | 抽出元 `mem_captures.id`（NULL = 抽出由来でない） |
| `node_kind` | `entity` / `event` / `decision` / `task` / `note` / `capture_summary`。`kinds_json` の補助列として明示。graph filter で頻用 |

### §2.2 新規テーブル

| テーブル | 役割 |
|----------|------|
| `mem_edges` | ノード間の有向関係（`from_node` / `to_node` / `edge_type` / `weight` / bi-temporal）。`decision_graph` の実体 |
| `mem_captures` | 抽出前の生キャプチャ（screen / a11y / audio）。raw_path を持ち、14 日 TTL で raw を消す |
| `edge_type_proposals` | 抽出 agent が出した `edge_type` の蓄積。Stage 4 末で頻出 top-N を CHECK 制約に固定 |
| `extraction_jobs` | BYOK cloud 抽出キュー。`status: queued/running/done/failed/expired`、リトライ管理、オフライン耐性 |
| `cost_ledger` | BYOK 呼び出しコスト追跡。`(timestamp, model, input_tokens, output_tokens, cost_usd, job_id)` |

### §2.3 既存維持

`mem_summaries` / `mem_dead_letter` / `meeting_*` / `mem_items_fts` (FTS5 仮想テーブル + トリガー) はそのまま。

`idx_mem_items_entity_unique`（部分 UNIQUE on `(source, entity_id) WHERE entity_id IS NOT NULL`）は維持。capture 行は `mem_captures` に隔離されるため、`entity_id IS NULL` の重複問題は構造的に消える。

---

## §3 Write Path

### §3.1 全体フロー

```
[capture trigger: capture_sampler / macos_ax / connector / 手動]
  │
  ├─ capture_sampler / macos_ax の場合:
  │   ↓ mem_captures::record (現状の memory_store::ingest 直書きを廃止)
  │   ↓ §3.2 significance filter で raw を弾く
  │   ↓ §3.3 batched dedup window (30 秒) で集約
  │   ↓ extraction_jobs に enqueue
  │
  ├─ connector (gmail / google_calendar / etc) の場合:
  │   ↓ 従来通り memory_store::ingest 直書き (entity_id あり、構造化済み)
  │   ↓ ただし node_kind を明示 (calendar→event, gmail→note 等)
  │   ↓ extraction_jobs に「edge 補完」ジョブを enqueue (関連ノードへの紐付け)
  │
  ↓
[extraction worker]
  ↓ extraction_jobs.status='queued' を pull
  ↓ オフライン検知: ネット切断中は待機 (queue は積み上がる)
  ↓ §6 cost_ledger 上限チェック → 超過時の挙動分岐
  ↓ BYOK cloud (Haiku 4.5 既定) で構造化抽出 (Anthropic tool_use)
  ↓ 出力: ExtractedFact[] = { entity_name, fact_type, claim, related_ids?, edge_type? }
  ↓ cost_ledger に呼び出しコスト記録
  ↓
[per ExtractedFact]
  ↓ §3.4 conflict resolution (is_same_fact / same_entity_different_fact)
  ↓ insert / update / supersede / link
  ↓ 影響を受けたノード周辺を centrality dirty-mark
  ↓
[centrality batch (1日1回)]
  ↓ dirty 周辺のみ再計算
```

### §3.2 Significance Filter（capture 直前に raw を弾く）

`capture_sampler.rs:28` の `LAST_SIG`（前回 1 件分の hash）では不十分なので、本格的な層に置き換える。判定要素:

| 要素 | 説明 | 既存基盤 |
|------|------|----------|
| **a11y tree diff** | 前回 ingest した同 `app_bundle_id + window_title` の AX dump と diff。差分行 < 3 行ならスキップ | `macos_ax::AxFields` を fingerprint 化 |
| **perceptual hash** (テキスト) | snippet の SimHash 64bit。直近 N 件の hash と Hamming 距離 ≤ 4 ならスキップ | 既存 `LAST_SIG` の置換 |
| **dwell_ms 閾値** | ウィンドウフォーカスが 5 秒未満（瞬間的な切替）はスキップ | macOS notification ベース、`spatial_context.dwell_ms` に蓄積予定 |
| **app/url denylist** | `settings.sections.privacy.excludedApps` / `excludedSites` に該当はスキップ | 既存 |

擬似コード:

```rust
fn should_capture(payload: &CapturePayload, sig_ring: &SigRing) -> SkipReason {
    if denylisted(payload) { return SkipReason::Privacy; }
    if payload.dwell_ms.unwrap_or(0) < 5_000 { return SkipReason::ShortDwell; }
    let sim = simhash64(&payload.snippet);
    if sig_ring.has_near(sim, /*hamming=*/ 4) { return SkipReason::NearDup; }
    if let Some(prev) = sig_ring.last_for(&payload.app_bundle_id, &payload.window_title) {
        if a11y_diff_lines(&prev.ax_dump, &payload.ax_dump) < 3 { return SkipReason::TrivialDiff; }
    }
    SkipReason::None
}
```

`SigRing` は in-memory + プロセス再起動時に最新 ~256 件を `mem_captures` から復元。`LAST_SIG` の「前回 1 件しか覚えない」問題を解消。

### §3.3 Batched Dedup Window（30 秒）

`mem_captures` への INSERT を 30 秒の sliding window で集約：

- 同一 `(app_bundle_id, window_title or url)` の連続キャプチャは 1 件に畳む
- 集約 row の `captured_at` は窓開始時刻、`dwell_ms` は窓内合計
- 窓終了時に 1 件のみ enqueue → 1 抽出ジョブ = 1 BYOK 呼び出し

理由: BYOK cost を抑える + 抽出 quality（窓内コンテキストを LLM に渡せる）が両立。

### §3.4 Conflict Resolution

抽出 agent からの `ExtractedFact` ごとに:

```rust
fn resolve_write(fact: ExtractedFact, conn: &Connection) -> Result<NodeId> {
    let candidates = find_candidates(&fact, conn)?;
    // find_candidates 内部:
    //   1. fact.entity_id があれば mem_items WHERE entity_id = ?
    //   2. fact embedding と cosine top-5 (decay_score >= 0.05 の現行有効ノードのみ)
    //   3. normalized_name 完全一致 (lowercase + NFKC + diacritic strip)

    if let Some(existing) = candidates.iter().find(|c| is_same_fact(c, &fact)) {
        // ── 同一: access_bump
        bump_access(existing.id, conn)?;
        link_capture(fact.source_capture_id, existing.id, "derives_from", conn)?;
        return Ok(existing.id.clone());
    }
    if let Some(conflict) = candidates.iter().find(|c| same_entity_different_fact(c, &fact)) {
        // ── 矛盾: bi-temporal 履歴化
        let new_id = insert_node(&fact, /*valid_from=*/ now(), conn)?;
        update_valid_to(&conflict.id, now(), conn)?;
        insert_edge(&new_id, &conflict.id, "supersedes", 1.0, conn)?;
        link_capture(fact.source_capture_id, &new_id, "derives_from", conn)?;
        return Ok(new_id);
    }
    // ── 新規
    let new_id = insert_node(&fact, now(), conn)?;
    for related in &fact.related_ids {
        insert_edge(&new_id, related, &fact.edge_type_for(related), 0.7, conn)?;
    }
    link_capture(fact.source_capture_id, &new_id, "derives_from", conn)?;
    Ok(new_id)
}
```

**`is_same_fact` の三段判定:**

```rust
fn is_same_fact(node: &Node, fact: &ExtractedFact) -> bool {
    // (1) entity_id 一致 (構造化済 connector 由来は最強い signal)
    if let (Some(a), Some(b)) = (&node.entity_id, &fact.entity_id) {
        if a == b && node.fact_type == fact.fact_type { return true; }
    }
    // (2) embedding cosine threshold + fact_type 一致
    if cosine_sim(&node.embedding, &fact.embedding) >= 0.92
        && node.fact_type == fact.fact_type { return true; }
    // (3) normalized name 完全一致 + claim の部分一致 (Levenshtein ratio >= 0.85)
    if normalize(&node.entity_name) == normalize(&fact.entity_name)
        && levenshtein_ratio(&node.claim, &fact.claim) >= 0.85 { return true; }
    false
}

fn same_entity_different_fact(node: &Node, fact: &ExtractedFact) -> bool {
    // 同 entity だが claim が顕著に違う = 矛盾
    let same_entity = match (&node.entity_id, &fact.entity_id) {
        (Some(a), Some(b)) => a == b,
        _ => normalize(&node.entity_name) == normalize(&fact.entity_name),
    };
    same_entity
        && node.fact_type == fact.fact_type
        && levenshtein_ratio(&node.claim, &fact.claim) < 0.5
}
```

閾値（0.92 / 0.85 / 0.5）は Stage 1 fixture eval で再調整。

### §3.5 オフライン挙動

- ネット切断中: extraction worker は `extraction_jobs.status='queued'` を消化しない（cloud BYOK 呼び出しを試みない）。`mem_captures` への raw 蓄積は通常通り進む。
- 復帰検知: tauri の network state イベント or 1 分間隔の health check で復帰検出 → queue ドレイン開始。
- UI 表示: `Settings > Memory` に **「処理待ち件数: N / 最古: M 時間前」** を表示。長時間溜まった場合の警告（48 時間以上）も。

### §3.6 BYOK コスト上限到達時

`cost_ledger` の月次集計が `settings.sections.kioku_cost.monthly_cap_usd` を超えた場合の挙動。`settings.sections.kioku_cost.cap_action` で制御:

| `cap_action` | 動作 |
|--------------|------|
| `pause_capture` (hard cap) | `capture_sampler` を停止、`mem_captures` 書込も停止。UI に警告 |
| `pause_extraction` (soft cap、既定) | capture は継続、extraction worker は `status='queued'` のまま放置。月明けで再開 |
| `fallback_to_lighter` | Haiku 4.5 → さらに軽量モデル（または `cost_per_call` 上限を下げた batched 抽出）に切替 |

警告閾値: 80% / 90% / 100% で UI 通知。詳細は §6 参照。

---

## §4 Read Path

### §4.1 全体フロー

```
Query (user utterance / agent task)
  │
  ↓ [Layer 1] kioku_rules を system prompt 先頭に注入 (常時)
  │
  ↓ [Layer 3] vector + lexical で entry nodes 5–10 個:
  │   SELECT id FROM mem_items
  │   WHERE valid_to IS NULL          -- 現行有効
  │     AND decay_score >= 0.05       -- 弱いノードは entry にしない
  │     AND embedding IS NOT NULL     -- 抽出済みノードのみ
  │   ORDER BY cosine(embedding, query_embed) DESC
  │   LIMIT 10
  │
  ↓ [Layer 2] graph traversal (recursive CTE):
  │   各 entry から depth 2-3
  │   edge_type filter: kioku_rules で禁止された型は除外 (例: scope に含まれない型)
  │
  ↓ rank_subgraph: score = path_score(weight 積) * decay_score * relevance
  │
  ↓ 上位 N ノードの mem_summaries.title + key_points のみ context へ
  │   (raw snippet / mem_captures.raw_path / raw_text は注入しない)
  │
  ↓ [open_pack 経路のみ] snippet を 500 文字でクリップして memory_hits.md に
  │   (format_hits_pack_markdown_matches_open_pack_legacy_format テスト更新を伴う)
  │
  ↓ [副作用] 各ヒットノードに対して:
      access_count++, last_accessed_at=now, decay_score をインクリメンタル更新
```

### §4.2 ノードフィルタ（query 別）

| LLM 経路 | 推奨 edge_type | node_kind |
|---|---|---|
| `chat.complete` | 全許可（`memoryAssembly` の hint で絞ってよい） | 全 |
| `brief.get` | `decided_in` / `follows_up` / `attended` 優先 | `decision` / `event` / `task` 優先 |
| `draft_reply_for_brief` | `mentions` / `decided_in` / `follows_up` | 全（recipient context 中心） |
| `open_pack` | 当該 Brief item の周辺のみ | 全 |
| meeting_recipes | `attended` / `decided_in` / `mentions` | meeting 中心 |

### §4.3 context window 内訳目安

`text-embedding-3-small` 換算は無関係（LLM コンテクスト側）。チャットモデル想定のトークン換算（英語 3.5 chars/token、日本語混在 2 chars/token）:

| 区画 | 上限 chars | 上限 tokens (目安) | 用途 |
|------|------------|--------------------|------|
| Layer 1 `kioku_rules` | 2,000 | 600–1,000 | 常時注入 |
| Layer 2 graph summary 注入 | 6,000 | 1,800–3,000 | `format_hits_*` 出力 |
| 既存 `memoryContext`（manual） | 2,000 | 600–1,000 | クライアント供給分 |
| 合計 system prompt 領域 | **10,000** | 約 3,000–5,000 | 既存 `SYSTEM_PROMPT_BUDGET_CHARS` 維持 |

`brief.get` / `open_pack` は user prompt 側に Brief 本体が入るため、Layer 2 配分を 4,000–5,000 chars に抑える。

### §4.4 raw を context に入れない原則

- `mem_captures.raw_path` / `raw_text` は **`context_assembly` から参照されない**（read API を分離）。
- `mem_items.snippet` は抽出済みの human-readable claim を入れる前提。Stage 5 完了後は **screen 由来の raw snippet が `mem_items` に存在しないことが保証される**。
- `format_hits_pack_markdown` は **snippet を 500 文字でクリップ**（既存テスト更新が必要）。

---

## §5 Decay Model

### §5.1 数式

```
decay_score(node)
  = w1 * recency(now - last_accessed_at)
  + w2 * log(1 + access_count)
  + w3 * centrality_score(node)
  + w4 * confidence(node)
```

| 項 | 重み (初期) | 形 |
|----|------------|----|
| recency | `w1=0.4` | `exp(-Δt / τ)`、`τ=7 days` |
| access_count | `w2=0.2` | `log10(1 + access_count) / log10(1 + ACC_CAP)`、`ACC_CAP=100` |
| centrality | `w3=0.3` | `weighted_degree / max_observed_degree`、0–1 正規化 |
| confidence | `w4=0.1` | `node.confidence` (NULL の場合 0.5) |

`provenance_bias` は §3 conflict resolution の `find_candidates` で entry filter として使い、decay_score には含めない（過剰なバイアスを避けるため）。

### §5.2 再計算頻度

| 契機 | 更新内容 |
|------|----------|
| ノードがヒット (`search` / graph traversal) | `access_count++`, `last_accessed_at=now`, **自身の decay_score** を再計算 |
| `mem_edges` 追加 / 削除 | 関与した両端ノードの centrality を **dirty-mark** |
| 1 日 1 回バッチ | dirty ノードの centrality を再計算 + 全現行有効ノードの decay_score を再計算 |
| `valid_to` 打鍵 | 該当ノードを decay 計算から除外（physical-delete はしない） |

### §5.3 threshold 以下ノードの扱い

`decay_score < 0.05` は:

- vector entry 抽出から除外（§4.1 SQL）
- graph traversal では **辿れる**（centrality 経由で価値が戻る可能性があるため）
- physical-delete はしない（Stage 5 で別判断）

### §5.4 fixture セットでのチューニング (Stage 1 内)

`tests/fixtures/kioku_eval/` に 50–100 件の合成データを置き:

- 入力: 既存 `mem_items` のサンプル + 合成 capture (AX dump、calendar event、meeting transcript chunk)
- ground truth: 各クエリに対する「正しいヒット ID リスト」と「不適切なヒット ID リスト」(human curate)
- 評価: `(w1, w2, w3, w4)` をグリッド探索（各 0.1 刻み、和 = 1.0 制約）し precision@N / recall@N / NDCG を最大化

確定値は `crates/.../decay.rs` の `pub const DECAY_W1: f32 = ...` に反映。Stage 2 着手前に固定。

---

## §6 BYOK コスト管理設計

### §6.1 `cost_ledger` テーブル

完全 DDL は `proposed-schema.sql` 参照。役割:

| 列 | 用途 |
|----|------|
| `id` | INTEGER PK AUTOINCREMENT |
| `recorded_at` | epoch ms |
| `model` | `claude-haiku-4-5` 等 |
| `input_tokens` / `output_tokens` | API レスポンスから |
| `cost_usd` | calc_cost(model, input, output) で算出 |
| `job_id` | `extraction_jobs.id`（NULL = 抽出以外、例: 要約） |
| `purpose` | `extraction` / `summarize` / `embed` 等 |
| `meta_json` | デバッグ用追加情報 |

### §6.2 月次集計クエリ

```sql
SELECT
  strftime('%Y-%m', recorded_at / 1000, 'unixepoch') AS month,
  model,
  purpose,
  COUNT(*) AS calls,
  SUM(input_tokens)  AS in_tok,
  SUM(output_tokens) AS out_tok,
  SUM(cost_usd)      AS spent_usd
FROM cost_ledger
WHERE recorded_at >= strftime('%s', 'now', 'start of month') * 1000
GROUP BY model, purpose
ORDER BY spent_usd DESC;
```

### §6.3 上限制御

`settings.sections.kioku_cost`:

```jsonc
{
  "monthly_cap_usd": 10.0,             // 既定 $10
  "cap_action": "pause_extraction",    // pause_capture | pause_extraction | fallback_to_lighter
  "warn_thresholds": [0.8, 0.9, 1.0],
  "fallback_model": "claude-haiku-4-5" // fallback_to_lighter 時のターゲット
}
```

挙動:
- 80% / 90%: UI 通知（バナー）
- 100%: `cap_action` に応じて分岐（§3.6）
- 月明け（UTC or local の選択不要、`strftime('%Y-%m', ...)` 単純比較で月境界）に自動再開

### §6.4 透明性 UI

**Settings > Memory > Cost** ペインに:

- 直近 30 日のコスト棒グラフ（日別 USD）
- 当月の使用済 / 上限 / 推定月額（線形外挿）
- モデル別内訳（pie chart）
- 直近 50 件の `cost_ledger` 行（debug）

実装は本タスクのスコープ外（設計のみ）。

---

## §7 spatial_context カラム設計（Phase 3 visionOS への布石）

### §7.1 値の構造

`mem_items.spatial_context TEXT` は JSON 文字列:

```jsonc
{
  // macOS 2D phase で populate するキー
  "display_id": "main",                   // CGDirectDisplayID 文字列化、または "main"/"left"
  "window_bounds": {"x":0,"y":0,"w":1280,"h":800},
  "dwell_ms": 12500,

  // Phase 3 visionOS で populate されるキー (macOS 2D phase は NULL or 省略)
  "window_pose":  {"x":1.2,"y":0.0,"z":-0.5,"yaw":0.1,"pitch":0,"roll":0},
  "gaze_target":  {"node_ref":"m_xxx","dwell_ms":3200},

  // 任意の追加キー (前方互換)
  "ext": { ... }
}
```

JSON は SQLite の json1 関数で部分クエリ可能（`json_extract(spatial_context, '$.display_id')`）。

### §7.2 macOS 2D phase の populate ルール

| キー | populate するか |
|------|-----------------|
| `display_id` | はい（`NSScreen.main` を文字列化） |
| `window_bounds` | はい（focused window の bounds） |
| `dwell_ms` | はい（focus 切替イベントから累計） |
| `window_pose` | NULL（visionOS 由来） |
| `gaze_target` | NULL（visionOS 由来） |

`spatial_context` 自体が NULL でも問題なく動作。

### §7.3 graph 上での利用

- 「同じ display_id で頻繁に同居するノード群」を `co_occurs_with` edge で接続（バッチで生成）
- visionOS 移行後: `gaze_target.node_ref` が指すノードへの `gazed_at` edge を追加
- 「右ディスプレイの記憶のみ」フィルタ: `WHERE json_extract(spatial_context, '$.display_id') = 'right'`

詳細実装は Phase 3 ticket。本ドキュメントは schema 互換性の確保のみを担保する。

---

## §8 完了基準（このアーキが機能している状態）

- screen 由来の raw が `mem_items` に存在しない（`mem_captures` のみ、Stage 5 完了時）
- 全 LLM 注入経路が `context_assembly` 経由で graph traversal に乗っている
- `kioku_rules` が常時 system prompt に入っている
- `MorningBriefCandidateSchema.decision_graph_hits` が空でない brief が出力される
- `decay_score < 0.05` のノードが entry に出ないことが eval 上確認できる
- 同一 entity の矛盾事実が bi-temporal で履歴化されている
- `cost_ledger` の月次合計がユーザー設定の上限内に収まっている
- オフライン → 復帰の queue ドレインが動作する

---

## §9 ADR 参照（将来の SHOGUN-AI 統合に備える）

将来 `/Users/torutano/SHOGUN-AI`（PGLite ベース `@shogun/memory-layer`）と統合する可能性を残し、本設計の主要な抽象境界を ADR として別途記録する（このドキュメントとは別ファイル、Phase 2 内の作業）：

- ADR-001: Write path interface（`mem_captures::record` / `extraction_jobs` enqueue / `resolve_write`）
- ADR-002: Read path interface（`assemble_memory_hits` の入出力、graph traversal 抽象）
- ADR-003: Extraction interface（`ExtractedFact` 構造、Anthropic tool_use schema）
- ADR-004: 永続化抽象（SQLite / PGLite で互換可能なクエリ集合）

これらは「将来統合に直面したときの作業量を見積もる材料」として保存する。本タスクで ADR の中身を書く必要は無い。
