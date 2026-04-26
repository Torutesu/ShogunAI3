# 語彙 (vocabulary)

更新: 2026-04-26
監査対象: `/Users/torutano/ShogunAI3/ShogunAI3` (Tauri v2 desktop, `shogun-ai-hifi` v0.4.1)

このリポジトリで「記憶」「文脈」「キャプチャ」を指して**実際に使われている**識別子のみをここに記録する。
以降のすべての監査・設計ドキュメントはこの表を語彙の正典として参照する。**新しい名前は導入しない。**

---

## 1. 記憶層全体を指す呼称

| 呼称 | 使用箇所 | 用法 |
|------|----------|------|
| **KIOKU** (`kioku`) | `src-tauri/src/meeting_store.rs:1` のコメント、`hifi/amc-pipeline/src/schemas.js`、`prompts.js` | 内部コードネーム（"work memory" の意）。AMC pipeline の `trigger_source` enum と `KiokuHitSchema` で外部契約として露出。 |
| **Memory**（大文字 M） | UI / END_USER_SETUP.md / hifi 全般 | ユーザー向け呼称。アプリ内で見える名称はこれ。 |
| `memory.db` | `src-tauri/src/memory_store.rs:14` `MEMORY_DB` | KIOKU の物理ファイル名（SQLite）。`paths::app_data_dir()` 配下。 |
| `memory_items.json`（legacy） | `src-tauri/src/memory_store.rs:15` `LEGACY_JSON` | DB が空のときのみ一度だけ取り込み、`memory_items.json.migrated` にリネームされる旧形式。 |

**結論:** 記憶層を指す内部用語は **KIOKU**、ユーザー向けは **Memory**。三層アーキテクチャの設計では KIOKU を物として扱い、表示名は Memory のまま据え置く。

---

## 2. テーブル / FTS

| 名前 | 種別 | 役割 | 定義箇所 |
|------|------|------|----------|
| `mem_items` | 物理テーブル | KIOKU の主テーブル。1 行 = 1 記憶 | `src-tauri/src/memory_store.rs:346` |
| `mem_items_fts` | FTS5 仮想テーブル | `title` / `snippet` / `source` の全文索引 | `src-tauri/src/memory_store.rs:355` |
| `mem_summaries` | 物理テーブル | 派生サマリーキャッシュ。Phase 1 では `target_kind='item'` のみ使用（Phase 2/3 で `session` / `week_rollup` 予定） | `src-tauri/src/memory_store.rs:400` |
| `mem_dead_letter` | 物理テーブル | ingest に失敗した行の退避先 | `src-tauri/src/dead_letter.rs:27` |
| `meetings` / `meeting_transcript_segments` / `meeting_note_blocks` / `meeting_templates` | 物理テーブル | 会議系。`memory.db` 内の **別ストア**だが provenance 上は "meeting" として KIOKU と同一文脈 | `src-tauri/src/meeting_store.rs:13–47` |

トリガー: `mem_items_ai` / `mem_items_ad` / `mem_items_au`（`memory_store.rs:378–391`）。
インデックス: `idx_mem_summaries_generated_at`、`idx_mem_summaries_priority`、`idx_mem_items_entity_unique`（部分 UNIQUE on `(source, entity_id) WHERE entity_id IS NOT NULL`、`memory_store.rs:499`）。

---

## 3. 行の分類軸

`mem_items` 1 行は以下の軸で分類される（`docs/context-layer-phase-0-1.md` §0 §1 で正規化済み）：

### 3.1 `source`（取り込みチャネル文字列、自由記述）

| `source` | 説明 |
|----------|------|
| `capture_sampler` | 前面アプリ名サンプル（`capture_sampler.rs`） |
| `capture_ax` | macOS Accessibility tree スナップショット（`macos_ax.rs`、最大 ~2000 字） |
| `google_calendar` | `calendar.sync` 経由 |
| `gmail` | `gmail.sync` 経由 |
| `meetings_*` / `meeting_*` / `meeting` | 会議パイプライン |
| `home_attachment` | Home の添付ファイル |
| `capture` | Memory 画面の Quick capture（手動） |
| `focus_session` | フォーカス開始ログ |
| `telemetry_chat_context` | `chat.completion.context` 計測 ring buffer の Memory 化（`hifi/README.md:39`） |
| その他 / レガシー | デフォルト `user` |

### 3.2 `provenance`（4 値、Phase 1 で正規化）

```
screen | connector | meeting | user
```

`source` から自動導出される（`memory_store.rs:20–27` `derive_provenance()`）：

```
capture_sampler | capture_ax        → screen
google_calendar | gmail             → connector
meeting* / meetings* / "meeting"    → meeting
それ以外                            → user
```

### 3.3 `kinds_json`

行の意味タグ配列の JSON（例: `["screen"]`）。FTS 対象外、自由記述。

### 3.4 その他の Phase 1 列

`entity_id`（連携先オブジェクト ID、例: Gmail message ID / カレンダーイベント ID）、`confidence`（0.0–1.0、推論行向け）、`redaction`（`none` / `summary_only` / `redacted`、現状ほぼ `none`）。

---

## 4. AMC / Brief 周りの語彙（contract レベル）

`hifi/amc-pipeline/src/schemas.js` で Zod スキーマとして定義され、外部契約として固定。

| 識別子 | 種類 | 備考 |
|--------|------|------|
| `KiokuHitSchema` | Zod object | `doc_id` / `title` / `snippet` / `last_touched` / `relevance_score` |
| `DecisionGraphHitSchema` | Zod object | `decision_id` / `summary` / `follow_ups_pending` |
| `TriggerSourceSchema` | Zod enum | `calendar / email / slack / kioku / decision_graph / signal / focus_block / other` |
| `MorningBriefCandidateSchema` | Zod object | `related_kioku_hits` と `decision_graph_hits` を引数に持つ |
| `RelatedContextItemSchema.uri` | string | `shogun://doc/{doc_id}` 形式 |
| `BriefItemCategorySchema` | Zod enum | `meeting / commitment / decision / followup / prep / review / signal` |

**重要事実:** `decision_graph` は **AMC pipeline の契約上は存在するが Rust 側に実装が無い**。`rg "decision_graph|DecisionGraph" src-tauri/` は 0 件。これは Phase 2 設計で正面から扱う対象。

---

## 5. Rust モジュール（`src-tauri/src/`）

| モジュール | 役割 |
|------------|------|
| `memory_store.rs` | KIOKU のスキーマ初期化、ingest、search、削除、JSON マイグレーション |
| `meeting_store.rs` | 会議系テーブル（同一 `memory.db` 内） |
| `summarizer.rs` / `summarizer_store.rs` | `mem_summaries` の生成と CRUD |
| `embed_backfill.rs` | 既存行への embedding 後付けバッチ |
| `embeddings.rs` | OpenAI 互換 `/v1/embeddings` 呼び出し（BYOK） |
| `context_assembly.rs` | LLM コール直前の文脈組み立て（フェーズ 1 で導入された一本化点） |
| `llm.rs` | `brief_generate` / `draft_reply_for_brief` / `chat_complete` / `draft_from_payload` |
| `brief_actions.rs` | Morning Brief の確定アクション（`open_pack` 等） |
| `capture_sampler.rs` / `macos_ax.rs` | `capture_sampler` / `capture_ax` 取得（macOS） |
| `dead_letter.rs` | ingest 失敗の退避 |
| `memory_debug.rs` / `memory_obs.rs` | UI 向けデバッグ / 観測 |
| `paths.rs` | `app_data_dir`（`directories` クレート、`ai.Shogun.ShogunAI3`） |
| `schedule_queue.rs` | `schedule_queue.json`（**ファイルベース**、append-only） |

---

## 6. ファイルベース永続化（DB 外）

| パス（`app_data_dir/` 配下） | 種別 | 定義箇所 |
|------------------------------|------|----------|
| `memory.db` | SQLite | `memory_store.rs:14` |
| `memory_items.json` → `memory_items.json.migrated` | 旧 JSON、起動時一度だけ取り込み | `memory_store.rs:15, 510–` |
| `settings.json` | アプリ設定（privacy フラグ等） | `settings_store.rs:9` |
| `schedule_queue.json` | 任意スケジュール キュー | `schedule_queue.rs:16` |
| `active_focus.json` | フォーカスセッション状態 | `brief_actions.rs:112` |
| `packs/{id}/*.json`、`packs/{id}/memory_hits.md` | Pack 出力（Markdown 含む） | `brief_actions.rs:119` `commands.rs:871` |

`packs/` の Markdown には `memory_hits.md` という形で**生のヒットがファイル化**される（`open_pack` 経路）。

---

## 7. 監査・設計で使う固有名（このリポジトリ内）

以降のドキュメントでは下記を変更せずに用いる：

- 記憶層の物 = **KIOKU**
- DB ファイル = `memory.db`
- 主テーブル = `mem_items`
- 派生サマリー = `mem_summaries`
- 退避 = `mem_dead_letter`
- 文脈組み立て = `context_assembly`
- 取り込みチャネル = `source`
- 4 値分類 = `provenance`
- 連携先 ID = `entity_id`
- 信頼度 = `confidence`
- マスキング = `redaction`
- 既存契約のヒット型 = `KiokuHitSchema` / `DecisionGraphHitSchema`
- 既存契約のトリガー型 = `TriggerSourceSchema`
- ユーザー向け呼称 = **Memory**

仮称が必要な場合のみ、本ドキュメント末尾の §8 に明示する。

---

## 8. （現時点では）仮称ゼロ

タスクで言及された "graph-based three-layer architecture" の各層も、リポジトリ既存語彙にマップする：

| タスク内の概念名 | このリポジトリでの呼称 |
|------------------|------------------------|
| Layer 1 Immutable Rules | `settings.json` 内の `sections.rules` 系（**新設**だが `settings_store` 配下に置く前提） |
| Layer 2 Episodic Graph | `mem_items` 拡張 + 新規 `mem_edges` テーブル（**KIOKU グラフ**）|
| Layer 3 Semantic Vectors | 既存 `mem_items.embedding` BLOB をそのまま使用（独立 store は作らない） |
| 抽出 entity / event | `KiokuHitSchema.doc_id` と `DecisionGraphHitSchema.decision_id` で既に露出している概念 |

正式名称が必要になった時点で更新する。
