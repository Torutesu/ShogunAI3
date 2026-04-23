# メモリ層の可観測性（Phase B-1 / B-2）設計

更新: 2026-04-23
対象: SHOGUN デスクトップ（Tauri）のコンテキスト取得経路の可観測性

## 背景（Phase A 所見）

Phase A で `memory.db` を直接検査した結果:

- 総行 2,326 のうち **全て `capture_ax` / `capture_sampler`** — Gmail / Calendar / Meeting / 手動 capture はゼロ行
- **embedding カラムは全行 NULL** — `capture_*` はスキップ設計 + 他 source が無いため semantic 検索の比較対象が実在しない
- FTS5 自体は健全: 件数 `mem_items_fts == mem_items == 2326`、既知キーワードでのプローブも返る
- `settings.json` に `sections.llm` が無い → Keychain に API key が無ければ `llm::chat_complete` は即エラー
- UI 側の `memoryAssembly` 配線・`brief.get` 呼び出しは多数存在する（`hifi/screens-c.jsx`, `hifi/screens-meetings.jsx`）

**結論**: 検索・組み立て・呼び出し経路は配線済み。しかし **実行時に何が呼ばれ・何が渡り・何が返ったかを外から観測する手段が無い**ため、「動いているか分からない」という状態になっている。データ不足（Phase α で解消予定）とは独立して、観測性を追加する価値がある。

## 非目標

本 spec では以下は**扱わない**:

- 検索精度そのものの改善（ハイブリッドスコアリング、チャンク化、リランカー等）— 将来別 spec
- ユーザー向けの出典表示 / "Used context" バッジ — Phase C で別 spec
- 新規コネクタ追加（Slack / Notion / Drive 等）— 本 spec の対象外
- OAuth 取得フローの改善
- `tauri_plugin_log` の書き出し先変更（既存の挙動を維持）

## 全体像

Phase B を 2 段階に分割:

1. **B-1（最小）** — `context_assembly` / `llm` / `memory_store` / `calendar_sync` / `gmail` の各ホットパスに **構造化ログ**を追加。`RUST_LOG=info` でターミナルに呼び出し内容が流れる状態を作る。
2. **B-2（画面）** — Hi-Fi UI に **開発者向け `Memory Debugger` 画面**を追加。B-1 で流すトレース項目と同じものを、ring buffer に蓄えて画面で閲覧できるようにする。任意クエリの即席実行もこの画面で可能。

B-1 を先に作る意味:
- 実行コストが最小（コード数十行）で、「呼ばれているか否か」の**直接の答え**が得られる
- B-2 のデータモデル（どのフィールドを ring buffer に入れるか）を B-1 のログ構造がそのまま規定するので、B-2 の設計が鋭くなる

---

## B-1: 構造化ログの追加

### 既存インフラ

- `tauri-plugin-log` (v2) が `debug_assertions` 時のみ `LevelFilter::Info` で起動済み（`lib.rs:72-78`）
- `log` crate (0.4) 経由で `log::info!` / `log::warn!` を呼べる
- 現状、`memory_store.rs:187,218,851` のみに数行のログが存在。context / llm / calendar_sync / gmail 経路はログ皆無

### 追加するログ項目

すべて `log::info!` で `target = "shogun::memory_obs"` を指定し、後から `RUST_LOG=shogun::memory_obs=info` でフィルタ可能にする。

| 箇所 | ログタイミング | フィールド |
|---|---|---|
| `context_assembly::assemble_memory_hits` 入口 | call 開始 | `query_len`, `limit`, `semantic` |
| `context_assembly::assemble_memory_hits` 出口 | call 終了 | `hits_count`, `elapsed_ms`, `provenance_counts`（例: `{screen: 7, connector: 3}`） |
| `llm::chat_complete` 入口（`memoryAssembly` あり経路） | `memoryAssembly` block 生成後 | `query_len`, `block_chars`, `hits_count`, `used_memory_context_string`（手動 string 併用のフラグ） |
| `llm::brief_generate` 出口 | LLM 応答の直後 | `sections_count`, `hits_used`, `elapsed_ms` |
| `llm::draft_reply_for_brief` 出口 | LLM 応答の直後 | `hits_used`, `elapsed_ms`, `content_len` |
| `memory_store::search_with_semantics` 出口 | 関数末尾 | `total`, `returned`, `semantic_applied`（bool: 実際に cosine 再ランクが走ったか） |
| `calendar_sync::spawn_background_calendar_sync` ループ | 各周回 | `enabled`, `credentials_present`, `due`, `last_sync_ms` |
| `calendar_sync` 成功 | 既存 `"calendar auto-sync: ingested N event(s)"` を維持 | `ingested` |
| `calendar_sync` 失敗 | 既存 `log::warn!` を維持 | `error` |
| `gmail::sync_messages`（存在するならそのエントリ関数） | 出口 | `fetched`, `ingested`, `errors` |
| `memory_store::ingest` 出口（非 `capture_*`） | 新規行コミット後 | `source`, `provenance`, `embedding_queued` |

### フォーマット方針

- 固定キー `event=<snake_case_name>`、残りは `key=value` ペアで 1 行 1 イベント
- テキスト本文（`query` の生値、`title`、`snippet`）は**出さない** — 長さのみ（`query_len`）または先頭 40 文字を `query_preview` としてクリップ
- 理由: ログに個人情報を残さない方針。Phase B-2 の画面は別経路（ring buffer）でフルクエリを保持するが、永続ログには書かない

### サンプル

```
INFO shogun::memory_obs: event=assemble_hits_begin query_len=32 limit=12 semantic=true
INFO shogun::memory_obs: event=assemble_hits_done hits=7 elapsed_ms=14 screen=5 connector=2 meeting=0 user=0
INFO shogun::memory_obs: event=chat_memory_block block_chars=4821 hits=7 manual_ctx=false
INFO shogun::memory_obs: event=brief_generate_done sections=4 hits_used=15 elapsed_ms=1820
INFO shogun::memory_obs: event=calendar_tick enabled=true credentials=true due=false last_sync_ms=1714...
```

### 実行方法（開発者）

```
cd src-tauri
RUST_LOG=shogun::memory_obs=info cargo tauri dev
```

`tauri-plugin-log` はデフォルトで stderr / OS ログファイル両方に出す。書き出し先は変更しない（既存動作維持）。

### B-1 完了条件

- [ ] 上表 11 項目のログが追加されている
- [ ] `cargo build` / `cargo test` が通る
- [ ] 既存のログ出力（`calendar auto-sync: ingested N event(s)` 等）は **メッセージ・レベルとも変えない**
- [ ] アプリを dev で起動し、Brief を 1 回叩くと `event=brief_generate_done ...` が stderr に出る
- [ ] `memoryAssembly` を送るチャット呼び出しで `event=assemble_hits_begin` → `event=assemble_hits_done` → `event=chat_memory_block` の 3 行が連続して出る
- [ ] 本文（クエリ生値や snippet）がログに出ていないことを grep で確認

---

## B-2: `/memory-debugger` 画面

B-1 のログは開発者が stderr を凝視する前提。B-2 は同じ情報を画面に載せ、履歴を遡れるようにする。

### ゲーティング

- Dev ビルド専用の画面。`cfg!(debug_assertions)` が true のときのみ IPC コマンドを登録
- さらに `settings.json` に `sections.developer.memoryDebugger === true` を要求（dev ビルドでもユーザー向けには隠せる）
- リリースビルドでは画面もルートも存在しない

### 画面構成

Hi-Fi の左サイドバー最下部に「Memory Debugger」項目を追加（ゲート有効時のみ）。画面は 4 タブ:

#### タブ 1: Query Tester

- クエリ入力 + `limit` (1-80) + `semantic` (bool) のフォーム
- 送信で `shogun_memory_debug_query` を呼び、以下を表示:
  - FTS 段階のヒット件数・上位 20 件（id / title / snippet / source / provenance / created_at）
  - semantic オン時: 各ヒットの cosine スコア・再ランク後順位
  - `context_assembly::format_hits_draft_context` / `format_hits_brief_json_prompt` / `format_hits_reply_draft` のそれぞれで生成されるブロック全文（コピーボタン付き、3 つ並記）

**目的**: 「このクエリを投げると実際に LLM に何が渡るか」を手元で再現できる

#### タブ 2: Recent Calls

`shogun_memory_debug_recent_calls(limit)` で ring buffer から最新 50 件のトレースを取り、時系列表で表示:

| timestamp | route | query_preview | hits | elapsed_ms | status |
|---|---|---|---|---|---|
| 12:34:56 | chat.complete | "先週のリリース..." | 7 | 1824 | ok |
| 12:34:20 | brief.get | (empty) | 15 | 2103 | ok |
| 12:33:40 | draft_reply | "Tanaka san" | 3 | 987 | err: API key... |

行クリックで詳細ペイン: 生クエリ（ring buffer に保持）、assembled ブロック全文、LLM 応答 status、エラーメッセージ

**目的**: 「さっきチャットで話した時、実際に context は付いたか？」を過去に遡って確認できる

#### タブ 3: Sync Health

`shogun_memory_debug_sync_status()` で各 source の状態を一覧:

| source | last_sync | ingested_last | error | credentials | auto_enabled |
|---|---|---|---|---|---|
| google_calendar | 2 min ago | 3 | — | ✅ | ✅ |
| gmail | 12 min ago | 0 | 401: invalid_grant | ✅ | ✅ |
| capture_ax | streaming | — | — | — | ✅ |

**目的**: 「Sync が回っているか / 失敗しているか」の一次情報を一画面で確認

#### タブ 4: DB Stats

`shogun_memory_debug_stats()` で `memory_store::stats` の拡張版を返す:

- 行数: total / source 別 / provenance 別
- Embedding カバレッジ: source 別に `with_embed / total %`
- FTS5 整合性: `mem_items_fts` count vs `mem_items` count（不一致なら赤）
- 最古・最新 `created_at`
- DB ファイルサイズ

**目的**: Phase A の sqlite 直検査を画面から実行できる

### 新規 IPC コマンド

| コマンド | 引数 | 戻り値 | 実装先 |
|---|---|---|---|
| `shogun_memory_debug_query` | `{ query, limit, semantic }` | FTS ヒット + semantic スコア + assembled ブロック | 新規 `memory_debug.rs` |
| `shogun_memory_debug_recent_calls` | `{ limit }` | ring buffer スナップショット | 新規 `memory_debug.rs` |
| `shogun_memory_debug_sync_status` | なし | source ごとの状態 | 新規 `memory_debug.rs` + `calendar_sync` / `gmail` 露出関数 |
| `shogun_memory_debug_stats` | なし | 拡張 stats | `memory_store::stats` を拡張 or 新規ラッパ |

すべて dev ビルド専用（`#[cfg(debug_assertions)]` で `tauri::generate_handler!` から登録）。

### ring buffer データモデル

新規モジュール `src-tauri/src/memory_debug.rs`:

```rust
pub struct CallTrace {
    pub ts_ms: u64,
    pub route: &'static str,        // "chat.complete" | "brief.get" | ...
    pub query: String,              // ring buffer に保持（永続ログには出さない）
    pub limit: u64,
    pub semantic: bool,
    pub hits_count: usize,
    pub provenance_counts: HashMap<String, u32>,
    pub elapsed_ms: u64,
    pub status: CallStatus,         // Ok | Err(String)
    pub assembled_block: Option<String>,  // format_hits_*_context の出力
}

pub struct RingBuffer {
    inner: Mutex<VecDeque<CallTrace>>,
    cap: usize,                     // 50
}
```

`context_assembly::assemble_memory_hits` と `llm::chat_complete` / `brief_generate` / `draft_reply_for_brief` / `draft_from_payload` の各呼び出しは、B-1 のログと同じタイミングで `RingBuffer::push` を呼ぶ。dev ビルド専用の `tauri::State` として `manage()` に乗せる。

**メモリ上限**: 50 件 × 各行最大 ~10 KB（assembled_block） = 500 KB。dev ビルドのみなので許容。

### Sync Health の情報源

現状 `calendar_sync.rs` は in-module static として **`LAST_SYNC_MS` のみ**を持っている（`last_ingested` / `last_error` は保持していない）。Sync Health タブのために state を拡張する:

```rust
// calendar_sync.rs 内
static STATE: Mutex<CalendarSyncState> = Mutex::new(CalendarSyncState::default());

pub struct CalendarSyncState {
    pub last_sync_ms: Option<u64>,
    pub last_ingested: Option<u64>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<u64>,
}

pub fn snapshot_calendar_sync_state() -> CalendarSyncState { /* clone の上返す */ }
```

既存の `LAST_SYNC_MS` 更新箇所（成功時）に `last_ingested` / `last_duration_ms` の更新を追加。`log::warn!("calendar auto-sync failed: {}", e)` の箇所に `last_error` 更新を追加。既存の挙動（ログ出力とリトライ条件）は変えない。

`gmail.rs` にも同等の state と snapshot 関数を追加。現状 gmail 側は自動 sync ループを持っていない（UI からの手動 sync のみ）ので、新規 state は `shogun_gmail_sync` 呼び出しの成功/失敗経路で更新する。

**読み取り専用の原則**: snapshot 関数は `Mutex::lock()` + clone のみ。実行ロジック（周回判定、API コール）には手を入れない。

### B-2 完了条件

- [ ] `memory_debug.rs` が新規追加され、dev ビルドのみコンパイルされる
- [ ] 4 つの新規 IPC コマンドが実装・登録されている
- [ ] `hifi/screens-memory-debug.jsx`（仮名）が追加され、4 タブが描画される
- [ ] Query Tester で任意クエリを叩くと FTS ヒット + assembled ブロックが画面に出る
- [ ] Recent Calls で過去 50 件のトレースが時系列で見える
- [ ] Sync Health に `google_calendar` / `gmail` の最終実行・ingested・error が表示される
- [ ] DB Stats が Phase A で調べた項目と一致する
- [ ] リリースビルド（`cfg(not(debug_assertions))`）では画面もコマンドも存在しない
- [ ] 画面にアクセスするためには `settings.json` の `sections.developer.memoryDebugger === true` が必要
- [ ] 既存の E2E テストが壊れていない

---

## リスク / 対応

| リスク | 対応 |
|---|---|
| ring buffer にクエリ生値が残ることで機微情報が漏れる | dev ビルドのみ、かつ明示的な `sections.developer.memoryDebugger` トグル必須。プロセス終了でメモリごと破棄 |
| 既存ログに性能影響 | `log::info!` は非有効時に実質 no-op。1 リクエストあたり 3-5 行増える程度で影響なし |
| 永続ログにクエリ本文が混入 | フィールド名で判別可能にし、`query_len` / `query_preview`（40 字クリップ）に統一。`assembled_block` は永続ログには出さず ring buffer のみ |
| Memory Debugger 画面がリリースビルドに残る | `#[cfg(debug_assertions)]` とコマンド登録ゲート、および `settings.developer.memoryDebugger` の両方を要求（二重ガード） |
| `calendar_sync` / `gmail` 側の snapshot 関数が既存挙動を壊す | 読み取り専用・Mutex lock のみ。既存同期ロジックは無改変 |

## ロールバック

B-1: ログ行の削除で 1 PR で revert 可能。既存動作変更なし。

B-2: `memory_debug.rs` 削除 + 4 コマンドの登録解除 + 画面ファイル削除。他モジュールへの変更はトレース push 呼び出しのみで、その箇所だけ revert すれば元通り。

## 依存・前提

- Phase α（ユーザー側: API key + Gmail/Calendar OAuth）の完了は **本 spec の前提ではない**。B-1 / B-2 とも α なしでも実装・動作確認できる（Sync Health が「not configured」と出るだけ）
- ただし B-2 の **価値** は α 完了後に最大化する（実データがないと Query Tester が退屈）
- `tauri-plugin-log` の現行設定（dev のみ Info）は変更しない

## 今後の拡張（本 spec 外）

- Phase C: ユーザー向け "Used context" バッジ（チャット返答の下に出典を表示。B-2 の ring buffer を最後の 1 件だけ UI に露出させる案）
- Retrieval 精度改善（ハイブリッドスコア / チャンク化 / クエリ書き換え）。B-2 の Query Tester はこの改善の A/B テスト基盤として再利用可能

## 参考パス

- `src-tauri/src/context_assembly.rs` — 単一入口 `assemble_memory_hits`
- `src-tauri/src/memory_store.rs` — search / search_with_semantics / ingest
- `src-tauri/src/llm.rs` — chat_complete / brief_generate / draft_reply_for_brief / draft_from_payload
- `src-tauri/src/calendar_sync.rs` — background Calendar sync
- `src-tauri/src/gmail.rs` — Gmail ingest
- `src-tauri/src/lib.rs:72-78` — `tauri-plugin-log` 初期化
- `hifi/lib/ipc-client.js:239,288,505` — `memoryAssembly` 配線
- `hifi/screens-c.jsx:48,59` — draft 経路の `memoryAssembly` 送信
- `hifi/screens-meetings.jsx:478,873,877,1212` — meetings からの呼び出し
- `docs/context-layer-phase-0-1.md` — 既存の context layer 仕様
