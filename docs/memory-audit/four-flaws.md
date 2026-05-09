# 4 つの欠陥チェック (four-flaws)

更新: 2026-04-26
監査対象: `/Users/torutano/ShogunAI3/ShogunAI3`

---

## 1. 一覧表

| 欠陥 | 現状 | 該当箇所 (path:line) | 深刻度 |
|---|---|---|---|
| **重複除去なし** | あり（部分的にしか効いていない） | `memory_store.rs:499` (`idx_mem_items_entity_unique` は `entity_id IS NOT NULL` のみ); `capture_sampler.rs:28` (in-memory `LAST_SIG` ハッシュのみ、プロセス再起動で消える) | **high** |
| **減衰なし** | あり（完全に無し） | DDL 全体に `last_accessed_at` / `access_count` / `decay_score` 列が無い（`memory_store.rs:346–353`、Phase 1 追加列も含めて）。検索結果のランキングは FTS5 rank と cosine のみで時間項なし (`memory_store.rs:988–1056`) | **high** |
| **ランキングなし** | あり（薄い） | `search` は FTS5 rank のみ、`search_with_semantics` は cosine 内積のみ (`memory_store.rs:1124–1135`)。recency / centrality / access boost / provenance バイアス いずれも掛けない | **mid** |
| **関係性追跡なし** | あり（完全に無し） | `mem_items` 同士、`mem_items ↔ meetings`、`mem_items ↔ mem_summaries` のいずれにも edges テーブル無し。外部キーは `meeting_*` 内部の親子のみ (`meeting_store.rs:38, 49`)。`mem_summaries.target_id → mem_items.id` は文字列マッチ、参照整合性は強制されない (`memory_store.rs:413`)。`AMC pipeline.DecisionGraphHitSchema` (`tools/amc-pipeline/src/schemas.js:26`) に対応する Rust 実装は **0 件** (`rg "decision_graph" src-tauri/`) | **high** |

---

## 2. 詳細根拠

### 2.1 重複除去なし

**実装されている重複対策:**
- `idx_mem_items_entity_unique`（`memory_store.rs:499`）— `(source, entity_id)` の UNIQUE。`entity_id IS NOT NULL AND entity_id != ''` の部分インデックス。
- `INSERT OR IGNORE`（`memory_store.rs:921`）— インデックス衝突時に黙って捨てる。
- DELETE pre-index（`memory_store.rs:485–496`）— インデックス作成前に `(source, entity_id)` の最古を残し他削除。
- `capture_sampler` の `LAST_SIG` / `LAST_AX_SIG`（`capture_sampler.rs:28–30`）— in-memory ハッシュで前回と同値ならスキップ。

**効いていない理由:**

1. `capture_sampler` / `capture_ax` の `entity_id` は **NULL** のため UNIQUE が掛からない。前面アプリが行ったり来たりするだけで膨大な重複が作られる（`LAST_SIG` は最終 1 個しか覚えない）。
2. 2 分の `RATE_LIMIT_MS` を過ぎれば同じ AX dump も再度 ingest される。
3. 連携系で `entity_id` が無い／揺らぐと（例: メモのバージョン変更で id 変わる）重複行がたまる。
4. 意味的重複（言い回しが違うが同一事実）は完全に放置。
5. 旧 JSON 取り込み時（`migrate_json_if_needed`）も `INSERT OR REPLACE` だけ。

**結果:** `mem_items` は時系列の append-only ログに近く、KIOKU としては**事実の最新スナップショット**を作れない。

### 2.2 減衰なし

DDL を見渡しても `last_accessed_at` / `access_count` / `decay_score` / `read_count` / `relevance_decay` 等の列は存在しない。`mem_summaries` にも `acknowledged_at` / `snooze_until` という UI 抑制系はあるが**ランキングには使われていない**。

検索の重み:
- `memory_store::search` は `bm25(mem_items_fts)` か LIKE 順、または `created_at DESC`。
- `memory_store::search_with_semantics` は cosine 内積のみ。

**含意:** 古くて 1 回しか参照されない `capture_ax` 行が、頻繁に参照される `meeting_*` 行と同じ重みでヒットに乗る。`stats.historyDays` は表示専用で計算には使われない。

### 2.3 ランキングなし（薄い）

「ランキング無し」は厳密には誤りで FTS rank と cosine がある。が、**それ以外の信号がゼロ**：

| 信号 | 反映? |
|---|---|
| recency (新しいほど高い) | ❌（FTS rank には間接的に効くが、明示の時間項なし） |
| access_count / 過去の引用回数 | ❌ |
| centrality（他からどれだけリンクされているか） | ❌ |
| provenance による bias（user > meeting > connector > screen 等） | ❌ |
| confidence による bias | ❌ |
| user_priority / acknowledged 等の UI 操作 | ❌（mem_summaries 専用） |

`brief_generate` は **クエリ空・限度 15 件・直近順**で取り出しているので、recency が効いているように見える唯一の経路だが、これも単なる `ORDER BY created_at DESC` のスキャン。

### 2.4 関係性追跡なし

**現状の唯一の関係性:**
- `meeting_transcript_segments.meeting_id → meetings.id` (FK, ON DELETE CASCADE)
- `meeting_note_blocks.meeting_id → meetings.id` (FK, ON DELETE CASCADE)
- `meetings.template_id → meeting_templates.id` (FK)

**存在しない関係性:**
- `mem_items` 同士のリンク
- `mem_items ↔ meetings`（同じ会議の話題なのに紐付かない）
- `mem_items ↔ mem_summaries`（target_id は文字列マッチで FK 無し）
- 「同一エンティティの異なる事実」（人物 X が複数の連絡先で出る、プロジェクト Y が複数の会議で言及される、等）
- 「決定 → 後続のフォローアップ」 ＝ `decision_graph`：これは AMC pipeline の Zod schema 上は存在するが Rust 側に**ゼロ**

**`AMC contract と実装のギャップ（決定的）:**
`tools/amc-pipeline/src/schemas.js:26–30`：
```js
export const DecisionGraphHitSchema = z.object({
  decision_id: z.string(),
  summary: z.string(),
  follow_ups_pending: z.number().int().nonnegative().optional(),
});
```
`MorningBriefCandidateSchema` の `decision_graph_hits` に渡すのは**呼出側の責務**だが、ShogunAI3 内に `decision_graph_hits` を生成するコードパスが無い（`rg "decision_graph" src-tauri/` 結果ゼロ）。AMC pipeline は**常に空配列**で動く。

すなわち **decision graph は契約上の便宜的プレースホルダ**として置かれ、実装側は触っていない。Phase 2 の三層設計は、まさにここを埋めるのが核心。

---

## 3. 二次的な欠陥（参考）

| 欠陥 | 詳細 |
|---|---|
| **bi-temporal ナシ** | `created_at` のみ。`valid_from` / `valid_to` / `recorded_at` 区別なし。同じ事実が後で更新された場合、旧情報は履歴に残らず単に消える（または新行として並ぶ）。 |
| **TTL ナシ** | 自動削除無し。`mem_items` は半永久的に成長する。配布想定が 1 年単位なら GB 級の risk。 |
| **vector index ナシ** | embedding 検索は wide-net (≤160) → 全件 cosine。10 万行を超えると wide-net 自体が辛くなる。 |
| **抽出層ナシ** | raw capture からの "entity / event / decision" 抽出 が無い。`capture_ax` の AX dump はそのまま蓄積される。LLM への注入は文字数クリップのみ。 |
| **`spatial` 想定ナシ** | display_id / window_pose / gaze_target 等の列は存在しない。Phase 3 の visionOS 拡張時に DDL 追加が必要。 |
| **rules layer ナシ** | "ユーザー明示の不変ルール" を保持する場所が `settings.json` の整理されないキーしか無い。常時 system prompt に注入する公式経路も無い。 |

---

## 4. 上位 3 つの欠陥（Phase 3 の summary 用）

1. **関係性追跡ナシ × decision_graph 契約だけ存在** — graph 移行が**最も価値のある**不在領域。
2. **重複除去が capture 由来に効かない** — `mem_items` の大半が screen 由来であり、ここを絞らないと他の改善が霞む。
3. **減衰ナシ + raw capture が LLM に入る** — Brief / Pack / Reply が screen 行をそのまま注入しているため、LLM 文脈の質が capture ノイズに引きずられる。
