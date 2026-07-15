# First-Run "aha" Flow — 設計

更新: 2026-07-16。対象: デスクトップ初回起動体験。実装は次スプリント（本ドキュメントが仕様）。

## 原則

**aha = 「自分の画面から生まれた記憶を、自分の言葉で検索して、当てる」**。
デモデータではなく本人のデータで起きること。目標: 初回起動から **3分以内**。

LP（lp/）が約束した物語 — 「一日が記憶になり、記憶が動く」— を、初回起動が最短距離で回収する。

## 現状フロー（as-is）

```
Consent → EntitlementGate → McpSetupGate → MainApp（いきなり全画面）
```

問題:
1. ゲート3枚はすべて「支払わせる・設定させる」で、**価値を1度も見せていない**
2. AX 権限がフロー外（Settings 掘り or 通知トースト頼み）— 権限が無いと記憶ゼロのまま
3. MainApp 着地後、何をすれば良いかの導きが無い（空の Memory 画面）

## 設計（to-be）

```
Consent → EntitlementGate → FirstRun（新設・3幕）→ MainApp
                              ├ 幕1: AX 権限（30秒）
                              ├ 幕2: 最初の記憶（60–90秒）
                              └ 幕3: 最初の検索 = aha（30秒）
McpSetupGate は FirstRun の後ろへ移動（aha の後なら設定する動機がある）
```

### 幕1 — 権限（説得ではなく宣言）

- 1画面。コピーは LP と同じ声:
  **「SHOGUN はあなたの画面のテキストを読む。だから最初に、その許可を。」**
  サブ: スクショではない・ローカル保存・パスワード欄除外（3点を1行ずつ、Trust セクションの言葉で）
- ボタン1つ: 「システム設定を開く」→ 既存 `app_permissions_manage`（accessibility deeplink）
- `accessibility_trust_status` を 2 秒ポーリングし、許可されたら**自動で幕2へ**（「戻って続行」ボタン不要）
- スキップ可（右下 dim リンク）。スキップ時は MainApp へ、Memory 画面に既存 AX バナー表示

### 幕2 — 最初の記憶が生まれる瞬間を見せる

- キャプチャは既に background で動いている（`start_background_sampler` は起動時 spawn 済み）
- 画面中央に**ライブカウンタ**: 「記憶した断片: N」（`shogun_capture_live_events` を 2 秒ポーリング、
  `capture_events::list_recent` の件数。既存 IPC のみで実装可）
- 下に薄く「Slack でも、ブラウザでも、いつもの作業をどうぞ。SHOGUN は見ています。」
- N ≥ 5 になったら CTA 出現: 「最初の検索をする →」
- 60 秒経っても N=0 の場合: トラブルシュート1行（前面アプリを切り替えてみてください）＋スキップ

### 幕3 — aha: 自分の記憶に当てる

- 検索ボックス1つ。プレースホルダは**直近の記憶から自動生成**
  （最後の capture の `app_label` を使い「さっき {app} で見ていたことを聞いてみる」）
- `memory.search`（既存 action）を叩き、ヒットを既存の highlight 付きで 3 件表示
- ヒットが返った瞬間に gold の短いパルス（LP のグラフパルスと同じモチーフ・1回だけ）
- コピー: **「これがあなたの記憶です。今日から、勝手に増えていきます。」**
- ボタン: 「SHOGUN を開く」→ MainApp（Home）
- （この後に McpSetupGate。コピーを「記憶を Claude からも使えるようにする」に変更 — 価値文脈が先にあるので設定率が上がる）

## 実装メモ

| 項目 | 内容 |
|------|------|
| 新規 | `src/app/FirstRunFlow.tsx`（3幕・1コンポーネント・状態は useState で直列） |
| 変更 | `AppCore.tsx` — gate 順序を Consent → Entitlement → FirstRun → MainApp に。McpSetupGate は FirstRun 内の幕3後半へ吸収 or 直後に |
| 完了フラグ | `settings.sections.onboarding.firstRunComplete`（既存 `mcpComplete` と同形式） |
| 再表示 | しない（Settings > General に「初回ツアーをもう一度」を置くのは任意・後回し） |
| 既存 IPC のみ | `app_permissions_manage` / `shogun_capture_status` / `shogun_capture_live_events` / `memory.search` — **Rust 変更ゼロで実装可能** |
| telemetry | `screen_viewed` に `firstrun_permission` / `firstrun_capture` / `firstrun_search` が乗る（既存 allowlist の screen prop のみ。イベント追加不要）→ ファネル計測が自動で立つ |
| e2e | mock handler は capture_live_events / memory.search を既にモック済み → 3幕の Playwright spec を追加（権限幕は mock で trusted=true 即進行） |

## やらないこと

- デモデータの投入（本人のデータで aha を起こすのが本設計の核）
- 動画・GIF チュートリアル
- 幕の追加（3幕で3分以内。それ以上は離脱）

## 受け入れ基準

- [ ] クリーン環境で Consent → aha（検索ヒット表示）まで 3 分以内・迷いなし
- [ ] AX 拒否/スキップでも MainApp に到達でき、復帰導線（バナー）がある
- [ ] `firstRunComplete` 済みなら FirstRun は一切表示されない
- [ ] e2e: 3幕通し・スキップ経路・再起動後非表示 の 3 spec 緑
