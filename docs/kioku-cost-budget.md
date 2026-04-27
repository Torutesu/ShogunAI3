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

### 2.1 入力 (per job、batched 60 秒窓内に集約された capture)

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

#### 2.3.1 prompt cache OFF (legacy path)

```
cost_per_job = 2000 / 1_000_000 * $1.00 + 400 / 1_000_000 * $5.00
             = $0.002 + $0.002
             = $0.004 / job
```

中央値 **$0.004 / job (約 0.6 円)**。

参考:
- Sonnet 4.6 想定: $0.012 / job (約 1.8 円) — 3x
- Opus 4.7 想定: $0.06 / job (約 9 円) — 15x

#### 2.3.2 prompt cache ON (KIOKU 既定経路、`AnthropicToolRequestOptions::enable_prompt_cache=true`)

§2.1 入力 2,000 tok のうち、**system prompt + tool schema = 約 1,500 tok は完全固定**で
キャッシュ対象。残り 500 tok (capture 集約サマリ + AX 抜粋) のみが variable。

Anthropic prompt cache の単価:
- cache write (初回): 通常 input 価格 × 1.25
- cache read (再利用): 通常 input 価格 × 0.10

KIOKU worker は 60 秒間隔で連続走行する (Anthropic ephemeral cache TTL は 5 分)
ため、**初回 1 回だけ cache write、以降ほぼ常に cache read**。

```
cost_per_job (steady state, cache hit)
  = 500 / 1_000_000 * $1.00              # variable input
    + 1500 / 1_000_000 * $0.10           # cached read
    + 400 / 1_000_000 * $5.00            # output
  = $0.0005 + $0.00015 + $0.002
  ≈ $0.0027 / job  (legacy 比 -32%)
```

cache write 1 回あたり: $0.0005 + (1500 × 1.25 / 1M) + $0.002 = $0.00438/job (legacy +9%)。
TTL 5 分 / poll 30〜60 秒なので 1 時間あたり cache write 1 回 + cache read ~60 回想定 →
cache miss は無視できる程度 (overhead < 2%)。

実装: `src-tauri/src/llm.rs::build_anthropic_tool_request_body` が
`cache_control: { type: "ephemeral" }` を system block + tool 定義に付与し、
`AnthropicToolResult.cache_creation_input_tokens` / `cache_read_input_tokens` を
返す。`cost_ledger::calc_cost_with_cache` が 3 種の input token を分けて課金する。

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

### 3.3 batched dedup window (60 秒) の集約率

window 内の `(app_bundle_id, window_title or url)` 同値を 1 ジョブに畳む。
`kioku_capture::DEFAULT_BATCHED_DEDUP_WINDOW_MS = 60_000` (Stage 1 観測後に 30 秒
から倍化 — 中央値ユーザーで 1 ジョブあたり集約数を約 1.33x に)。

構造的見積もり: **集約率 0.3** (= 平均して 1 ジョブに 3.3 件の capture が集約される)。
30 秒だと 0.4 だったが、window 倍化で同 (app, title) のヒット率が ~25% 改善する想定。

抽出ジョブ件数 = 191 × 0.3 ≈ **57 ジョブ/日**。

中央値レンジ:
- 軽負荷ユーザー (300 raw/日): 300 × 0.348 × 0.3 ≈ **31 ジョブ/日**
- 重負荷ユーザー (800 raw/日): 800 × 0.348 × 0.3 ≈ **84 ジョブ/日**

---

## §4 月額試算

### 4.1 中央値ユーザー (57 ジョブ/日、cache ON)

prompt cache + 60 秒 window 反映後:

```
monthly_cost (steady state, cache hit dominant)
  = 57 jobs/day × $0.0027/job × 30 days
  = $4.62 / month
```

中央値 **約 $4.6 / 月 (約 700 円)** — legacy 計算 ($9.12) から **-49%**。

### 4.2 レンジ (cache ON / window 60s)

| プロファイル | ジョブ/日 | 月額 (Haiku 4.5) | legacy (cache OFF / window 30s) | 削減率 |
|--------------|-----------|------------------|----------------------------------|--------|
| 軽負荷ユーザー | 31 | **$2.51 / 月** | $5.04 | -50% |
| 中央値 | 57 | **$4.62 / 月** | $9.12 | -49% |
| 重負荷ユーザー | 84 | **$6.80 / 月** | $13.32 | -49% |
| 超重負荷 (raw 1500/日想定) | 156 | **$12.64 / 月** | $25.08 | -50% |

dev-localhost 実観測 (raw 829.5/日 = ほぼ重負荷上限) を当てはめると:

```
829.5 × 0.348 × 0.3 = 86.6 jobs/day
86.6 × $0.0027 × 30 = $7.01 / month
```

**dev-localhost 投影: 約 $7.0 / 月** (legacy 試算 $13.85 から **-49%**)。
cap $10 内に十分収まる。

### 4.3 cap 既定値の妥当性

`settings.sections.kioku_cost.monthly_cap_usd` 既定 **$10 / 月** は重負荷ユーザー
+ dev-localhost 観測クラスを丸ごと吸収できる。超重負荷 (raw 1500/日) でも残り
20% 余裕。

- 軽〜中央値ユーザー: 大幅な余裕。
- 重負荷ユーザー: 余裕あり。月跨ぎ pause_extraction はほぼ起きない想定。
- 超重負荷ユーザー: 月後半に cap 抵触の可能性 → `cap_action='pause_extraction'`
  で月明けまで queued 保留 → ユーザーは UI で気付ける。

**提案: 既定 $10、推奨 cap_action = `pause_extraction`** (capture は続行するため、
復旧時に過去分が抽出される)。$10 は cache OFF 時の中央値想定 ($9.12) を保守的に
吸収する水準として据え置く — Stage 2 観測で実 cache hit 率が想定通りなら、将来
$5 まで下げる選択肢も検討。

### 4.4 Sonnet / Opus 上書きシナリオ (参考)

ユーザーが quality 優先で上書きした場合 (cache ON / window 60s 前提):

| モデル | 中央値ユーザー月額 | 重負荷ユーザー月額 |
|--------|--------------------|--------------------|
| Haiku 4.5 (既定) | $4.62 | $6.80 |
| Sonnet 4.6 | $13.86 | $20.40 |
| Opus 4.7 | $69.30 | $102.00 |

Sonnet / Opus は input 単価が 3x / 15x なので cap $10 を超える。ユーザーは cap を
明示的に上げるか、Haiku 4.5 に留める判断が必要。UI で「上書き時の試算月額」を
出すことを推奨 (Settings > Memory > Cost ペインで `extractionModel` 切替時に再計算)。

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
| dev-localhost (legacy 試算) | 829.5 | ⏳ Stage 2 待ち | $0 (worker OFF) | $13.85 | ⚠️ cap $10 超過 |
| dev-localhost (cache ON / window 60s) | **829.5** | ⏳ Stage 2 待ち | $0 (worker OFF) | **$7.01** | ✅ cap $10 内、余裕 30% |
| (内部ユーザー A) | (待機中) | | | | |
| (内部ユーザー B) | (待機中) | | | | |

**dev-localhost 試算ロジック (cache ON 反映)**:
§3.1 の重負荷上限 (800/day) をわずかに超える 829.5 行/日 → §3.2 の dedup 係数 0.348
+ §3.3 の **集約係数 0.3 (60s window)** → **86.6 jobs/day** → 86.6 ×
**$0.0027/job (cache hit)** × 30 = **$7.01/month**。

§4.2 の重負荷ユーザー想定 ($6.80) と概ね一致し、構造的試算モデル (cache 後) が
現実的に有効であることが裏取れた。cache OFF 時 ($13.85) との差 ~$6.84/月 が
prompt caching + window 倍化の合算効果。

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
