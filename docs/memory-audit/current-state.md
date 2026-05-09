# 現状のメモリ実装スキャン (current state)

更新: 2026-04-26
監査対象: `/Users/torutano/ShogunAI3/ShogunAI3`

各ファイルの役割・永続化先・書き込み/読み込みタイミング・TTL を記録する。

---

## 1. Rust 側 (`src-tauri/src/`)

| ファイル | 役割 (1 行) | 永続化先 | 書き込みタイミング | 読み込みタイミング | TTL / decay / cleanup |
|---|---|---|---|---|---|
| `memory_store.rs` | KIOKU の DDL / `ingest` / `search` / `search_with_semantics` / `delete` / 旧 JSON マイグレーション。 | `mem_items`、`mem_items_fts`、`mem_summaries` (一部) | `ingest()` 呼出時（capture / connector / 手動）。`embedding` は `capture_sampler`/`capture_ax` 以外で別タスクに spawn (`memory_store.rs:966–982`)。 | `search()` / `search_with_semantics()` 呼出時。接続のたびにスキーマ確認 ALTER。 | **無し**。`stats.historyDays` は表示用。削除は `memory.delete` / Data Controls / 手動のみ。 |
| `meeting_store.rs` | 会議系（`meetings`, `meeting_transcript_segments`, `meeting_note_blocks`, `meeting_templates`）。`memory.db` 内の別ストア。 | 同 `memory.db` | 会議録音中の transcript/note 追加、テンプレ初期化 | `meeting_commands` / `meeting_recipes` 経由 + `search` の `scope: meetings_only` | 無し |
| `summarizer_store.rs` | `mem_summaries` の CRUD。`target_kind='item'` のみ Phase 1。 | `mem_summaries` | 要約生成完了時（LLM 経由） | UI 表示時 (`memory_debug` / Memory 画面) | 無し（`acknowledged_at` / `snooze_until` で UI 抑制のみ） |
| `summarizer.rs` | `mem_summaries` を生成する LLM 呼び出しラッパ | `mem_summaries`（経由 `summarizer_store`） | サマリ生成リクエスト時 | — | — |
| `embed_backfill.rs` / `memory_store::backfill_embeddings` | 既存 `mem_items` 行に `embedding` を後付け。`capture_sampler` / `capture_ax` 除外。 | `mem_items.embedding` | 明示コマンド or 起動後バックグラウンド | — | 無し（rate-limit `delayMs` のみ） |
| `embeddings.rs` | OpenAI 互換 `/v1/embeddings` 呼び出し（BYOK） | — (in-memory のみ) | embed 時 | — | — |
| `context_assembly.rs` | LLM コール直前のヒット組み立て。**唯一のヒット供給点**として Phase 1 で集約済み。 | 読み専用（`memory_store::search_with_semantics` を委譲） | — | `chat_complete` / `brief_generate` / `draft_*` / `open_pack` / 一部 `meeting_recipes` | — |
| `llm.rs` | `chat_complete` / `brief_generate` / `draft_reply_for_brief` / `draft_from_payload` / `anthropic_tool_complete` 等の LLM 呼び出し集約。 | 読み専用 | — | クライアント要求時。Memory ヒットを system message に追加（条件付き）。 | — |
| `brief_actions.rs` | Brief 行の確定アクション。`open_pack` で Pack ディレクトリ + `memory_hits.md` を生成。 | `app_data_dir/packs/{id}/`（JSON + Markdown）、`active_focus.json` | アクション確定時 | UI 復帰時 | `clear_app_data_files()` で全削除可能 |
| `dead_letter.rs` | 失敗 ingest の退避。`(source, entity_id)` upsert で attempts++。 | `mem_dead_letter` | connector 失敗時 | リトライ UI | 無し（手動のみ） |
| `capture_sampler.rs` | macOS 前面アプリ + AX を 2 分上限で `mem_items` に ingest。secure text は除外。 | `mem_items`（`source=capture_sampler`/`capture_ax`） | サンプラ起動中 + 変化検知（`LAST_SIG`/`LAST_AX_SIG` で重複抑制） | — | DB 側無し。`RATE_LIMIT_MS=120_000` で重複抑制のみ。 |
| `macos_ax.rs` | AXUIElement → `AxFields` → `format_snapshot`。secure / 全空は `None`。 | — | サンプラから呼出 | — | — |
| `memory_debug.rs` / `memory_obs.rs` | UI 向けデバッグストアと観測ログ（ring buffer in-memory） | in-memory のみ | 各経路 | UI から | プロセス終了で消える |
| `schedule_queue.rs` | `schedule_queue.json` 追記 | JSON ファイル | スケジュール作成時 | 起動時 / UI 表示時 | 無し |
| `settings_store.rs` | `settings.json` の R/W、privacy フラグ等 | JSON ファイル | 設定変更時 | 起動時 + 設定画面 | — |
| `paths.rs` | `app_data_dir` 解決、`clear_app_data_files()` | — | — | — | — |
| `connector_sync.rs` / `calendar_sync.rs` / `gmail.rs` / `google_*` / `notion.rs` / `linear.rs` / `slack.rs` / `zoom.rs` / `github.rs` | 連携同期。引っ張ってきたアイテムを `memory_store::ingest` に流す。 | `mem_items`（`source=<connector>`） | 同期間隔またはユーザー操作 | — | 無し |
| `meeting_*` 群 | 会議録音 / 文字起こし / 拡張 / インポート / MCP 公開 | `meeting_*` テーブル | 会議実行中 | UI / Recipes | 無し |

---

## 2. UI / Node 側 (`hifi/`)

| 場所 | 役割 | 永続化 | 備考 |
|---|---|---|---|
| `hifi/lib/highlight.js` | `<mark>` レンダラ（FTS5 highlight 用 STX/ETX 整形） | — | UI 共通 |
| `hifi/lib/ipc-client.js` | Tauri `invoke` ラッパ + Tauri 不在時のモック | localStorage（モック時） | 開発 / プレビュー |
| `hifi/lib/brief-telemetry.js` | `chat.completion.context` イベントの ring buffer + Memory 化 | `localStorage` の ring buffer + `memory.ingest`（`source='telemetry_chat_context'`） | KIOKU 行を生む副作用あり |
| `hifi/screens-memory-debug.jsx` | Memory デバッグ画面 | — | `memory_debug` Rust と対 |
| `tools/amc-pipeline/src/composer.js` 他 | Anthropic 呼び出しで AMC 化 | — | 入力は **`MorningBriefCandidate`** で、`related_kioku_hits` と `decision_graph_hits` を**呼出側が用意**して渡す |
| `tools/amc-pipeline/src/schemas.js` | Zod スキーマ。`KiokuHitSchema` / `DecisionGraphHitSchema` を定義 | — | AMC 契約の正典 |

`amc-pipeline` は Node プロセスとして外部から動くこともある（`brief:run` / `brief:dry`）。本番では Rust 側 `shogun_brief_get` が同じ JSON を返す方針（`hifi/README.md:53`）。

---

## 3. 書き込み元と `mem_items.source` のマッピング

| ingest 呼出元 | `source` | `provenance`（自動） | embedding 付与 |
|---|---|---|---|
| `capture_sampler` ループ | `capture_sampler` | screen | **スキップ** |
| `capture_sampler` AX 経路 | `capture_ax` | screen | **スキップ** |
| `calendar_sync` | `google_calendar` | connector | あり |
| `gmail.rs` | `gmail` | connector | あり |
| 会議パイプライン | `meeting*` | meeting | あり |
| Memory 画面 (Quick capture) | `capture` | user | あり |
| Home 添付 | `home_attachment` | user | あり |
| Focus 開始 | `focus_session` | user | あり |
| `brief-telemetry.js` | `telemetry_chat_context` | user | あり |
| その他 connector / レガシー | varies | user (デフォルト) | あり |

**全 ingest が同一 `mem_items` に直書き**。中間ステージング・キュー・正規化レイヤーは無し。

---

## 4. 読み込みパス（context 注入が起きる経路）

| 経路 | デフォルトで Memory 注入 | 経路詳細 |
|---|---|---|
| `chat.complete` | **No**（明示の `memoryContext` 文字列 or `memoryAssembly` フラグ + privacy 許可時のみ） | `llm.rs:115–190`、`SYSTEM_PROMPT_BUDGET_CHARS=10_000`、 `memoryContext` 単体は 12,000 char クリップ |
| `brief.get` (`brief_generate`) | **Yes** | `llm.rs:366–`、`format_hits_brief_json_prompt` で番号付き、`SYSTEM_PROMPT_BUDGET_CHARS` |
| `shogun.draft_reply` (`draft_reply_for_brief`) | **Yes** | `llm.rs:441–`、`format_hits_reply_draft` |
| `shogun.open_pack` (`brief_actions::open_pack`) | **Yes（ファイル化）** | `format_hits_pack_markdown` で `packs/{id}/memory_hits.md` に**フルスニペットそのまま** |
| `draft_from_payload` | デフォルト No | `memoryAssembly` 指定時のみ、`DRAFT_PROMPT_BUDGET_CHARS=6_000` |
| meeting_recipes (`FollowUpEmail`/`FeatureDigest`/`PrdDraft`) | **Yes** | `MEETING_DIGEST_BUDGET_CHARS=8_000` 等 |

**重要**: `format_hits_pack_markdown`（`context_assembly.rs:212`）は **snippet をクリップせずそのまま** Markdown に書き出す。`capture_ax` 行（最大 ~2000 字）が複数ヒットすると Pack ファイル内に raw a11y dump が並ぶ。これは既存ファイル parity を保つための仕様（テスト `format_hits_pack_markdown_matches_open_pack_legacy_format` 参照）。

---

## 5. TTL / decay / cleanup の有無 (まとめ)

| 仕組み | 有無 | 場所 |
|---|---|---|
| 行単位 TTL | **無し** | — |
| `created_at` ベースの自動削除 | **無し** | — |
| アクセス頻度による decay | **無し** | — |
| 重複除去（強い） | 部分的: `(source, entity_id)` UNIQUE のみ | `idx_mem_items_entity_unique` |
| 重複抑制（弱い） | `capture_sampler` の `LAST_SIG` 同値ハッシュ in-memory のみ | `capture_sampler.rs:28` |
| 関連付け / グラフ | **無し** | — |
| ランキング（rerank 以外） | 無し（FTS rank と cosine のみ） | — |
| アクセスカウント | **無し** | — |
| クリーンアップ | 全削除 (`clear_app_data_files`) と Data Controls 範囲削除 / `memory.delete` 1 件のみ | `paths.rs:32` |
