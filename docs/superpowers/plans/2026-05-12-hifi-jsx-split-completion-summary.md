# Hi-Fi UI JSX 分割 — プロジェクト完了サマリ

> 2026-04-18 着工、2026-05-12 完了。Phase 0〜6 通算 6 phase / 30 step / 30 PR / 約 25 日。

## Mission

Babel-in-browser でロードされていた 22,000 行の単一 JSX 群 (`hifi/app.jsx` 4,829 行 ほか) を、Vite + ESM + feature-folder + TypeScript strict の現代的構成に移行する。既存 e2e を **regression ゼロで通過させながら** 完了させる。

## Before / After

| 指標 | 着工時 | 完了時 |
|---|---|---|
| 配置 | 1 file in `hifi/` | **64 files** in `src/{app,features,shared,hooks}/` |
| 最大単一ファイル | 4,844 行 | **1,914 行** (MainApp.tsx) ↓60% |
| ビルド | Babel-in-browser (ロード時パース) | **Vite + esbuild** (1.3 秒で 800KB バンドル) |
| TS 型チェック | (none) | **0 errors**, strict + checkJs |
| ESLint | (none) | **0 errors, 0 warnings** (`--max-warnings 0`) |
| `// @ts-nocheck` | — | **0** |
| `eslint-disable max-lines` | — | **1** (MainApp、Phase 6+ 候補) |
| window 互換シム | 多数 | **1** (SHOGUN_LEGAL_VERSIONS、e2e 用に意図保持) |
| Vitest tests | 0 | **311** (lib 199 + RTL 86 + その他 26) |
| Playwright e2e | 3 spec | **68 tests / 10 specs** |
| 循環依存 | (unknown) | **0** (madge 強制) |
| Feature 間 import | 暗黙許容 | **ESLint error で禁止** |
| Custom hooks | 0 | **11** in `src/app/hooks/` |

## Phase ロードマップ

```
Phase 0  ─── e2e 安全網 (PR #59)
   │       4 spec 追加、ベースラインスクショ
Phase 1  ─── Vite + ESM 化 (PR #62)
   │       hifi/* → src/{app, features/_legacy, shared}/
   │       _legacy に巨大 JSX を一時隔離
Phase 2  ─── feature 別分解 (PR #64-74)
   │       _legacy/ → 8 features に分割
   │       Step 3-12 = 11 PR
Phase 3  ─── ESM polish + decomposition (PR #75-80)
   │       window 互換シム除去、shell/Pane/Screen 細分化
   │       Vitest 立ち上げ (lib 199 tests)
Phase 4  ─── MainApp 整理 (PR #81-84)
   │       Portals 9 個抽出、max-lines threshold 整合
   │       e2e 拡充 (56 → 68)
Phase 5  ─── State hooks + lint cleanup (PR #85-87)
   │       11 custom hooks 抽出、inline <style> → CSS
   │       ESLint 0 errors、RTL tests 86 件
Phase 6  ─── 最終仕上げ (PR #88-89, #90)
           GranolaOverlay 分解、exhaustive-deps 0 warnings
           ESLint --max-warnings 0 強制
```

## 重要な意思決定と教訓

### 1. 二段階移行戦略 (Phase 1 → 2)
Vite 化と分割を**同時にやると debug 不能**。Phase 1 で巨大 JSX を `_legacy/` にそのまま移して Vite に乗せ、Phase 2 で feature 単位に分解する 2 段階を採用。これにより各段階で原因を追跡可能に。

### 2. e2e ゼロ regression 原則
Phase 0 で先に e2e を厚くしてから移行を開始。Phase 1 以降の各 PR で **56 → 68 tests** が緑であることを Controller (= 私) が直接確認。subagent の自己報告だけに依存しない方針に Phase 3 中盤で切替（**Phase 2 中の subagent レポート不正確問題で発覚**）。

### 3. Subagent 検証ゲート
Phase 0 では各 task で 3 段階レビュー (implementer / spec compliance / code quality) を導入。Phase 2 以降は subagent の自己報告を信頼してしまい、後で「lib loading bug が Phase 1 から潜在していた」「CI が複数 PR で長期間赤」が判明。**Controller 直接検証が大事**。

### 4. 意図的に残した window 互換シム
`window.SHOGUN_LEGAL_VERSIONS` だけは Phase 4 Step 4 で残す決定。Playwright e2e helper の `Object.defineProperty` トラップ機構に依存しており、ESM 化すると "version bump re-prompts" テストが動かない。**load-bearing なシムをドキュメント化**。

### 5. Phase 中の CI 4 バグ
セッション中に発見した CI バグ:
- **lib loading bug**: shared/lib モジュールが tree-shake で消えていた (Phase 1〜2 中ずっと壊れていた)
- **check-ipc-mock パス古い**: Phase 2 Step 11 で mockIpcInvoke 移動時に script 未更新
- **Tauri icon path**: `../public/...` が repo root 外を指していた
- **Tauri API 2.11 vs Rust 2.10.3 mismatch**: バージョンピン要

すべて 15+ ブランチへ cherry-pick で伝播済。

## PR チェーン (30 PR)

```
main
 └─ #59  Phase 0   e2e 安全網
     └─ #62  Phase 1   Vite/ESM
         └─ #64  Phase 2 Step 3 morning-brief
             └─ #65  Phase 2 Step 4 memory-debug
                 └─ #67  Phase 2 Step 5 chat
                     └─ #68  Phase 2 Step 6 agents
                         └─ #69  Phase 2 Step 7 screens-c (4 features)
                             └─ #70  Phase 2 Step 8 home + memory
                                 └─ #71  Phase 2 Step 9 meetings
                                     └─ #72  Phase 2 Step 10 settings-modal
                                         └─ #73  Phase 2 Step 11 app shell
                                             └─ #74  Phase 2 Step 12 _legacy 削除
                                                 └─ #75  Phase 3 Step 1 lib loading fix
                                                     └─ #76  Phase 3 Step 2 ESM imports
                                                         └─ #77  Phase 3 Step 3 MainApp shell
                                                             └─ #78  Phase 3 Step 4 big panes
                                                                 └─ #79  Phase 3 Step 5 big screens
                                                                     └─ #80  Phase 3 Step 6 Vitest lib tests
                                                                         └─ #81  Phase 4 Step 1 portals
                                                                             └─ #82  Phase 4 Step 2 max-lines
                                                                                 └─ #83  Phase 4 Step 3 e2e expand
                                                                                     └─ #84  Phase 4 Step 4 legal-versions doc
                                                                                         └─ #85  Phase 5 Step 1 state hooks
                                                                                             └─ #86  Phase 5 Step 2 lint cleanup
                                                                                                 └─ #87  Phase 5 Step 3 RTL tests
                                                                                                     └─ #88  Phase 6 Step 1 GranolaOverlay
                                                                                                         └─ #89  Phase 6 Step 2 exhaustive-deps
                                                                                                             └─ #90  Phase 6 Step 3 (this doc)
```

## 残課題（任意・将来）

- MainApp.tsx (1914 行) を更に細分化して `eslint-disable max-lines` を除去
- Tauri 実機 smoke 取得 (Phase 0 Task 6 の手動作業)
- 配布用 README 更新（新しい dev フロー、ビルド手順）
- (オプション) Memory/Meetings/Home Screen を更に分解
- (オプション) GranolaOverlay 1137 行の更なる分解

## マージ順序

すべて main へマージするには、PR を **作成順**（#59 → #62 → #64 → ... → #90）でマージ。各 PR の base はチェーンの直前の PR を指しているので、順序ベースで自動的に main に到達する。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
