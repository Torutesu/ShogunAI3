# SHOGUN — Granola Integration PRD (Backend Only, for Cursor)

## 0. Scope

Frontend は既に実装済み。本 PRD は **backend / logic layer のみ**。
UI コンポーネントの生成・スタイル指示・画面遷移設計は含めない。
既存フロントが叩く **Tauri commands と内部モジュール** を実装する。

---

## 0.1 フロント契約の照合メモ（本 workspace: `hifi`）

実装前に **必ず** 最新のフロントと再照合すること。以下は 2026-04 時点の `hifi` に対するスナップショットである。

### Tauri / Action レイヤ

- **会議専用の `invoke` は未登録**。`lib/shogun-api.js` および `app.jsx` の `ShogunAPI` マッピングに、ミーティング用コマンドは存在しない。
- ドメイン機能の多くは **`shogun_<snake_case>`**（例: `shogun_memory_search`, `shogun_brief_get`, `shogun_google_calendar_sync`）。アプリ一般は `app_*`、認証は `auth_*`。
- UI からは `window.SHOGUN_RUNTIME.executeAction` → `lib/action-registry.js` の **dot 記法**（例: `brief.get`, `memory.search`）が `ShogunAPI` メソッドにマッピングされる。会議系の `register("meetings.*", …)` は **未追加**。
- Meetings 画面（`screens-meetings.jsx`）は現状、カレンダー同期（`calendar.sync`）、Brief（`brief.get`）、ローカル `MeetingNoteLocal` / `MeetingMediaRecording`（ブラウザ MediaRecorder 経由のデモ）に依存。**PRD Section 6.4 のコマンド名とはまだワイヤされていない**。

### 推奨（実装時）

- **Rust の `#[tauri::command]` 名**は既存に合わせ **`shogun_meeting_*`** プレフィックスを推奨（下記 Section 6.4 / 付録 A の対応表）。
- フロントを `invoke` 直叩きにする場合も、`action-registry` に **`meetings.*`** を追加して `ShogunAPI` にメソッドを生やすのが既存パターンに沿う。

### MCP ツール識別子

- 本リポジトリ内の Morning Brief / AMC 系では **`shogun.<verb>`** 形式（例: `shogun.open_pack`）が例として登場。Section 10 の新規 tool も **ドット区切り + `shogun.` プレフィックス**で揃えることを推奨（付録 B）。

---

## 1. Context (既存 SHOGUN 構成)

- Tauri (Rust + React) / macOS 向け
- **Accessibility API capture** (Rust) — 画面テキスト取得済み
- **KIOKU** — PGLite + pgvector, 9 tables, hybrid search, 20 MCP tools, Dream Cycle
- **Morning Brief** — overnight 処理 → open 時表示
- **BYOK** — OpenAI / Anthropic key はユーザー管理
- Offline JWT license (Supabase)

この PRD で追加するのは「**会議の耳**」レイヤー。
Granola の会議記録 UX を、SHOGUN の画面記憶 (Accessibility) と同じ
KIOKU 記憶層に統合して、**Granola より広いコンテキスト記憶**を成立させる。

---

## 2. Goals / Non-Goals

### Goals

- macOS 上の**任意の会議アプリ** (Zoom / Meet / Teams / WebEx / Slack Huddle) の音声を **bot なし**で capture
- 録音ファイルは保持しない (transcript only, Granola と同じ privacy model)
- ユーザーの手打ちメモと AI 補完を **視覚的に分離**したデータ構造で保持
- 会議ノートを KIOKU の既存 memory schema に**自然に同居**させる
- 既存の 20 MCP tools から会議データも横断検索可能にする
- Recipe 機構を追加し、**画面履歴 + 会議 + KIOKU 記憶**を横断したアクション実行を可能にする

### Non-Goals

- 音声ファイルの保存・再生 (Granola と同じく transcript only)
- 会議への bot 参加
- iOS / Windows / Android 対応 (このマイルストーンは macOS のみ)
- CRM 直接連携 (後続マイルストーン)
- フロントエンド実装 (既存フロント利用)

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 Existing SHOGUN Frontend                 │
│             (実装済み - 本 PRD では触らない)               │
└──────────────────────┬──────────────────────────────────┘
                       │ Tauri invoke
┌──────────────────────▼──────────────────────────────────┐
│                  Tauri Command Layer                     │
│  start_meeting / stop_meeting / enhance_notes / ...     │
└──┬──────────────┬───────────────┬───────────────────┬──┘
   │              │               │                   │
┌──▼──────┐ ┌─────▼─────┐ ┌──────▼──────┐ ┌─────────▼────┐
│  Audio  │ │Transcriber│ │   Notes     │ │   Recipes    │
│ Capture │ │  (STT)    │ │  Engine     │ │   Engine     │
│  (Rust) │ │  (async)  │ │  (Rust+TS)  │ │  (Rust+TS)   │
└──┬──────┘ └─────┬─────┘ └──────┬──────┘ └─────────┬────┘
   │              │               │                   │
   └──────────────┴───────────────┼───────────────────┘
                                  │
                     ┌────────────▼────────────┐
                     │         KIOKU           │
                     │  (PGLite + pgvector)    │
                     │   既存 9 tables に      │
                     │   meetings 系 4 table   │
                     │   を追加                 │
                     └─────────────────────────┘
```

（図中のコマンド名は論理名。実装時は付録 A の **`shogun_meeting_*`** に寄せる。）

---

## 4. Audio Capture Module (Rust)

### 4.1 要件

- **System audio (loopback)** と **microphone input** を同時取得
- Stereo または mono の PCM 16kHz / 16bit に正規化
- **録音ファイル化しない** — メモリ上のリングバッファから STT へ直接流す
- Granola 同等で「手動起動のみ」— 自動記録禁止

### 4.2 実装方針 (macOS)

- macOS 14.2+ を最低要件とする
- **CoreAudio の Tap API** (`AudioHardwareCreateProcessTap` 等) を使い、
  システム音声をプロセス単位で tap
- マイクは `AVAudioEngine` または CoreAudio input unit
- Rust から Objective-C bridge 経由で呼ぶ (`objc2` crate 推奨)
- 2つのストリームを timestamp 同期させ、mixed mono PCM にしてから STT へ
- **TCC (Transparency, Consent, Control) 権限**: マイク + システム音声の事前許可 UI trigger を Tauri 側で実装

### 4.3 データ構造

```rust
pub struct AudioFrame {
    pub timestamp_ms: u64,      // meeting 開始からの ms
    pub source: AudioSource,    // Mic | System
    pub pcm: Vec<i16>,          // 16kHz mono
}

pub enum AudioSource { Mic, System }

pub struct MeetingSession {
    pub id: Uuid,
    pub started_at: DateTime<Utc>,
    pub app_bundle_id: Option<String>, // "us.zoom.xos" 等
    pub state: MeetingState,
}

pub enum MeetingState { Idle, Recording, Transcribing, Enhancing, Done }
```

### 4.4 Privacy 挙動

- 各 AudioFrame は STT に渡した直後に zeroize して drop
- ディスクには一切書かない (temp file 含む禁止)
- Meeting 終了時に in-memory ring buffer を即時 clear

---

## 5. Transcription Module

### 5.1 方針

- BYOK 前提。プロバイダは選択可能:
  - `Deepgram` (streaming, 低 latency)
  - `AssemblyAI` (streaming + diarization 強)
  - `OpenAI Whisper API` (fallback)
- ユーザー設定で選択。未設定時は Deepgram default
- Streaming transcription を使う (chunk → partial transcript 逐次返却)
- **Speaker diarization** を有効化 (最低 2 話者分離)

### 5.2 出力フォーマット

```rust
pub struct TranscriptSegment {
    pub meeting_id: Uuid,
    pub segment_id: Uuid,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: SpeakerLabel,      // Self | Other(n)
    pub text: String,
    pub confidence: f32,
    pub is_final: bool,             // partial か final か
}

pub enum SpeakerLabel {
    Self_,         // mic source
    Other(u8),     // system audio の diarized speaker idx
}
```

### 5.3 注意

- Mic source は無条件に `SpeakerLabel::Self_`
- System source 側の diarization 結果だけ `Other(n)` に割当
- partial segment は UI へ即 push、final で DB 書き込み
- 数字 (金額・日付・%) は transcription 精度が落ちる前提で、
  Enhance 段階の LLM に「数字は verbatim 尊重」を instruction 化

---

## 6. Notes Engine (核心)

Granola の最重要発明である **「ユーザー打 = 黒 / AI補完 = 灰」** の
データ構造をそのままモデル化する。

### 6.1 データモデル

```rust
pub struct Note {
    pub id: Uuid,
    pub meeting_id: Uuid,
    pub blocks: Vec<NoteBlock>,
    pub updated_at: DateTime<Utc>,
}

pub struct NoteBlock {
    pub id: Uuid,
    pub order: u32,
    pub content: String,
    pub origin: BlockOrigin,
    pub source_segments: Vec<Uuid>, // zoom-back 用: 紐付く TranscriptSegment
}

pub enum BlockOrigin {
    User,        // ユーザー手打ち (黒)
    Ai,          // AI enhance で追加 (灰)
    AiEdited,    // AI が出した後、ユーザーが編集 → 黒扱い
}
```

**重要**: `BlockOrigin` は frontend が色分けに使う。
backend は origin を**絶対に失わない**。
AI block をユーザーが 1 文字でも編集したら `AiEdited` に昇格し、
以降は User block と同等に扱う。

### 6.2 Enhance Notes 動作

```
Input:
  - user_blocks: Vec<NoteBlock where origin=User>
  - transcript: Vec<TranscriptSegment>
  - template: Option<Template>

Process:
  1. user_blocks の骨格を変えない (順序・原文保持)
  2. transcript から user_blocks でカバーされていないコンテキストを抽出
  3. LLM に以下を指示:
     - 各 user_block の直下/直後に、関連補足を Ai block として挿入
     - template があれば section 構造に従う
     - 原文にない推論はしない (hallucination 禁止)
     - 各 Ai block に source_segments を必ず付与
  4. 結果を Note に merge し保存

Output:
  - 更新済み Note (User + Ai blocks 混在)
```

**Re-enhance** は同じ処理を再実行するだけ。
ただし `AiEdited` と `User` block は**不変**として保護。

### 6.3 Transcript Zoom-back

- 各 Note block は `source_segments: Vec<Uuid>` を持つ
- フロントから `get_source_for_block(block_id)` を叩くと
  対応する TranscriptSegment 配列が返る
- Ai block は必ず 1 個以上の segment を持たねばならない (検証可能性)
- User block は segments 0 個でも OK

### 6.4 Tauri commands（論理名と推奨 `invoke` 名）

PRD 原案の論理操作と、**既存 SHOGUN の `shogun_*` 慣例に合わせた推奨コマンド名**の対応。payload はすべて JSON（Tauri deserialize）とする。

| 論理 | PRD 原案 | 推奨 Tauri command | 備考 |
|------|-----------|---------------------|------|
| 会議開始 | `start_meeting(template_id?)` | `shogun_meeting_start` | payload: `{ template_id?: string }` |
| 会議終了 | `stop_meeting(meeting_id)` | `shogun_meeting_stop` | `{ meeting_id: string }` |
| ユーザーブロック追加 | `append_user_block(...)` | `shogun_meeting_note_append_block` | `{ meeting_id, text, after_block_id?: string }` |
| ブロック編集 | `edit_block(...)` | `shogun_meeting_note_edit_block` | `{ block_id, text }` |
| ブロック削除 | `delete_block(...)` | `shogun_meeting_note_delete_block` | `{ block_id }` |
| Enhance | `enhance_notes(meeting_id)` | `shogun_meeting_enhance` | `{ meeting_id }` |
| Re-enhance | `re_enhance_notes(meeting_id)` | `shogun_meeting_re_enhance` | `{ meeting_id }` |
| Zoom-back | `get_source_for_block(block_id)` | `shogun_meeting_transcript_for_block` | `{ block_id }` |
| ライブ transcript | `get_live_transcript(meeting_id)` | `shogun_meeting_transcript_live` | `{ meeting_id }` |
| 会議パージ | （Section 12） | `shogun_meeting_purge` | `{ meeting_id }` |

フロントが `executeAction` 経由にする場合の **Action key 例**（`action-registry`）: `meetings.start`, `meetings.stop`, `meetings.note.append_block`, … — 実装時にフロントと確定すること。

---

## 7. Templates

### 7.1 データモデル

```rust
pub struct Template {
    pub id: Uuid,
    pub name: String,               // "Customer Interview"
    pub description: String,
    pub sections: Vec<TemplateSection>,
    pub enhance_instruction: String, // LLM への system prompt
    pub is_builtin: bool,
    pub created_by: Option<Uuid>,    // None = builtin
}

pub struct TemplateSection {
    pub title: String,
    pub guidance: String,            // "key pain points, quotes, numbers"
}
```

### 7.2 Builtin templates (最低限)

- `1-on-1`
- `Standup`
- `Weekly Team Meeting`
- `Customer Interview`
- `Sales Call`
- `Design Review`

### 7.3 動作

- `start_meeting(template_id)` で選択 → 骨格 section を Note に事前挿入
- `enhance_notes` 時に template.enhance_instruction を system prompt に合成
- ユーザー作成 template は KIOKU の `templates` table に保存

---

## 8. Recipes Engine

Granola Recipes 互換 + SHOGUN 拡張。

### 8.1 Granola との差分

| | Granola Recipe | SHOGUN Recipe |
|---|---|---|
| 対象 | 単一会議 transcript | 会議 + 画面履歴 + KIOKU |
| 呼び出し | Granola Chat 内 `/` | SHOGUN Chat + Morning Brief |
| 出力 | text | text / action / MCP tool call |

### 8.2 データモデル

```rust
pub struct Recipe {
    pub id: Uuid,
    pub name: String,              // "Coach Me" / "Draft follow-up email"
    pub description: String,
    pub prompt_template: String,   // {{meeting}}, {{screen_history}}, {{memory}} などを展開
    pub scope: RecipeScope,
    pub is_builtin: bool,
}

pub enum RecipeScope {
    MeetingOnly,              // 会議 transcript のみ
    MeetingPlusMemory,        // + KIOKU 検索
    MeetingPlusScreen,        // + 画面 Accessibility 履歴
    Full,                     // すべて
}
```

### 8.3 Builtin Recipes (最低限)

- `Coach Me` — 発言比率、open question 比率、filler word
- `Follow-up Email Draft` — scope=Full
- `Extract Action Items` — scope=MeetingOnly
- `Feature Request Digest` — scope=MeetingPlusMemory
- `PRD Section Draft` — scope=Full
- `Decision Log` — scope=MeetingOnly

### 8.4 実行

論理: `run_recipe(recipe_id, meeting_id) -> RecipeResult`

推奨 Tauri command: `shogun_meeting_recipe_run` — payload: `{ recipe_id, meeting_id }`。

RecipeScope に応じて以下をコンテキストに注入：

- transcript (必須)
- KIOKU hybrid search 結果 (scope に応じ)
- Accessibility capture 直近 N 時間 (scope に応じ)

---

## 9. KIOKU Integration

### 9.1 既存 9 tables に追加する 4 tables

```sql
-- 会議セッション
CREATE TABLE meetings (
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  app_bundle_id TEXT,
  template_id UUID REFERENCES templates(id),
  title TEXT,
  participants JSONB, -- 識別可能な範囲で
  embedding VECTOR(1536) -- 会議全体の要約 embedding
);

-- transcript (final segments のみ)
CREATE TABLE meeting_transcript_segments (
  id UUID PRIMARY KEY,
  meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE,
  start_ms BIGINT NOT NULL,
  end_ms BIGINT NOT NULL,
  speaker TEXT NOT NULL,      -- "self" | "other_1" | "other_2" ...
  text TEXT NOT NULL,
  confidence REAL
);

-- notes (block 単位)
CREATE TABLE meeting_note_blocks (
  id UUID PRIMARY KEY,
  meeting_id UUID REFERENCES meetings(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  content TEXT NOT NULL,
  origin TEXT NOT NULL,       -- 'user' | 'ai' | 'ai_edited'
  source_segment_ids UUID[],  -- transcript zoom-back 用
  embedding VECTOR(1536)
);

-- templates (user + builtin)
CREATE TABLE templates (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  sections JSONB NOT NULL,
  enhance_instruction TEXT NOT NULL,
  is_builtin BOOLEAN DEFAULT false,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 9.2 Hybrid Search 拡張

既存の KIOKU hybrid search (pgvector + keyword) に、
`meeting_transcript_segments.text` と `meeting_note_blocks.content` を追加する。

検索 API は unified:

```
search_memory(query: String, scope: SearchScope)
  -> Vec<MemoryHit>

pub enum SearchScope {
    All,
    ScreenOnly,
    MeetingsOnly,
    Folder(Uuid),
    TimeRange(DateTime, DateTime),
}
```

既存の memory 検索コマンド（例: `shogun_memory_search`）の **payload に `scope` を追加**する形が自然。別コマンドにする場合は `shogun_memory_search` の挙動と重複しないようドキュメント化すること。

### 9.3 Dream Cycle 拡張

overnight 処理に以下を追加：

- 当日の meeting を横断して要約を生成 → `daily_digest` に保存
- 未処理の action items を抽出 → `tasks` に昇格
- 会議と画面履歴を相互参照し、「会議で言及されたが未実行の項目」を検出

### 9.4 Morning Brief 拡張

既存 Morning Brief のセクションに追加：

- 昨日の会議サマリ (meeting title + 3 bullets)
- 未完了 action items
- 今日の会議予定 (Calendar 連携済みなら)

---

## 10. MCP Tools 拡張

既存 20 tools に以下を追加する（**識別子は Morning Brief / AMC と同様 `shogun.*` ドット形式で統一**することを推奨）。

| 論理（PRD原案） | 推奨 tool 名 | 返却 |
|-----------------|--------------|------|
| `list_meetings(...)` | `shogun.meetings_list` | `Meeting[]` |
| `get_meeting(id)` | `shogun.meeting_get` | `MeetingDetail` |
| `get_meeting_transcript(id)` | `shogun.meeting_transcript` | `TranscriptSegment[]` |
| `get_meeting_notes(id)` | `shogun.meeting_notes` | `NoteBlock[]` |
| `search_meetings(query, filters?)` | `shogun.meetings_search` | `MeetingHit[]` |
| `run_recipe_on_meeting(recipe_id, meeting_id)` | `shogun.meeting_recipe_run` | `RecipeResult` |

### 認可境界

- ローカルツール (SHOGUN app 内) は無制限アクセス
- 外部 MCP client (Claude Desktop 等) は OAuth 2.0 + DCR で接続
- Granola と同じ境界: **自分所有のノートのみ**外部 MCP から参照可能

---

## 11. Folder / Scope

Granola の Folder 概念を KIOKU 既存のタグ / scope と統合：

```rust
pub struct Folder {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
    pub meeting_ids: Vec<Uuid>,
}
```

- Folder 単位の Chat は `search_memory(query, scope=Folder(id))` で実装
- Folder 横断パターン抽出は Recipe 化可能

---

## 12. Privacy / Compliance

- Audio buffer は RAM only、終了時 zeroize
- Transcript / notes は完全ローカル (PGLite)
- BYOK: STT / LLM はユーザーキーで直接叩く (SHOGUN サーバーを経由しない)
- ユーザーが会議単位で `purge_meeting(id)` を叩ける (cascade delete) — 実装コマンド名は `shogun_meeting_purge`（Section 6.4 表参照）
- macOS TCC: マイク + 画面収録 + Accessibility の 3 権限すべて明示取得

---

## 13. Error Handling

- STT 接続断 → メモリ上に最後の 60s PCM を hold し、復旧時に再送
- Enhance 失敗 → Note は User blocks のまま保持、再試行可能
- Disk full → 新規 meeting 開始を拒否、既存 meeting 継続
- BYOK key 無効 → 会議開始前に事前検証、途中で落ちないように

---

## 14. Build Order (Cursor 向け実装順)

1. KIOKU schema migration (4 tables 追加)
2. Audio Capture (Rust, macOS CoreAudio Tap)
3. Transcription (Deepgram streaming client)
4. Notes Engine data model + Tauri commands
5. Enhance Notes (LLM 呼び出し)
6. Templates (builtin 6 種)
7. Transcript zoom-back
8. Recipes Engine + builtin 6 種
9. MCP tools 6 個追加
10. Dream Cycle / Morning Brief 拡張
11. Folder scope
12. E2E テスト (実会議で smoke test)

---

## 15. 既存モジュールへの影響

- **Accessibility Capture**: 変更なし。ただし Recipe scope=Full のときに参照される
- **KIOKU**: schema 追加のみ、既存テーブル変更なし
- **Morning Brief**: セクション追加のみ
- **MCP Server**: tool 追加のみ、既存 20 tools は不変
- **Frontend (既存)**: 本 PRD では触らない。Tauri command 名を既存命名規約に揃えること

---

## 16. Out of Scope (別 PRD)

- CRM 連携 (HubSpot / Attio / Salesforce)
- Slack / Notion 書き出し
- Zapier
- Windows / iOS 対応
- 録音ファイル保存 (設計思想上、将来も追加しない可能性が高い)

---

## Cursor への指示

1. 本ドキュメントを単一ソースとする
2. Section 14 の build order 通りに順次実装
3. 各モジュールは **Rust crate として分離** し、Tauri main から組み上げる:
   - `crates/audio_capture`
   - `crates/transcription`
   - `crates/notes_engine`
   - `crates/recipes_engine`
4. すべての新規 Tauri command は `src-tauri/src/commands/meetings/` に集約（リポジトリに該当パスが無い場合は同等のモジュール分割でよい）
5. **フロントの `invoke` / `executeAction` 名は実装直前に `hifi` の `lib/shogun-api.js`・`lib/action-registry.js` と突き合わせ、本 PRD Section 0.1・6.4・10 を更新してからマージすること**
6. テスト: 各 crate に unit test、Tauri level に integration test
7. 実装中に仕様の曖昧箇所があれば、本 PRD にコメント追記してから進める

---

## 付録 A: PRD 原案コマンド名 → 推奨 `shogun_meeting_*` 一覧

実装時の単一ソース用（Section 6.4 と同一内容）。

- `shogun_meeting_start`
- `shogun_meeting_stop`
- `shogun_meeting_note_append_block`
- `shogun_meeting_note_edit_block`
- `shogun_meeting_note_delete_block`
- `shogun_meeting_enhance`
- `shogun_meeting_re_enhance`
- `shogun_meeting_transcript_for_block`
- `shogun_meeting_transcript_live`
- `shogun_meeting_purge`
- `shogun_meeting_recipe_run`

---

## 付録 B: MCP tool 名（`shogun.*`）

- `shogun.meetings_list`
- `shogun.meeting_get`
- `shogun.meeting_transcript`
- `shogun.meeting_notes`
- `shogun.meetings_search`
- `shogun.meeting_recipe_run`
