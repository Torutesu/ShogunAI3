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

1. **dev / 内部ユーザー (3〜5 名想定) で 7 日観測** — 各人の `mem_items` 直近 7 日の `capture_sampler` / `capture_ax` 行数 / 日を実測
2. 観測値を §3.1 の中央値 550 と比較。±50% 以内なら本試算で妥当
3. dedup 率 §3.2 と集約率 §3.3 を fixture eval / 実測で確認
4. Haiku 4.5 単価を Anthropic 公式で再確認 (`docs/anthropic-models-pricing.md` を参照する場合は別途維持)
5. 試算結果と観測値を **本ドキュメントの §7 実測ログ**に追記
6. PR レビューで Select 承認 → Stage 2 着手可

---

## §7 実測ログ (Stage 1 末に追記)

(空欄 — Stage 1 末に dev/内部ユーザー実測値を記録)

---

## §8 cost_ledger テーブル参照

実装時の参照先:

- DDL: `docs/memory-architecture/proposed-schema.sql` §6
- `cost_ledger` 行は `extraction_jobs` 1 件あたり 1 行を想定 (purpose='extraction')
- `mem_summaries` 生成 (purpose='summarize') / embedding 呼び出し (purpose='embed') も同テーブルに記録
- 月次集計クエリは `target-design.md` §6.2 参照

実装着手は **T5 (抽出 agent + worker)** で行う。本ドキュメントは試算のみ。
