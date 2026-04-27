-- =============================================================================
-- 提案スキーマ (proposed-schema.sql)  —  KIOKU 三層アーキテクチャ確定版
-- =============================================================================
-- ターゲット: ShogunAI3 / `memory.db` (SQLite + FTS5 + json1)
-- 設計参照 : docs/memory-architecture/target-design.md
-- 監査参照 : docs/memory-audit/{four-flaws,current-schema}.md
-- 注意     : 実装はしない。本ファイルは「最終形の論理スキーマ」を一覧する目的。
--            実際の段階移行は docs/memory-architecture/migration-plan.md 参照。
-- 接続設定: PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; (既存通り)
-- =============================================================================

-- =============================================================================
-- §1  既存 mem_items への列追加
-- =============================================================================
-- Phase 1 で既に追加済の列 (provenance / entity_id / confidence / redaction /
-- embedding) は重複定義しない。ここでは Phase 2 で追加する列のみ列挙する。
-- いずれも feature-detect ALTER (現行 ensure_* パターン) を踏襲し、デフォルト値は
-- マイグレーション失敗を避けるため最小限。

-- bi-temporal: なぜ必要か
--   "事実が真であった期間" と "DB に書かれた時刻" を分離しないと、矛盾解決時に履歴が消える。
ALTER TABLE mem_items ADD COLUMN valid_from   INTEGER;  -- epoch ms; NULL は created_at と同義扱い
ALTER TABLE mem_items ADD COLUMN valid_to     INTEGER;  -- 終端 epoch ms; NULL = 現行有効
ALTER TABLE mem_items ADD COLUMN recorded_at  INTEGER;  -- DB 書込時刻 epoch ms

-- decay model 入力: なぜ必要か
--   ランキング / wide-net フィルタ / centrality 計算のため (target-design.md §5)。
ALTER TABLE mem_items ADD COLUMN access_count       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mem_items ADD COLUMN last_accessed_at   INTEGER;            -- epoch ms
ALTER TABLE mem_items ADD COLUMN decay_score        REAL;               -- 0–1 正規化
ALTER TABLE mem_items ADD COLUMN centrality_score   REAL;               -- バッチ更新

-- 抽出元キャプチャ: なぜ必要か
--   ノードの根拠を辿る。raw の TTL 削除後も派生ノードは残せる。
ALTER TABLE mem_items ADD COLUMN source_capture_id  INTEGER;            -- → mem_captures.id (論理 FK)

-- ノード種別: なぜ必要か
--   graph traversal で edge_type と組合せて意味的フィルタを掛ける。
--   'entity' / 'event' / 'decision' / 'task' / 'note' / 'capture_summary'
ALTER TABLE mem_items ADD COLUMN node_kind   TEXT;

-- spatial_context (Phase 3 visionOS 布石、macOS 2D phase は一部のみ populate):
--   JSON: {display_id, window_bounds, dwell_ms, window_pose?, gaze_target?, ext?}
--   json1 関数 (json_extract 等) で部分クエリ可能。target-design.md §7 参照。
ALTER TABLE mem_items ADD COLUMN spatial_context  TEXT;

-- ※ 以下は **Phase 1 で既に追加済** なのでここでは ALTER しない (重複エラーを避ける)
--    embedding BLOB / provenance TEXT / entity_id TEXT / confidence REAL / redaction TEXT
-- ※ 既存 idx_mem_items_entity_unique (部分 UNIQUE on (source, entity_id)) は維持。
--    capture 行は mem_captures に隔離されるため、entity_id IS NULL の重複問題は構造的に解消。

-- ── 追加インデックス ─────────────────────────────────────────────────────────
-- 1) bi-temporal クエリ用 (現行有効ノードを頻繁に参照)
CREATE INDEX IF NOT EXISTS idx_mem_items_valid_active
  ON mem_items(valid_to)
  WHERE valid_to IS NULL;

-- 2) decay-aware の wide-net 用
CREATE INDEX IF NOT EXISTS idx_mem_items_decay
  ON mem_items(decay_score)
  WHERE valid_to IS NULL;

-- 3) ノード種別での graph filter
CREATE INDEX IF NOT EXISTS idx_mem_items_kind
  ON mem_items(node_kind, valid_to);

-- 4) 直近順クエリ (既存の sequential scan を解消)
CREATE INDEX IF NOT EXISTS idx_mem_items_recent
  ON mem_items(created_at DESC);

-- 5) 抽出元逆引き
CREATE INDEX IF NOT EXISTS idx_mem_items_capture
  ON mem_items(source_capture_id)
  WHERE source_capture_id IS NOT NULL;

-- =============================================================================
-- §2  mem_edges  —  Layer 2 のエッジ (新規)
-- =============================================================================
-- なぜ必要か:
--  (a) 関係性追跡が完全に欠如している (docs/memory-audit/four-flaws.md §2.4)。
--  (b) decision_graph (AMC contract) を実体化する唯一の経路。
--  (c) graph traversal の主役 (recursive CTE で from_node/to_node を辿る)。
CREATE TABLE IF NOT EXISTS mem_edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node     TEXT    NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,
  to_node       TEXT    NOT NULL REFERENCES mem_items(id) ON DELETE CASCADE,

  -- edge_type: Stage 2 では文字列自由。Stage 4 末で頻出 top-N を CHECK 制約化する。
  -- 既知のセット (Phase 2 着手時点):
  --   'decided_in'      : task / commitment が decision に属する
  --   'follows_up'      : decision → 後続 task
  --   'mentions'        : note / capture_summary → entity / event
  --   'attended'        : entity (人) → event (会議)
  --   'blocks'          : task A → task B
  --   'derives_from'    : extracted node → 元 capture (mem_captures 経由)
  --   'co_occurs_with'  : 時間的同一性 (calendar event ↔ meeting recording)
  --   'supersedes'      : 矛盾解決時の旧→新参照 (valid_to が打たれた旧から新へ)
  edge_type     TEXT    NOT NULL,

  -- 0.0–1.0、抽出 agent が信頼度として書く。decay や ranker で path_score 積算時に使う。
  weight        REAL    NOT NULL DEFAULT 0.7,

  -- bi-temporal (ノードと同じ理由)
  valid_from    INTEGER NOT NULL,
  valid_to      INTEGER,
  recorded_at   INTEGER NOT NULL,

  source_capture_id INTEGER,        -- → mem_captures.id (論理 FK)
  redaction         TEXT             -- 既存値域: 'none' | 'summary_only' | 'redacted'
);

CREATE INDEX IF NOT EXISTS idx_mem_edges_from
  ON mem_edges(from_node, edge_type, valid_to);
CREATE INDEX IF NOT EXISTS idx_mem_edges_to
  ON mem_edges(to_node, edge_type, valid_to);
CREATE INDEX IF NOT EXISTS idx_mem_edges_active
  ON mem_edges(edge_type, valid_to)
  WHERE valid_to IS NULL;

-- =============================================================================
-- §3  mem_captures  —  抽出前の生キャプチャ退避 (新規)
-- =============================================================================
-- なぜ必要か:
--  (a) 現状 capture_sampler / capture_ax が mem_items に直書きしており、raw が
--      retrieval パスに漏れる (docs/memory-audit/current-retrieval.md §3)。
--  (b) BYOK cloud 抽出ジョブのソース。失敗時の再処理キュー。
--  (c) TTL で raw を捨てつつ、派生ノードは残せる。
--  (d) オフライン耐性: ネット切断中は extraction_jobs が滞留しても、raw は確保される。
CREATE TABLE IF NOT EXISTS mem_captures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- type: 'screen_app' (capture_sampler) | 'screen_ax' (capture_ax)
  --       | 'audio_chunk' | 'screenshot' | 'connector_raw' (将来)
  type            TEXT NOT NULL,

  -- raw_path: DB 外パス (screenshot / 音声)。テキスト系は NULL で raw_text を使う。
  --           14 日 TTL で unlink、列値は NULL に更新。
  raw_path        TEXT,
  raw_text        TEXT,                  -- AX dump 等。**LLM へ直接渡さない**。

  app_bundle_id   TEXT,
  window_title    TEXT,                  -- significance filter の dedup key
  url             TEXT,                  -- ブラウザ系の場合
  captured_at     INTEGER NOT NULL,      -- epoch ms
  processed_at    INTEGER,               -- 抽出完了 epoch ms (NULL = pending/running/expired)

  -- extraction_status: 'queued' | 'running' | 'done' | 'failed' | 'expired' | 'skipped'
  --   'expired' は TTL 経過で raw を消した状態 (派生ノードは残っている)
  --   'skipped' は significance filter で抽出不要と判定された場合
  extraction_status   TEXT NOT NULL DEFAULT 'queued',
  extraction_error    TEXT,
  derived_node_ids_json TEXT,            -- JSON 配列: 派生 mem_items.id

  -- ttl_expires_at: raw を消すタイミング (= captured_at + 14 days)
  ttl_expires_at  INTEGER NOT NULL,

  -- spatial_context: mem_items と同じ JSON 構造 (target-design.md §7)
  spatial_context TEXT,

  -- significance filter で残したサマリ (window_title diff hash 等、再復元用)
  -- 形式: {"simhash64":"...", "ax_diff_lines":N, "dwell_ms":..., "denylist_hit":bool?}
  filter_meta_json TEXT
);

-- 抽出ワーカーが queued/failed を pull する際の主索
CREATE INDEX IF NOT EXISTS idx_mem_captures_status
  ON mem_captures(extraction_status, captured_at);

-- TTL バッチ用 (raw_path / raw_text を消す対象選定)
CREATE INDEX IF NOT EXISTS idx_mem_captures_ttl
  ON mem_captures(ttl_expires_at)
  WHERE extraction_status = 'done';

-- =============================================================================
-- §4  edge_type_proposals  —  edge_type 値域固定の準備 (新規)
-- =============================================================================
-- なぜ必要か:
--  Stage 2 では edge_type を文字列自由にしている (抽出 agent が新型を提案できる柔軟性)。
--  ただし無秩序に増えるとクエリの意味的フィルタが組めない。
--  抽出 agent が出した edge_type を蓄積し、Stage 4 末で頻出 top-N を CHECK 制約に固定する。
CREATE TABLE IF NOT EXISTS edge_type_proposals (
  edge_type     TEXT PRIMARY KEY,        -- 自由文字列、UNIQUE
  first_seen_at INTEGER NOT NULL,        -- epoch ms
  last_seen_at  INTEGER NOT NULL,
  seen_count    INTEGER NOT NULL DEFAULT 1,

  -- 抽出 agent が示した使用意図 (3 件まで例示)
  example_from_node_ids_json TEXT,       -- JSON 配列
  example_to_node_ids_json   TEXT,
  example_descriptions_json  TEXT,       -- agent が出した自然言語の意図説明 (max 3 件)

  -- Stage 4 末で human review 用フラグ
  reviewed      INTEGER NOT NULL DEFAULT 0,  -- 0 = 未レビュー, 1 = 採用, 2 = 却下
  reviewer_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_edge_type_proposals_freq
  ON edge_type_proposals(seen_count DESC, last_seen_at DESC);

-- =============================================================================
-- §5  extraction_jobs  —  BYOK 呼び出しキュー (新規)
-- =============================================================================
-- なぜ必要か:
--  BYOK cloud 一本 (Haiku 4.5 等) で抽出するため、リトライ / オフライン耐性 /
--  cost 上限制御 / 失敗ハンドリングを一元管理する必要がある。
CREATE TABLE IF NOT EXISTS extraction_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id    INTEGER REFERENCES mem_captures(id) ON DELETE CASCADE,
                                          -- 通常 capture 由来 (NULL は edge 補完など別目的)
  job_kind      TEXT NOT NULL DEFAULT 'extract',
                                          -- 'extract' | 'edge_link' | 'summarize'
  -- status:
  --   'queued'   抽出待ち (オフライン中もここに留まる)
  --   'running'  pull 中
  --   'done'     完了 (cost_ledger に row があるはず)
  --   'failed'   非リトライ可能エラー (extraction_error に詳細)
  --   'expired'  cost cap 到達で月内処理を諦めた状態 (月明けで queued に戻す)
  status        TEXT NOT NULL DEFAULT 'queued',

  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  next_attempt_at INTEGER,                -- backoff (epoch ms); 即時可なら NULL
  last_error    TEXT,

  created_at    INTEGER NOT NULL,
  started_at    INTEGER,                  -- running 開始
  finished_at   INTEGER,                  -- done/failed/expired 確定

  -- 抽出パラメータ (model 切替や fallback でモデル変えた履歴を残す)
  model         TEXT,                     -- 'claude-haiku-4-5' 等
  meta_json     TEXT                      -- batched window 内に集約された capture_id 群など
);

CREATE INDEX IF NOT EXISTS idx_extraction_jobs_queued
  ON extraction_jobs(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_extraction_jobs_capture
  ON extraction_jobs(capture_id);

-- =============================================================================
-- §6  cost_ledger  —  BYOK コスト追跡 (新規)
-- =============================================================================
-- なぜ必要か:
--  BYOK cloud 一本のコスト透明性が必須要件 (Select 判断)。
--  月次集計と上限制御の根拠データ。設定画面の透明性 UI の供給元。
CREATE TABLE IF NOT EXISTS cost_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at     INTEGER NOT NULL,       -- epoch ms
  model           TEXT    NOT NULL,       -- 'claude-haiku-4-5' / 'claude-sonnet-4-6' / etc
  -- purpose: 'extraction' (抽出) | 'summarize' (mem_summaries 生成) | 'embed' (埋め込み)
  --        | 'amc_compose' (AMC pipeline) | 'amc_summary' | 'chat' | 'draft'
  purpose         TEXT    NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cost_usd        REAL    NOT NULL,       -- calc_cost(model, in, out) で算出した USD 金額
  job_id          INTEGER,                -- extraction_jobs.id (関係しない呼び出しは NULL)
  meta_json       TEXT                    -- {request_id, latency_ms, fallback_used} 等
);

-- 月次集計クエリ用 (target-design.md §6.2 参照)
CREATE INDEX IF NOT EXISTS idx_cost_ledger_recorded
  ON cost_ledger(recorded_at);

-- 'purpose' 別の絞り込み (UI 表示)
CREATE INDEX IF NOT EXISTS idx_cost_ledger_purpose
  ON cost_ledger(purpose, recorded_at);

-- =============================================================================
-- §7  既存維持 (DDL は重複させない)
-- =============================================================================
--  mem_summaries        : Phase 1 のまま。
--                         LLM 注入は title + key_points から組む (snippet 直注入は廃止予定)。
--                         target_kind ∈ {'item','session','week_rollup'} の値域は変えない。
--  mem_dead_letter      : connector pull 失敗のリトライキュー。役割を mem_captures と分離
--                         (dead_letter = pull 失敗、captures.failed = 抽出失敗)。
--  meeting_*            : meetings / meeting_transcript_segments / meeting_note_blocks /
--                         meeting_templates すべて変更しない。会議由来のノードは抽出経路で
--                         mem_items (node_kind='event') と mem_edges (attended/decided_in/
--                         mentions) に投影される。
--  mem_items_fts        : FTS5 仮想テーブル + ai/ad/au トリガーは現状維持。snippet が
--                         "抽出済 claim" になった後も title/snippet/source 索引で動作する。
--  idx_mem_items_entity_unique : 維持 (capture 行は mem_captures に隔離されるため、
--                         entity_id IS NULL の重複問題は構造的に解消)。

-- =============================================================================
-- §8  Layer 1 (kioku_rules) は DB に持たない
-- =============================================================================
-- settings.json の sections.kioku_rules 配列に置く。理由:
--  - 不変性が高く、量も少ない (数十件想定)
--  - 起動時 in-memory cache に 1 回読めば足りる
--  - エクスポート / インポートが容易 (Phase 2 では実装しないが、ファイル直編集は可能)
--  - "user-defined truth" として settings の延長に置くほうがメンタルモデルに合う

-- =============================================================================
-- §9  監査メモ
-- =============================================================================
-- 1. UNIQUE / NOT NULL 制約は最低限。マイグレーション時に NULL を許容することで
--    ensure_redaction_nullable 同様のテーブル再構築を避ける。
-- 2. spatial_context は単一 TEXT JSON 列。複数列 ALTER を避け、json1 (json_extract)
--    で部分クエリ。前方互換 (新キー追加で既存行を壊さない)。
-- 3. ベクトル類似は依然として全件 cosine の素朴計算。HNSW 等は SQLite 単体では
--    導入コストが高いので、wide-net を decay_score でフィルタすることでレイテンシ
--    を抑える方針 (target-design.md §1.3, §4)。
-- 4. mem_summaries.target_id ↔ mem_items.id は論理 FK。CHECK / TRIGGER で強制しない
--    のは Phase 1 の既存挙動を破壊しないため。
-- 5. mem_edges.edge_type は Stage 4 末で CHECK 化。それまでは edge_type_proposals に
--    集計し、頻出 top-N を採用する human review プロセスを噛ませる。
-- 6. extraction_jobs.status='expired' は cost cap 到達による月跨ぎ復旧用。月明けで
--    'queued' に戻すバッチ (1 日 1 回) を実装すれば自動復旧。
-- 7. cost_ledger は append-only。VACUUM や archiving は Phase 2 では行わない
--    (年 50K 行程度を想定、ストレージ影響は小さい)。
