# KIOKU edge_type taxonomy

更新: 2026-04-27
対象: `mem_edges.edge_type` の値域、抽出 agent への指示、Stage 4 GA で `CHECK` 制約に固定する候補集合。

## §1 採用済み edge_type

Stage 2 末で **採用済み (canonical)** とみなされる 8 型。`src-tauri/src/kioku_edge_types.rs::CANONICAL_EDGE_TYPES` の正典。新規 capture / 抽出ジョブが正典外の型を使うと `edge_type_proposals` に `reviewed = 0` で蓄積される。

| edge_type | 意図 | from / to の典型 | 採用判断 |
|-----------|------|--------------------|----------|
| `decided_in` | task / commitment が決定の中で確定した | `task` / `decision` | ✓ AMC pipeline `DecisionGraphHit.follow_ups_pending` の根拠 |
| `follows_up` | 決定 → 後続タスク | `decision` / `task` | ✓ Brief の "What's next" 行を生成する主要 signal |
| `mentions` | 言及（軽い関連性） | 任意 → `entity` / `event` | ✓ 最も汎用、デフォルトの edge type |
| `attended` | 人物がイベントに参加した | `entity` (人) / `event` | ✓ Meeting recipes / Calendar のリンク |
| `blocks` | task A が task B をブロック | `task` / `task` | ✓ Brief の deferred_count 計算 |
| `derives_from` | 抽出ノードがその根拠キャプチャに紐づく | `mem_items` / `mem_captures.id` (論理 FK) | ✓ 根拠追跡 + capture TTL 後のメタ保持 |
| `co_occurs_with` | 時間的同一性（calendar event ↔ 会議録音など） | `event` / `event` | ✓ Phase 3 visionOS の spatial_context と組み合わせて利用 |
| `supersedes` | 矛盾解決時の旧→新参照 | (新ノード) / (`valid_to` が打たれた旧ノード) | ✓ resolve_write::Superseded で自動生成 |

## §2 抽出 agent への指示

Stage 4 GA で `mem_edges.edge_type` に `CHECK` 制約を入れた後は、上記 8 型 + Stage 4 review で採択された型のみ受理される。Stage 2 / 3 の抽出 system prompt では:

```
edge_type ∈ {decided_in, follows_up, mentions, attended, blocks,
             co_occurs_with, derives_from}
※ supersedes は worker が自動付与するので agent は出力しない
※ 上記に当てはまらない関係は記録しないか、最も近い 1 つを選ぶ
```

新型を提案する場合の運用は §4 を参照。

## §3 採用判断のガイドライン

新規 edge_type が `edge_type_proposals` に出現したときの review 基準。Stage 4 GA の review UI が以下のチェックを表示する想定:

1. **意味的な独立性** — 既存 8 型のいずれかで十分にカバーできるなら却下
2. **観測頻度** — 7 日で `seen_count` が 5 未満なら早期判断は保留
3. **AMC 契約との整合** — `hifi/amc-pipeline/src/schemas.js` の `DecisionGraphHit` / `KiokuHit` で参照される signal を再現できるか
4. **graph traversal への影響** — `kioku_graph_traversal::DEFAULT_EDGE_TYPES` に追加すべきか別フィルタにするか

採択時は `kioku_edge_types::set_review_status(conn, edge_type, REVIEW_ACCEPTED, Some(note))`。
却下時は `REVIEW_REJECTED` + 理由ノート（例: "too vague — collapse into mentions"）。

## §4 新型を提案するときの運用

- 抽出 agent が独自の edge_type を出した場合 worker (`add_relation_edges`) が `record_proposal` で記録する
- 採択前は `mem_edges.edge_type` に**そのまま書かれる**（Stage 4 GA まで CHECK 制約は無い）
- review UI は `list_proposals(only_unreviewed=true)` で未判定の上位 30 件程度を取得して提示
- 採択 / 却下後の **既存 edge** の扱い:
  - 採択 → 何もしない（そのまま）
  - 却下 → migration で `valid_to = now()` を打って soft-retire、抽出 agent への prompt から該当型を削除

## §5 Stage 4 GA で発行する CHECK 制約

migration plan §Stage 4.2 で実施予定の `mem_edges` テーブル再構築時の制約イメージ:

```sql
CREATE TABLE mem_edges_new (
  ...
  edge_type TEXT NOT NULL CHECK (edge_type IN (
    'decided_in', 'follows_up', 'mentions', 'attended',
    'blocks', 'co_occurs_with', 'derives_from', 'supersedes'
    -- + Stage 4 review で採択された追加型
  )),
  ...
);
INSERT INTO mem_edges_new SELECT ... FROM mem_edges
  WHERE edge_type IN (採択リスト);
DROP TABLE mem_edges;
ALTER TABLE mem_edges_new RENAME TO mem_edges;
```

採択リスト外の既存 edge は `valid_to` を打って残し（観測 + ロールバック余地のため）、リネーム後の新テーブルには取り込まない。

## §6 実装参照

- `src-tauri/src/kioku_edge_types.rs`
  - `CANONICAL_EDGE_TYPES`
  - `is_canonical(edge_type)` / `record_proposal(conn, edge_type, now_ms)` / `list_proposals(...)` / `set_review_status(...)`
- `src-tauri/src/kioku_extraction.rs::add_relation_edges` — fact-derived edge を作るたびに `record_proposal` を呼ぶ
- `src-tauri/src/kioku_extraction.rs::resolve_write` — `supersedes` edge も同様に記録
- 仕様: `docs/memory-architecture/migration-plan.md` §Stage 4
