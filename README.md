# SHOGUN AI（デスクトップ）

macOS 向けの **Tauri v2** デスクトップアプリと、**Hi-Fi UI**（React + TypeScript、Vite ビルド、ブラウザ／WebView 共用）を同一プロダクトとして開発しています。

## 利用者向け（同梱・配布用ドキュメント）

- **[セットアップ（日本語）](docs/END_USER_SETUP.md)** — 起動、API キー、Memory・埋め込みの要点
- **[プライバシー概要](PRIVACY.md)**（英語）
- **[利用規約（日本語・ベータ）](docs/TERMS_OF_SERVICE.md)**
- **[Terms of Service (English, beta)](docs/TERMS_OF_SERVICE_EN.md)**

### Unsigned ビルドのインストール（ベータ配布版）

現在は Apple Developer 未登録のため **未署名 DMG** を配布しています。初回起動時に macOS の Gatekeeper が「開発元を確認できないため開けません」という警告を出しますが、以下で起動できます：

**macOS Sonoma (14) 以前:**
1. DMG をマウントし、Shogun AI.app を Applications フォルダにドラッグ
2. Applications フォルダで **右クリック → 開く**
3. 警告ダイアログで **「開く」** をクリック（次回からは普通にダブルクリックで起動）

**macOS Sequoia (15) 以降:**
1. 上記 2 で警告が出る → そのままダイアログを閉じる
2. **システム設定 → プライバシーとセキュリティ** を開く
3. 下部の "Shogun AI はブロックされました" の横の **「このまま開く」** をクリック
4. 認証 → 起動

> 公式版（Apple 公証済み）はリリース予定です。それまでは未署名ビルドでお試しください。アプリの全機能は普通に動作します。

## 開発者向け

- **UI 全体構成:** 後述「ディレクトリ構成」参照
- **アクション一覧:** [`docs/action-map.md`](docs/action-map.md)
- **macOS 配布・署名・公証:** [`docs/macos-release.md`](docs/macos-release.md)
- **Morning Brief パイプライン（Node）:** [`tools/amc-pipeline/README.md`](tools/amc-pipeline/README.md)
- **JSX 分割プロジェクト完了サマリ:** [`docs/archive/superpowers/plans/2026-05-12-hifi-jsx-split-completion-summary.md`](docs/archive/superpowers/plans/2026-05-12-hifi-jsx-split-completion-summary.md)

### 必要環境

| ツール | バージョン |
|---|---|
| Node.js | 20+ |
| Rust | stable |
| macOS | 14+（開発時） |

### セットアップ

```bash
npm ci
```

### 開発フロー

| 用途 | コマンド |
|---|---|
| Vite dev サーバ（ブラウザでプレビュー） | `npm run dev` |
| Vite 本番ビルド（`web-dist/`へ） | `npm run build` |
| ビルド済アセットを `vite preview` で配信 | `npm run preview` |
| Tauri 実機起動（dev mode、Rust ↔ Vite dev） | `npm run dev:desktop` |
| Tauri 実機ビルド（未署名 .app／.dmg） | `npm run build:desktop` |
| Tauri 実機ビルド（署名つき） | `npm run build:desktop:signed` |

### 検証コマンド

| 用途 | コマンド |
|---|---|
| TypeScript 型チェック | `npm run typecheck` |
| ESLint（warn 0 / error 0） | `npm run lint` |
| 循環参照チェック | `npm run cycles` |
| 未使用 export/dep 検出 | `npm run knip` |
| Rust check | `npm run check:rust` |
| Rust test | `npm run test:rust` |
| Vitest 単体テスト | `npm run test:unit` |
| Playwright e2e | `npm run test:e2e` |
| 自家製アクション整合チェック | `npm run check:actions` |
| 全部まとめて | `npm run quality` |

### ディレクトリ構成

```
ShogunAI3/
├─ index.html                        ← Vite SPA エントリ
├─ vite.config.ts, tsconfig.json, eslint.config.js, vitest.config.ts
├─ public/assets/                    ← favicon, app icons, brand marks
├─ src/
│  ├─ main.tsx                       ← createRoot + <App/>
│  ├─ app/
│  │  ├─ App.tsx                     ← root: ErrorBoundary + AppCore
│  │  ├─ AppCore.tsx                 ← consent gate + 法的同意
│  │  ├─ MainApp.tsx                 ← シェル（state は hooks/ に分離）
│  │  ├─ MainApp.css                 ← inline <style> から抽出
│  │  ├─ ErrorBoundary.tsx
│  │  ├─ context/                   ← ShogunRuntimeContext (typed runtime)
│  │  ├─ hooks/                      ← custom hooks (state cluster ごと)
│  │  │  ├─ useChatHistory.ts, useChatModals.ts, useChatDrag.ts, useChatActions.ts
│  │  │  ├─ useSidebarLayout.ts, useShareControls.ts, useFloatMenus.ts
│  │  │  ├─ useHummingbird.ts, useTweaks.ts, useMeetingHud.ts
│  │  │  ├─ useProfile.ts, useHistoricalImport.ts, useWriteConfirm.ts
│  │  ├─ shell/                      ← TopBar, Sidebar, ShareModal + 9 portals + 4 overlays
│  │  └─ lib/                        ← constants, helpers, mockIpc
│  ├─ features/                      ← feature folders (縦割り)
│  │  ├─ home/, memory/, chat/, agents/, work/, meetings/
│  │  ├─ settings/, memory-debug/
│  │  └─ <feature>/{ FeatureScreen.tsx, components/, hooks/, lib/, types.ts, index.ts }
│  └─ shared/                        ← 横断
│     ├─ icons/         ← Icon, Kamon, IntegrationLogo
│     ├─ modals/        ← ConfirmWriteModal, ConsentModal
│     ├─ ipc/           ← ipc-client, mock/handler, shogun-api, action-registry
│     ├─ lib/           ← markdown-mini, brief-telemetry, morning-brief, …
│     └─ tokens/        ← tokens.css, app.css
├─ tests/e2e/                        ← Playwright (14 specs)
├─ scripts/                          ← check-actions.py, dev-desktop-mac.sh, …
├─ tools/amc-pipeline/               ← Morning Brief Node サブパッケージ
├─ src-tauri/                        ← Rust (Tauri 2)
└─ docs/                             ← spec / plan / release notes
```

#### feature 内の標準レイアウト

```
src/features/<feature>/
├─ index.ts            ← 公開エントリ
├─ <Feature>Screen.tsx ← ルート画面
├─ components/         ← この feature 専用のコンポーネント
├─ hooks/              ← この feature 専用の hooks
├─ lib/                ← 純関数・契約
└─ types.ts            ← 型
```

### 設計原則

- **境界の機械的強制**: `eslint-plugin-boundaries` で `shared → feature → app` の一方向のみ許可。feature 間直接 import 禁止。
- **循環参照ゼロ**: `madge --circular` を CI で強制。
- **max-lines 1500 warn**: `src/` 全ファイルが現状この閾値内。
- **TypeScript strict + checkJs**: 0 errors。
- **e2e ゼロ regression**: Phase 0 で確立した安全網 (Playwright) を 30+ PR にわたって緑維持。
- **テスト**: Vitest 311（lib pure + RTL component）+ Playwright 68（e2e）。
- **window 互換シム**: ESM 化で原則撤廃。意図的に残した 1 つ（`SHOGUN_LEGAL_VERSIONS`）は legal-versions.ts に明示。

### CI

`.github/workflows/ci.yml` が PR で実行：

- `npm run check:actions` （自前整合性チェック）
- `npm run check:rust` / `test:rust` （Cargo）
- `npm run build:web-dist` （Vite build）
- `npm run test:e2e` （Playwright）
- `npm run build:desktop` （Tauri 実機ビルド）

## ライセンス

本ソフトウェアの**ソースコードおよびバイナリ**は、**プロプライエタリ（独占的）**です。第三者への再配布・改変・リバースエンジニアリング等は、**別途締結する契約または [`LICENSE`](LICENSE) に記載の範囲**でのみ許可されます。サードパーティのライブラリは各ライセンスに従います。
