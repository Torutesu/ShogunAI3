# Memory Digest: Summary & Prioritization

**Status**: Draft
**Date**: 2026-04-24
**Author**: Brainstorming session (Claude Opus 4.7 + user)

## Problem

`memory_store` に流入する生データ (Gmail messages, Calendar events, screen capture AX dumps) がそのままユーザに提示されている。特に screen capture は日あたり数百件のノイズになり、Memory River・Morning Brief・Chat context すべての体験を阻害する。ユーザは「重要なポイントだけ見たい」という明確な要求を持つ。

## Goals

- Memory River, Morning Brief, Chat context の 3 サーフェスで、要約ベースの表示/注入を提供する。
- 要約は一度生成したら永続化・再利用する (on-demand + cache)。
- Priority 判定 (high / medium / low) で画面のノイズを下げる。
- Screen capture は単発ではなくアクティビティセッション単位で集約する。
- 既存の `mem_items` テーブルは破壊変更しない (non-breaking)。
- 既存 Morning Brief パイプラインは summary を入力として受けるよう拡張 (非依存サーフェスでは完全に維持)。

## Non-Goals

- V1 では要約の手動編集機能を持たない。
- V1 では複数モデルの切り替えをしない (Sonnet 4.6 で統一)。
- V1 ではキャッシュ無効化の自動化 (TTL など) をしない。schema_version bump 時のみ全削除。
- `low` priority アイテムのグルーピング UI (「その他 N 件」集約) は V1 対象外。
- Realtime (on-ingest) の要約生成はしない。on-demand + 朝バッチのみ。

---

## § 1. Architecture Overview

### モジュール構成

```
src-tauri/src/
  summarizer.rs         [新規]  LLM 呼び出し + プロンプト管理
  summarizer_store.rs   [新規]  mem_summaries / mem_sessions テーブル管理
  session_grouper.rs    [新規]  screen capture セッション境界検出
  memory_store.rs       [既存]  テーブル作成 DDL に 2 テーブル追加 (init_db)
  commands.rs           [既存]  新規 Tauri コマンド 4 本追加
  llm.rs                [既存]  Anthropic messages API の薄ラッパ流用
  lib.rs                [既存]  invoke_handler! に新コマンド登録
  settings_store.rs     [既存]  enable_memory_summary boolean 追加
```

### 新規 Tauri コマンド

| コマンド | 用途 | 呼び出し元 |
|----------|------|-----------|
| `shogun_memory_summary_get` | 単一 item / session / day_rollup の要約取得 (キャッシュ優先、無ければ同期生成) | River カード、Chat context assembly |
| `shogun_memory_summary_batch` | 複数 id の一括要約 (並列 max 5、朝バッチ用) | Morning Brief ロード時 |
| `shogun_memory_session_list` | 指定日の sealed session 一覧 + 各要約 | Memory River (screen ソース表示) |
| `shogun_memory_summary_invalidate` | 特定 id のキャッシュ削除 | dev only |

### プロセス内レイヤリング

```
┌────────────────────────────────────┐
│ UI (JSX): River / Morning Brief     │
└──────┬─────────────────────────────┘
       │ invoke()
┌──────▼─────────────────────────────┐
│ commands.rs (新規 4 コマンド)         │
└──────┬─────────────────────────────┘
       │
┌──────▼─────────────────────────────┐     ┌─────────────────────┐
│ summarizer.rs                       │◀───▶│ llm.rs (Anthropic) │
│  - generate_item_summary()         │     └─────────────────────┘
│  - generate_session_rollup()       │
│  - heuristic_fallback()            │
└──────┬─────────────────────────────┘
       │                             ┌─────────────────────┐
┌──────▼──────────────────────┐      │ session_grouper.rs  │
│ summarizer_store.rs          │◀─────│  - sweep_sessions() │
└──────┬──────────────────────┘      └─────────────────────┘
       │
┌──────▼──────────────────────┐
│ SQLite (mem_items 同居)       │
│  - mem_summaries              │
│  - mem_sessions               │
└──────────────────────────────┘
```

### 設計原則

- **summarizer.rs**: LLM と prompt に責任集中。プロンプト改善がこのファイル内で完結する。
- **summarizer_store.rs**: DB I/O に責任集中。スキーマ変更時の影響を局所化。
- **session_grouper.rs**: screen 特化ロジック。connector/meeting には触らない。
- 既存 `memory_store.rs` は init_db の DDL 追加のみの最小変更。

---

## § 2. Data Model

### テーブル: `mem_summaries`

```sql
CREATE TABLE IF NOT EXISTS mem_summaries (
  target_kind    TEXT    NOT NULL,           -- 'item' | 'session' | 'day_rollup'
  target_id      TEXT    NOT NULL,           -- item.id / session.id / date (YYYY-MM-DD)
  title          TEXT    NOT NULL,           -- 要約見出し (<=80 文字)
  key_points     TEXT    NOT NULL,           -- JSON array of strings (1-5 個、各 <=140 文字)
  source_type    TEXT    NOT NULL,           -- 'mail' | 'calendar' | 'meeting' | 'screen_session' | 'screen_day'
  priority       TEXT    NOT NULL,           -- 'high' | 'medium' | 'low'
  reason         TEXT,                        -- なぜその priority か (<=60 文字)
  model          TEXT    NOT NULL,           -- 'claude-sonnet-4-6' | 'heuristic'
  schema_version INTEGER NOT NULL DEFAULT 1,
  generated_at   INTEGER NOT NULL,           -- unix_ms
  raw_json       TEXT    NOT NULL,           -- LLM 応答 tool_use 全文 (再解析用)
  PRIMARY KEY (target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_mem_summaries_generated_at
  ON mem_summaries(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_summaries_priority
  ON mem_summaries(priority, generated_at DESC);
```

### テーブル: `mem_sessions`

```sql
CREATE TABLE IF NOT EXISTS mem_sessions (
  id            TEXT    PRIMARY KEY,         -- 'sess_<start_ms>'
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  item_count    INTEGER NOT NULL,            -- 含まれる mem_items 件数
  item_ids      TEXT    NOT NULL,            -- JSON array of mem_items.id (最大 200 件で truncate)
  primary_kinds TEXT    NOT NULL,            -- JSON array: 頻出 kinds (例: ["screen"])
  app_hint      TEXT,                        -- 最頻 window title から抽出 (Figma, VS Code 等)
  sealed        INTEGER NOT NULL DEFAULT 0,  -- 1 = 境界確定
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mem_sessions_time
  ON mem_sessions(start_ms DESC);
CREATE INDEX IF NOT EXISTS idx_mem_sessions_sealed
  ON mem_sessions(sealed, end_ms DESC);
```

### 設計の要点

**`target_kind` で 3 種類を統一管理**
- `item` → connector (mail/calendar) / meeting の単発 (`target_id` = `mem_items.id`)
- `session` → screen capture セッション (`target_id` = `mem_sessions.id`)
- `day_rollup` → 日次集約 (`target_id` = `"YYYY-MM-DD"`)

`summarizer_store::get_cached(kind, id)` 1 関数で 3 パターン対応。

**`raw_json` を保持**
- LLM 応答を丸ごと保存 → プロンプト改善・スキーマ拡張時に再解析
- schema_version bump 時のマイグレーション容易

**`sealed` カラム (session)**
- 最新 session は capture が届くたび `end_ms` を伸ばす (sealed=0)
- 15 分 activity なければ sealed=1 に遷移、以降は要約対象
- sealed=0 は要約キャッシュ作成対象外

**PRIMARY KEY が複合**
- `(target_kind, target_id)` 一意
- 再要約は UPSERT で上書き
- schema_version 差のみ invalidate、通常はキャッシュヒット

### 既存 `mem_items` への変更

**なし**。外部キー制約を張らず `target_id` で論理的に紐づけるのみ。理由: `mem_items.id` は `m_<ms>_<seq>` 文字列、FK 制約は TRUNCATE/再インデックス時に面倒。

### マイグレーション

`memory_store.rs::init_db()` に `CREATE TABLE IF NOT EXISTS` 2 つ追加。既存データ破壊なし。

---

## § 3. LLM Prompts & Model Selection

### モデル

**全ターゲット `claude-sonnet-4-6` で統一**。

| ターゲット | モデル | 理由 |
|-----------|--------|------|
| item (mail/calendar/meeting) | sonnet-4-6 | 単一ドキュメントの抽出的要約 |
| session | sonnet-4-6 | 時系列 capture からパターン抽出 |
| day_rollup | sonnet-4-6 | 前段要約が済んだ入力の統合 |

Anthropic prompt caching 有効化、system prompt は `cache_control: { type: "ephemeral" }` (5 分 TTL)。

### Tool Use スキーマ (共通)

Messages API の `tool_choice` を強制し、構造化出力を保証:

```json
{
  "name": "emit_memory_summary",
  "description": "Emit a single memory summary for display to the user.",
  "input_schema": {
    "type": "object",
    "properties": {
      "title":       { "type": "string", "maxLength": 80 },
      "key_points":  {
        "type": "array",
        "items": { "type": "string", "maxLength": 140 },
        "minItems": 1,
        "maxItems": 5
      },
      "source_type": {
        "type": "string",
        "enum": ["mail", "calendar", "meeting", "screen_session", "screen_day"]
      },
      "priority":    { "type": "string", "enum": ["high", "medium", "low"] },
      "reason":      { "type": "string", "maxLength": 60 }
    },
    "required": ["title", "key_points", "source_type", "priority"]
  }
}
```

### Priority 判定ルール (プロンプト埋め込み)

```
HIGH:
- Action required of the user (reply needed, decision pending, deadline mentioned)
- Calendar event starting within 24h
- Person-to-person message from a recognized frequent contact
- Screen session with significant content creation (>30 min focused)

MEDIUM:
- Informational with relevance (newsletter, meeting invite >24h out)
- Screen session with mixed activity
- Calendar event beyond 24h but this week

LOW:
- Automated notifications (CI builds, marketing, shipment tracking)
- Brief screen captures (<15 min, no clear activity)
- Calendar events already passed with no follow-up
```

`reason` フィールドに判定根拠を 1 行で書かせる。

### ソース別プロンプト (4 種)

| ファイル | 入力 | 指示 |
|---------|------|------|
| `prompt_item_mail.txt` | Gmail 1 件 (subject + from + snippet + body ≤4000 文字) | 抽出要約、sender を title に含む、action 必要なら high、bulk なら low |
| `prompt_item_calendar.txt` | Calendar 1 件 (summary + start/end + attendees + description) | 開始時刻相対で priority、参加者から会議性格推定、準備事項を key_points に |
| `prompt_session_screen.txt` | 1 session の capture 配列 (window title + 抜粋、最大 30 件) | 主要活動・使用アプリ・作業内容を抽出、意味ある作業は medium 以上 |
| `prompt_day_rollup.txt` | 同日の session 要約 + priority=high/medium の item 要約 | 全体像、主要トピック (最大 3)、未完了アクション、翌日への申し送り |

### コスト試算

- item summary: ~1500 input + 300 output = **~0.005 USD**
- session summary: ~4000 input + 400 output = **~0.013 USD**
- day_rollup: ~3000 input + 600 output = **~0.015 USD**

朝バッチ想定 (前日 30 items + 4 sessions + 1 day_rollup): **~0.22 USD / 日** → 月 ~6.6 USD

### Fallback: Heuristic

LLM 失敗時 (rate limit / network / invalid tool_use):

```rust
fn heuristic_item_summary(item: &MemItem) -> Summary {
  Summary {
    title: truncate(&item.title, 60),
    key_points: vec![extract_first_sentence(&item.snippet)],
    source_type: derive_source_type(&item.source),
    priority: "medium",                       // 判定不可なので中立
    reason: Some("LLM unavailable, heuristic fallback".to_string()),
    model: "heuristic",
  }
}
```

UI は必ず何か表示可能。LLM 復旧後に invalidate + 再生成で本物に置換。

---

## § 4. Data Flow

### Surface B: Memory River (主用途)

```
User が River を開く / スクロール
  ↓
memory.search(query="", limit=40) で mem_items を 40 件取得
  ↓
UI が item id リストを集めて:
  invoke('shogun_memory_summary_batch', { ids: [...] })
  ↓
summarizer_store.get_cached_many(ids) でキャッシュ一括確認
  ├─ ヒット → 即返却 (想定 95%)
  └─ ミス → summarizer.generate_item_summary() 並列 (max 5) → upsert → 返却
  ↓
UI レンダリング:
  - 要約カード (title + key_points) がデフォルト
  - "Show raw" トグルで既存 snippet 展開
  - priority=low は 50% opacity + 折りたたみ
  - priority=high は左端 gold アクセントバー
```

Screen capture の扱い:
- `source=capture_ax` の item は **個別には表示しない**
- `shogun_memory_session_list(date)` でセッション一覧取得、各 session を 1 カードとして描画
- セッションカードタップで item_ids の raw capture 展開

### Surface A: Morning Brief

```
Home 画面ロード
  ↓
shogun_brief_get (既存) が走る
  ↓ (パイプライン入力に summary を注入)
shogun_memory_summary_batch で昨日分 connector item + sealed session を要約
  ↓
Morning Brief の候補生成ステップに summary を input (既存: raw snippet)
  (入力がクリーンになるので出力品質↑)
  ↓
shogun_memory_summary_get(kind="day_rollup", target_id=yesterday_date)
  → 結果を「Yesterday's Summary」セクションに表示
```

既存 Morning Brief の動作は維持、入力層の改善のみ (non-breaking change)。

### Surface C: Chat Context Assembly

```
User がチャット入力
  ↓
context_assembly.rs: memory.search(query, semantic=true, limit=15)
  ↓ (新規ステップ)
取得 hits の id で summary キャッシュ確認
  ├─ ヒット → Hit に summary フィールド埋め込み
  └─ ミス → raw snippet のまま (on-demand 生成はしない、Chat 遅延抑制)
  ↓
LLM プロンプト組み立て時、summary があれば summary を、なければ raw snippet を使用
  (summary は平均 150 字 vs raw 2000 字 → コンテキスト節約)
  ↓
Claude に送信、応答
```

Chat は on-demand 生成しない: ユーザ入力から応答までの P50 レイテンシを低く保つため。朝バッチ + River 閲覧で自然にキャッシュが埋まる運用前提。

### Session 生成 (Background)

`session_grouper.rs::sweep_sessions()` 呼び出しタイミング:
- Tauri アプリ起動時 1 回 (catch-up)
- `shogun_memory_session_list` 呼び出し時 (on-demand で最新化)

アルゴリズム:
```
1. sealed=0 の最新 session を取得
2. session.end_ms 以降の capture_ax source item を時系列取得
3. 各 capture の created_at を見て:
   - 前 capture と <15 min → 同 session に追加 (end_ms 更新)
   - >=15 min ギャップ → 現 session を sealed=1、新 session 作成
4. 最新 capture から 15 min 以上経過 → 現 session も sealed=1
5. 新規 sealed された session id を返す (呼び出し側で summary 対象にする)
```

計算量: O(n) where n = 未処理 capture 件数。

### キャッシュ無効化ポリシー

**デフォルト: 無効化しない** (YAGNI)。
- connector データは不変
- session sealed 後は不変
- schema_version bump 時のみ全削除 (起動時チェック)

デバッグ用 `shogun_memory_summary_invalidate` は dev build のみ有効。

---

## § 5. UI Integration

### Memory River カード (Surface B の主体)

**デフォルト表示 (要約カード)**:

```
┌─────────────────────────────────────────────────┐
│ ▌ Q2 予算レビュー依頼 (Alice)       13:18 · HIGH │  ← gold 左バー
├─────────────────────────────────────────────────┤
│ • 金曜までに承認要                                │
│ • 前年比 +8% の予算枠、主に人件費              │
│ • Alice が返信を待機中                            │
│                                 [Show raw] [↗] │
└─────────────────────────────────────────────────┘
```

- 左バー: high=`var(--gold)`, medium=`var(--border-hi)`, low=`transparent` + カード全体 50% opacity
- 右上: 時刻 + priority バッジ (HIGH/MED/LOW, t-mono 小字)
- title: 1 行、60 字 truncate
- key_points: 最大 5 個 `<li>`, 各 140 字 truncate
- `[Show raw]`: クリックで既存 snippet 展開 (max-height transition 200ms)
- `[↗]`: Open in Chat (既存流用)

**折りたたみ (low priority のデフォルト)**:

```
┌─────────────────────────────────────────────────┐
│ ⚠ GitHub CI: build succeeded          11:42 · LOW │
└─────────────────────────────────────────────────┘
```

1 行 title のみ。クリックで expand。

**Session カード (screen capture 用)**:

```
┌─────────────────────────────────────────────────┐
│ ▌ Figma: Mobile app design          09:12-10:47 │
│   [1h 35m · 42 captures · Figma (主)]           │
├─────────────────────────────────────────────────┤
│ • Tab bar コンポーネント 3 パターン試作             │
│ • 色彩パレット gold 系統で統一方針決定              │
│                                  [See captures] │
└─────────────────────────────────────────────────┘
```

- 時間レンジ + capture count + app_hint を meta 行に
- `[See captures]` で session.item_ids から raw capture 一覧展開

### Morning Brief (Surface A)

既存 `BriefItemCard` は変更なし。画面下部に新規セクション:

```
┌─────────────────────────────────────────────────┐
│ Yesterday's Summary                              │
├─────────────────────────────────────────────────┤
│ 2026-04-23 の主要トピック:                         │
│ • Q2 予算レビュー (Alice から金曜期限)             │
│ • Figma mobile 設計 (2h 作業)                     │
│ • 会議 3 件完了 (議事録未確認: 1 件)               │
│                                                  │
│ [View full Memory →]                            │
└─────────────────────────────────────────────────┘
```

`shogun_memory_summary_get(kind="day_rollup", target_id=yesterday_date)` の結果を描画。

### Chat Context (Surface C)

UI 変更なし (内部改善のみ)。summary ベースで AI 応答が簡潔化。

### Filter UI 拡張

既存の Memory filter に Priority 列を追加:

```
SOURCES                   PRIORITY
✓ Screen capture          ✓ High
✓ Audio / Meetings        ✓ Medium
✓ Manual input            ☐ Low        ← デフォルト OFF
✓ Calendar
✓ Mail
```

デフォルトで low を除外 = ユーザの「重要ポイントだけ」ニーズに初期状態で応える。

### 実装ファイル

- `hifi/screens-a.jsx`: River カード summary レンダリング + expand + filter 拡張
- `hifi/screens-morning-brief.jsx`: Yesterday's Summary セクション追加
- `hifi/lib/shogun-api.js`: IPC ラッパ追加 (`memorySummaryGet`, `memorySummaryBatch`, `memorySessionList`)
- `hifi/app.css`: priority バッジ色、左バー、low opacity

### アニメーション

- Summary 生成中 (キャッシュミス) は skeleton loader (既存 pattern 流用)
- Expand/collapse は CSS `max-height` transition 200ms
- Filter 変更は既存 `runRuntimeActionA('memory.search', ...)` パターンに従う

---

## § 6. Error Handling

### LLM 呼び出し失敗の分類

| エラー種別 | 検出方法 | 挙動 |
|-----------|---------|------|
| ネットワーク一時障害 | `reqwest::Error::is_timeout() / is_connect()` | 指数バックオフ 3 回 (500ms / 2s / 5s) |
| Rate limit (429) | status code | `Retry-After` ヘッダ尊重、最大 30s 待機 |
| 認証エラー (401) | status code | 即失敗、heuristic fallback、UI にキー再設定導線 |
| 無効な tool_use | `stop_reason != "tool_use"` or JSON 不整合 | heuristic fallback、raw_json に error 記録 |
| 異常な出力値 | tool 入力 JSON schema validation | heuristic fallback |
| タイムアウト (60s) | reqwest timeout | heuristic fallback |

### Batch 部分失敗

`shogun_memory_summary_batch` 戻り値:

```json
{
  "ok": [{ "target_id": "m_...", "summary": {...} }, ...],
  "failed": [{ "target_id": "m_...", "error": "rate_limited" }, ...],
  "heuristic_used": 2
}
```

UI 側で failed 件数をトースト表示、再試行ボタン提供。

### Session Grouper のエラー

- sealed=0 session は常に 1 件のみの不変条件
- `sweep_sessions()` は SQLite WRITE lock で race 防止
- 不整合検出 (capture created_at 逆行など) はログ + スキップ

---

## § 7. Testing Strategy

### Rust ユニットテスト

**summarizer_store.rs**:
- `upsert` → `get_cached` の round trip
- 同 PK の二重 upsert で overwrite
- `target_kind` 違いでの並存
- `schema_version` 差での invalidation

**session_grouper.rs**:
- 15 min 以内連続 capture → 1 session
- 15 min ギャップ → 2 session に分割
- sealed=0 の伸長、sweep で sealed=1 遷移
- 空の capture セット → session 作成されない

**summarizer.rs**:
- Heuristic fallback が常に有効な schema を返す
- Priority rules が各入力パターンで意図通り分岐

**commands.rs 新規 4 本**:
- mock LLM (`llm::chat_complete` 差し替え) で期待 JSON を返す
- batch で並列上限 (max 5) が守られる

### 統合テスト

- `tests/` に Node.js E2E を追加 (`npm run test:e2e` 統合)
- モックモード (`tauri.conf.json::mock_llm: true`) で heuristic 経路の全画面動作確認

### Smoke Test

- Gmail 20 件 + Calendar 24 件 + screen 2h 分をテストアカウントに流す
- Morning Brief ロード → ラグなく表示
- Memory River スクロール → summary カード、expand で raw
- Chat で関連質問 → summary が context 注入されているか log で確認

---

## § 8. Rollout / Phasing

### Phase 1 (MVP, 推定 1 週間)

- `mem_summaries` テーブル + `target_kind="item"` のみ
- connector (mail/calendar) の per-item summary
- Memory River への組み込み
- Priority enum + filter UI に追加
- Heuristic fallback 一式

この時点で **主要ニーズ「重要ポイントだけ見たい」は約 80% 達成** (connector が主ノイズ源)。

### Phase 2 (1-2 週間)

- `mem_sessions` + screen session 要約
- Session カード UI
- `target_kind="session"` 対応

### Phase 3 (1 週間)

- `target_kind="day_rollup"` 対応
- Morning Brief の Yesterday's Summary 統合
- Chat context assembly への summary 注入

### Phase 4 (未スケジュール)

- Priority=low のグループ化 UI
- Summary 手動編集
- 複数モデル対応 (将来検討)

### Feature Flag

`settings_store.rs::enable_memory_summary` boolean:
- デフォルト `true` (新規ユーザ有効)
- 既存ユーザはマイグレーションで `true`
- 問題時は `false` で従来動作にロールバック (Settings 画面に toggle)

`enable_memory_summary=false` なら River は従来通り raw snippet を表示。

---

## Open Questions / Future Work

- **Priority=low のグルーピング UI**: Phase 4 以降で「その他 N 件」集約形式を検討。
- **Summary の手動編集**: ユーザが要約を訂正 → raw_json に store、再学習シグナルへ。
- **多言語対応**: Sonnet 4.6 は多言語対応しているが、プロンプトの明示的な言語指定が必要か要検討。
- **Entity 抽出**: summary から人物・プロジェクト名を抽出して Kakejiku ビューに反映 (別 spec)。
- **Embedding ベース priority ランク**: 現在 LLM 判定のみ、将来 VIP sender のベクトル学習なども。

---

## Success Criteria

V1 デプロイ後に以下で判断:

1. Memory River で raw snippet が表示される頻度が 10% 以下 (low priority 除外後)。
2. Morning Brief のロード時間が従来比 +2 秒以内 (キャッシュ効く前提)。
3. Chat 応答の引用が summary ベースに切り替わっているか (ログで検証)。
4. Phase 1 (connector item のみ) で LLM コストが 1 日あたり $0.25 以下。V1 全体 (+ session + day_rollup) で 1 日あたり $0.50 以下。超過時は朝バッチ頻度を下げて調整可能なこと。
5. `enable_memory_summary=false` に戻しても従来機能が壊れないこと (ロールバック検証)。
