# Memory Digest Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connector (Gmail / Google Calendar) アイテムごとに構造化要約 (title / key_points / priority) を生成・キャッシュし、Memory River で要約カード + expand raw + Priority フィルタとして提示する。Heuristic pre-filter で bulk メール・CI 通知・過去カレンダー事件を LLM スキップしてコスト削減する。

**Architecture:** 新規 Rust モジュール `summarizer.rs` (LLM + heuristic + prompt) と `summarizer_store.rs` (mem_summaries テーブル CRUD) を追加。`llm.rs` に Anthropic tool_use 呼び出しヘルパ `anthropic_tool_complete` を追加し、summarizer から tool_use ベースで構造化出力を取得。UI 側は `screens-a.jsx` の Filter に Priority 列追加 + River scrubbed ビューで summary カードを描画し "Show raw" で既存 snippet 展開。`settings_store` に `enable_memory_summary` feature flag を追加 (デフォルト true、問題時は false でロールバック)。

**Tech Stack:** Rust (rusqlite 0.32, reqwest 0.12, tokio 1, serde_json 1.0), Anthropic Messages API with tool_use (claude-sonnet-4-6), React JSX (browser Babel, Memory River in `screens-a.jsx`).

**Spec reference:** `docs/superpowers/specs/2026-04-24-memory-digest-design.md` (commit `b54f60e`)

**Out of scope (Phase 2/3):** `mem_sessions` + screen capture session summaries, `target_kind="week_rollup"`, Morning Brief "Last Week's Summary", Chat context assembly への summary 注入。

---

## File Structure

**新規ファイル:**
- `src-tauri/src/summarizer.rs` — オーケストレーション + heuristics + LLM プロンプト
- `src-tauri/src/summarizer_store.rs` — `mem_summaries` テーブル CRUD

**変更ファイル:**
- `src-tauri/src/memory_store.rs` — `init_schema()` に `mem_summaries` CREATE TABLE 追加
- `src-tauri/src/llm.rs` — `anthropic_tool_complete()` ヘルパ追加
- `src-tauri/src/commands.rs` — 3 新規 Tauri コマンド
- `src-tauri/src/lib.rs` — モジュール登録 + `invoke_handler!` に新コマンド追加
- `src-tauri/src/settings_store.rs` — `enable_memory_summary` boolean のデフォルト追加
- `hifi/lib/shogun-api.js` — 3 新規 IPC ラッパ (`memorySummaryGet`, `memorySummaryBatch`, `memorySummaryInvalidate`)
- `hifi/screens-a.jsx` — Priority フィルタ列追加、River scrubbed カードで summary 表示 + "Show raw" expand

---

## Task 1: Feature flag を settings_store に追加

**Files:**
- Modify: `src-tauri/src/settings_store.rs` (`ensure_defaults` 関数の中)

### Step 1: 既存の `ensure_defaults` を確認

- [ ] 現在の boolean デフォルト設定パターンを `src-tauri/src/settings_store.rs:37` 付近で確認

```bash
grep -n "biometricLockEnabled\|entry(" src-tauri/src/settings_store.rs | head -10
```

期待: `o.entry("biometricLockEnabled".to_string()).or_insert(json!(false));` のような行がある。

### Step 2: `enable_memory_summary` デフォルト true を追加

- [ ] `src-tauri/src/settings_store.rs` の `ensure_defaults` 内、既存の boolean 設定の近くに以下を追加:

```rust
// Memory Digest (Phase 1): feature flag for summary generation and display.
o.entry("enableMemorySummary".to_string()).or_insert(json!(true));
```

配置場所: `sections.memory` の default 群 (semanticRerank 等がある場所) の近く。`sections.security` ではなく `sections.memory` ブロック内に追加すること。

### Step 3: ビルド確認

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` で警告なくビルド通ること

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

期待: `Finished` で終了、新規 warning なし。

### Step 4: コミット

- [ ] 変更を commit

```bash
git add src-tauri/src/settings_store.rs
git commit -m "feat(memory): add enableMemorySummary feature flag default

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `mem_summaries` テーブルを作成 (init_schema に追加)

**Files:**
- Modify: `src-tauri/src/memory_store.rs` (`init_schema` 関数内、既存の CREATE TABLE 群の後)
- Test: `src-tauri/src/memory_store.rs` 末尾の `#[cfg(test)]` mod tests

### Step 1: 失敗するテストを書く (テーブル存在確認)

- [ ] `src-tauri/src/memory_store.rs` の `#[cfg(test)] mod tests { }` ブロック末尾に追加:

```rust
  #[test]
  fn init_schema_creates_mem_summaries_table() {
    use rusqlite::Connection;
    let conn = Connection::open_in_memory().expect("open in-memory");
    // Run the same schema DDL the real init_schema runs.
    // (We'll mirror init_schema's CREATE TABLE statements into a helper
    // in the next step; for now just exercise the new table.)
    conn.execute_batch(
      "CREATE TABLE IF NOT EXISTS mem_summaries (
        target_kind    TEXT    NOT NULL,
        target_id      TEXT    NOT NULL,
        title          TEXT    NOT NULL,
        key_points     TEXT    NOT NULL,
        source_type    TEXT    NOT NULL,
        priority       TEXT    NOT NULL,
        reason         TEXT,
        model          TEXT    NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        generated_at   INTEGER NOT NULL,
        raw_json       TEXT    NOT NULL,
        PRIMARY KEY (target_kind, target_id)
      );"
    ).expect("create mem_summaries");

    // Verify we can insert a row.
    conn.execute(
      "INSERT INTO mem_summaries
         (target_kind, target_id, title, key_points, source_type, priority, reason, model, generated_at, raw_json)
       VALUES
         ('item', 'm_1', 'T', '[\"k\"]', 'mail', 'medium', 'r', 'heuristic', 1, '{}')",
      [],
    ).expect("insert row");

    let count: i64 = conn.query_row(
      "SELECT COUNT(*) FROM mem_summaries",
      [],
      |r| r.get(0),
    ).expect("count");
    assert_eq!(count, 1);
  }
```

### Step 2: テスト実行して FAIL を確認

- [ ] テストを走らせる

```bash
cargo test --manifest-path src-tauri/Cargo.toml init_schema_creates_mem_summaries_table -- --nocapture
```

期待: **PASS** する (このテストは DDL 自体を検証するだけなので実は実装なしで通る)。次のステップで本体に反映するために書いたテスト。

### Step 3: `init_schema` 本体に CREATE TABLE を追加

- [ ] `src-tauri/src/memory_store.rs` の `init_schema` 関数末尾に以下を追加 (既存の CREATE VIRTUAL TABLE mem_items_fts の後):

```rust
  // Memory Digest (Phase 1): per-item summary cache.
  // target_kind: 'item' | 'session' | 'week_rollup' (Phase 1 は 'item' のみ使用)
  // target_id: item.id / session.id / ISO week
  conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS mem_summaries (
      target_kind    TEXT    NOT NULL,
      target_id      TEXT    NOT NULL,
      title          TEXT    NOT NULL,
      key_points     TEXT    NOT NULL,
      source_type    TEXT    NOT NULL,
      priority       TEXT    NOT NULL,
      reason         TEXT,
      model          TEXT    NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      generated_at   INTEGER NOT NULL,
      raw_json       TEXT    NOT NULL,
      PRIMARY KEY (target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mem_summaries_generated_at
      ON mem_summaries(generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_summaries_priority
      ON mem_summaries(priority, generated_at DESC);"
  ).map_err(|e| format!(\"mem_summaries DDL: {}\", e))?;
  ```

実際の挿入位置は既存の `conn.execute_batch` 呼び出しパターンを踏襲すること (エラーハンドリングの `map_err` 形式を合わせる)。

### Step 4: 本物の起動で DDL 走ることを確認

- [ ] Tauri アプリを dev 起動し、SQLite DB ファイルに mem_summaries ができているか確認

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run tauri dev &
sleep 20  # wait for DB init
sqlite3 ~/Library/Application\ Support/ai.shogun.desktop/memory.db \
  ".schema mem_summaries"
```

(注: DB 実パスは `paths::app_data_dir()` の実装に従う。シェルから不明な場合は `find ~/Library -name memory.db 2>/dev/null` で確認)

期待: `CREATE TABLE mem_summaries (...)` が表示される。

### Step 5: 既存テストが全部通ることを確認

- [ ] 回帰チェック

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

期待: 全テスト pass、mem_summaries 関連の新規テストも含めて。

### Step 6: コミット

- [ ] Rust 変更を commit

```bash
git add src-tauri/src/memory_store.rs
git commit -m "feat(memory): add mem_summaries table for Phase 1 digest cache

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `summarizer_store.rs` モジュール作成 (CRUD)

**Files:**
- Create: `src-tauri/src/summarizer_store.rs`
- Modify: `src-tauri/src/lib.rs` (`mod summarizer_store;` 追加)
- Test: `src-tauri/src/summarizer_store.rs` 末尾の `#[cfg(test)]`

### Step 1: モジュールファイルを新規作成 (空の骨格)

- [ ] `src-tauri/src/summarizer_store.rs` を新規作成:

```rust
//! mem_summaries テーブルの CRUD。target_kind/target_id による統一管理。
//! Phase 1 では target_kind="item" のみ使用 (session/week_rollup は Phase 2/3)。

use crate::memory_store::open_conn;
use rusqlite::params;
use serde_json::{json, Value};

pub const SCHEMA_VERSION: i64 = 1;

/// 1 件の要約を表す Rust 構造体。DB 行と 1:1 対応。
#[derive(Debug, Clone)]
pub struct Summary {
  pub target_kind: String,
  pub target_id: String,
  pub title: String,
  pub key_points: Vec<String>,
  pub source_type: String,
  pub priority: String,   // 'high' | 'medium' | 'low'
  pub reason: Option<String>,
  pub model: String,
  pub schema_version: i64,
  pub generated_at: i64,
  pub raw_json: String,
}

impl Summary {
  /// UI / IPC で返すための JSON 表現。
  pub fn to_json(&self) -> Value {
    json!({
      "targetKind": self.target_kind,
      "targetId": self.target_id,
      "title": self.title,
      "keyPoints": self.key_points,
      "sourceType": self.source_type,
      "priority": self.priority,
      "reason": self.reason,
      "model": self.model,
      "schemaVersion": self.schema_version,
      "generatedAt": self.generated_at,
    })
  }
}

pub fn get_cached(target_kind: &str, target_id: &str) -> Result<Option<Summary>, String> {
  let conn = open_conn()?;
  let row = conn.query_row(
    "SELECT target_kind, target_id, title, key_points, source_type, priority,
            reason, model, schema_version, generated_at, raw_json
     FROM mem_summaries WHERE target_kind = ?1 AND target_id = ?2",
    params![target_kind, target_id],
    |r| {
      let kp_json: String = r.get(3)?;
      let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
      Ok(Summary {
        target_kind: r.get(0)?,
        target_id: r.get(1)?,
        title: r.get(2)?,
        key_points,
        source_type: r.get(4)?,
        priority: r.get(5)?,
        reason: r.get(6)?,
        model: r.get(7)?,
        schema_version: r.get(8)?,
        generated_at: r.get(9)?,
        raw_json: r.get(10)?,
      })
    },
  );
  match row {
    Ok(s) => Ok(Some(s)),
    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
    Err(e) => Err(format!("mem_summaries read: {}", e)),
  }
}

pub fn get_cached_many(target_kind: &str, ids: &[String]) -> Result<Vec<Summary>, String> {
  if ids.is_empty() {
    return Ok(Vec::new());
  }
  let conn = open_conn()?;
  let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("?{}", i + 1)).collect();
  let sql = format!(
    "SELECT target_kind, target_id, title, key_points, source_type, priority,
            reason, model, schema_version, generated_at, raw_json
     FROM mem_summaries
     WHERE target_kind = ?1 AND target_id IN ({})",
    placeholders.join(",")
  );
  let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {}", e))?;
  let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len() + 1);
  bound.push(&target_kind);
  for id in ids {
    bound.push(id);
  }
  let rows = stmt.query_map(bound.as_slice(), |r| {
    let kp_json: String = r.get(3)?;
    let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
    Ok(Summary {
      target_kind: r.get(0)?,
      target_id: r.get(1)?,
      title: r.get(2)?,
      key_points,
      source_type: r.get(4)?,
      priority: r.get(5)?,
      reason: r.get(6)?,
      model: r.get(7)?,
      schema_version: r.get(8)?,
      generated_at: r.get(9)?,
      raw_json: r.get(10)?,
    })
  }).map_err(|e| format!("query: {}", e))?;

  let mut out = Vec::new();
  for row in rows {
    out.push(row.map_err(|e| format!("row: {}", e))?);
  }
  Ok(out)
}

pub fn upsert(s: &Summary) -> Result<(), String> {
  let conn = open_conn()?;
  let kp_json = serde_json::to_string(&s.key_points)
    .map_err(|e| format!("key_points serialize: {}", e))?;
  conn.execute(
    "INSERT INTO mem_summaries
       (target_kind, target_id, title, key_points, source_type, priority,
        reason, model, schema_version, generated_at, raw_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(target_kind, target_id) DO UPDATE SET
       title = excluded.title,
       key_points = excluded.key_points,
       source_type = excluded.source_type,
       priority = excluded.priority,
       reason = excluded.reason,
       model = excluded.model,
       schema_version = excluded.schema_version,
       generated_at = excluded.generated_at,
       raw_json = excluded.raw_json",
    params![
      s.target_kind, s.target_id, s.title, kp_json, s.source_type,
      s.priority, s.reason, s.model, s.schema_version, s.generated_at, s.raw_json
    ],
  ).map_err(|e| format!("mem_summaries upsert: {}", e))?;
  Ok(())
}

pub fn delete(target_kind: &str, target_id: &str) -> Result<bool, String> {
  let conn = open_conn()?;
  let n = conn.execute(
    "DELETE FROM mem_summaries WHERE target_kind = ?1 AND target_id = ?2",
    params![target_kind, target_id],
  ).map_err(|e| format!("mem_summaries delete: {}", e))?;
  Ok(n > 0)
}
```

### Step 2: `lib.rs` にモジュール登録

- [ ] `src-tauri/src/lib.rs` の `mod` 宣言群 (行 10 付近) に追加:

```rust
mod summarizer_store;
```

既存の `mod memory_store;` などの近くに並べる。

### Step 3: ビルド確認

- [ ] コンパイル

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

期待: 警告のみ (未使用関数 `delete` 等)、エラーなし。

### Step 4: 失敗するテストを書く (upsert → get_cached 往復)

- [ ] `src-tauri/src/summarizer_store.rs` 末尾に追加:

```rust
#[cfg(test)]
mod tests {
  use super::*;

  fn setup_conn() -> rusqlite::Connection {
    use rusqlite::Connection;
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
      "CREATE TABLE mem_summaries (
        target_kind    TEXT    NOT NULL,
        target_id      TEXT    NOT NULL,
        title          TEXT    NOT NULL,
        key_points     TEXT    NOT NULL,
        source_type    TEXT    NOT NULL,
        priority       TEXT    NOT NULL,
        reason         TEXT,
        model          TEXT    NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        generated_at   INTEGER NOT NULL,
        raw_json       TEXT    NOT NULL,
        PRIMARY KEY (target_kind, target_id)
      );"
    ).unwrap();
    conn
  }

  fn sample(target_id: &str, priority: &str) -> Summary {
    Summary {
      target_kind: "item".into(),
      target_id: target_id.into(),
      title: "Test".into(),
      key_points: vec!["point 1".into(), "point 2".into()],
      source_type: "mail".into(),
      priority: priority.into(),
      reason: Some("because".into()),
      model: "test".into(),
      schema_version: 1,
      generated_at: 1700000000,
      raw_json: "{\"x\":1}".into(),
    }
  }

  #[test]
  fn summary_to_json_roundtrip() {
    // Purely struct logic, no DB.
    let s = sample("m_1", "high");
    let v = s.to_json();
    assert_eq!(v["targetKind"], "item");
    assert_eq!(v["targetId"], "m_1");
    assert_eq!(v["priority"], "high");
    assert_eq!(v["keyPoints"][0], "point 1");
  }
}
```

この時点では `upsert` や `get_cached` をテストしたくても本物の `open_conn()` がグローバル DB パスに書こうとするので、純粋なロジック (`Summary::to_json`) の往復だけを unit test する。DB 系の統合テストは Task 11 で扱う。

### Step 5: テスト実行

- [ ] テスト走らせる

```bash
cargo test --manifest-path src-tauri/Cargo.toml summary_to_json_roundtrip -- --nocapture
```

期待: PASS。

### Step 6: コミット

- [ ] 新規ファイルをコミット

```bash
git add src-tauri/src/summarizer_store.rs src-tauri/src/lib.rs
git commit -m "feat(memory): add summarizer_store CRUD for mem_summaries

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `llm.rs` に `anthropic_tool_complete()` ヘルパを追加

**Files:**
- Modify: `src-tauri/src/llm.rs` (末尾に新関数追加)

### Step 1: `chat_complete()` の既存 Anthropic 呼び出し部分を確認

- [ ] `chat_complete()` 内で使われている `llm_providers::chat_body` / `chat_headers` / API URL の組み立て箇所を読む

```bash
grep -n "chat_body\|chat_headers\|api.anthropic\|anthropic-version" src-tauri/src/llm.rs src-tauri/src/llm_providers.rs | head -20
```

### Step 2: 新関数 `anthropic_tool_complete` を追加

- [ ] `src-tauri/src/llm.rs` 末尾に追加:

```rust
/// Anthropic Messages API を tool_choice 強制モードで呼び出し、tool_use の入力 JSON を返す。
/// Phase 1 summarizer 専用: emit_memory_summary のような structured output ツールを使う想定。
///
/// - `system`: System prompt。短ければキャッシュ効果小、長ければ ephemeral cache_control を付ける (v1 は付けない)。
/// - `user`: ユーザーメッセージ本文 (LLM に渡す本編のデータ)。
/// - `tool`: JSON schema (`{"name": ..., "description": ..., "input_schema": ...}` の中身)。
/// - `model`: 例 "claude-sonnet-4-6"。
///
/// 戻り値: LLM が emit したツールの input JSON (= summary の構造化データ)。
pub async fn anthropic_tool_complete(
  system: &str,
  user: &str,
  tool: &serde_json::Value,
  model: &str,
) -> Result<serde_json::Value, String> {
  let key = crate::secrets::get_llm_api_key()?
    .ok_or_else(|| "LLM API key not configured".to_string())?;

  let tool_name = tool
    .get("name")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "tool.name required".to_string())?
    .to_string();

  let body = serde_json::json!({
    "model": model,
    "max_tokens": 1024,
    "system": system,
    "messages": [{ "role": "user", "content": user }],
    "tools": [tool],
    "tool_choice": { "type": "tool", "name": tool_name },
  });

  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(60))
    .build()
    .map_err(|e| format!("reqwest build: {}", e))?;

  let resp = client
    .post("https://api.anthropic.com/v1/messages")
    .header("x-api-key", key)
    .header("anthropic-version", "2023-06-01")
    .header("content-type", "application/json")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("Anthropic tool_use network error: {}", e))?;

  let status = resp.status();
  let text = resp
    .text()
    .await
    .map_err(|e| format!("Anthropic tool_use body: {}", e))?;

  if !status.is_success() {
    return Err(format!("Anthropic tool_use {}: {}", status, text.chars().take(300).collect::<String>()));
  }

  let parsed: serde_json::Value = serde_json::from_str(&text)
    .map_err(|e| format!("Anthropic tool_use JSON parse: {}", e))?;

  // Expect content = [{ type: "tool_use", name: tool_name, input: { ... } }, ...]
  let content = parsed
    .get("content")
    .and_then(|v| v.as_array())
    .ok_or_else(|| "Anthropic response missing content array".to_string())?;

  for item in content {
    if item.get("type").and_then(|t| t.as_str()) == Some("tool_use")
      && item.get("name").and_then(|n| n.as_str()) == Some(tool_name.as_str())
    {
      return item
        .get("input")
        .cloned()
        .ok_or_else(|| "tool_use missing input".to_string());
    }
  }

  Err(format!(
    "Anthropic response has no tool_use for {}: {}",
    tool_name,
    text.chars().take(300).collect::<String>()
  ))
}
```

### Step 3: ビルド確認

- [ ] コンパイル

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

期待: 新規 warning は `anthropic_tool_complete` が未使用の dead_code のみ、エラーなし。

### Step 4: コミット

- [ ] コミット

```bash
git add src-tauri/src/llm.rs
git commit -m "feat(llm): add anthropic_tool_complete helper for tool_use calls

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `summarizer.rs` の heuristic 層を実装 (LLM 無しで完結)

**Files:**
- Create: `src-tauri/src/summarizer.rs`
- Modify: `src-tauri/src/lib.rs` (`mod summarizer;` 追加)

### Step 1: モジュール作成 (heuristic 関数のみ、LLM は Step 6 以降)

- [ ] `src-tauri/src/summarizer.rs` を新規作成:

```rust
//! Phase 1 summarizer: connector (mail/calendar) アイテムの要約を生成する。
//! 1. heuristic_priority_guess で明らかな low を LLM 前に検出 (pre-filter)
//! 2. それ以外は LLM tool_use で構造化要約を生成
//! 3. LLM 失敗時は heuristic_fallback が medium 固定で返す

use crate::summarizer_store::{Summary, SCHEMA_VERSION};
use serde_json::{json, Value};

/// heuristic が自信を持って判定できた時のショートカット結果。
#[derive(Debug, Clone)]
pub struct PriorityGuess {
  pub priority: String, // Phase 1 では "low" のみ返す
  pub reason: String,
  pub title_hint: String,
}

/// Item が bulk / 自動通知 / 過去カレンダーかを判定。
/// Some(guess) なら LLM スキップ、None なら LLM 実行。
pub fn heuristic_priority_guess(item: &Value) -> Option<PriorityGuess> {
  let source = item.get("source").and_then(|v| v.as_str()).unwrap_or("");
  let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let snippet = item.get("snippet").and_then(|v| v.as_str()).unwrap_or("");

  match source {
    "gmail" => gmail_heuristic(title, snippet),
    "google_calendar" => calendar_heuristic(snippet),
    _ => None,
  }
}

fn gmail_heuristic(title: &str, snippet: &str) -> Option<PriorityGuess> {
  let lower_body = snippet.to_lowercase();
  let has_unsubscribe = lower_body.contains("unsubscribe") || lower_body.contains("配信停止");
  let is_no_reply = snippet.contains("no-reply@")
    || snippet.contains("noreply@")
    || snippet.contains("donotreply@");
  let is_github_noreply = snippet.contains("noreply@github.com")
    || snippet.contains("notifications@github.com");
  let is_ci_sender = snippet.contains("builds@")
    || snippet.contains("ci@")
    || snippet.contains("actions@github.com");

  if has_unsubscribe || is_no_reply || is_github_noreply || is_ci_sender {
    return Some(PriorityGuess {
      priority: "low".to_string(),
      reason: "Automated/bulk notification".to_string(),
      title_hint: title_first_line(title, 60),
    });
  }
  None
}

fn calendar_heuristic(snippet: &str) -> Option<PriorityGuess> {
  // Calendar snippet 例: "Google Calendar · 2026-05-01T09:00:00+09:00 · https://..."
  // 過去の event かつ最近更新されてない = low 扱い
  let start_ms = parse_calendar_start_ms(snippet)?;
  let now_ms = crate::memory_store::now_ms() as i64;
  if start_ms < now_ms - 24 * 3600 * 1000 {
    return Some(PriorityGuess {
      priority: "low".to_string(),
      reason: "Past event, >24h ago".to_string(),
      title_hint: "Calendar (past)".to_string(),
    });
  }
  None
}

/// snippet 内の ISO-8601 datetime 文字列を ms に変換。解析失敗なら None。
fn parse_calendar_start_ms(snippet: &str) -> Option<i64> {
  // 最初に現れる "YYYY-MM-DDTHH:MM:SS" 形式のトークンを取り出す。
  let re_candidate: String = snippet
    .chars()
    .skip_while(|c| !c.is_ascii_digit())
    .take(25)
    .collect();
  // chrono で parse
  chrono::DateTime::parse_from_rfc3339(&re_candidate)
    .ok()
    .map(|dt| dt.timestamp_millis())
}

/// タイトルを 1 行化 + 長さ制限。
fn title_first_line(s: &str, max: usize) -> String {
  let first_line = s.lines().next().unwrap_or(s);
  first_line.chars().take(max).collect()
}

/// LLM 失敗時のフォールバック要約。medium 固定、タイトル/snippet を truncate。
pub fn heuristic_fallback(item: &Value, source_type: &str) -> Summary {
  let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
  let title_raw = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let snippet_raw = item.get("snippet").and_then(|v| v.as_str()).unwrap_or("");

  let title = title_first_line(title_raw, 60);
  let first_sentence = snippet_raw
    .split(|c| c == '。' || c == '.' || c == '\n')
    .next()
    .unwrap_or(snippet_raw)
    .chars()
    .take(140)
    .collect::<String>();

  Summary {
    target_kind: "item".into(),
    target_id: id,
    title: if title.is_empty() { "(no title)".into() } else { title },
    key_points: vec![if first_sentence.is_empty() { "(no content)".into() } else { first_sentence }],
    source_type: source_type.to_string(),
    priority: "medium".into(),
    reason: Some("LLM unavailable, heuristic fallback".into()),
    model: "heuristic".into(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: json!({"fallback": true}).to_string(),
  }
}

/// heuristic_priority_guess が Some を返した時、Summary に変換。
pub fn summary_from_guess(item: &Value, source_type: &str, guess: &PriorityGuess) -> Summary {
  let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
  Summary {
    target_kind: "item".into(),
    target_id: id,
    title: guess.title_hint.clone(),
    key_points: vec![guess.reason.clone()],
    source_type: source_type.to_string(),
    priority: guess.priority.clone(),
    reason: Some(guess.reason.clone()),
    model: "heuristic_prefilter".into(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: json!({"prefilter": true, "reason": guess.reason}).to_string(),
  }
}

/// item.source から source_type enum 値へ正規化。
pub fn derive_source_type(source: &str) -> &'static str {
  match source {
    "gmail" => "mail",
    "google_calendar" => "calendar",
    "meeting_note" | "audio_meeting" => "meeting",
    _ => "mail", // 未知ソースは mail fallback (Phase 1 の enum にない場合)
  }
}
```

### Step 2: `chrono` が Cargo.toml にあるか確認

- [ ] 既存 `google_calendar.rs` で chrono を使っているので入っているはず。確認:

```bash
grep -n "chrono" src-tauri/Cargo.toml
```

期待: `chrono = ...` の行が見つかる。なければ追加 (`chrono = "0.4"`)。

### Step 3: `memory_store::now_ms()` が pub(crate) 以上で公開されているか確認

- [ ] 調査

```bash
grep -n "pub.*fn now_ms\|pub(crate) fn now_ms\|fn now_ms" src-tauri/src/memory_store.rs
```

期待: `pub(crate) fn now_ms()` または `pub fn now_ms()`。もし private なら `pub(crate) fn now_ms` に変更。

### Step 4: `lib.rs` にモジュール登録

- [ ] `src-tauri/src/lib.rs` に追加:

```rust
mod summarizer;
```

### Step 5: ビルド

- [ ] コンパイル

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

期待: 未使用関数の warning のみ、エラーなし。もし chrono feature が足りないエラー出たら `chrono = { version = "0.4", features = ["serde"] }` に変更。

### Step 6: 失敗するテストを書く (heuristic_priority_guess)

- [ ] `src-tauri/src/summarizer.rs` 末尾に追加:

```rust
#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn gmail_with_unsubscribe_is_low() {
    let item = json!({
      "id": "m_1",
      "source": "gmail",
      "title": "Gmail: Sale ends tonight!",
      "snippet": "Subject: Sale ends\nFrom: promo@shop.com\nClick here to unsubscribe at any time.",
    });
    let guess = heuristic_priority_guess(&item).expect("should match");
    assert_eq!(guess.priority, "low");
    assert!(guess.reason.contains("Automated"));
  }

  #[test]
  fn gmail_github_noreply_is_low() {
    let item = json!({
      "id": "m_2",
      "source": "gmail",
      "title": "Gmail: [org/repo] PR opened",
      "snippet": "Subject: PR\nFrom: noreply@github.com\nYou were mentioned in...",
    });
    let guess = heuristic_priority_guess(&item).expect("should match");
    assert_eq!(guess.priority, "low");
  }

  #[test]
  fn gmail_personal_is_none() {
    let item = json!({
      "id": "m_3",
      "source": "gmail",
      "title": "Gmail: Q2 review needed",
      "snippet": "Subject: Q2 review\nFrom: alice@example.com\nCan you approve by Friday?",
    });
    assert!(heuristic_priority_guess(&item).is_none());
  }

  #[test]
  fn calendar_future_is_none() {
    // 30 日後の event
    let future_ms = (crate::memory_store::now_ms() as i64) + 30 * 24 * 3600 * 1000;
    let future_iso = chrono::DateTime::from_timestamp_millis(future_ms).unwrap().to_rfc3339();
    let item = json!({
      "id": "m_4",
      "source": "google_calendar",
      "title": "Calendar: Future meeting",
      "snippet": format!("Google Calendar · {} · https://calendar.google.com/...", future_iso),
    });
    assert!(heuristic_priority_guess(&item).is_none());
  }

  #[test]
  fn calendar_past_is_low() {
    // 2 日前の event
    let past_ms = (crate::memory_store::now_ms() as i64) - 2 * 24 * 3600 * 1000;
    let past_iso = chrono::DateTime::from_timestamp_millis(past_ms).unwrap().to_rfc3339();
    let item = json!({
      "id": "m_5",
      "source": "google_calendar",
      "title": "Calendar: Past meeting",
      "snippet": format!("Google Calendar · {} · https://...", past_iso),
    });
    let guess = heuristic_priority_guess(&item).expect("past should match");
    assert_eq!(guess.priority, "low");
  }

  #[test]
  fn heuristic_fallback_always_returns_medium() {
    let item = json!({
      "id": "m_99",
      "source": "gmail",
      "title": "Whatever",
      "snippet": "Some content here. More content.",
    });
    let s = heuristic_fallback(&item, "mail");
    assert_eq!(s.priority, "medium");
    assert_eq!(s.model, "heuristic");
    assert_eq!(s.target_id, "m_99");
    assert_eq!(s.target_kind, "item");
    assert_eq!(s.key_points.len(), 1);
  }

  #[test]
  fn derive_source_type_maps_known() {
    assert_eq!(derive_source_type("gmail"), "mail");
    assert_eq!(derive_source_type("google_calendar"), "calendar");
    assert_eq!(derive_source_type("meeting_note"), "meeting");
    assert_eq!(derive_source_type("unknown"), "mail");
  }
}
```

### Step 7: テスト実行

- [ ] 全テスト走らせる

```bash
cargo test --manifest-path src-tauri/Cargo.toml summarizer -- --nocapture
```

期待: 全 7 ケース PASS。もし chrono::DateTime::from_timestamp_millis が無い旨のエラーが出たら、代わりに `chrono::Utc.timestamp_millis_opt(ms).unwrap().to_rfc3339()` に書き換える。

### Step 8: コミット

- [ ] Rust 変更を commit

```bash
git add src-tauri/src/summarizer.rs src-tauri/src/lib.rs src-tauri/src/memory_store.rs
git commit -m "feat(memory): add summarizer heuristic priority guess and fallback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `summarizer::summarize_item` 本体 (LLM + prompt + fallback)

**Files:**
- Modify: `src-tauri/src/summarizer.rs` (prompt定数と summarize_item 関数を追加)

### Step 1: Tool schema 定数を追加

- [ ] `summarizer.rs` の `use` 文の下、`PriorityGuess` 定義の前 (または末尾近く) に追加:

```rust
pub const SUMMARIZER_MODEL: &str = "claude-sonnet-4-6";

/// Anthropic tool_use で使う schema。emit_memory_summary ツール 1 本。
pub fn emit_memory_summary_tool() -> Value {
  json!({
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
  })
}

const SYSTEM_PROMPT: &str = r#"You are a memory summarizer for a personal assistant app. Your job is to condense a single connector memory item (an email or a calendar event) into a short structured summary the user can scan quickly.

Rules:
- Always emit via the emit_memory_summary tool. Never respond with plain text.
- title: <= 80 chars, single line, in the SAME language as the source content. For emails include the sender name when possible. For calendar events include the event title.
- key_points: 1-5 short bullets, each <= 140 chars. Capture the important facts (deadline, decision needed, specific action, key figures). If there's nothing to say, emit a single bullet explaining so.
- priority (required):
    HIGH  = user action required (reply, decision, deadline within a few days), or calendar event starting within 24h, or message from a known frequent correspondent.
    MEDIUM = informational but relevant (newsletter from a followed source, meeting invite >24h out, calendar event this week).
    LOW   = automated notifications, bulk marketing, past events with no follow-up.
- reason: one short sentence explaining why this priority was chosen (<= 60 chars).
- source_type: 'mail' for Gmail input, 'calendar' for Google Calendar input.
- Preserve the user's language: if the content is Japanese, write title/key_points/reason in Japanese."#;
```

### Step 2: `summarize_item` 関数を追加

- [ ] `summarizer.rs` の末尾 (テスト mod の前) に追加:

```rust
/// Item を summary に変換する。Phase 1 のメインエントリ。
///
/// Flow:
/// 1. heuristic_priority_guess で明らかな low 判定ならそれを使う (LLM スキップ)
/// 2. LLM 呼び出し (anthropic_tool_complete) で構造化要約を取得
/// 3. LLM 失敗時は heuristic_fallback で medium 固定の要約
pub async fn summarize_item(item: &Value) -> Result<Summary, String> {
  let source = item.get("source").and_then(|v| v.as_str()).unwrap_or("");
  let source_type = derive_source_type(source);

  // 1. Heuristic pre-filter
  if let Some(guess) = heuristic_priority_guess(item) {
    return Ok(summary_from_guess(item, source_type, &guess));
  }

  // 2. LLM tool_use call
  let user_content = render_item_for_llm(item);
  let tool = emit_memory_summary_tool();

  match crate::llm::anthropic_tool_complete(SYSTEM_PROMPT, &user_content, &tool, SUMMARIZER_MODEL).await {
    Ok(tool_input) => match build_summary_from_tool_input(item, source_type, &tool_input) {
      Ok(s) => Ok(s),
      Err(e) => {
        log::warn!("summarizer tool_input parse error for {}: {}", target_id_of(item), e);
        Ok(heuristic_fallback(item, source_type))
      }
    },
    Err(e) => {
      log::warn!("summarizer LLM error for {}: {}", target_id_of(item), e);
      Ok(heuristic_fallback(item, source_type))
    }
  }
}

fn target_id_of(item: &Value) -> String {
  item.get("id").and_then(|v| v.as_str()).unwrap_or("unknown").to_string()
}

/// LLM に渡す user メッセージを組み立てる。source 別にフィールドを整形。
fn render_item_for_llm(item: &Value) -> String {
  let source = item.get("source").and_then(|v| v.as_str()).unwrap_or("");
  let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let snippet = item.get("snippet").and_then(|v| v.as_str()).unwrap_or("");
  // snippet は 4000 文字で truncate (prompt 肥大化防止)
  let snippet_trim: String = snippet.chars().take(4000).collect();
  match source {
    "gmail" => format!("Source: Gmail\n\nTitle: {}\n\nBody:\n{}", title, snippet_trim),
    "google_calendar" => format!("Source: Google Calendar\n\nTitle: {}\n\nDetails:\n{}", title, snippet_trim),
    _ => format!("Source: {}\n\nTitle: {}\n\nBody:\n{}", source, title, snippet_trim),
  }
}

/// LLM が返した tool_input JSON (= emit_memory_summary の input) を Summary に変換。
fn build_summary_from_tool_input(item: &Value, source_type: &str, input: &Value) -> Result<Summary, String> {
  let title = input
    .get("title")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "tool_input.title missing".to_string())?
    .to_string();

  let key_points: Vec<String> = input
    .get("key_points")
    .and_then(|v| v.as_array())
    .ok_or_else(|| "tool_input.key_points missing or not array".to_string())?
    .iter()
    .filter_map(|v| v.as_str().map(String::from))
    .collect();

  if key_points.is_empty() {
    return Err("tool_input.key_points empty after parse".into());
  }

  let priority = input
    .get("priority")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "tool_input.priority missing".to_string())?
    .to_string();

  if !matches!(priority.as_str(), "high" | "medium" | "low") {
    return Err(format!("invalid priority: {}", priority));
  }

  let reason = input
    .get("reason")
    .and_then(|v| v.as_str())
    .map(String::from);

  Ok(Summary {
    target_kind: "item".into(),
    target_id: target_id_of(item),
    title,
    key_points,
    source_type: source_type.to_string(),
    priority,
    reason,
    model: SUMMARIZER_MODEL.to_string(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: serde_json::to_string(input).unwrap_or_default(),
  })
}
```

### Step 3: ビルド確認

- [ ] コンパイル

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

期待: エラーなし。`log` crate が既存で使われているはず (warn! マクロ)、確認:

```bash
grep "^use log" src-tauri/src/llm.rs src-tauri/src/memory_store.rs | head -3
```

### Step 4: `build_summary_from_tool_input` の失敗ケースをテスト

- [ ] `summarizer.rs` の `#[cfg(test)] mod tests` に追加:

```rust
  #[test]
  fn build_summary_from_tool_input_ok() {
    let item = json!({ "id": "m_10" });
    let input = json!({
      "title": "Q2 予算レビュー (Alice)",
      "key_points": ["金曜までに承認要", "前年比 +8%"],
      "source_type": "mail",
      "priority": "high",
      "reason": "Deadline Friday"
    });
    let s = build_summary_from_tool_input(&item, "mail", &input).unwrap();
    assert_eq!(s.title, "Q2 予算レビュー (Alice)");
    assert_eq!(s.priority, "high");
    assert_eq!(s.key_points.len(), 2);
    assert_eq!(s.model, SUMMARIZER_MODEL);
  }

  #[test]
  fn build_summary_rejects_invalid_priority() {
    let item = json!({ "id": "m_11" });
    let input = json!({
      "title": "t",
      "key_points": ["a"],
      "source_type": "mail",
      "priority": "urgent"  // invalid
    });
    assert!(build_summary_from_tool_input(&item, "mail", &input).is_err());
  }

  #[test]
  fn build_summary_rejects_empty_key_points() {
    let item = json!({ "id": "m_12" });
    let input = json!({
      "title": "t",
      "key_points": [],
      "source_type": "mail",
      "priority": "medium"
    });
    assert!(build_summary_from_tool_input(&item, "mail", &input).is_err());
  }
```

### Step 5: テスト走らせる

- [ ] 実行

```bash
cargo test --manifest-path src-tauri/Cargo.toml summarizer:: -- --nocapture
```

期待: 全パス。

### Step 6: コミット

- [ ] 変更を commit

```bash
git add src-tauri/src/summarizer.rs
git commit -m "feat(memory): add summarize_item with LLM tool_use + fallback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Tauri コマンド 3 本を追加 (`commands.rs` + `lib.rs`)

**Files:**
- Modify: `src-tauri/src/commands.rs` (末尾に新コマンド追加)
- Modify: `src-tauri/src/lib.rs` (`invoke_handler!` に登録)

### Step 1: `commands.rs` に 3 コマンドを追加

- [ ] `src-tauri/src/commands.rs` の末尾 (既存 command 群の最後) に追加:

```rust
// ---- Memory Digest Phase 1: summary commands ----

/// target_kind="item" 指定で特定 item の summary を取得。キャッシュ優先、なければ同期生成。
///
/// payload: { "targetId": "m_...", "targetKind"?: "item" (default), "item"?: { ... } }
///   - `item` が同梱されていれば再取得不要 (River 側で既に hit を持っている場合)
///   - 無ければ mem_items から fetch (Phase 1 では item 同梱必須 = UI 側で用意)
#[tauri::command]
pub async fn shogun_memory_summary_get(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let target_id = payload
    .get("targetId")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "targetId is required".to_string())?
    .to_string();
  let target_kind = payload
    .get("targetKind")
    .and_then(|v| v.as_str())
    .unwrap_or("item")
    .to_string();

  // 1. cache lookup
  if let Some(cached) = crate::summarizer_store::get_cached(&target_kind, &target_id)? {
    return Ok(serde_json::json!({ "summary": cached.to_json(), "cached": true }));
  }

  // 2. generate (Phase 1 は item のみサポート)
  if target_kind != "item" {
    return Err(format!("target_kind={} not supported in Phase 1", target_kind));
  }

  let item = payload
    .get("item")
    .cloned()
    .ok_or_else(|| "item payload required when cache miss".to_string())?;

  let summary = crate::summarizer::summarize_item(&item).await?;
  crate::summarizer_store::upsert(&summary)?;

  Ok(serde_json::json!({ "summary": summary.to_json(), "cached": false }))
}

/// 複数 item 分の summary を並列取得 (max 5)。Phase 1 では item のみ。
///
/// payload: { "items": [ { id, title, snippet, source, ... }, ... ] }
#[tauri::command]
pub async fn shogun_memory_summary_batch(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let items = payload
    .get("items")
    .and_then(|v| v.as_array())
    .cloned()
    .ok_or_else(|| "items array required".to_string())?;

  if items.is_empty() {
    return Ok(serde_json::json!({ "ok": [], "failed": [], "heuristicUsed": 0 }));
  }

  // 1. cache lookup for all ids at once
  let ids: Vec<String> = items
    .iter()
    .filter_map(|it| it.get("id").and_then(|v| v.as_str()).map(String::from))
    .collect();
  let cached = crate::summarizer_store::get_cached_many("item", &ids)?;
  let cached_ids: std::collections::HashSet<String> =
    cached.iter().map(|s| s.target_id.clone()).collect();

  let mut ok_results: Vec<serde_json::Value> = cached.iter().map(|s| s.to_json()).collect();
  let mut failed_results: Vec<serde_json::Value> = Vec::new();
  let mut heuristic_used: u32 = 0;

  // 2. 未キャッシュの item を並列要約 (max 5 並列)
  let to_generate: Vec<serde_json::Value> = items
    .iter()
    .filter(|it| {
      it.get("id")
        .and_then(|v| v.as_str())
        .map_or(false, |id| !cached_ids.contains(id))
    })
    .cloned()
    .collect();

  // chunk by 5
  for chunk in to_generate.chunks(5) {
    let futures: Vec<_> = chunk
      .iter()
      .map(|item| {
        let item_clone = item.clone();
        async move {
          let target_id = item_clone
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
          match crate::summarizer::summarize_item(&item_clone).await {
            Ok(s) => {
              if let Err(e) = crate::summarizer_store::upsert(&s) {
                log::warn!("summary upsert failed for {}: {}", target_id, e);
              }
              Ok(s)
            }
            Err(e) => Err((target_id, e)),
          }
        }
      })
      .collect();

    let results = futures::future::join_all(futures).await;
    for r in results {
      match r {
        Ok(s) => {
          if s.model == "heuristic" || s.model == "heuristic_prefilter" {
            heuristic_used += 1;
          }
          ok_results.push(s.to_json());
        }
        Err((id, e)) => {
          failed_results.push(serde_json::json!({ "targetId": id, "error": e }));
        }
      }
    }
  }

  Ok(serde_json::json!({
    "ok": ok_results,
    "failed": failed_results,
    "heuristicUsed": heuristic_used,
  }))
}

/// 特定 summary のキャッシュを削除。dev 用途 (次回 get で再生成)。
///
/// payload: { "targetId": "m_...", "targetKind"?: "item" }
#[tauri::command]
pub fn shogun_memory_summary_invalidate(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let target_id = payload
    .get("targetId")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "targetId required".to_string())?;
  let target_kind = payload
    .get("targetKind")
    .and_then(|v| v.as_str())
    .unwrap_or("item");
  let deleted = crate::summarizer_store::delete(target_kind, target_id)?;
  Ok(serde_json::json!({ "deleted": deleted }))
}
```

### Step 2: `futures` crate が依存にあるか確認

- [ ] 確認

```bash
grep -n "^futures" src-tauri/Cargo.toml
```

無ければ (Phase 1 で追加):

```toml
futures = "0.3"
```

`Cargo.toml` の `[dependencies]` 下に追加。

### Step 3: `lib.rs` の `invoke_handler!` にコマンド登録

- [ ] `src-tauri/src/lib.rs` の `tauri::generate_handler![...]` 内、既存コマンド群の末尾に追加:

```rust
    commands::shogun_memory_summary_get,
    commands::shogun_memory_summary_batch,
    commands::shogun_memory_summary_invalidate,
```

### Step 4: ビルド確認

- [ ] コンパイル

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

期待: エラーなし、warning は既知の dead_code のみ。

### Step 5: アプリ起動 & DevTools で呼び出しテスト

- [ ] Tauri dev 起動

```bash
npm run tauri dev
```

アプリ立ち上がったら DevTools で:

```js
// invalidate は即応答するはず (未保存なら deleted=false)
await window.__TAURI_INTERNALS__.invoke('shogun_memory_summary_invalidate', { payload: { targetId: 'nonexistent' } })
```

期待: `{deleted: false}`

次に実在 item で batch:

```js
// 既にある connector item 1 件を取ってきて summary batch にかける
const search = await window.__TAURI_INTERNALS__.invoke('shogun_memory_search', { payload: { query: 'Gmail', limit: 1 } })
const item = search.hits[0]
await window.__TAURI_INTERNALS__.invoke('shogun_memory_summary_batch', { payload: { items: [item] } })
```

期待: `{ok: [{...summary...}], failed: [], heuristicUsed: 0 or 1}` (初回は LLM 呼び出しで 1-3 秒かかる)。2 回目実行でキャッシュヒット = 即応答。

### Step 6: コミット

- [ ] 変更を commit

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(memory): add Tauri commands for summary get/batch/invalidate

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `shogun-api.js` に IPC ラッパ 3 本を追加

**Files:**
- Modify: `hifi/lib/shogun-api.js`

### Step 1: 既存のラッパ関数を確認

- [ ] 既存パターン確認

```bash
grep -n "memorySearch:\|memoryFetch:\|briefGet:" hifi/lib/shogun-api.js
```

既存形式:
```javascript
memorySearch: (input) => call("shogun_memory_search", input, READ),
memoryIngest: (input) => call("shogun_memory_ingest", input, WRITE),
```

### Step 2: 3 本追加

- [ ] `hifi/lib/shogun-api.js` の既存メモリ系ラッパの近く (`memoryIngest` の下など) に追加:

```javascript
    memorySummaryGet: (input) => call("shogun_memory_summary_get", input, READ),
    memorySummaryBatch: (input) => call("shogun_memory_summary_batch", input, READ),
    memorySummaryInvalidate: (input) => call("shogun_memory_summary_invalidate", input, WRITE),
```

挿入後の並び例:
```javascript
    memorySearch: (input) => call("shogun_memory_search", input, READ),
    memoryFetch: (input) => call("shogun_memory_fetch", input, READ),
    memoryIngest: (input) => call("shogun_memory_ingest", input, WRITE),
    memorySummaryGet: (input) => call("shogun_memory_summary_get", input, READ),
    memorySummaryBatch: (input) => call("shogun_memory_summary_batch", input, READ),
    memorySummaryInvalidate: (input) => call("shogun_memory_summary_invalidate", input, WRITE),
    memoryEmbedBackfill: (input) =>
      call("shogun_memory_embed_backfill", input, WRITE, { timeoutMs: 600000 }),
```

### Step 3: IPC mock check が通るか確認

- [ ] 既存の mock チェッカー実行

```bash
npm run check:ipc-mock
```

期待: 新コマンド 3 本がモック定義されていないと怒られる可能性あり。その場合は `hifi/lib/ipc-client.js` の mock モードでも定義を追加する。

もしエラーなら:
```bash
grep -n "memorySearch\|MOCK_RESPONSES" hifi/lib/ipc-client.js | head -10
```

で mock テーブルの場所を探し、同じ形で追加:

```javascript
shogun_memory_summary_get: () => ({
  summary: {
    targetKind: "item",
    targetId: "m_stub",
    title: "Stub summary",
    keyPoints: ["This is a mocked summary"],
    sourceType: "mail",
    priority: "medium",
    reason: "mock",
    model: "mock",
    schemaVersion: 1,
    generatedAt: Date.now(),
  },
  cached: false,
}),
shogun_memory_summary_batch: (payload) => ({
  ok: (payload?.items || []).map((it) => ({
    targetId: it.id,
    title: `Stub: ${it.title || "untitled"}`,
    keyPoints: ["mock point"],
    sourceType: "mail",
    priority: "medium",
    model: "mock",
    schemaVersion: 1,
    generatedAt: Date.now(),
  })),
  failed: [],
  heuristicUsed: 0,
}),
shogun_memory_summary_invalidate: () => ({ deleted: true }),
```

mock ファイルの既存パターンに合わせて調整。

### Step 4: ビルドチェック

- [ ] 全チェック

```bash
npm run check:ipc-mock && npm run check:actions
```

期待: すべて PASS。

### Step 5: コミット

- [ ] 変更を commit

```bash
git add hifi/lib/shogun-api.js hifi/lib/ipc-client.js
git commit -m "feat(hifi): add IPC wrappers for memory summary commands

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Memory River Filter UI に Priority 列を追加

**Files:**
- Modify: `hifi/screens-a.jsx` (Filter UI と activeFilters state)

### Step 1: activeFilters state にpriority キーを追加

- [ ] `hifi/screens-a.jsx:1182` 付近の `useState` 初期値を確認:

```javascript
const [activeFilters, setActiveFilters] = useState(() => ({ screen: true, audio: true, input: true, calendar: true, mail: true }));
```

これを分離して (state 構造変更):

```javascript
const [activeFilters, setActiveFilters] = useState(() => ({
  sources: { screen: true, audio: true, input: true, calendar: true, mail: true },
  priority: { high: true, medium: true, low: false },   // low デフォルト OFF
}));
```

同時に `toggleFilter` と `activeFilterCount` の実装を更新:

```javascript
const toggleFilter = (group, key) => {
  setActiveFilters((prev) => ({
    ...prev,
    [group]: { ...prev[group], [key]: !prev[group][key] },
  }));
};

const activeFilterCount =
  Object.values(activeFilters.sources).filter(Boolean).length +
  Object.values(activeFilters.priority).filter(Boolean).length;
```

### Step 2: Filter UI 描画を更新 (Sources と Priority 2 カラム)

- [ ] `hifi/screens-a.jsx:1436` 付近の `Sources` メニュー描画部分を修正。現在:

```jsx
<div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', padding:'2px 6px 6px'}}>Sources</div>
{[['screen','Screen capture'],['audio','Audio / Meetings'],['input','Manual input'],['calendar','Calendar'],['mail','Mail']].map(([k,l])=>(
  <label key={k} style={{...}}>
    <input type="checkbox" checked={!!activeFilters[k]} onChange={()=>toggleFilter(k)}/>
    <span>{l}</span>
  </label>
))}
```

これを以下に変更:

```jsx
<div style={{ display: 'flex', gap: 20 }}>
  <div style={{ flex: 1 }}>
    <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', padding:'2px 6px 6px'}}>Sources</div>
    {[['screen','Screen capture'],['audio','Audio / Meetings'],['input','Manual input'],['calendar','Calendar'],['mail','Mail']].map(([k,l])=>(
      <label key={k} style={{display:'flex', alignItems:'center', gap:10, padding:'8px 6px', cursor:'pointer', fontSize:13, color:'var(--text)'}}>
        <input type="checkbox" checked={!!activeFilters.sources[k]} onChange={()=>toggleFilter('sources', k)}/>
        <span>{l}</span>
      </label>
    ))}
  </div>
  <div style={{ flex: 1 }}>
    <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', padding:'2px 6px 6px'}}>Priority</div>
    {[['high','High'],['medium','Medium'],['low','Low']].map(([k,l])=>(
      <label key={k} style={{display:'flex', alignItems:'center', gap:10, padding:'8px 6px', cursor:'pointer', fontSize:13, color:'var(--text)'}}>
        <input type="checkbox" checked={!!activeFilters.priority[k]} onChange={()=>toggleFilter('priority', k)}/>
        <span>{l}</span>
      </label>
    ))}
  </div>
</div>
```

### Step 3: Apply / Reset ボタンの参照を更新

- [ ] Apply ボタンの onClick 内で `kinds` を取る箇所 (line 1445 付近):

```javascript
const kinds = Object.entries(activeFilters.sources).filter(([,on])=>on).map(([x])=>x);
```

- [ ] Reset ボタン (line 1450 付近):

```javascript
setActiveFilters({
  sources: { screen: true, audio: true, input: true, calendar: true, mail: true },
  priority: { high: true, medium: true, low: false },
});
```

### Step 4: ブラウザで挙動確認

- [ ] Tauri dev が動いていれば Cmd+R でリロード。Memory 画面の `Filters` ボタンをクリック:

期待: 2 カラム (Sources / Priority)、Priority 列に High/Medium/Low が並び、Low はデフォルト OFF。Apply で既存の kinds ベースの検索が従来通り動く。Filter カウンタは source 5 + priority 2 = 7。

### Step 5: コミット

- [ ] 変更を commit

```bash
git add hifi/screens-a.jsx
git commit -m "feat(hifi): add Priority filter column to Memory filter UI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Memory River の scrubbed カードに summary を表示 + "Show raw" expand

**Files:**
- Modify: `hifi/screens-a.jsx` (River scrubbed stage 描画 + summary fetch state)

### Step 1: summary state を追加

- [ ] `hifi/screens-a.jsx` の state 宣言群 (line 1180 付近) に追加:

```javascript
const [scrubSummary, setScrubSummary] = useState(null);      // { title, keyPoints, priority, ... } or null
const [scrubSummaryLoading, setScrubSummaryLoading] = useState(false);
const [showRaw, setShowRaw] = useState(false);
```

### Step 2: scrubbed 変更時に summary を fetch する useEffect を追加

- [ ] 既存の `scrubbed` が決まる箇所の下 (どこで scrubbed / scrubIdx が update するかは既存ロジック参照) に:

```javascript
useEffect(() => {
  if (!scrubbed || !scrubbed.id) {
    setScrubSummary(null);
    setShowRaw(false);
    return;
  }
  const isConnector = scrubbed.src === 'gmail' || scrubbed.src === 'google_calendar'
                   || scrubbed.provenance === 'connector';
  if (!isConnector) {
    setScrubSummary(null);
    setShowRaw(true);  // screen/meeting はこの Phase では summary 対象外、raw を出す
    return;
  }
  setShowRaw(false);
  setScrubSummaryLoading(true);
  ShogunAPI.memorySummaryGet({
    targetId: scrubbed.id,
    targetKind: 'item',
    item: {
      id: scrubbed.id,
      title: scrubbed.title || '',
      snippet: scrubbed.snippet || '',
      source: scrubbed.src,
    },
  }).then((res) => {
    if (res.ok && res.data && res.data.summary) {
      setScrubSummary(res.data.summary);
    } else {
      setScrubSummary(null);
    }
  }).catch(() => {
    setScrubSummary(null);
  }).finally(() => {
    setScrubSummaryLoading(false);
  });
}, [scrubbed?.id]);
```

注: `ShogunAPI` の参照は既存の `window.ShogunAPI` or module 指定に合わせる (既存コード中の利用箇所を参考)。`scrubbed.provenance` が無ければ fallback で `scrubbed.src === "gmail" || "google_calendar"` のみで判定。

### Step 3: scrubbed 描画ブロックを summary カードに変更

- [ ] `hifi/screens-a.jsx` の River scrubbed 左カラム (line 1538 付近) の描画を以下に変更 (既存の title/snippet 直接描画を summary カードに置き換え):

```jsx
{scrubbed && !showRaw && scrubSummary && (
  <div className="memory-summary-card" style={{
    display:'flex', flexDirection:'column', gap:12,
    padding:'16px 18px',
    background:'var(--surface)',
    border:'1px solid var(--border)',
    borderRadius:12,
    borderLeftWidth: 3,
    borderLeftColor:
      scrubSummary.priority === 'high' ? 'var(--gold)' :
      scrubSummary.priority === 'medium' ? 'var(--border-hi)' :
      'transparent',
    opacity: scrubSummary.priority === 'low' ? 0.6 : 1,
  }}>
    <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:10}}>
      <div style={{fontSize:18, fontWeight:600, lineHeight:1.3, flex:1}}>{scrubSummary.title}</div>
      <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', padding:'3px 8px', borderRadius:6, border:'1px solid var(--border)'}}>
        {String(scrubSummary.priority || 'med').toUpperCase()}
      </div>
    </div>
    <ul style={{margin:0, paddingLeft:18, display:'flex', flexDirection:'column', gap:6}}>
      {(scrubSummary.keyPoints || []).map((k, i) => (
        <li key={i} style={{fontSize:14, color:'var(--text)', lineHeight:1.5}}>{k}</li>
      ))}
    </ul>
    <div style={{display:'flex', gap:8, marginTop:4}}>
      <button type="button" onClick={() => setShowRaw(true)} style={{
        padding:'6px 12px', borderRadius:8, border:'1px solid var(--border)',
        background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
      }}>Show raw</button>
    </div>
  </div>
)}
{scrubbed && scrubSummaryLoading && !scrubSummary && (
  <div style={{padding:'20px 18px', color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>Generating summary…</div>
)}
{scrubbed && showRaw && (
  <div style={{padding:'16px 18px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12}}>
    <div style={{fontSize:18, fontWeight:600, marginBottom:8}}>{scrubbed.title}</div>
    <div style={{fontSize:13, color:'var(--text-mute)', whiteSpace:'pre-wrap'}}>{scrubbed.snippet}</div>
    {scrubSummary && (
      <button type="button" onClick={() => setShowRaw(false)} style={{
        marginTop:12, padding:'6px 12px', borderRadius:8, border:'1px solid var(--border)',
        background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
      }}>Show summary</button>
    )}
  </div>
)}
```

この 3 ブロックのうち、**既存の scrubbed 描画部分 (title + snippet を直接描く JSX) を削除**してこれに置き換える。既存の Scrubber 両サイドの時刻/アイコン表示は温存すること。

### Step 4: ブラウザで挙動確認

- [ ] Tauri dev リロード → Memory 画面 → 任意の Gmail/Calendar item に River スクラブ

期待挙動:
- 初回: "Generating summary…" → 数秒後に要約カード表示 (title + key_points + priority バッジ)
- 2 回目: 即キャッシュヒットで表示 (待ち時間ゼロ)
- 左バー色が priority で変わる (high=gold, medium=灰, low=透明)
- "Show raw" ボタンで raw snippet 展開、"Show summary" で戻る
- screen capture (AX) にスクラブ合わせたら raw だけ表示 (summary 対象外)

### Step 5: コミット

- [ ] 変更を commit

```bash
git add hifi/screens-a.jsx
git commit -m "feat(hifi): render summary card in Memory River with Show raw toggle

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Smoke Test — 実データで end-to-end 動作確認

**Files:**
- (読み取り専用) 既存の Gmail 20 件 + Calendar 24 件は既に DB にあるはず

### Step 1: DB に connector item があることを確認

- [ ] sqlite3 で件数チェック

```bash
sqlite3 ~/Library/Application\ Support/ai.shogun.desktop/memory.db \
  "SELECT source, COUNT(*) FROM mem_items WHERE source IN ('gmail','google_calendar') GROUP BY source;"
```

期待: gmail 20+ 件、google_calendar 24+ 件。0 件なら先のセッションで行った sync 手順を再実行。

### Step 2: Tauri アプリ起動

- [ ] 起動

```bash
npm run tauri dev
```

### Step 3: DevTools で batch 要約を走らせる

- [ ] Memory 画面を開いて、River スクラブでまず 1 件要約が動くか確認 (Task 10 の動作チェック)

その後 DevTools で bulk test:

```js
const search = await window.__TAURI_INTERNALS__.invoke('shogun_memory_search', { payload: { query: '', limit: 30, kinds: ['mail', 'calendar'] } })
const items = (search.hits || []).slice(0, 15)
console.log('items to summarize:', items.length)
const t0 = Date.now()
const res = await window.__TAURI_INTERNALS__.invoke('shogun_memory_summary_batch', { payload: { items } })
console.log('elapsed ms:', Date.now() - t0)
console.log('ok:', res.ok.length, 'failed:', res.failed.length, 'heuristic:', res.heuristicUsed)
console.table(res.ok.map(s => ({ id: s.targetId, title: s.title.slice(0, 50), priority: s.priority, model: s.model })))
```

期待:
- ok が items 分、failed は 0 (または network 断で一時失敗可)
- heuristicUsed > 0 (GitHub 通知/promo メール等があれば)
- model は大半が `claude-sonnet-4-6`、一部 `heuristic_prefilter`
- elapsed は 10-30 秒程度 (並列 5 で 3 バッチ分)

2 回目実行:

```js
const res2 = await window.__TAURI_INTERNALS__.invoke('shogun_memory_summary_batch', { payload: { items } })
console.log('2nd elapsed:', 'should be <100ms')
```

期待: 1 秒未満 (全キャッシュヒット)。

### Step 4: DB を直接覗いて summary が保存されているか確認

```bash
sqlite3 ~/Library/Application\ Support/ai.shogun.desktop/memory.db \
  "SELECT target_id, priority, model, substr(title,1,40) FROM mem_summaries ORDER BY generated_at DESC LIMIT 10;"
```

期待: 行が 15 件以上、title が適切に日本語/英語で要約されている、priority が high/medium/low に分かれている。

### Step 5: Filter の Priority 列で絞り込み動作確認

- [ ] Memory 画面 → Filters ボタン → Priority: Low を OFF (デフォルト OFF なのでそのまま)、Apply → River に low が表示されないこと確認

期待: 自動通知系 (GitHub noreply 等) が River から消える。

### Step 6: 問題なければ最終コミット

- [ ] 変更があれば commit (通常 smoke test だけなら変更なし)

```bash
git status
# clean なら次のステップへ、fix があれば適宜 commit
```

### Step 7: 完了レポート

- [ ] 以下を手元で整理:
  - summary batch 初回/2 回目の時間差
  - heuristic pre-filter 比率 (heuristicUsed / total)
  - エラー件数
  - Low priority に分類された item の例 (想定通りか)

この数値が success criteria § 4 の見積もりとズレているかチェック。大きく外れていれば prompt / heuristic の調整を Phase 1.5 で。

---

## Self-Review Checklist

プラン全体を spec と突き合わせて:

- [ ] **Spec Goals カバー**: 3 サーフェス (River / Morning Brief / Chat) のうち Phase 1 は River のみ、他は Phase 2/3 と明記 ✓
- [ ] **Non-Goals 守備**: session / week_rollup / Chat 注入は出現していない ✓
- [ ] **Heuristic pre-filter** は Task 5 で実装、Task 6 の `summarize_item` flow に組み込まれている ✓
- [ ] **Feature flag `enable_memory_summary`** は Task 1 で追加。ただし UI での flag 参照 (`if (enable) renderSummary else raw`) は Task 10 に明示せず → **修正: Task 10 Step 2 に feature flag チェックを追加** (以下に追記)

### 補足修正 (Task 10 Step 2 の useEffect 冒頭):

Task 10 の useEffect の冒頭に `enable_memory_summary` flag チェックを追加 (settings 経由で読む):

flag は `sections.memory` に格納されているため、`settingsLoad` のレスポンスから `res.data.sections.memory.enableMemorySummary` または section ごとの load API (`section: 'memory'`) で参照すること。

```javascript
// 先頭で settings を読む (既存の useSettings パターンに従う、see existing screens)
// flag は sections.memory に存在する (sections.security ではない)
const [summaryEnabled, setSummaryEnabled] = useState(true);
useEffect(() => {
  ShogunAPI.settingsLoad({}).then((res) => {
    if (res.ok && res.data) {
      setSummaryEnabled(res.data.enableMemorySummary !== false);
    }
  });
}, []);
```

useEffect 内の先頭に `if (!summaryEnabled) { setShowRaw(true); return; }` を追加。

実装時は既存の settings 読み込みパターン (`ShogunAPI.settingsLoad` or 類似) を参照すること。flag 参照ロジックが既に hook 化されていればそれを再利用。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-memory-digest-phase1.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
