# 永続化レイヤー (persistence layers)

更新: 2026-04-26
監査対象: `/Users/torutano/ShogunAI3/ShogunAI3`

## 1. 結論

| エンジン | 形式 | 用途 |
|----------|------|------|
| **SQLite (rusqlite)** | `memory.db` 単一ファイル、WAL モード、`foreign_keys=ON` | KIOKU 主体 + 会議 + dead-letter（**同一 DB 内**） |
| **平文 JSON** | `app_data_dir` 直下 | 設定 / スケジュールキュー / フォーカス状態 / Pack 出力 |
| **Markdown** | `app_data_dir/packs/{id}/` | Pack 化された Memory ヒット（`memory_hits.md`） |

**PGLite / pgvector / 他 DB は使われていない**（タスク文の前提とは異なる、要注意）。`@shogun/memory-layer`（`/Users/torutano/SHOGUN-AI`）は別リポジトリで PGLite ベース、本リポジトリ ShogunAI3 とは未統合。

---

## 2. SQLite: `memory.db`

### 2.1 ファイル位置

```rust
// src-tauri/src/memory_store.rs:14, 30
const MEMORY_DB: &str = "memory.db";
pub(crate) fn db_path() -> Result<PathBuf, String> {
  Ok(paths::app_data_dir()?.join(MEMORY_DB))
}
```

`paths::app_data_dir()` は `directories::ProjectDirs::from("ai", "Shogun", "ShogunAI3")` の `data_dir()`（`paths.rs:8–17`）。macOS では `~/Library/Application Support/ai.Shogun.ShogunAI3/`。

### 2.2 接続設定

```rust
// memory_store.rs:42–48
let conn = Connection::open(path)?;
conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
init_schema(&conn)?;
ensure_embedding_column(&conn)?;
ensure_context_layer_columns(&conn)?;
ensure_redaction_nullable(&conn)?;
migrate_json_if_needed(&conn)?;
```

接続のたびにスキーマ確認 + 必要なら ALTER TABLE。**マイグレーションフレームワークは無い**（feature-detect で増分）。

### 2.3 同一 DB 内のテーブル

`memory_store::open_conn()` 経由で**全モジュールが同一 `memory.db` を共有**：

| モジュール | テーブル |
|------------|---------|
| `memory_store` | `mem_items`、`mem_items_fts`（FTS5 仮想テーブル）、`mem_summaries` |
| `meeting_store` | `meeting_templates`、`meetings`、`meeting_transcript_segments`、`meeting_note_blocks` |
| `dead_letter` | `mem_dead_letter` |

ストレージは 1 ファイル、論理境界はモジュール側のみ。

### 2.4 Embedding 表現

- `mem_items.embedding` BLOB / `meetings.embedding` BLOB / `meeting_note_blocks.embedding` BLOB
- フォーマット: f32 リトルエンディアン連結（L2 正規化済み、`hifi/README.md:5`）
- 次元: OpenAI 互換 `text-embedding-3-small`（既定、`settings.sections.llm.embeddingModel`）= **1536 次元**
- ベクトルインデックス: **無し**（HNSW / pgvector 等は不在）。検索は FTS5 wide → 全件 cosine 内積（`memory_store.rs:1110–1135`）。

### 2.5 想定書き込み量（推測）

| 行 | 1日あたり想定 | 根拠 |
|----|----------------|------|
| `mem_items` (`capture_sampler`) | 数百行 | `RATE_LIMIT_MS=120_000`（2 分、`capture_sampler.rs:27`）= 上限 720/日、実際は前面アプリ変化時のみで数百件 |
| `mem_items` (`capture_ax`) | 数十〜数百行 | `axMinIntervalSecs` 既定値次第 |
| `mem_items` (`capture` / 手動) | 数件〜数十件 | ユーザー操作依存 |
| `mem_items` (`gmail` / `google_calendar`) | 数十〜数百件 | 同期間隔・受信量依存。`(source, entity_id)` UNIQUE で同一は upsert |
| `mem_items` (`telemetry_chat_context`) | チャット利用回数分 | `shogunBriefTelemetrySink` |
| `mem_summaries` | 既存 item 分の遅延ライト | `target_kind='item'` のみ |
| `meeting_*` | 会議 1 件あたり多数の transcript / note | 会議時間依存 |
| `mem_dead_letter` | 通常ゼロ、失敗時のみ | upsert で attempts++ |

`capture_sampler` と `capture_ax` の合算で **DB の 9 割以上が screen 由来**になる可能性が高い。

### 2.6 インデックス（既存）

```sql
-- memory_store.rs より
CREATE UNIQUE INDEX idx_mem_items_entity_unique
  ON mem_items(source, entity_id)
  WHERE entity_id IS NOT NULL AND entity_id != '';
CREATE INDEX idx_mem_summaries_generated_at ON mem_summaries(generated_at DESC);
CREATE INDEX idx_mem_summaries_priority ON mem_summaries(priority, generated_at DESC);

-- meeting_store.rs
CREATE INDEX idx_mts_meeting ON meeting_transcript_segments(meeting_id);
CREATE INDEX idx_mnb_meeting ON meeting_note_blocks(meeting_id);

-- dead_letter.rs
CREATE UNIQUE INDEX idx_mem_dead_letter_unique
  ON mem_dead_letter(source, entity_id)
  WHERE entity_id IS NOT NULL AND entity_id != '';
CREATE INDEX idx_mem_dead_letter_recent ON mem_dead_letter(last_failed_at DESC);
```

注意：**`mem_items.created_at` の単独索引が無い** → 「直近 N 件」クエリは FTS5 経由でない場合スキャンになりやすい。

---

## 3. ファイルベース永続化（DB 外）

すべて `paths::app_data_dir()` 直下、JSON / Markdown。

| ファイル | 形式 | 役割 | 定義箇所 |
|----------|------|------|----------|
| `memory.db` | SQLite | KIOKU 主体 | `memory_store.rs:14` |
| `memory_items.json` → `.migrated` | JSON | 旧形式の一回限り取り込み | `memory_store.rs:15, 510–` |
| `settings.json` | JSON | アプリ設定 | `settings_store.rs:9` |
| `schedule_queue.json` | JSON 配列 | append-only スケジュールキュー | `schedule_queue.rs:16` |
| `active_focus.json` | JSON | 進行中フォーカスセッション状態 | `brief_actions.rs:112` |
| `packs/{id}/*.json` | JSON | Pack メタ（Brief 行確定アクションの成果物） | `brief_actions.rs:119`、`commands.rs:871` |
| `packs/{id}/memory_hits.md` | Markdown | Pack 化された Memory ヒット | `brief_actions.rs`（`open_pack` 経路） |

`packs/` の Markdown は `clear_app_data_files()`（`paths.rs:32–46`）で削除対象。

---

## 4. キャプチャ系の永続化方針

**screenshots / 音声 / a11y tree の生キャプチャ用ストアは存在しない。**

- `capture_sampler.rs` は前面アプリ名 + AX スナップショット（最大 ~2000 字）を**そのまま `mem_items` に ingest** する（`source='capture_sampler'` または `'capture_ax'`）。
- 中間テーブル / 別 DB / blob ストア は無い。
- secure text fields（パスワード入力）は `macos_ax::format_snapshot` で `None` になり ingest されない（`macos_ax.rs:31–`）。

**含意:**
1. raw capture と「ユーザー保存メモ」「同期されたカレンダー / メール」が同じテーブルに混在。
2. 重複除去は `(source, entity_id)` UNIQUE と `INSERT OR IGNORE` のみで、`capture_sampler` / `capture_ax` は `entity_id=NULL` なので**重複防止が効かない**。
3. `capture_sampler` / `capture_ax` 行は `embedding` がスキップされる（`memory_store.rs:966`）→ semantic search のヒット候補にならず（lexical では当たる）、再ランクで最下位（`f32::NEG_INFINITY`、`memory_store.rs:1128`）。

---

## 5. 設定で記憶層に効くもの（`settings.sections.*`）

| セクション | キー | 効果 |
|------------|------|------|
| `capture` | `sampleIntervalSecs`、`axMinIntervalSecs`、`axRichCapture`、pause/resume | capture_sampler の挙動 |
| `privacy` | `excludedApps`、`excludedSites` | サンプル時に弾く |
| `privacy` | `allowChatServerMemoryAssembly` | `chat.complete` の `memoryAssembly` を尊重するか（既定 true） |
| `llm` | `embeddingModel` | 既定 `text-embedding-3-small`（OpenAI 互換 BYOK） |
| `integrations` | `googleCalendarAutoSync`、`googleCalendarSyncIntervalMins` | 連携同期 |

**TTL / 自動 GC は設定に存在しない。**`stats.historyDays` は最古 `created_at` からの**表示用**日数（`docs/context-layer-phase-0-1.md` §0 の注）。

---

## 6. 検索・取り出しの永続化との関係

| 関数 | 経路 | アクセスする永続化 |
|------|------|--------------------|
| `memory_store::search` | FTS5 → LIKE フォールバック | `mem_items_fts` + `mem_items` |
| `memory_store::search_with_semantics` | FTS wide → cosine 再ランク | `mem_items_fts` + `mem_items.embedding` BLOB（**API キー必須**） |
| `meeting_store::search_meeting_memory_hits` | 会議スコープ（`scope: meetings_only`） | `meetings` / `meeting_transcript_segments` / `meeting_note_blocks` |
| `context_assembly::assemble_memory_hits` | 上記を委譲呼び出し | 同上 |

**ベクトル類似計算は同一 SQLite 内で全行スキャン**（`for (idx, item) in arr.iter()` のループ、`memory_store.rs:1112–1135`）。`limit*8` で wide-net した上の上限 160 件にしか効かないが、本格的にスケールしない設計。

---

## 7. 監査結論

- 物理永続化は **SQLite 1 ファイル + JSON 数本 + Markdown の Pack 出力** に集約。
- Layer 1（rules）に該当するものは現状 `settings.json` の一部分だけで、独立した永続層は無い。
- Layer 2（episodic graph）に相当するものは無い。`mem_items` は flat な行ベースで、edges テーブルも `kinds_json` 以外の関係性表現も無い。
- Layer 3（semantic vectors）は `mem_items.embedding` BLOB として layer 2 候補と物理的に同居。専用 vector store は無い。
- グラフ移行に際して **SQLite を維持**するのが local-first 哲学・既存 `memory.db` の連続性・配布バンドル簡素化の三点で最有力。`recursive CTE` が graph traversal の主役になる。
