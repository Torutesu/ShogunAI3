# Hi-Fi UI JSX 分割 — 設計書

- 作成日: 2026-05-07
- 対象: `hifi/` 配下の JSX/JS 約 22,000 行（最大 `app.jsx` 4,829 行、`settings-modal.jsx` 4,708 行、`screens-a.jsx` 4,164 行）
- 著者: Torutesu + Claude (brainstorming)
- 状態: ドラフト（実装前）

## 1. 背景と問題

`hifi/` UI は Babel-in-browser + `<script type="text/babel">` で動作している。クロスファイル参照は `/* global X, Y, Z */` 注釈による暗黙のグローバル名前空間結合で、ビルドステップが存在しない。

これにより以下の負債が常時蓄積している。

1. **暗黙結合**: ファイル順依存・実行時 `ReferenceError`・循環参照の検出不能。
2. **静的検証不在**: 型エラー・未使用 import・タイポが本番まで届く。
3. **パース時間肥大**: ロード毎にブラウザが Babel で 22K 行をパース。
4. **巨大ファイル**: 1ファイル 4,800 行級が複数存在し、レビュー・編集・人間の認知限界を超える。
5. **テスト網羅不足**: Playwright e2e は 3 spec のみで、22K 行の安全網としては薄い。

## 2. ゴール

- ビルドステップ導入により ESM ベースの静的依存グラフへ移行する。
- 暗黙のグローバル結合を `import` / `export` に置換する。
- ファイルを feature 単位に分割し、1ファイル 600 行ソフト上限・800 行 warn・1000 行 error を CI で強制する。
- 縦割り（feature）と横断（shared）の境界を ESLint `boundaries` で機械的に強制する。
- TS 型チェック（`strict + checkJs` ハイブリッド）を入れ、JSDoc + `.tsx` で漸進的に型を厚くできる土台を作る。
- 上記すべてを**論理変更ゼロ**で達成し、Tauri 配布フローを止めない。

### 非ゴール

- Rust 側 (`src-tauri/`) の改造。
- Tauri specta による IPC 型自動生成（将来検討）。
- 視覚回帰テスト（Phase 2 完了後に検討）。
- React 19 / Suspense / Server Components 等への移行。
- `app.css` (34KB) の CSS Modules 化（必要なら別 spec）。
- 新機能の追加。

## 3. 技術選択（決定済み）

| 領域 | 選択 | 根拠 |
|---|---|---|
| ビルド | **Vite** | esbuild プリコンパイル、HMR、`vite preview` で本番同等成果物 |
| 型 | **TS hybrid (`allowJs` + `checkJs`)** | 22K 行を一気に `.tsx` 化せず、JSDoc 経由で .jsx も型検査 |
| 構成 | **feature-folder ハイブリッド** | `src/features/<feature>/`（縦割り）+ `src/shared/`（横断） |
| 移行順序 | **二段階: Vite 化 → 分割** | 同時進行はデバッグ不能。論理変更ゼロの中間状態を経由 |

## 4. アーキテクチャ

### 4.1 ディレクトリ全体像

```
ShogunAI3/
├─ src/                       ← 新エントリ（Vite ルート）
│  ├─ main.tsx                ← createRoot + <App/>
│  ├─ app/                    ← 旧 app.jsx 由来のシェル
│  │  ├─ App.tsx
│  │  ├─ shell/{Sidebar,TopBar,CommandPalette}.tsx
│  │  ├─ providers/{Settings,Theme,Tweak}.tsx
│  │  └─ hooks/useNavigation.ts
│  ├─ features/               ← 縦割り
│  │  ├─ home/
│  │  ├─ memory/  (debug/ サブディレクトリを内包)
│  │  ├─ chat/
│  │  ├─ agents/
│  │  ├─ work/
│  │  ├─ meetings/
│  │  ├─ morning-brief/
│  │  └─ settings/
│  └─ shared/                 ← 横断
│     ├─ icons/        ← Icon, Kamon, IntegrationLogo
│     ├─ modals/       ← ConfirmWriteModal, ConsentModal
│     ├─ hooks/        ← useSettings, usePrivacyFlag など
│     ├─ ipc/          ← transport, client, api, actions, runtime-actions, legacy-window
│     ├─ lib/          ← markdown-mini, highlight, user-timezone, brief-telemetry,
│     │                  morning-brief, meeting-media-recording, meeting-note-local,
│     │                  integration-connectors, clerk-auth, demo-seed, keyboard-shortcuts,
│     │                  legal-versions, storage
│     ├─ tokens/       ← tokens.css と CSS Variables
│     └─ types/        ← Settings, Memory, ChatMessage 等のドメイン型
├─ index.html                 ← Vite SPA エントリ（旧 .html を置換）
├─ vite.config.ts
├─ tsconfig.json              ← allowJs + checkJs + strict
├─ eslint.config.js           ← flat config
├─ web-dist/                  ← `vite build` 出力（gitignore、Tauri `frontendDist` の既存値を流用）
├─ src-tauri/tauri.conf.json  ← `frontendDist: ../web-dist` のまま、`beforeBuildCommand` のみ更新
└─ playwright.config.js       ← `webServer` を `vite preview` に変更
```

`hifi/` と `SHOGUN Hi-Fi UI.html` は Phase 1 完了時点で削除する。`hifi/vendor/{react,babel}.*` も同タイミングで削除。

### 4.2 feature 内の標準レイアウト

```
src/features/<feature>/
├─ index.ts            ← この feature の公開エントリ。screen と必要な型のみ
├─ <Feature>Screen.tsx ← ルート画面
├─ components/         ← この feature 専用のコンポーネント
├─ hooks/              ← この feature 専用の hooks
├─ lib/                ← この feature 専用の純関数・契約
└─ types.ts            ← feature 内で共有する型
```

### 4.3 旧ファイル → 新場所のマッピング

| 旧 (行数) | 含まれる Screen | 新 |
|---|---|---|
| `app.jsx` (4,829) | App / Sidebar / Providers | `src/app/` 配下に分解 |
| `screens-a.jsx` (4,164) | `ScreenHome`, `ScreenMemory`, `MemoryDigestView`, `MemorySearchView` | `src/features/{home, memory}/` |
| `screens-b.jsx` (716) | `ScreenChat` | `src/features/chat/` |
| `screens-c.jsx` (1,501) | `ScreenWork`, `ScreenCapture`, `ScreenIntegrations`, `ScreenSettings` | `src/features/{work, capture, integrations, settings-screen}/`（`ScreenSettings` と `settings-modal.jsx` の関係は Phase 2 着手時に再調査） |
| `screens-agents.jsx` (1,662) | `ScreenAgents` ほか | `src/features/agents/` |
| `screens-meetings.jsx` (3,216) | `ScreenMeetings` ほか | `src/features/meetings/` |
| `screens-memory-debug.jsx` (630) | `ScreenMemoryDebug` | `src/features/memory/debug/` |
| `screens-morning-brief.jsx` (286) | Morning Brief 専用ビュー | `src/features/morning-brief/` |
| `settings-modal.jsx` (4,708) | `SettingsModal` 全タブ | `src/features/settings/`（タブ毎に `panels/`） |
| `icons.jsx`, `integration-logos.jsx` | `Icon`, `Kamon`, `IntegrationLogo` | `src/shared/icons/` |
| `runtime-actions.jsx` | runtime actions | `src/shared/ipc/runtime-actions.tsx` |
| `components/{confirm-write,consent}-modal.jsx` | 横断モーダル | `src/shared/modals/` |
| `lib/*.js` | 横断ヘルパ | `src/shared/lib/*.ts` または `src/shared/ipc/*.ts` |

## 5. データフロー

### 5.1 IPC 層の再構成

```
Tauri (Rust)              Browser preview
   ▲                          ▲
   │                          │
   └── tauriTransport ──┬── mockTransport
                         │
              shared/ipc/transport.ts   ← Transport 抽象（ランタイム判定）
                         │
              shared/ipc/client.ts      ← invoke<T>() / listen() ラッパ
                         │
              shared/ipc/api.ts         ← shogun-api 相当（ドメイン関数）
                         │
              shared/ipc/actions.ts     ← action-registry 相当
                         │
              features/*/ から純粋に import
```

`mockTransport` は現 `hifi/lib/ipc-client.js` の `mockTransport`（localStorage ベース）をロジック温存でコピー。`transport.ts` は `window.__TAURI__` の有無で実装を切替える。

### 5.2 window グローバルの扱い分類

| 種類 | 扱い | 理由 |
|---|---|---|
| `window.__TAURI__` | そのまま参照 | Tauri 注入、契約 |
| `window.ShogunIpcClient` 等の自前 globals | `src/shared/ipc/legacy-window.ts` で**書き出しのみ維持**、新コードは import | 互換と健全化の両立 |
| `window.SHOGUN_DEMO_SEED` | `import.meta.env.DEV` 分岐で `src/shared/lib/demo-seed.ts` に移管 | デバッグ専用なので隔離 |
| `localStorage` 直書き | `src/shared/lib/storage.ts` 経由に集約（型付きラッパ） | キー名タイポ防止 |
| `/* global Icon, Kamon */` 等 | 全削除 | ESM import に置換 |

### 5.3 IPC 型付け

- `src-tauri/src/commands.rs` の各 `#[tauri::command]` 関数を**手書き** TS 型として `src/shared/ipc/types.ts` に1関数1型で定義。
- 自動生成は将来の余地として残す（Phase 3 候補、本スペック外）。
- 呼び出し側は `invoke<T>('memory_search', { query }): Promise<MemorySearchResult>` の形で型を効かせる。

## 6. 型・Lint・CI ガード

### 6.1 tsconfig.json

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowJs": true,
    "checkJs": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

Phase 1 マージ時点では `checkJs: false` で開始し、Phase 1.5 の専用 PR で `true` に切替える。

### 6.2 ESLint 構成（flat config）

中核プラグイン:
- `@typescript-eslint`
- `eslint-plugin-react`, `eslint-plugin-react-hooks`
- `eslint-plugin-import`（resolver: typescript）
- `eslint-plugin-unused-imports`
- `eslint-plugin-boundaries`

機械的に止めるルール（全部 `error`、CI は `--max-warnings 0`）:

| ルール | 防ぐ負債 |
|---|---|
| `import/no-cycle` | 循環参照 |
| `import/no-self-import` | 自己参照 |
| `import/no-internal-modules` | feature 内部直叩き禁止、`index.ts` 経由を強制 |
| `unused-imports/no-unused-imports` | dead import |
| `boundaries/element-types` | 逆向き依存禁止、feature 同士の直接 import 禁止 |
| `react-hooks/rules-of-hooks` + `exhaustive-deps` | hooks 由来のバグ |
| `no-restricted-syntax` (`window.Shogun*` 直アクセス) | window バス再発防止 |
| `max-lines: [800, skipBlankLines: true]` | 巨大ファイル復活（warn）。1000 行で error。`src/features/_legacy/**` は Phase 2 中だけ override で完全除外、Phase 2 step 12 で除外解除 |
| `no-restricted-imports` (`hifi/**`) | Phase 2 進行中の旧パス逆戻り防止（Phase 1 で `hifi/` 自体を削除するため、誤って復活させる差分も検出される） |

**段階的有効化**: Phase 1 マージ時点では `boundaries/element-types` と `max-lines` を `warn`、Phase 1.5 で `error` に昇格。これは Phase 1 PR の差分が大きいため、ガード強度を後追いで上げる方針。

`boundaries` 設定:

```js
{
  elements: [
    { type: 'app',      pattern: 'src/app/**' },
    { type: 'feature',  pattern: 'src/features/*/**', capture: ['feature'] },
    { type: 'shared',   pattern: 'src/shared/**' },
  ],
  rules: [
    { from: 'shared',  disallow: ['app', 'feature'] },
    { from: 'feature', disallow: [{ type: 'feature', feature: '!${from.feature}' }] },
    { from: 'app',     allow: ['feature', 'shared'] },
  ]
}
```

### 6.3 追加ガード

| ツール | 用途 |
|---|---|
| `knip` | 未使用 export / dependency / files 検出 |
| `madge` | 循環参照の可視化 |
| `size-limit` | feature ごとの bundle 予算 |
| `prettier` | 整形 |

### 6.4 CI ジョブ（`.github/workflows/hifi-quality.yml`）

```
- typecheck:     tsc --noEmit
- lint:          eslint . --max-warnings 0
- knip:          knip --no-progress
- cycles:        madge --circular --extensions ts,tsx src   (exit 1 if any)
- test:e2e:      playwright test（vite preview 経由）
- check:rust:    既存維持
- test:rust:     既存維持
- check:actions: hifi/scripts/check-actions.py（Phase 2 で src/ 対応に更新）
- check:ipc-mock: hifi/scripts/check-ipc-mock-sync.mjs（Phase 1 で src/ パスに更新）
```

### 6.5 ランタイムエラーハンドリング

- `shared/ipc/client.ts` で `invoke<T>` を try/catch ラップし、`IpcError` 型に正規化。
- すべての feature 画面はトップに薄い `<ErrorBoundary>` を持ち、フォールバック UI を表示（既存挙動の温存）。
- mock 環境では `IpcError` を console に出力、Tauri では既存テレメトリへ。

## 7. テスト・検証戦略

### 7.1 検証ピラミッド

```
Manual smoke (Tauri 実機 + ブラウザ preview)
Playwright e2e (各 feature 代表シナリオ)
Component tests (Vitest + RTL)
Pure-function unit tests (Vitest)
Static: tsc / eslint / knip / madge
```

### 7.2 Phase 0 で追加する e2e spec（必須前提）

| 新規 spec | 担保内容 |
|---|---|
| `home-morning-brief.spec.js` | Home 表示、Morning Brief カード、next-action クリック |
| `memory-search.spec.js` | Memory タブ、FTS 結果、semantic 切替 |
| `chat-basic.spec.js` | Chat 送信、context source 表示、履歴復元 |
| `agents-list.spec.js` | Agents 一覧、空状態、カード遷移 |
| `work-grid.spec.js` | Work プロジェクトグリッド、ハイライト |
| `meetings-list.spec.js` | Meetings 一覧、録音ボタン disabled 状態 |
| `settings-tabs.spec.js` | 全 Settings タブを順に開く |
| `keyboard-shortcuts.spec.js` | 主要ショートカット (cmd+k 等) |

**判定方針**: DOM 存在 + 主要テキスト + クリック後の遷移のみ。スクショピクセル比較は導入しない（フォント差で割れる）。所要目安 8 spec × 平均 20 秒 = 約 3 分。

### 7.3 Vitest（コンポーネント・純関数）

Phase 2 各 feature PR の DoD:
- `shared/lib/*` 純関数: 100% カバレッジ目標。
- feature 内 hooks: `@testing-library/react` の `renderHook` で代表ケース。
- feature 内コンポーネント: snapshot ではなく role/name クエリで書く。

### 7.4 Tauri 実機 smoke

Phase 1 PR、Phase 2 各 PR で：
1. `npm run build:web-dist` → `npm run build:desktop`（未署名で可）
2. 該当画面の主要動作を目視確認。
3. PR 説明にスクリーンショット添付。

### 7.5 Playwright 設定変更

```diff
  webServer: {
-   command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
+   command: `npm run preview -- --port ${PORT} --strictPort`,
  }
```

`vite preview` は `dist/` を提供するため、e2e は本番同等成果物を叩く。

### 7.6 既存 Python / Node チェッカ

`hifi/scripts/check-actions.py`（action-map.md 整合）と `hifi/scripts/check-ipc-mock-sync.mjs`（mock IPC 整合）は維持。

- Phase 1: `hifi/` 削除に伴い `scripts/check-actions.py` と `scripts/check-ipc-mock-sync.mjs` に移動し、内部のパスを `src/` 系に書き換える。`action-map.md` も `docs/action-map.md` などリポジトリルート相対のパスに移動。
- Phase 2: feature ごとに action-map のセクションを分割し、各 feature 配下に置けるか検討（過度な分割は逆効果なので結論は Phase 2 着手時）。

## 8. マイグレーションプラン

### Phase 0 — 安全網の構築（1 PR、1〜2日）

1. 8 つの追加 e2e spec を `tests/e2e/` 配下に新規追加。既存 `python3 -m http.server` で green。
2. CI に `madge --circular` ジョブ追加（現状で循環ゼロを基準化）。
3. PR 説明に現状の Tauri 実機スクショ（Home / Memory / Chat / Settings / Meetings）を添付。

**完了条件**: 既存 + 新 e2e が両方 green。
**ロールバック**: revert で完結。

### Phase 1 — Vite + ESM 化（1 PR、論理変更ゼロ、3〜5日）

1. `vite`, `@vitejs/plugin-react`, `typescript`, ESLint flat 関連、`vitest`, `@testing-library/react`, `knip`, `madge`, `size-limit` を `package.json` に追加。スクリプトに `dev`, `build`, `preview`, `typecheck`, `lint`, `test:unit`, `quality` を追加。
2. `vite.config.ts`、`tsconfig.json`（初回 `checkJs: false`）、`eslint.config.js`（初回 `boundaries` を warn）、新 `index.html` を作成。
3. ファイル移動と拡張子変更。`hifi/screens-*.jsx` などは `src/features/_legacy/` に一時隔離（巨大ファイルのまま）。
4. 各ファイルへの機械的置換：
   - `/* global X, Y, Z */` を削除し、当該シンボルへの参照を解決するための `import` をファイル冒頭に追加
   - **他ファイルから参照されているトップレベル宣言（旧 `window.X = X` の右辺、または別ファイルが `/* global */` で参照していたもの）に `export` を付与**。それ以外の関数・定数は `export` しない（公開面積を最小化）
   - 旧コードが `window.X` 形式で公開していたシンボルのうち、Tauri Rust 側 / e2e フィクスチャ / 外部 deep link が触っているものだけ、ファイル末尾で `if (typeof window !== 'undefined') { window.X = X; }` の互換シムを残す。識別の手がかりは `grep "window.Shogun\|window.Screen" hifi/`
   - CSS は `App.tsx` 冒頭で `import './tokens.css'` `import './app.css'` の方式に統一
5. Tauri / Playwright / web-dist の切替：
   - Vite 設定で `build.outDir: 'web-dist'`、`build.emptyOutDir: true` を指定（既存の `frontendDist: ../web-dist` を温存）
   - `src-tauri/tauri.conf.json` の `build.devUrl` を `http://localhost:5173` に追加し、`beforeDevCommand: "npm run dev"` を設定。`beforeBuildCommand` は `npm run build:web-dist` のまま、内部で `vite build` を呼ぶように差し替え
   - `package.json` の `build:web-dist` を `vite build` に差し替え（`scripts/sync-web-dist.mjs` は削除）
   - `playwright.config.js` の `webServer.command` を `npm run preview -- --port 4173 --strictPort`
   - 旧 `SHOGUN Hi-Fi UI.html`、`hifi/vendor/{react,babel}.*` を削除
   - `hifi/` を削除（中身は全て `src/` へ移動済み）
   - `scripts/check-actions.py`, `scripts/check-ipc-mock-sync.mjs` を `hifi/scripts/` から `scripts/` に移動し、内部パスを `src/` 系に更新
   - `hifi/assets/{app-icon-mac-1024.png, mark.png, mark.svg, mark-512-dark.png, integrations/}` は `public/assets/` に移動。Vite は `public/` 配下を `web-dist/` 直下にコピーする（favicon・OG 画像など `index.html` から相対参照する画像はここに置く）。`tauri.conf.json` の `beforeBuildCommand` 内の `npx tauri icon` 引数も新パスに更新
   - `hifi/docs/{amc-composer-spec.md, prd/}` は `docs/hifi-legacy/` に移動（リポ全体の `docs/` 配下に集約）
   - `hifi/schemas/morning-brief-v2.schema.json` は `src/features/morning-brief/schemas/` に配置（Phase 2 step 3 で feature 内に取り込まれる前段として、Phase 1 では `src/shared/schemas/` に一旦置く）
   - `hifi/preview-home*.jpg` などのプレビュー画像はリポジトリから削除（README で参照されていなければ）するか、`docs/screenshots/` に移動
   - `hifi/README.md` の有用な内容を `src/README.md` または ルート `README.md` に統合し、旧ファイルは削除
   - `hifi/action-map.md` を `docs/action-map.md` に移動（`scripts/check-actions.py` の参照先もここに合わせる）
   - `hifi/amc-pipeline/`（独立 Node サブパッケージ）は `tools/amc-pipeline/` にディレクトリごと移動。Vite ビルドの対象外で、独自の `package.json` を持つため移動だけ行い中身は触らない
6. 検証：
   - `npm run quality` が green
   - `npm run build:desktop`（未署名）で Tauri 実機が起動し、Phase 0 のスクショと目視一致
   - PR 説明に Phase 0 スクショとの比較を添付

**完了条件**: 6-1〜6-3 全てクリア。
**ロールバック**: 1 PR 単位なので revert で完結。`_legacy/` のおかげで論理は完全に温存。

### Phase 1.5 — checkJs 有効化（小 PR、1日）

1. `tsconfig.json` を `checkJs: true` に切替。
2. 出てきた型エラーを `// @ts-expect-error TODO(phase2): <feature名>` で機械的にマーク。
3. Phase 2 の各 PR DoD の追跡対象としてカウント。

### Phase 2 — feature ごとの分割（複数 PR、合計 8〜15日）

推奨順序と所要見込み：

| 順 | feature | 旧ファイル | 規模 | リスク |
|---|---|---|---|---|
| 1 | `shared/icons` 最終整理（Icon/Kamon/IntegrationLogo の API 確定、`index.ts` バレル整備、JSDoc 型付け） | (Phase 1 で済) | 小 | なし |
| 2 | `shared/lib`, `shared/ipc` の TS 化（IPC 型を `commands.rs` から手書きで起こす） | `shared/lib/*.ts`, `shared/ipc/*.ts` | 中 | IPC 型の正確性 |
| 3 | `morning-brief` | `screens-morning-brief.tsx` (286) | 小 | 低 |
| 4 | `memory/debug` | `screens-memory-debug.tsx` (630) | 小 | 低 |
| 5 | `chat` | `screens-b.tsx` (716, `ScreenChat`) | 小 | 低 |
| 6 | `agents` | `screens-agents.tsx` (1,662) | 中 | 低 |
| 7 | `work` + `capture` + `integrations` + `settings-screen` | `screens-c.tsx` (1,501, 4 画面同居) | 中 | 中（4 画面の責務分離） |
| 8 | `home` + `memory` | `screens-a.tsx` (4,164) | 大 | 中（Home に Morning Brief 同居、Memory は MemoryDigestView/MemorySearchView 等のサブビュー多数） |
| 9 | `meetings` | `screens-meetings.tsx` (3,216) | 大 | 中（録音/STT/メディア副作用） |
| 10 | `settings`（modal 全タブ） | `settings-modal.tsx` (4,708) | 最大 | 中（タブ間状態共有。`settings/state/` を先に切り出してから panels に依存させる） |
| 11 | `app` shell 最終整理（Sidebar / TopBar / CommandPalette / Providers の切り出し） | `App.tsx` | 中 | 低 |
| 12 | `_legacy/` 削除、`max-lines` を 800/1000 に強制（warn → error 昇格、`_legacy` 例外解除） | — | 小 | なし（ガード本格起動） |

各 PR の DoD:
- 対象 feature 配下の `_legacy` ファイルが消えている
- `@ts-expect-error TODO(phase2): <feature>` がゼロ
- 該当 feature の Vitest 追加（hooks と純関数）
- e2e 既存スイート green
- Tauri 実機 smoke のスクショ添付（該当画面のみ）
- `madge --circular` ゼロ維持

並行作業の制約：8（home + memory）と 10（settings modal）は app shell との接点が広いので必ず直列で進める。3〜7 は理論上並行可能だが、ソロ開発前提のため基本直列とする。

## 9. リスク表

| リスク | 影響 | 緩和 |
|---|---|---|
| Tauri webview と Vite preview で挙動差 | Phase 1 マージ後にユーザ環境のみ壊れる | Phase 1 PR 必須の実機 smoke、Phase 0 スクショとの比較 |
| `mockTransport` の挙動が ESM 化で微変 | e2e 偽通過 | mock 実装はファイル丸ごとコピー、差分レビュー必須 |
| Babel parse → esbuild parse の構文サポート差 | Phase 1 で一部ファイルが build エラー | `@vitejs/plugin-react` のデフォルトで吸収可能。エラーが出た場合は当該行のみ ESM 標準構文に書換 |
| `_legacy/` が居座り続ける | Phase 2 中断で技術負債残存 | `_legacy/` 内のファイル数を README にバッジ表示。各リリースで残数を晒し圧力にする |
| Settings の状態共有が分割で破綻 | Settings 全タブが壊れる | feature 9 で `settings/state/` を先に切り出し、各 panel をそれに依存させる順 |
| 型エラー収束が長期化 | `@ts-expect-error` が増殖して腐る | Phase 1.5 でマーク時にコメントへ feature 名を必須記載、Phase 2 PR の DoD で機械的に追跡 |

## 10. 完了の定義（プロジェクト全体）

- `hifi/` ディレクトリと `SHOGUN Hi-Fi UI.html` が消えている。
- `src/features/_legacy/` が消えている。
- すべての `.tsx` / `.ts` が `max-lines: 1000` 以下、原則 600 行以下。
- `@ts-expect-error TODO(phase2):` がゼロ。
- `madge --circular` ゼロ維持。
- `boundaries` ルールが `error` で全 PR を通過。
- Tauri 実機ビルドが従来と同じ機能で動く。
- Phase 0 で追加した 8 spec が全て green を維持。
