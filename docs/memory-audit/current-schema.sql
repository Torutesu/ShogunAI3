-- =============================================================================
-- 現状スキーマ (current-schema.sql)  —  ShogunAI3 / `memory.db`
-- =============================================================================
-- 監査対象: /Users/torutano/ShogunAI3/ShogunAI3
-- 抽出元  : src-tauri/src/memory_store.rs (init_schema, ensure_*),
--           src-tauri/src/meeting_store.rs (ensure_meeting_schema),
--           src-tauri/src/dead_letter.rs (ensure_schema)
-- 注意    : マイグレーションフレームワークは無く、`open_conn()` の度に
--           CREATE IF NOT EXISTS + ALTER TABLE で feature-detect される。
--           本ファイルは「最新の `memory.db` 行が論理的に持つ列」を再構築したもの。
-- 接続設定: PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
-- =============================================================================

-- ----------------------------------------------------------------------------
-- KIOKU 主体: mem_items
-- ----------------------------------------------------------------------------
-- 1 行 = 1 記憶。screen / connector / meeting / user の全 provenance を吸収する単一テーブル。
-- - 想定書き込み量/日: 数百〜数千（capture_sampler/capture_ax が大半）
-- - vector index 無し。`embedding` BLOB 全件スキャンで cosine 計算。
CREATE TABLE mem_items (
  id          TEXT PRIMARY KEY NOT NULL,    -- 'm_{epoch_ms}_{seq}'
  title       TEXT NOT NULL,                -- 短い見出し
  snippet     TEXT NOT NULL,                -- 本文 / 要約 / AX dump
  source      TEXT NOT NULL,                -- capture_sampler | capture_ax | google_calendar | gmail | meeting* | capture | focus_session | telemetry_chat_context | ...
  kinds_json  TEXT NOT NULL,                -- JSON 配列 (例: ["screen"])。FTS 対象外、自由記述。
  created_at  INTEGER NOT NULL,             -- epoch ms

  -- ALTER で後付け（feature-detect、`docs/context-layer-phase-0-1.md` §1）
  embedding   BLOB,                         -- f32 little-endian 連結 (L2 正規化)。capture_sampler/capture_ax はスキップ。
  provenance  TEXT,                         -- screen | connector | meeting | user。NULL のまま search 時に source から導出される。
  entity_id   TEXT,                         -- 上流オブジェクト ID (Gmail message id, Calendar event id, ...)
  confidence  REAL,                         -- 0.0–1.0、推論行向け
  redaction   TEXT                          -- none | summary_only | redacted。現状ほぼ NULL/none。
);

-- 重複除去は entity_id がある場合のみ。capture_sampler/capture_ax は entity_id=NULL ⇒ 重複防止が効かない。
CREATE UNIQUE INDEX idx_mem_items_entity_unique
  ON mem_items(source, entity_id)
  WHERE entity_id IS NOT NULL AND entity_id != '';

-- ----------------------------------------------------------------------------
-- 全文索引 (FTS5 仮想テーブル)
-- ----------------------------------------------------------------------------
-- title / snippet / source のみが検索対象。Phase 1 で増えた列 (provenance/entity_id/confidence/redaction) は索引対象外。
CREATE VIRTUAL TABLE mem_items_fts USING fts5(
  title,
  snippet,
  source,
  tokenize = 'unicode61',
  content = 'mem_items',
  content_rowid = 'rowid'
);

-- mem_items への INSERT / DELETE / UPDATE をミラーするトリガー。
CREATE TRIGGER mem_items_ai AFTER INSERT ON mem_items BEGIN
  INSERT INTO mem_items_fts(rowid, title, snippet, source)
  VALUES (new.rowid, new.title, new.snippet, new.source);
END;
CREATE TRIGGER mem_items_ad AFTER DELETE ON mem_items BEGIN
  INSERT INTO mem_items_fts(mem_items_fts, rowid, title, snippet, source)
  VALUES ('delete', old.rowid, old.title, old.snippet, old.source);
END;
CREATE TRIGGER mem_items_au AFTER UPDATE ON mem_items BEGIN
  INSERT INTO mem_items_fts(mem_items_fts, rowid, title, snippet, source)
  VALUES ('delete', old.rowid, old.title, old.snippet, old.source);
  INSERT INTO mem_items_fts(rowid, title, snippet, source)
  VALUES (new.rowid, new.title, new.snippet, new.source);
END;

-- ----------------------------------------------------------------------------
-- 派生サマリーキャッシュ: mem_summaries
-- ----------------------------------------------------------------------------
-- Memory Digest (Phase 1)。LLM 生成の要約をキャッシュ。
-- target_kind: 'item' (現状のみ) / 'session' / 'week_rollup' (Phase 2/3 予定)
-- target_id  : item.id / session.id / ISO week
CREATE TABLE mem_summaries (
  target_kind     TEXT    NOT NULL,
  target_id       TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  key_points      TEXT    NOT NULL,         -- JSON 配列
  source_type     TEXT    NOT NULL,         -- 入力の source_type
  priority        TEXT    NOT NULL,         -- 'high' | 'medium' | 'low' (LLM 割当)
  reason          TEXT,
  model           TEXT    NOT NULL,         -- 生成モデル名
  schema_version  INTEGER NOT NULL DEFAULT 1,
  generated_at    INTEGER NOT NULL,         -- epoch ms
  raw_json        TEXT    NOT NULL,         -- 生成時の生 JSON
  lang            TEXT    NOT NULL DEFAULT 'en',  -- 'en' | 'jp' | 'bi'
  user_priority   TEXT,                     -- ユーザー手動上書き ('high'|'medium'|'low' or NULL)
  acknowledged_at INTEGER,                  -- 既読 ms (NULL = 未読)
  snooze_until    INTEGER,                  -- スヌーズ ms (NULL = なし)
  PRIMARY KEY (target_kind, target_id)
);

CREATE INDEX idx_mem_summaries_generated_at ON mem_summaries(generated_at DESC);
CREATE INDEX idx_mem_summaries_priority     ON mem_summaries(priority, generated_at DESC);

-- ----------------------------------------------------------------------------
-- Dead-letter: mem_dead_letter
-- ----------------------------------------------------------------------------
-- ingest 失敗の退避キュー。同じ (source, entity_id) は upsert (attempts++)。
CREATE TABLE mem_dead_letter (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,
  entity_id       TEXT,
  payload_json    TEXT NOT NULL,
  error_message   TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  first_failed_at INTEGER NOT NULL,
  last_failed_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_mem_dead_letter_unique
  ON mem_dead_letter(source, entity_id)
  WHERE entity_id IS NOT NULL AND entity_id != '';

CREATE INDEX idx_mem_dead_letter_recent
  ON mem_dead_letter(last_failed_at DESC);

-- ----------------------------------------------------------------------------
-- 会議系 (同一 memory.db 内、別ストア)
-- ----------------------------------------------------------------------------
CREATE TABLE meeting_templates (
  id                 TEXT PRIMARY KEY NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  sections_json      TEXT NOT NULL,
  enhance_instruction TEXT NOT NULL,
  is_builtin         INTEGER NOT NULL DEFAULT 0,
  created_by         TEXT,
  created_at         INTEGER NOT NULL
);

CREATE TABLE meetings (
  id                 TEXT PRIMARY KEY NOT NULL,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  app_bundle_id      TEXT,
  template_id        TEXT REFERENCES meeting_templates(id),
  title              TEXT,
  participants_json  TEXT NOT NULL DEFAULT '[]',
  state              TEXT NOT NULL DEFAULT 'recording',
  embedding          BLOB
);

CREATE TABLE meeting_transcript_segments (
  id          TEXT PRIMARY KEY NOT NULL,
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  speaker     TEXT NOT NULL,
  text        TEXT NOT NULL,
  confidence  REAL,
  is_final    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE meeting_note_blocks (
  id                       TEXT PRIMARY KEY NOT NULL,
  meeting_id               TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  ord                      INTEGER NOT NULL,
  content                  TEXT NOT NULL,
  origin                   TEXT NOT NULL,            -- 'manual' | 'transcript' | 'ai_enhance' 等
  source_segment_ids_json  TEXT NOT NULL DEFAULT '[]',
  embedding                BLOB
);

CREATE INDEX idx_mts_meeting ON meeting_transcript_segments(meeting_id);
CREATE INDEX idx_mnb_meeting ON meeting_note_blocks(meeting_id);

-- =============================================================================
-- 監査メモ
-- =============================================================================
-- 1. グラフ構造はゼロ。`mem_items` 同士、`mem_items <-> meetings`、`mem_items <-> mem_summaries`
--    のいずれにも外部キーや edges テーブルが無い。`mem_summaries.target_id` は文字列マッチで
--    `mem_items.id` を指すが、参照整合性は強制されない。
-- 2. AMC pipeline (`hifi/amc-pipeline/src/schemas.js`) の `DecisionGraphHitSchema` に対応する
--    Rust テーブルは無い。`decision_graph_hits` を入れるには新規 DDL が必要。
-- 3. `mem_items.created_at` 単独索引が無い → 直近 N 件取得は FTS 経由でないと sequential scan。
--    現実装の `search_recent` は ORDER BY created_at DESC の sequential scan。
-- 4. 部分 UNIQUE (`idx_mem_items_entity_unique`) は `entity_id IS NOT NULL` のみ。
--    capture_sampler/capture_ax (entity_id=NULL) は重複防止が効かない。
-- 5. embedding は f32 BLOB 直保存。次元 = 1536 (text-embedding-3-small)。
--    類似計算は `dot_product(qvec, doc_vec)` の全件スキャン (`memory_store.rs:1124–1130`)。
-- 6. TTL / 自動 GC / decay / access counter / centrality いずれも無し。
