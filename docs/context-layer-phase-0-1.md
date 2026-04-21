# コンテキスト層：フェーズ 0 / 1 詳細計画

更新: 2026-04-20  
対象: SHOGUN デスクトップ（Tauri）ローカル Memory（`memory.db`）と LLM 呼び出し経路。

---

## フェーズ 0 — 真実のソース・オブ・トゥース一覧

### 1. Memory 行（`mem_items`）の論理スキーマ

| 列 | 型 | 説明 |
|----|-----|------|
| `id` | TEXT PK | `m_{epoch_ms}` 形式（ingest 時生成） |
| `title` | TEXT | 短い見出し |
| `snippet` | TEXT | 本文・要約 |
| `source` | TEXT | 取り込みチャネル識別子（下表） |
| `kinds_json` | TEXT | タグ配列の JSON |
| `created_at` | INTEGER | epoch ms |
| `embedding` | BLOB | 任意、f32 リトルエンディアン連結 |
| `provenance` | TEXT | **フェーズ 1 追加** — `screen` \| `connector` \| `meeting` \| `user` |
| `entity_id` | TEXT | **フェーズ 1 追加** — 上流オブジェクト ID（任意） |
| `confidence` | REAL | **フェーズ 1 追加** — 0.0–1.0（任意） |
| `redaction` | TEXT | **フェーズ 1 追加** — `none` \| `summary_only` \| `redacted`（将来の UI / フィルタ用） |

FTS5 は `title`, `snippet`, `source` のみ。新列は検索対象外（意図どおり）。

### 2. ソース別一覧（`source` 文字列）

| `source` | provenance（自動） | embedding | 保持期間 | 備考 |
|----------|-------------------|-----------|----------|------|
| `capture_sampler` | screen | **スキップ** | **無期限**（ユーザーが Data Controls で削除するまで） | 前面アプリ名サンプル |
| `capture_ax` | screen | **スキップ** | 同上 | AX スナップショット（最大 ~2000 字） |
| `google_calendar` | connector | **あり** | 同上 | `calendar.sync`；`entity_id` にイベント ID を付与可能 |
| `gmail` | connector | **あり** | 同上 | `gmail.sync`；`entity_id` に Gmail メッセージ ID を付与 |
| `meetings_granola` 等 `meetings*` / `meeting` | meeting | **あり**（ingest 時） | 同上 | UI / 会議パイプラインから |
| `home_attachment` | user | あり | 同上 | Home のファイル添付 |
| `capture`（手動 Quick capture） | user | あり | 同上 | Memory 画面の手動保存 |
| `focus_session` | user | あり | 同上 | フォーカス開始ログ |
| その他・レガシー | user | あり | 同上 | デフォルトは `source` から推定しない場合 `user` |

**保持期間**: アプリは行単位の TTL を自動適用していない。削除は `memory.delete`、Data Controls の範囲削除、またはユーザーによる手動。`stats.historyDays` は最古 `created_at` からの**表示用**日数。

### 3. 会議データ（Memory 外）

`meeting_store` のトランスクリプト・ノート等は **別 SQLite テーブル**。`memory.search` の `scope: meetings_only` は会議用ヒットを返す。本ドキュメントの「Memory 行」とは別ストアだが、プロダクト上は同一「会議」provenance に分類する。

### 4. チャットにデフォルトで入るもの（プロダクト原則）

| 経路 | デフォルトで Memory を LLM に渡すか | 備考 |
|------|--------------------------------------|------|
| `chat.complete` | **いいえ** | クライアントが設定した `memoryContext`（文字列）のみをシステムメッセージに追加。空なら Memory なし。 |
| `chat.complete` + privacy フラグ | **任意** | オプション `memoryAssembly`（オブジェクト）が付き、かつ `settings.sections.privacy.allowChatServerMemoryAssembly === true`（明示オプトイン。未設定・`false` は拒否）のときのみ、サーバ側で `memory.search` 相当を実行しブロックを合成。 |
| `brief.get`（LLM 経路） | **はい** | ローカル Memory 上位ヒットを要約プロンプトに含める（実装は `context_assembly` に集約）。 |
| `shogun.draft_reply` | **はい** | Brief アイテム + セマンティック検索ヒット。 |
| `shogun.open_pack` | **はい**（ファイル化） | FTS で関連 Memory を `memory_hits.md` に出力。 |
| `shogun_draft` | **デフォルト否** | オプション `memoryAssembly` があるときのみローカルヒットをドラフトプロンプトに含める。 |

**原則**: ユーザーの明示操作なしにチャットへ大量のプライベート文脈を流し込まない。ブリーフ・ドラフト返信・パック生成など「ユーザーが要約・下書きを依頼した」経路でのみ積極的に Memory を引く。

---

## フェーズ 1 — 統一コンテキスト層

### 1. データモデル

- `provenance`: 4 値に正規化。ingest 時に省略された場合は **`source` から導出**（上表）。
- `entity_id`: カレンダーイベント ID、会議 ID 等。未設定は NULL。
- `confidence`: 推定・推論由来の行向け（将来）。未設定は NULL。
- `redaction`: 現状はほぼ `none`。将来、要約のみ外部送信等のポリシーに利用。

### 2. コード構成（Rust）

- 新規モジュール `context_assembly.rs`:
  - `assemble_memory_hits` — `query` / `limit` / `semantic` を受け、`memory_store::search` または `search_with_semantics` を単一路径で呼ぶ。
  - `format_hits_brief_json_prompt` — `brief_generate` 用の箇条書き。
  - `format_hits_reply_draft` — `draft_reply_for_brief` 用。
  - `format_hits_pack_markdown` — `open_pack` の `memory_hits.md` 用。
  - `format_hits_draft_context` — `draft_from_payload` 用（`memoryAssembly` 指定時）。

### 3. 呼び出し統合

| 呼び出し元 | 変更内容 |
|------------|----------|
| `llm::brief_generate` | `context_assembly` のみからヒット取得・整形 |
| `llm::draft_reply_for_brief` | 同上 |
| `llm::draft_from_payload` | 任意 `memoryAssembly` で同上 |
| `brief_actions::open_pack` | Memory 検索・Markdown 生成を `context_assembly` に委譲 |
| `llm::chat_complete` | 任意 `memoryAssembly`（`query`, `limit`, `semantic`）で追加システム文脈を合成可能 |

### 4. マイグレーション

- 既存 DB に列追加（`ALTER TABLE`）。既存行に対し `source` から `provenance` を一括バックフィル（`PRAGMA user_version` で 1 回のみ）。

### 5. 完了条件

- [x] 本ドキュメントと実装（`mem_items` 列、`context_assembly`、`ingest` 拡張）が一致する。
- [ ] `cargo test` / `cargo build` が通る（`cargo check` は通過）。
- [x] 既存 UI のデフォルト動作（チャットは手動 Memory のみ）が変わらない。

---

## 参考パス

- `src-tauri/src/memory_store.rs` — スキーマ・ingest・search
- `src-tauri/src/context_assembly.rs` — フェーズ 1 組み立て
- `src-tauri/src/llm.rs` — `brief_generate`, `draft_reply_for_brief`, `chat_complete`, `draft_from_payload`
- `src-tauri/src/brief_actions.rs` — `open_pack`
- `hifi/action-map.md` — UI ↔ コマンド対応
