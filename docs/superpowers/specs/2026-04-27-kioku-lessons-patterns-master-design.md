# KIOKU — Lessons & Patterns Layer

**Status**: Design proposal (internal, not external-facing)
**Owner**: Select KK
**Target**: KIOKU schema v2(SHOGUN Phase 1〜3 共通)
**Last updated**: 2026-04-27

> **Implementation note (added by reviewer):** This master design will be implemented as 3 sub-specs:
> - Sub-spec A — Lessons MVP (§ 7 tasks 1-4): schema + capture from rejection + capture from tool failure + injection
> - Sub-spec B — Patterns MVP (§ 7 tasks 5-6): daily batch + Morning Brief retrieval
> - Sub-spec C — Settings UI (§ 7 task 7): Patterns / Lessons tabs
>
> Order: A → B → C. Each sub-spec gets its own brainstorm → spec → plan → implement cycle.
>
> **DB reality:** This doc says `PGLite/pgvector` and `VECTOR(768)`. The actual backend is `rusqlite` (SQLite, see `Cargo.toml`) with embeddings stored as BLOB and cosine similarity computed in Rust (see `memory_store.rs`). Sub-specs translate the SQL into SQLite-compatible form. The data model and intent are unchanged.

---

## 0. なぜこの層を足すのか

現在の KIOKU は「**何が起きたか**」を記録する層しかない。
具体的には:

- `events`(passive capture: window, app, accessibility tree, dwell)
- `embeddings`(semantic recall)
- `summaries`(rolling time windows)

これらはすべて **observation layer**。生データの粒度違いでしかない。

一方 SHOGUN の差別化は "Memory that captures your day. **Execution that acts on it.**" である以上、
**memory が execution を賢くしなければ意味がない。** observation だけでは agent は毎回ゼロから推論する。

足りないのは2つの抽象層:

| 層 | 何を記録するか | なぜ必要か |
|---|---|---|
| **Patterns** | ユーザーの繰り返し行動・好みの構造 | 次の行動を**先回り**するため |
| **Lessons** | 失敗・低品質出力・拒否されたアクション | 同じミスを**二度繰り返さない**ため |

これは Phase 3 の spatial-native でも同じで、「この window 配置で集中が切れる」「この時間帯に X を始めると 80% 中断される」みたいな空間的・時間的 lessons が積み上がる土台になる。

---

## 1. 既存層との関係

```
┌─────────────────────────────────────────────────┐
│ Layer 0: Episodic    (in-context, ephemeral)     │  ← 既存
├─────────────────────────────────────────────────┤
│ Layer 1: Events      (raw passive capture)       │  ← 既存
├─────────────────────────────────────────────────┤
│ Layer 2: Embeddings  (semantic search)           │  ← 既存
├─────────────────────────────────────────────────┤
│ Layer 3: Summaries   (time-windowed digest)      │  ← 既存
├═════════════════════════════════════════════════┤
│ Layer 4: Patterns    (recurring behavior shapes) │  ← 新規
├─────────────────────────────────────────────────┤
│ Layer 5: Lessons     (failure & rejection moat)  │  ← 新規
└─────────────────────────────────────────────────┘
```

Layer 4-5 は **Layer 1-3 から派生する二次データ**。
生データを直接書き換えず、別テーブルとして蓄積する(append-only)。

---

## 2. Layer 4: Patterns

### 定義

> 同一または類似の (context, action, outcome) が **n 回以上**観測された時に、その構造を1つのレコードに昇格させる。

要するに「ユーザーがいつもこうする」を構造化する。

### スキーマ(PGLite/pgvector)

```sql
CREATE TABLE patterns (
  id            UUID PRIMARY KEY,
  kind          TEXT NOT NULL,    -- 'temporal' | 'sequential' | 'preference' | 'spatial'
  trigger       JSONB NOT NULL,   -- いつ・どこで発火するか
  action        JSONB NOT NULL,   -- ユーザーが実際にやる/やった行動
  outcome       JSONB,            -- 結果(任意)
  confidence    REAL NOT NULL,    -- 0.0〜1.0
  observed_n    INT  NOT NULL,    -- 観測回数
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  embedding     VECTOR(768),      -- 意味検索用
  status        TEXT DEFAULT 'active'  -- 'active' | 'stale' | 'invalidated'
);

CREATE INDEX idx_patterns_kind     ON patterns(kind);
CREATE INDEX idx_patterns_active   ON patterns(status) WHERE status = 'active';
CREATE INDEX idx_patterns_emb_hnsw ON patterns USING hnsw (embedding vector_cosine_ops);
```

### kind の4分類

| kind | 例 | trigger 形 | action 形 |
|---|---|---|---|
| `temporal` | 「平日朝9時に Slack を開く」 | `{dow:[1..5], hour:9}` | `{app:"Slack", verb:"open"}` |
| `sequential` | 「Notion で議事録 → Linear でissue化」 | `{prev_action:"notion.write_meeting"}` | `{app:"Linear", verb:"create_issue"}` |
| `preference` | 「PR レビューは要約版を好む」 | `{task:"pr_review"}` | `{format:"tldr_first", length:"short"}` |
| `spatial` | 「左ディスプレイで集中作業、右で参照」 | `{display:"left"}` | `{focus_mode:true}` (Phase 3) |

### 昇格ロジック(generation)

```
1. 1日1回(local cron, idle時)バックグラウンドで走る
2. 直近 N 日(default 14日)の events / summaries を走査
3. 同じ shape の (context, action) クラスタを検出
   - context 類似度 > 0.85
   - action 完全一致 or 高一致
4. observed_n >= 3 になったら patterns テーブルに INSERT/UPSERT
5. observed_n >= 10 で confidence boost、>= 30 で "stable"
```

### invalidation(忘却)

- last_seen_at が30日以上前 → status = 'stale'
- ユーザーが明示的に否定(後述の lessons で `pattern_id` が紐付く) → status = 'invalidated'
- stale が90日続いたら hard delete 候補

**重要**: pattern は「正しさ」ではなく「観測された」事実。だからユーザーの行動が変わったら自動で錆びる仕組みが要る。

### 利用シーン(execution layer 側)

- **Morning Brief**: 「いつもの 9:30 Slack チェックの前に、未読 PR が3件あります」
- **先回り提案**: Notion で議事録書き終わった瞬間に「Linear に issue 化しますか?」
- **拒否最小化**: 「PR要約 short」を学習済みなら最初から短く出す

---

## 3. Layer 5: Lessons

### 定義

> agent が **失敗した・拒否された・低評価を受けた**事象を、
> 二度と同じ判断をしないための **append-only な教訓リスト**として永続化する。

これは「memory が execution を賢くする」直接的な層。
patterns が肯定的学習(do this)、lessons が否定的学習(don't do this)。

### スキーマ

```sql
CREATE TABLE lessons (
  id              UUID PRIMARY KEY,
  category        TEXT NOT NULL,    -- 'tool_failure' | 'user_rejection' | 'wrong_assumption' | 'policy_violation'
  trigger_context JSONB NOT NULL,   -- 何をしようとした時か
  attempted       JSONB NOT NULL,   -- 何をした(or しようとした)
  outcome         JSONB NOT NULL,   -- どうなった(error message, user feedback等)
  rule            TEXT NOT NULL,    -- 自然言語の教訓("PR要約に絵文字を入れると拒否される")
  scope           TEXT DEFAULT 'user',  -- 'user' | 'global' | 'session'
  source          TEXT NOT NULL,    -- 'explicit_feedback' | 'inferred_from_undo' | 'tool_error' | 'manual'
  embedding       VECTOR(768),
  created_at      TIMESTAMPTZ DEFAULT now(),
  applies_n       INT DEFAULT 0,    -- prompt に注入された回数
  prevented_n     INT DEFAULT 0,    -- これによって防がれた失敗回数(後述)
  status          TEXT DEFAULT 'active'  -- 'active' | 'superseded' | 'archived'
);

CREATE INDEX idx_lessons_category ON lessons(category);
CREATE INDEX idx_lessons_active   ON lessons(status) WHERE status = 'active';
CREATE INDEX idx_lessons_emb_hnsw ON lessons USING hnsw (embedding vector_cosine_ops);
```

### category の4分類

| category | トリガー | 例 |
|---|---|---|
| `tool_failure` | MCP tool が error を返した | 「`gmail.send` に Bcc 100件超で失敗」 |
| `user_rejection` | ユーザーが undo / reject / 強い否定 | 「議事録を絵文字付きで出したら『真面目にして』と言われた」 |
| `wrong_assumption` | agent の前提が誤りだったと後で判明 | 「『次の会議』と聞かれて Google Calendar だけ見たが、Notion にも予定があった」 |
| `policy_violation` | SHOGUN ルール違反(例: 競合名を出した、技術スタック露出) | 「LP コピーで『Tauri』と書いて修正された」 |

### 入力経路(source)

1. **explicit_feedback**: ユーザーが明示的に「これダメ」「やり直し」「こうじゃない」
2. **inferred_from_undo**: agent の action 直後に Cmd+Z / 削除 / 取り消しが**強いシグナル**
3. **tool_error**: MCP tool が construct error / permission error / quota error を返した
4. **manual**: ユーザーが「次から〜しないで」と明示的にルール化

### 注入ロジック(retrieval)

すべての agent run の冒頭で:

```ts
// 擬似コード
const candidates = await db.lessons.search({
  embedding: embed(currentTaskContext),
  status: 'active',
  topK: 5,
  minSimilarity: 0.75,
});

const systemPromptAddendum = candidates
  .map(l => `- ${l.rule}`)
  .join('\n');

// system prompt の末尾に "Lessons from past sessions:\n..." として注入
```

ポイント:
- **全件は注入しない**。コンテキスト爆発する。task に意味的に近いものだけ top-K
- 注入したら `applies_n++`
- そのrunでlessonに違反しなかったら(後段の verifier が判定) `prevented_n++`

### 昇華(supersession)

同じ trigger_context に対して新しいlessonが入った時、古い方が矛盾するなら自動的に `status='superseded'` にする。
判定は LLM (semantic compare) で月1回バッチ。

### moat としての性質

ユーザーが SHOGUN を使えば使うほど、その人専用の lessons が積み上がる。
これは **エクスポートできない移行コスト**になる。

> "Other AI tools start every conversation from zero. SHOGUN remembers what didn't work — for you."

(↑ 外部copy草案。NGワードチェック後、別途 shogun-angle-tweet スキル経由で精製する)

---

## 4. Phase 別ロードマップ

### Phase 1(macOS 2D, MVP)

**実装する**:
- patterns: `temporal`, `sequential`, `preference` の3種のみ
- lessons: `tool_failure`, `user_rejection` の2種のみ
- generation: 日次バッチ(node-cron, 02:30 local)
- retrieval: agent run 冒頭で top-5 注入

**実装しない**:
- spatial pattern(ディスプレイ単一前提なので無意味)
- supersession の自動判定(手動 archive のみ)
- prevented_n の自動カウント(verifier 不在)

### Phase 2(multi-display + focus graph)

**追加**:
- patterns: `spatial` 追加(focus graph 由来の context を取れるようになる)
- lessons の trigger_context に `display_id` / `window_bounds` を含められるように schema 拡張(NULL許容で互換維持)
- supersession 自動化(LLM judge)

### Phase 3(visionOS spatial-native)

**追加**:
- patterns spatial に `gaze_target`, `dwell_ms`, `window_pose` を追加
- spatial lessons("この window 配置だと中断される" )
- gaze-based attention pattern(視線が外れた瞬間を low-quality session signal として lesson source に)

schema は最初から spatial 用カラムを NULL 許容で持っておく(後付け migration を避ける)。

```sql
ALTER TABLE patterns ADD COLUMN spatial_context JSONB;  -- Phase 1から空で持つ
ALTER TABLE lessons  ADD COLUMN spatial_context JSONB;
```

`spatial_context` は `{display_id, window_bounds, gaze_target, dwell_ms, window_pose}` の任意フィールドを内包する。

---

## 5. プライバシー & データ主権

両層とも **ローカル PGLite に閉じる**。クラウド送信なし。

- BYOK で LLM に embed/judge する時、**rule 文だけ**送る(trigger_context の生データは送らない)
- 例外: ユーザーが明示的に export したい時のみ JSON dump 可能
- ユーザーが特定 lesson を削除した時、関連 events を一緒に消すかは別 confirm
- 「忘れて」コマンド: 自然言語で `forget that lesson about emojis` と言われたら該当 lesson を `status='archived'` にする

---

## 6. UI 露出(プロダクト内)

KIOKU 設定画面に新タブ:

- **Patterns** タブ: 学習済みパターンの一覧、各々を「これ違う」で invalidate 可能
- **Lessons** タブ: 累積数、カテゴリ別グラフ、「今月、SHOGUN は X 個の失敗を防いだ」counter
- どちらも個別レコード表示は **要約のみ**。生データは別画面でユーザーが明示的に depth-in した時だけ。

---

## 7. 実装タスク分解(Phase 1)

優先度順:

1. **schema migration**: patterns, lessons テーブル + index 追加(half day)
2. **lesson capture from user_rejection**: チャット内で `bad reply` ボタン押下 → lesson に変換(1.5 day)
3. **lesson capture from tool_failure**: MCP error handler に hook 仕込み(0.5 day)
4. **lesson injection**: agent run 冒頭で top-K retrieval + system prompt 末尾に注入(1 day)
5. **patterns daily batch**: events から temporal/sequential 抽出(2 day)
6. **patterns retrieval in Morning Brief**: 朝のサマリーで「いつもの〜」を出す(1 day)
7. **settings UI: lessons/patterns タブ**(2 day、frontend-design スキル併用)

合計: **約 8 開発日**(1人 solo, 集中ベース)

---

## 8. やらないこと(明示)

- **クロスユーザー学習**: 個人 OS なのでユーザー間で lessons/patterns を共有しない
- **クラウド同期**: Phase 3 までやらない。BYOK + local-first を崩さない
- **AI による"性格"形成**: lessons は事実ベース、性格モデルは作らない
- **Anthropic 公式 Memory tool との統合**: KIOKU は SHOGUN の独自層。混ぜない

---

## 9. 成功指標(Phase 1終了時)

- ユーザー1人あたり active lessons が 30 日で **20件以上** 蓄積される
- `applies_n / sessions` が **30%** を超える(=注入が実際に発火している)
- 同じ user_rejection が**繰り返される率**が、lesson 注入前比で **50% 以下**に下がる

これが達成できれば「SHOGUN は使うほど自分専用に賢くなる」という体験が成立する。

---

*This is an internal design doc. Do not surface schema details, layer names, or implementation specifics in external copy. For external messaging, see `shogun-brand` skill rules: benefit/experience-based language only.*
