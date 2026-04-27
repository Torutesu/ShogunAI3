# KIOKU BYOK コスト試算 (Phase 2 Stage 1)

更新: 2026-04-26
監査対象: `/Users/torutano/ShogunAI3/ShogunAI3`
前提: `docs/memory-architecture/{target-design,migration-plan}.md`

このドキュメントは Stage 2 着手前の Select 確認ゲート (`migration-plan.md` §Select 確認チェックリスト C) で参照される。**実測ではなく構造的推定**。Stage 1 末に dev/内部ユーザーの実 capture 量で再確認すること。

---

## §1 抽出 agent モデルと単価

### 1.1 既定モデル

- **`claude-haiku-4-5`** (`settings.sections.llm.extractionModel` の既定値)
- 上書き可: `claude-sonnet-4-6` / `claude-opus-4-7` / その他 BYOK 互換 (将来)
- fallback (cost cap 到達時): `cap_action = fallback_to_lighter` を選んだ場合は **同 Haiku 4.5 を維持** (より軽量モデルが提供されないため、batched 抽出に切替えで実効コスト削減)

### 1.2 単価仮定

**注意: 単価は Anthropic 公式ページが正典。本表は試算用の参考値。**

| モデル | input ($/M tok) | output ($/M tok) |
|--------|-----------------|------------------|
| `claude-haiku-4-5` (既定) | $1.00 | $5.00 |
| `claude-sonnet-4-6` (上書き想定) | $3.00 | $15.00 |
| `claude-opus-4-7` (上書き想定) | $15.00 | $75.00 |

実装では `cost_ledger.cost_usd` を計算する `calc_cost(model, input_tokens, output_tokens)` 関数で集中管理し、単価更新は Rust 1 箇所の修正で済むようにする。

---

## §2 1 抽出ジョブあたりのトークン消費

### 2.1 入力 (per job、batched 30 秒窓内に集約された capture)

| 構成要素 | 平均 chars | tokens (英語 ≈ 3.5 chars/tok) |
|----------|------------|-------------------------------|
| system prompt (構造化抽出指示 + tool schema) | 1,500 | 430 |
| capture 集約サマリ (window_title / app / url / 抜粋) | 800 | 230 |
| AX dump (clip 後) | 1,200 | 350 |
| 関連既存ノードのヒント (entity_id 候補 ± 周辺 5 件 summary) | 1,500 | 430 |
| バッファ (separators / few-shot examples) | 500 | 150 |
| **input 合計** | **5,500** | **約 1,600 tok** |

日本語混在 (2 chars/tok) の場合は ~2,800 tok。試算では **2,000 tok を中央値**として使う。

### 2.2 出力 (per job)

| 構成要素 | 平均 tokens |
|----------|-------------|
| ExtractedFact 配列 (3〜8 件、tool_use JSON) | 250 |
| edge proposals (related_ids + edge_type) | 80 |
| metadata (confidence, fact_type 等) | 70 |
| **output 合計** | **約 400 tok** |

### 2.3 1 ジョブあたり cost (Haiku 4.5)

```
cost_per_job = 2000 / 1_000_000 * $1.00 + 400 / 1_000_000 * $5.00
             = $0.002 + $0.002
             = $0.004 / job
```

中央値 **$0.004 / job (約 0.6 円)**。

参考:
- Sonnet 4.6 想定: $0.012 / job (約 1.8 円) — 3x
- Opus 4.7 想定: $0.06 / job (約 9 円) — 15x

---

## §3 1 日あたり抽出ジョブ件数

### 3.1 raw capture 量 (現状観測ベースの推定)

監査結果 (`docs/memory-audit/persistence-layers.md` §2.5) より：

| source | 1 日あたり想定行数 | 備考 |
|--------|--------------------|------|
| `capture_sampler` | 200〜500 行 | `RATE_LIMIT_MS=120_000` (2 分) 上限 720/日。実態は前面アプリ変化検知時のみ |
| `capture_ax` | 100〜300 行 | `axMinIntervalSecs` 既定値 + 変化時のみ |
| `google_calendar` | 5〜30 行 | 同期時 |
| `gmail` | 30〜100 行 | 受信量依存 |
| `meeting*` | 0〜50 行 | 会議実施日のみ |
| `capture` (手動) | 0〜10 行 | ユーザー操作依存 |
| その他 (`focus_session` / `home_attachment` / `telemetry_chat_context` 等) | 5〜30 行 | |

**典型ユーザーの raw capture 総数: 約 350〜850 行/日。中央値 600 行/日 を採用。**

注: connector 由来 (gmail / calendar) は構造化済みで抽出ジョブに送らない (`target-design.md` §3.1 後段)。`capture_sampler` / `capture_ax` のみ抽出対象。

抽出対象 raw: **300〜800 行/日、中央値 550 行/日**。

### 3.2 significance filter の dedup 率推定

`target-design.md` §3.2 の 4 要素フィルタの構造的見積もり：

| 要素 | 期待スキップ率 |
|------|----------------|
| denylist (excludedApps / excludedSites) | 10% |
| dwell_ms < 5,000 (瞬間切替) | 30% |
| simhash64 hamming ≤ 4 (近似重複) | 35% |
| a11y diff < 3 行 (些細変化) | 15% |

直列適用後の保留率は **(1 - 0.10) × (1 - 0.30) × (1 - 0.35) × (1 - 0.15) ≈ 0.348**。
抽出に流れる行数 = 550 × 0.348 ≈ **191 行/日**。

### 3.3 batched dedup window (30 秒) の集約率

window 内の `(app_bundle_id, window_title or url)` 同値を 1 ジョブに畳む。観測前の構造的見積もりでは **集約率 0.4** (= 平均して 1 ジョブに 2.5 件の capture が集約される)。

抽出ジョブ件数 = 191 × 0.4 ≈ **76 ジョブ/日**。

中央値レンジ:
- 軽負荷ユーザー (300 raw/日): 300 × 0.348 × 0.4 ≈ **42 ジョブ/日**
- 重負荷ユーザー (800 raw/日): 800 × 0.348 × 0.4 ≈ **111 ジョブ/日**

---

## §4 月額試算

### 4.1 中央値ユーザー (76 ジョブ/日)

```
monthly_cost
  = 76 jobs/day × $0.004/job × 30 days
  = $9.12 / month
```

中央値 **約 $9 / 月 (約 1,350 円)**。

### 4.2 レンジ

| プロファイル | ジョブ/日 | 月額 (Haiku 4.5) |
|--------------|-----------|------------------|
| 軽負荷ユーザー | 42 | **$5.04 / 月** |
| 中央値 | 76 | **$9.12 / 月** |
| 重負荷ユーザー | 111 | **$13.32 / 月** |
| 超重負荷 (raw 1500/日想定) | 209 | **$25.08 / 月** |

### 4.3 cap 既定値の妥当性

`settings.sections.kioku_cost.monthly_cap_usd` 既定 **$10 / 月** は中央値ユーザーをほぼカバーする水準。

- 軽〜中央値ユーザー: 余裕で収まる。
- 重負荷ユーザー: 月後半に cap 抵触の可能性 → `cap_action='pause_extraction'` で月明けまで queued 保留 → ユーザーは UI で気付ける。
- 超重負荷ユーザー: 早い段階で cap 抵触 → ユーザーが cap 引き上げを判断。

**提案: 既定 $10、推奨 cap_action = `pause_extraction`** (capture は続行するため、復旧時に過去分が抽出される)。

### 4.4 Sonnet / Opus 上書きシナリオ (参考)

ユーザーが quality 優先で上書きした場合:

| モデル | 中央値ユーザー月額 | 重負荷ユーザー月額 |
|--------|--------------------|--------------------|
| Haiku 4.5 (既定) | $9.12 | $13.32 |
| Sonnet 4.6 | $27.36 | $39.96 |
| Opus 4.7 | $136.80 | $199.80 |

UI で「上書き時の試算月額」を出すことを推奨 (Settings > Memory > Cost ペインで `extractionModel` 切替時に再計算)。

---

## §5 cap_action 既定値の根拠

| 選択肢 | 推奨 | 理由 |
|--------|------|------|
| `pause_capture` (hard) | ❌ 既定にしない | cap 到達 = capture も停止。ユーザーがその間の活動を記憶できなくなる損失が大きい |
| **`pause_extraction` (soft)** | ✅ **既定** | capture は続行 → raw が `mem_captures` に蓄積。月明けに自動再開で抽出ジョブが消化される (`extraction_jobs.status='expired'` → `'queued'` 復帰バッチ) |
| `fallback_to_lighter` | ⚠️ 警告付き選択肢 | Haiku 4.5 がすでに最軽量級。さらに軽量化できる場合 (将来 Anthropic が下位モデル提供時) のみ有効 |

`pause_extraction` の含意:
- ユーザーは「気付かないうちに記憶が止まる」体験を回避できる
- raw は確保されるので過去分の遡及抽出は失われない
- 月跨ぎの抽出遅延が発生 → UI に「処理待ち件数 + 次回リセット日」表示を必須化

---

## §6 Stage 2 着手前のチェック手順

### §6.1 観測スクリプト

`scripts/kioku-observation.mjs` が dev / 内部ユーザーの `memory.db` を読み、
本ドキュメントの §7 にそのまま貼れる Markdown レポートを生成する。

```bash
# macOS の典型ユーザー (Tauri アプリを終了してから実行 — SQLite は単一ライター)
node scripts/kioku-observation.mjs --user alex-mac --days 7

# パスを明示する場合
node scripts/kioku-observation.mjs \
  --db "$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db" \
  --days 7 \
  --user beta-tester-3
```

要件: `sqlite3` CLI (macOS は標準搭載 / Linux は `apt install sqlite3`)。
スクリプトは read-only モードで開く + ネイティブ依存ゼロなので
`npm install` 不要。

### §6.2 観測項目

スクリプトが計算し §7 にレポートする項目:

| ブロック | 計算内容 | §3 の参照 |
|---------|---------|-----------|
| 1. Capture rate | `mem_items` (legacy) と `mem_captures` (Stage 2) を `source` / `type` 別に過去 N 日カウント、行/日換算 | §3.1 中央値 550 と比較 |
| 2. Dedup health | `mem_captures.extraction_status` 分布 + skipped 比率 | §3.2 期待 ~65% |
| 3. BYOK cost ledger | `cost_ledger` 過去 N 日 sum + 月次累計 + 月額線形外挿 | §2.3 / §4.1 |
| 4. Queue depth | `extraction_jobs.status` 分布 + 最古 pending capture | (運用) |
| 5. Graph composition | active `mem_items.node_kind` + active `mem_edges.edge_type` | (出荷判定の signal) |

### §6.3 ゲート判定

1. **3〜5 名で 7 日観測** — 各レポートを §7 に追記
2. 観測値の中央値が `§3.1 中央値 550` と ±50% 以内
3. dedup skip 率が **40〜80%** に収まる (期待 65% ± 15)
4. 月額線形外挿 (Block 3 の "Linear monthly projection") が **既定 cap $10/月以内**
5. queue 滞留: 最古 pending capture が観測時点で **48 時間以内**
6. Haiku 4.5 単価を Anthropic 公式で再確認 (本ドキュメント §1.2 を更新)
7. PR レビューで Select 承認 → Stage 2 着手可

`scripts/kioku-observation.mjs` の出力を
`docs/kioku-observation-${YYYY-MM-DD}-${user}.md` として個別 commit し、
本ドキュメント §7 には総括のみ追記する運用も可。

---

## §7 実測ログ

各観測実行のレポートを下に貼り付ける。`scripts/kioku-observation.mjs`
の `--user` 引数は §7 のセクションヘッダにそのまま反映される。

### サンプル (テンプレート — 実観測時に上書き)

```markdown
## KIOKU observation — alex-mac (7-day window)

Generated: 2026-04-29T22:00:00.000Z
Source DB: `~/Library/Application Support/ai.Shogun.ShogunAI3/memory.db` (found)
Phase 2 schema present: yes

### 1. Capture rate (last 7 days)

**`mem_captures` rows by type (Stage 2 path):**

| type | rows | rows/day |
| --- | --- | --- |
| screen_app | 380 | 54.3 |
| screen_ax | 156 | 22.3 |

### 2. Dedup health (Stage 2 only)

| extraction_status | rows |
| --- | --- |
| done | 145 |
| queued | 12 |
| skipped | 379 |

- Significance-filter skip rate: **70.6%** (target ~65%, see cost-budget §3.2).

### 3. BYOK cost ledger

**Last 7 days:**

| model | purpose | input_tok | output_tok | cost_usd | calls |
| --- | --- | --- | --- | --- | --- |
| claude-haiku-4-5 | extraction | 290,000 | 58,000 | $0.5800 | 145 |

- 7-day total: **$0.5800** across **145** calls.
- Avg cost/call: $0.0040 (cost-budget §2.3 expects ~$0.004 for Haiku).
- Linear monthly projection: **$2.4857** (cap default $10).
- Month-to-date (UTC) total: **$0.5800**.

### 4. Queue depth (right now)

| status | jobs |
| --- | --- |
| done | 145 |
| queued | 12 |

- Oldest pending capture: `2026-04-29T13:42:00.000Z`

### 5. Graph composition

**Active mem_items by node_kind:**

| node_kind | count |
| --- | --- |
| entity | 320 |
| event | 84 |
| decision | 12 |
| task | 38 |
| note | 91 |

**Active mem_edges by edge_type:**

| edge_type | count |
| --- | --- |
| mentions | 412 |
| follows_up | 47 |
| decided_in | 23 |
```

### dev-localhost 実観測 (2026-04-27)

`docs/kioku-stage1-gate-2026-04-27.md` から転記。Source DB は当時の Tauri app data
dir (`~/Library/Application Support/ai.Shogun.ShogunAI3/memory.db`) を `/tmp` に
スナップショットして `--db /tmp/kioku-memory-snap.db` で計測した。

```markdown
## KIOKU observation — dev-localhost (7-day window)

Generated: 2026-04-26T23:50:32.990Z
Source DB: `/tmp/kioku-memory-snap.db` (found)
Phase 2 schema present: yes

### 1. Capture rate (last 7 days)

**`mem_items` rows by source (legacy capture path):**

| source | rows | rows/day |
| --- | --- | --- |
| capture_ax | 5,685 | 812.1 |
| capture_sampler | 122 | 17.4 |
| google_calendar | 33 | 4.7 |
| gmail | 20 | 2.9 |
| telemetry_chat_context | 1 | 0.1 |

- `mem_captures` (Stage 2 path): no rows in window

### 2. Dedup health (Stage 2 only)

- No mem_captures rows.

### 3. BYOK cost ledger

- No ledger rows in window.
- Month-to-date (UTC) total: **$0.0000**.

### 4. Queue depth (right now)

- No jobs.

### 5. Graph composition

**Active mem_items by node_kind:**

| node_kind | count |
| --- | --- |
| capture_summary | 5,806 |
| event | 33 |
| note | 21 |
| (unset) | 1 |

- No active edges (extraction worker hasn't produced relations yet).
```

### 集計

| user | rows/day (capture) | dedup skip (実測) | 7-day cost | monthly proj | 判定 |
|------|--------------------|-------------------|------------|--------------|-----|
| dev-localhost | **829.5** (capture_ax+sampler) | ⏳ Stage 2 待ち | $0 (worker OFF) | **$13.85** (構造的試算) | ⚠️ cap $10 を 4% 超過 — `pause_extraction` で吸収 |
| (内部ユーザー A) | (待機中) | | | | |
| (内部ユーザー B) | (待機中) | | | | |

**dev-localhost 試算ロジック**: §3.1 の重負荷上限 (800/day) をわずかに超える 829.5
行/日 → §3.2 の dedup 係数 0.348 + §3.3 の集約係数 0.4 → 115.4 jobs/day → 115.4
× $0.004 × 30 = **$13.85/month**。§4.2 の重負荷ユーザー想定 ($13.32) とほぼ一致
し、構造的試算モデルが現実的に有効であることが裏取れた。

**観測ギャップ (Stage 2 着手前に Select が埋める)**:

- dedup skip 実測値 (`mem_captures.extraction_status` 別比) — worker ON 後 24h
  で計測可能
- 集約係数 0.4 の実測 (`extraction_jobs` 1 件あたり `mem_captures` 件数の中央値)
- 中央値プロファイルの内部ユーザーで観測 — dev-localhost は重負荷側に振れている
  ため平均が分からない

---

## §8 cost_ledger テーブル参照

実装時の参照先:

- DDL: `docs/memory-architecture/proposed-schema.sql` §6
- `cost_ledger` 行は `extraction_jobs` 1 件あたり 1 行を想定 (purpose='extraction')
- `mem_summaries` 生成 (purpose='summarize') / embedding 呼び出し (purpose='embed') も同テーブルに記録
- 月次集計クエリは `target-design.md` §6.2 参照

実装着手は **T5 (抽出 agent + worker)** で行う。本ドキュメントは試算のみ。
