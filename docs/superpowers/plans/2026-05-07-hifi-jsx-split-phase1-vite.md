# Hi-Fi UI JSX 分割 — Phase 1（Vite + ESM 化）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Babel-in-browser + 暗黙グローバル結合の現アーキテクチャを Vite + ESM ベースに置き換える。**論理コードは1行も変更しない**（globals→imports の機械的置換、ファイル移動・拡張子変更のみ）。Tauri 実機・既存 e2e・既存 Rust ビルドが Vite 切替後も green を維持することがゴール。

**Architecture:** `hifi/*` を `src/{app, features/_legacy, shared/{icons,lib,ipc,modals,tokens}}` に再配置。各 JSX/JS は `.tsx`/`.ts` にリネームし、ファイル冒頭の `/* global X, Y */` 注釈を削除して `import` に置換、トップレベル宣言に `export` を付与、Tauri Rust や e2e が触る `window.X` グローバルだけは互換シムとしてファイル末尾に残す。Vite の `build.outDir` を既存の `web-dist/` に向け、Tauri の `frontendDist` 設定変更を最小化する。Phase 1 では巨大画面ファイル（`screens-a.tsx` 4164行 等）は `src/features/_legacy/` に**そのまま**置き、`max-lines` ESLint ルールを Phase 2 期間中だけ除外する。

**Tech Stack:** Vite 5、TypeScript 5（`strict + allowJs`、`checkJs: false`で開始しPhase 1.5でtrue化）、ESLint flat config（`@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-import`, `eslint-plugin-unused-imports`, `eslint-plugin-boundaries`）、Vitest + @testing-library/react、knip、madge、size-limit。React と ReactDOM はランタイム同梱（`vendor/` の手書きバンドルから `react`/`react-dom` パッケージへ移行）。

**スペック:** [docs/superpowers/specs/2026-05-07-hifi-jsx-split-design.md](../specs/2026-05-07-hifi-jsx-split-design.md) §8 Phase 1 + Phase 1.5

**前提:** Phase 0（PR #59）の e2e 4 spec が main に入っているか、もしくは本ブランチが Phase 0 の変更を含む状態でスタートする。Phase 1 は新ブランチ `feat/hifi-vite-migration` を `docs/hifi-jsx-split-design`（または Phase 0 マージ後の `main`）から切って作業する。

---

## ファイル構造（移行後の最終形）

```
ShogunAI3/
├─ index.html                        ← Vite ルート（旧 SHOGUN Hi-Fi UI.html を置換）
├─ vite.config.ts
├─ tsconfig.json
├─ eslint.config.js
├─ package.json                      ← 新スクリプト dev/build/preview/typecheck/lint/test:unit/quality
├─ public/
│  └─ assets/{mark.png, mark.svg, mark-512-dark.png, app-icon-mac-1024.png, integrations/}
├─ src/
│  ├─ main.tsx                       ← createRoot + <App/>
│  ├─ app/
│  │  └─ App.tsx                     ← 旧 hifi/app.jsx 全体（4829行のまま）
│  ├─ features/
│  │  └─ _legacy/                    ← Phase 2 で feature 配下に再配置するための一時隔離
│  │     ├─ screens-a.tsx            (4164)
│  │     ├─ screens-b.tsx            (716)
│  │     ├─ screens-c.tsx            (1501)
│  │     ├─ screens-agents.tsx       (1662)
│  │     ├─ screens-meetings.tsx     (3216)
│  │     ├─ screens-memory-debug.tsx (630)
│  │     ├─ screens-morning-brief.tsx (286)
│  │     └─ settings-modal.tsx       (4708)
│  └─ shared/
│     ├─ icons/{Icon.tsx, Kamon.tsx, IntegrationLogo.tsx, index.ts}
│     ├─ lib/{markdown-mini.ts, highlight.ts, brief-telemetry.ts, morning-brief.ts, meeting-media-recording.ts, meeting-note-local.ts, integration-connectors.ts, clerk-auth.ts, demo-seed.ts, keyboard-shortcuts.ts, legal-versions.ts, user-timezone.ts}
│     ├─ ipc/{ipc-client.ts, shogun-api.ts, action-registry.ts, runtime-actions.tsx}
│     ├─ modals/{confirm-write-modal.tsx, consent-modal.tsx}
│     └─ tokens/{tokens.css, app.css}
├─ src-tauri/
│  └─ tauri.conf.json                ← devUrl + beforeBuildCommand 更新（frontendDist は据え置き）
├─ scripts/
│  ├─ check-actions.py               ← hifi/scripts から移動、内部パス更新
│  ├─ check-ipc-mock-sync.mjs        ← 同上
│  └─ build-icons.mjs                ← 既存
├─ tools/
│  └─ amc-pipeline/                  ← hifi/amc-pipeline から移動、独立 package.json 維持
├─ tests/e2e/                        ← Playwright（Phase 0 で追加した4 spec含む）
├─ docs/
│  ├─ action-map.md                  ← hifi/ から移動
│  └─ hifi-legacy/                   ← hifi/docs から移動
├─ web-dist/                         ← Vite build 出力先（Tauri frontendDist 既存値を流用、gitignore）
└─ playwright.config.js              ← webServer を vite preview に変更
```

**Phase 1 終了時点で削除されるもの:**
- `hifi/`（中身は全て移動済）
- `SHOGUN Hi-Fi UI.html`
- `hifi/vendor/{react.development.js, react-dom.development.js, babel.min.js}`
- `scripts/sync-web-dist.mjs`（Vite の `build` で代替）

---

## 移行戦略上の重要な前提

1. **中間状態は壊れていてよい**: 各タスクの途中で `python3 -m http.server` 経由の旧 e2e は壊れる。**Task 16 まで e2e は走らせない**（Task 16 で `vite preview` 経由の Playwright に切替えた後に green を確認）。
2. **Tauri 実機ビルドも同様に Task 16 後にだけ確認する**: `npm run build:desktop` は Vite 設定切替後に動く。
3. **TypeScript エラーは Phase 1.5（Task 18）まで出してもよい**: `tsconfig.json` は `checkJs: false` で開始し、Phase 1 マージ直後に `true` に切替える別 PR で `@ts-expect-error` をマーキングする。
4. **互換シム必須**: 既存 e2e は `window.SHOGUN_RUNTIME`, `window.ShogunAPI`, `window.ShogunIpcClient`, `window.SHOGUN_LEGAL_VERSIONS`, `window.ShogunMorningBrief`, `window.ShogunIntegrationConnectors`, `window.ShogunUserTimezone`, `window.MeetingNoteLocal`, `window.ShogunActionRegistry`, `window.ShogunKeyboardShortcuts`, `window.shogunMarkdownMini`, `window.shogunBriefTelemetrySink` などを参照している。これらは ESM モジュール末尾で `if (typeof window !== 'undefined') { window.X = X; }` の形で**全て温存する**。
5. **画面ファイル `_legacy` は最小限の編集**: `/* global */` 削除、`import` 追加、`export` 付与、末尾の `window.X = X` 互換シム残し。**画面の中身（JSX 構造、ロジック）は1行も触らない**。

---

## Task 1: Vite + 開発依存をインストール

**Files:**
- Modify: `package.json`
- Create: `package-lock.json` の更新差分

**目的:** Vite 周辺パッケージを `devDependencies` に追加し、`npm scripts` を新ビルドフローに対応させる。ソースコードは触らない（旧 HTML はまだ動く）。

- [ ] **Step 1: 依存追加**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
npm install --save-dev \
  vite@^5 @vitejs/plugin-react@^4 \
  typescript@^5 @types/react@^18 @types/react-dom@^18 @types/node@^20 \
  eslint@^9 @typescript-eslint/parser@^7 @typescript-eslint/eslint-plugin@^7 \
  eslint-plugin-react@^7 eslint-plugin-react-hooks@^4 \
  eslint-plugin-import@^2 eslint-plugin-unused-imports@^4 \
  eslint-plugin-boundaries@^4 eslint-import-resolver-typescript@^3 \
  vitest@^2 @testing-library/react@^16 @testing-library/jest-dom@^6 jsdom@^25 \
  knip@^5 madge@^8 size-limit@^11 @size-limit/preset-app@^11 \
  prettier@^3
```

- [ ] **Step 2: ランタイムに React/ReactDOM を移動**

```bash
npm install react@^18 react-dom@^18
```

- [ ] **Step 3: package.json scripts を更新**

`package.json` の `"scripts"` セクションを以下に書き換える（既存の `tauri`, `dev:desktop`, `build:desktop`, `build:desktop:signed`, `test:e2e`, `test:e2e:ui`, `check:actions`, `check:ipc-mock`, `check:rust`, `test:rust`, `build:icons` は維持）：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --host 127.0.0.1",
    "build:web-dist": "vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings 0",
    "test:unit": "vitest run",
    "test:unit:watch": "vitest",
    "knip": "knip --no-progress",
    "cycles": "madge --circular --extensions ts,tsx src",
    "quality": "npm run typecheck && npm run lint && npm run cycles && npm run knip && npm run check:rust && npm run test:e2e",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "check:actions": "python3 scripts/check-actions.py",
    "check:ipc-mock": "node scripts/check-ipc-mock-sync.mjs",
    "check:rust": "cargo check --manifest-path src-tauri/Cargo.toml",
    "test:rust": "cargo test --manifest-path src-tauri/Cargo.toml --locked",
    "tauri": "tauri",
    "dev:desktop": "tauri dev",
    "build:desktop": "tauri build",
    "build:desktop:signed": "tauri build -c src-tauri/tauri.signing.local.json",
    "build:icons": "node scripts/build-icons.mjs"
  }
}
```

注: `check:actions` と `check:ipc-mock` のパスは Task 13 で `scripts/` 配下に移動した時点で有効になる。Phase 1 中は一時的にこれらが赤になっても OK（`quality` ターゲットは Task 17 で実行）。

- [ ] **Step 4: コミット**

```bash
git add package.json package-lock.json
git commit -m "chore(hifi): add Vite + TS + ESLint flat + Vitest deps for Phase 1"
```

---

## Task 2: 設定ファイル群を作成

**Files:**
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `eslint.config.js`
- Create: `.gitignore` への `web-dist/`, `dist/`, `node_modules/.vite/` 追記
- Modify: `.gitignore`

**目的:** Vite/TS/ESLint の設定を確定。この時点ではソースが無い（src/ 未作成）ので、ビルドは失敗する想定。中間状態である。

- [ ] **Step 1: vite.config.ts**

Create `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: '.',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'web-dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
```

- [ ] **Step 2: tsconfig.json**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
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
    "checkJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
    "types": ["vite/client"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "web-dist", "dist", "src-tauri", "tools/amc-pipeline"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: tsconfig.node.json**

Create `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "strict": true
  },
  "include": ["vite.config.ts", "playwright.config.js"]
}
```

- [ ] **Step 4: eslint.config.js (flat config)**

Create `eslint.config.js`:

```javascript
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import boundaries from 'eslint-plugin-boundaries';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        project: './tsconfig.json',
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // Tauri-injected globals
        __TAURI__: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react,
      'react-hooks': reactHooks,
      import: importPlugin,
      'unused-imports': unusedImports,
      boundaries,
    },
    settings: {
      react: { version: 'detect' },
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app/**' },
        { type: 'feature', pattern: 'src/features/*/**', capture: ['feature'] },
        { type: 'shared', pattern: 'src/shared/**' },
      ],
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'import/no-cycle': 'error',
      'import/no-self-import': 'error',
      'unused-imports/no-unused-imports': 'error',
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['hifi/**', '../../hifi/**'], message: 'hifi/ is removed in Phase 1; use src/ paths.' }]
      }],
      'max-lines': ['warn', { max: 800, skipBlankLines: true, skipComments: true }],
      // boundaries: warn for Phase 1, will be flipped to error in Phase 1.5
      'boundaries/element-types': ['warn', {
        default: 'allow',
        rules: [
          { from: 'shared', disallow: ['app', 'feature'] },
          { from: 'app', allow: ['feature', 'shared'] },
        ],
      }],
    },
  },
  {
    // _legacy/ files: relax max-lines until Phase 2 step 12
    files: ['src/features/_legacy/**'],
    rules: {
      'max-lines': 'off',
    },
  },
  {
    // tests
    files: ['tests/**/*.js', 'tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'max-lines': 'off',
    },
  },
  {
    ignores: ['web-dist/**', 'dist/**', 'node_modules/**', 'src-tauri/**', 'tools/amc-pipeline/**', 'hifi/**'],
  },
];
```

なお `globals` import は `import globals from 'globals';` を冒頭に追加する必要があるので、忘れず追加する。

- [ ] **Step 5: .gitignore 追記**

`.gitignore` の末尾に追加：

```
# Vite
web-dist/
dist/
.vite/
node_modules/.vite/

# Vitest
coverage/
```

- [ ] **Step 6: コミット**

```bash
git add vite.config.ts tsconfig.json tsconfig.node.json eslint.config.js .gitignore
git commit -m "chore(hifi): scaffold Vite + TS + ESLint flat config (Phase 1)"
```

検証は不要（src/ 未作成のため `npm run build` は失敗する）。

---

## Task 3: src/main.tsx と index.html を作成

**Files:**
- Create: `src/main.tsx`
- Create: `index.html`（ルート、旧 SHOGUN Hi-Fi UI.html とは別ファイル）

**目的:** Vite のエントリポイント。`src/main.tsx` は createRoot して `<App/>` をレンダリングするだけのスケルトン。`index.html` はフォント/CSS link を含む最小 SPA エントリ。

- [ ] **Step 1: src/main.tsx**

Create `src/main.tsx`:

```typescript
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import '@/shared/tokens/tokens.css';
import '@/shared/tokens/app.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

注: この時点では `@/app/App`、`@/shared/tokens/tokens.css`、`@/shared/tokens/app.css` のいずれも存在しない。`vite build` は失敗する想定（中間状態）。

- [ ] **Step 2: index.html**

Create `index.html`（リポジトリルート）:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Shogun AI · Hi-Fi UI</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="/assets/mark.png" type="image/png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Noto+Sans+JP:wght@300;400;500&family=JetBrains+Mono:wght@400;500&display=swap"
    rel="stylesheet"
  />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 3: コミット**

```bash
git add src/main.tsx index.html
git commit -m "feat(hifi): add Vite entry index.html + src/main.tsx (Phase 1)"
```

---

## Task 4: shared/icons を移行

**Files:**
- Create: `src/shared/icons/Icon.tsx`
- Create: `src/shared/icons/Kamon.tsx`
- Create: `src/shared/icons/IntegrationLogo.tsx`
- Create: `src/shared/icons/index.ts`
- Read (do not modify yet): `hifi/icons.jsx`, `hifi/integration-logos.jsx`

**目的:** Icon と Kamon は `hifi/icons.jsx` 内で `function Icon(...)` `function Kamon(...)` として定義され `window.Icon`/`window.Kamon` に export されている（実は `/* global Icon, Kamon */` 経由で他ファイルから参照される暗黙パターン）。これを `export` 関数に置換し、互換シムを残す。

- [ ] **Step 1: 内容確認**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
head -20 hifi/icons.jsx
grep -n "^function \|^const \|window\." hifi/icons.jsx | head
grep -n "^function \|^const \|window\." hifi/integration-logos.jsx | head
```

確認したいこと:
- `hifi/icons.jsx` のトップレベル宣言（`Icon`, `Kamon`, ヘルパ）
- `hifi/integration-logos.jsx` のトップレベル宣言（`IntegrationLogo` ほか）
- `window.X = X` の形でエクスポートされている全シンボル名

- [ ] **Step 2: src/shared/icons/Icon.tsx を作成**

`hifi/icons.jsx` の内容をベースに、`src/shared/icons/Icon.tsx` を作成。書き換えルール：
1. ファイル冒頭の `/* global Icon, Kamon, React */` を削除
2. ファイル冒頭に `import React from 'react';` を追加
3. `function Icon(...)` の前に `export` を付ける
4. ファイル末尾に互換シム `if (typeof window !== 'undefined') { window.Icon = Icon; }` を残す（旧コードがまだ window 経由で参照する可能性に備える）

具体的な書換は内容に依存するので、`hifi/icons.jsx` をそのままコピーして冒頭と末尾だけ修正する。

例（`hifi/icons.jsx` が以下の形だった場合）:

```javascript
/* global React */
function Icon({name, size = 18}) {
  // ...
}
function Kamon({size = 18}) {
  // ...
}
window.Icon = Icon;
window.Kamon = Kamon;
```

書換後（`src/shared/icons/Icon.tsx`）:

```typescript
import React from 'react';

export function Icon({name, size = 18}) {
  // ...（ロジックそのまま）
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).Icon = Icon;
}
```

`Kamon` も同じファイルに同居していたら、`src/shared/icons/Kamon.tsx` に分離する（1ファイル1コンポーネントに）。

- [ ] **Step 3: src/shared/icons/Kamon.tsx を作成**

`hifi/icons.jsx` から `Kamon` 関数を抜き出して別ファイルに。ヘルパ関数（`Kamon` 内部でだけ使われる）も同居させる。互換シム `window.Kamon = Kamon;` を末尾に。

- [ ] **Step 4: src/shared/icons/IntegrationLogo.tsx を作成**

`hifi/integration-logos.jsx` の内容を同様に変換。冒頭の `/* global Icon, Kamon, IntegrationLogo, React, ReactDOM */` を削除し `import React from 'react';` を追加、`Icon`/`Kamon` 参照は削除（このファイルは `IntegrationLogo` だけ使う前提だが、もし参照していれば `import { Icon } from './Icon';` を追加）。

- [ ] **Step 5: src/shared/icons/index.ts を作成**

```typescript
export { Icon } from './Icon';
export { Kamon } from './Kamon';
export { IntegrationLogo } from './IntegrationLogo';
```

- [ ] **Step 6: 部分検証（型チェックのみ）**

```bash
npx tsc --noEmit 2>&1 | grep -E "shared/icons" || echo "No icons errors"
```

期待: shared/icons 配下にエラーなし（他ファイルのエラーは別件として無視）。

- [ ] **Step 7: コミット**

```bash
git add src/shared/icons/
git commit -m "feat(hifi/shared): migrate icons to src/shared/icons/ (Phase 1)"
```

旧 `hifi/icons.jsx` と `hifi/integration-logos.jsx` は Task 16 でまとめて削除。Phase 1 の途中では残しておく（旧 HTML が参照している間は両立）。

---

## Task 5: shared/lib を移行

**Files:**
- Create: `src/shared/lib/{markdown-mini.ts, highlight.ts, brief-telemetry.ts, morning-brief.ts, meeting-media-recording.ts, meeting-note-local.ts, integration-connectors.ts, clerk-auth.ts, demo-seed.ts, keyboard-shortcuts.ts, legal-versions.ts, user-timezone.ts, index.ts}`
- Read: `hifi/lib/*.js`（13 ファイル）

**目的:** `hifi/lib/*.js` を ESM 化して `src/shared/lib/*.ts` にコピー。各ファイルは独立したモジュールとして export を付け、互換シム（`window.X = X`）は既存の e2e と画面ファイルが参照しているもののみ温存。

各ファイルのウインドウ公開シンボル:

| 旧ファイル | window 公開シンボル |
|---|---|
| `lib/markdown-mini.js` | `shogunMarkdownMini` |
| `lib/highlight.js` | （関数 export のみ、window 公開なし） |
| `lib/brief-telemetry.js` | `BriefTelemetry`, `shogunBriefTelemetrySink` |
| `lib/morning-brief.js` | `ShogunMorningBrief` |
| `lib/meeting-media-recording.js` | `MeetingMediaRecording` |
| `lib/meeting-note-local.js` | `MeetingNoteLocal` |
| `lib/integration-connectors.js` | `ShogunIntegrationConnectors` |
| `lib/clerk-auth.js` | `ShogunClerkAuth` |
| `lib/demo-seed.js` | `SHOGUN_DEMO_SEED` |
| `lib/keyboard-shortcuts.js` | `ShogunKeyboardShortcuts` |
| `lib/legal-versions.js` | `SHOGUN_LEGAL_VERSIONS` |
| `lib/user-timezone.js` | `ShogunUserTimezone` |

ファイル数が多いので、各ファイルを個別タスクではなく1タスクで処理する。実装者は各ファイルに対して以下のルーチンを順に適用する。

- [ ] **Step 1: 全 13 ファイルを一括コピー（拡張子のみ変更）**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
mkdir -p src/shared/lib

for NAME in markdown-mini highlight brief-telemetry morning-brief \
            meeting-media-recording meeting-note-local integration-connectors \
            clerk-auth demo-seed keyboard-shortcuts legal-versions user-timezone; do
  cp "hifi/lib/${NAME}.js" "src/shared/lib/${NAME}.ts"
done

ls src/shared/lib/  # 12 .ts files (highlight.js は実は他のと同じパターン、計13想定だが12が正)
```

ファイル数: 12 ファイル（`hifi/lib/` 15 ファイルから IPC 系 3 — `ipc-client.js`, `shogun-api.js`, `action-registry.js` — を除いた残り。それらは Task 6 で `shared/ipc/` に行く）。実際の数は `ls hifi/lib/ | wc -l` で確認すること。

- [ ] **Step 2: 各 `.ts` ファイルへの機械的書換**

各 `src/shared/lib/<name>.ts` に対して以下を順に適用（テキストエディタまたは `sed` で）：

   1. **冒頭の `/* global ... */` を削除**
   2. **依存があれば `import` を追加**（ほとんどのファイルは外部依存なし、ブラウザ API の `localStorage`, `Intl` 等は global 扱いで OK）
   3. **トップレベルの `function`/`const`/`let`/`var` で他ファイルから参照されるものに `export` を付与**：上の表の「window 公開シンボル」が export 対象
   4. **末尾の `window.X = X` を以下の互換シム形式に書換**（残す）:
      ```typescript
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).X = X;
      }
      ```
   5. 型注釈は最小限のみ追加（型エラーは Phase 1.5 で潰すので `checkJs:false` の現時点では無視）

各ファイルの書換ルール:

1. **`/* global X, Y */` を削除**して、参照しているシンボルが他のファイルから来ているなら `import { X } from '@/shared/icons'` などを追加する
2. **トップレベル関数 / const に `export` を付与**: 他ファイルが `/* global X */` で参照していたものが対象（上の表の「window 公開シンボル」を含む）
3. **末尾の互換シム**: `window.X = X` 形式の代入を `if (typeof window !== 'undefined') { (window as unknown as Record<string, unknown>).X = X; }` に書換

例（`hifi/lib/markdown-mini.js` → `src/shared/lib/markdown-mini.ts`）:

旧:
```javascript
function shogunMarkdownMini(text) {
  // ...
}
window.shogunMarkdownMini = shogunMarkdownMini;
```

新:
```typescript
export function shogunMarkdownMini(text: string): string {
  // ...（ロジックそのまま、戻り値型は最小限）
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).shogunMarkdownMini = shogunMarkdownMini;
}
```

- [ ] **Step 2: src/shared/lib/index.ts**

Create `src/shared/lib/index.ts`:

```typescript
export * from './markdown-mini';
export * from './highlight';
export * from './brief-telemetry';
export * from './morning-brief';
export * from './meeting-media-recording';
export * from './meeting-note-local';
export * from './integration-connectors';
export * from './clerk-auth';
export * from './demo-seed';
export * from './keyboard-shortcuts';
export * from './legal-versions';
export * from './user-timezone';
```

- [ ] **Step 3: 部分検証**

```bash
ls src/shared/lib/  # 13 .ts ファイル + index.ts の合計14ファイル
npx tsc --noEmit 2>&1 | grep -E "shared/lib" | head -10  # 型エラーが何件か出るのは想定内
```

- [ ] **Step 4: コミット**

```bash
git add src/shared/lib/
git commit -m "feat(hifi/shared): migrate lib/* helpers to src/shared/lib/ (Phase 1)"
```

---

## Task 6: shared/ipc を移行

**Files:**
- Create: `src/shared/ipc/ipc-client.ts`
- Create: `src/shared/ipc/shogun-api.ts`
- Create: `src/shared/ipc/action-registry.ts`
- Create: `src/shared/ipc/runtime-actions.tsx`
- Create: `src/shared/ipc/index.ts`
- Read: `hifi/lib/{ipc-client,shogun-api,action-registry}.js`, `hifi/runtime-actions.jsx`

**目的:** IPC 系は他ファイルから多数参照されるので独立した shared/ipc/ に集約。ロジックは1行も変えず、ESM の export と互換シムだけを追加する。

各ファイルの window 公開シンボル:

| 旧 | window 公開 |
|---|---|
| `lib/ipc-client.js` | `ShogunIpcClient` |
| `lib/shogun-api.js` | `ShogunAPI` |
| `lib/action-registry.js` | `ShogunActionRegistry`, `SHOGUN_RUNTIME` |
| `runtime-actions.jsx` | （runtime side effects のみ、window 直書きなし／action-registry に depend） |

- [ ] **Step 1: ipc-client.ts**

`hifi/lib/ipc-client.js` をコピーして書換：

```bash
cp hifi/lib/ipc-client.js src/shared/ipc/ipc-client.ts
```

書換：
- `/* global */` 注釈を削除
- ファイル冒頭で必要な依存を import（このファイルは外部依存少なめ）
- `function createIpcClient(...)` の前に `export` を付与
- `window.ShogunIpcClient = { createIpcClient, ... }` 等を末尾で互換シムに

- [ ] **Step 2: shogun-api.ts**

```bash
cp hifi/lib/shogun-api.js src/shared/ipc/shogun-api.ts
```

書換：
- `/* global ShogunIpcClient */` を削除し `import { ShogunIpcClient } from './ipc-client';`（または該当 API）を追加
- `function createApi(...)` 等に `export` 付与
- `window.ShogunAPI = ...` の互換シムを末尾に

- [ ] **Step 3: action-registry.ts**

```bash
cp hifi/lib/action-registry.js src/shared/ipc/action-registry.ts
```

書換：
- `/* global ShogunAPI, BriefTelemetry, ... */` を削除し対応する `import` を追加
- 末尾で `window.ShogunActionRegistry`、`window.SHOGUN_RUNTIME` の両方を互換シムとして残す（`window.SHOGUN_RUNTIME` は Phase 0 e2e がフックしている重要 API）

- [ ] **Step 4: runtime-actions.tsx**

```bash
cp hifi/runtime-actions.jsx src/shared/ipc/runtime-actions.tsx
```

書換：
- `/* global Icon, React, BriefTelemetry */` を削除
- `import React from 'react';` 追加、`import { Icon } from '@/shared/icons';` 追加、`import { BriefTelemetry } from '@/shared/lib';` 追加
- トップレベル宣言に `export` 付与

- [ ] **Step 5: src/shared/ipc/index.ts**

```typescript
export * from './ipc-client';
export * from './shogun-api';
export * from './action-registry';
export * from './runtime-actions';
```

- [ ] **Step 6: コミット**

```bash
git add src/shared/ipc/
git commit -m "feat(hifi/shared): migrate IPC layer to src/shared/ipc/ (Phase 1)"
```

---

## Task 7: shared/modals を移行

**Files:**
- Create: `src/shared/modals/ConfirmWriteModal.tsx`
- Create: `src/shared/modals/ConsentModal.tsx`
- Create: `src/shared/modals/index.ts`
- Read: `hifi/components/{confirm-write-modal,consent-modal}.jsx`

- [ ] **Step 1: ConfirmWriteModal.tsx**

```bash
cp hifi/components/confirm-write-modal.jsx src/shared/modals/ConfirmWriteModal.tsx
```

書換：
- `/* global React, Icon */` を削除し `import React from 'react'; import { Icon } from '@/shared/icons';`
- `function ConfirmWriteModal(...)` に `export` 付与
- 末尾に `window.ConfirmWriteModal = ConfirmWriteModal;` 互換シム

- [ ] **Step 2: ConsentModal.tsx**

```bash
cp hifi/components/consent-modal.jsx src/shared/modals/ConsentModal.tsx
```

書換：
- 同様パターン
- `import` する依存（`Icon`, `Kamon`, markdown helper など）を spec 通りに追加
- 互換シム

- [ ] **Step 3: index.ts**

```typescript
export { ConfirmWriteModal } from './ConfirmWriteModal';
export { ConsentModal } from './ConsentModal';
```

- [ ] **Step 4: コミット**

```bash
git add src/shared/modals/
git commit -m "feat(hifi/shared): migrate modals to src/shared/modals/ (Phase 1)"
```

---

## Task 8: 画面ファイルを src/features/_legacy/ に移動

**Files:**
- Create: `src/features/_legacy/{screens-a,screens-b,screens-c,screens-agents,screens-meetings,screens-memory-debug,screens-morning-brief,settings-modal}.tsx`
- Read: `hifi/{screens-*.jsx, settings-modal.jsx}`

**目的:** 巨大な画面ファイルを Vite で扱える ESM 形式に変換するが、**中身は1行も触らない**（feature 分割は Phase 2）。書換は冒頭の globals→imports + トップレベル関数の export + 末尾の互換シムのみ。

- [ ] **Step 1: 8 ファイルを順に変換**

各ファイルに対して以下を適用：

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
mkdir -p src/features/_legacy

# screens-a.jsx (4164 行)
cp hifi/screens-a.jsx src/features/_legacy/screens-a.tsx
# screens-b.jsx (716 行)
cp hifi/screens-b.jsx src/features/_legacy/screens-b.tsx
# screens-c.jsx (1501 行)
cp hifi/screens-c.jsx src/features/_legacy/screens-c.tsx
# screens-agents.jsx (1662 行)
cp hifi/screens-agents.jsx src/features/_legacy/screens-agents.tsx
# screens-meetings.jsx (3216 行)
cp hifi/screens-meetings.jsx src/features/_legacy/screens-meetings.tsx
# screens-memory-debug.jsx (630 行)
cp hifi/screens-memory-debug.jsx src/features/_legacy/screens-memory-debug.tsx
# screens-morning-brief.jsx (286 行)
cp hifi/screens-morning-brief.jsx src/features/_legacy/screens-morning-brief.tsx
# settings-modal.jsx (4708 行)
cp hifi/settings-modal.jsx src/features/_legacy/settings-modal.tsx
```

各 `.tsx` ファイルに対して以下の機械的書換を適用（**中身ロジック不変**）：

1. **冒頭の `/* global ... */` 注釈を削除**
2. **冒頭に必要な import を追加**：
   - 全ファイルで: `import React from 'react';`
   - `React` 以外で `/* global */` が参照していたシンボルに対応：
     - `Icon`, `Kamon`, `IntegrationLogo` → `import { Icon, Kamon, IntegrationLogo } from '@/shared/icons';`
     - `ReactDOM` → `import * as ReactDOM from 'react-dom';`
     - `BriefTelemetry`, `MeetingNoteLocal`, `ShogunIntegrationConnectors`, `ShogunUserTimezone`, `ShogunKeyboardShortcuts`, `shogunMarkdownMini` 等 → `import { BriefTelemetry, MeetingNoteLocal, ... } from '@/shared/lib';`
     - `ShogunIpcClient`, `ShogunAPI`, `ShogunActionRegistry` 等 → `import { ShogunIpcClient, ShogunAPI, ShogunActionRegistry } from '@/shared/ipc';`
3. **トップレベル `function ScreenX()` 等に `export` を付与**：他ファイルが `window.ScreenX` 経由で参照しているもの全て
4. **末尾の `window.X = X;` を互換シム形式に置換**：
   ```typescript
   if (typeof window !== 'undefined') {
     (window as unknown as Record<string, unknown>).ScreenX = ScreenX;
   }
   ```

- [ ] **Step 2: src/features/_legacy/index.ts**

Create `src/features/_legacy/index.ts`:

```typescript
export { ScreenHome, ScreenMemory } from './screens-a';
export { ScreenChat } from './screens-b';
export { ScreenWork, ScreenCapture, ScreenIntegrations, ScreenSettings } from './screens-c';
export { ScreenAgents } from './screens-agents';
export { ScreenMeetings } from './screens-meetings';
export { ScreenMemoryDebug } from './screens-memory-debug';
// screens-morning-brief.tsx exports its component(s) — verify by reading the file
// and re-export here.
// settings-modal.tsx exports SettingsModal.
export { SettingsModal } from './settings-modal';
```

注: `screens-morning-brief.tsx` の export 名はファイル本文を読んで確定（`function MorningBrief...` のような名前）。

- [ ] **Step 3: 部分検証**

```bash
npx tsc --noEmit 2>&1 | grep -cE "_legacy" || echo "OK"
```

`checkJs: false` なので `.tsx` は型チェックされる。型エラー多数（`any`、`undefined` 比較、未定義 prop など）が出るが、ロジックは正しいので Phase 1.5 で `@ts-expect-error` をつけて先送り。**今は数を確認するだけ**で先に進む。

- [ ] **Step 4: コミット**

```bash
git add src/features/_legacy/
git commit -m "feat(hifi/_legacy): move screens to src/features/_legacy/ with ESM imports (Phase 1)"
```

---

## Task 9: src/app/App.tsx に旧 app.jsx を移行

**Files:**
- Create: `src/app/App.tsx`
- Read: `hifi/app.jsx`（4829 行）

**目的:** 旧 `hifi/app.jsx` の中身全体を `src/app/App.tsx` に移動。冒頭の globals→imports と `App` 関数（または `MainApp` か他のメイン関数名）の `export` 付与のみ。中身ロジックは不変。

- [ ] **Step 1: 既存ファイルの構造を確認**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
head -3 hifi/app.jsx
grep -n "^function App\|^function MainApp\|^const App\|^const MainApp" hifi/app.jsx
grep -n "ReactDOM.render\|createRoot" hifi/app.jsx
```

`hifi/app.jsx` のメイン関数名を確認（`App` なのか `MainApp` なのか、どちらが createRoot 対象か）。

- [ ] **Step 2: コピー**

```bash
mkdir -p src/app
cp hifi/app.jsx src/app/App.tsx
```

- [ ] **Step 3: 機械的書換**

`src/app/App.tsx` に対して：

1. 冒頭の `/* global Icon, Kamon, React, ReactDOM, ScreenHome, ScreenMemory, ScreenChat, ScreenAgents, ScreenWork, ScreenMeetings, ScreenMemoryDebug, SettingsModal, ConfirmWriteModal, ConsentModal, ShogunIpcClient, ShogunAPI, ShogunActionRegistry, ShogunKeyboardShortcuts, shogunMarkdownMini */` を削除

2. 以下の import を追加（実際に参照されているシンボルに合わせて取捨選択）:

```typescript
import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import * as ReactDOM from 'react-dom';
import { Icon, Kamon } from '@/shared/icons';
import {
  ScreenHome,
  ScreenMemory,
  ScreenChat,
  ScreenAgents,
  ScreenWork,
  ScreenMeetings,
  ScreenMemoryDebug,
  ScreenCapture,
  ScreenIntegrations,
  ScreenSettings,
  SettingsModal,
} from '@/features/_legacy';
import { ConfirmWriteModal, ConsentModal } from '@/shared/modals';
import {
  ShogunIpcClient,
  ShogunAPI,
  ShogunActionRegistry,
} from '@/shared/ipc';
import {
  ShogunKeyboardShortcuts,
  shogunMarkdownMini,
} from '@/shared/lib';
```

3. 元の `function MainApp()` または `function App()` を見つけて `export` を付与:

```typescript
export function App() {  // または export function MainApp()
  // ...
}
```

メイン関数の名前が `MainApp` の場合、export 名を統一するため最終行に
```typescript
export { MainApp as App };
```
を追加するか、`src/main.tsx` の import を `MainApp` に変更する（より単純）。

4. 元の `ReactDOM.render(<App/>, document.getElementById('root'));` または同等の起動コードを**削除**（main.tsx が代替）

- [ ] **Step 4: 部分検証**

```bash
npx tsc --noEmit 2>&1 | grep -cE "app/App" || echo "OK"
```

エラー数を記録（Phase 1.5 用）。

- [ ] **Step 5: コミット**

```bash
git add src/app/
git commit -m "feat(hifi/app): migrate root App.tsx with ESM imports (Phase 1)"
```

---

## Task 10: CSS を src/shared/tokens/ に移動

**Files:**
- Create: `src/shared/tokens/tokens.css`
- Create: `src/shared/tokens/app.css`
- Read: `hifi/tokens.css`, `hifi/app.css`

- [ ] **Step 1: 移動**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
mkdir -p src/shared/tokens
cp hifi/tokens.css src/shared/tokens/tokens.css
cp hifi/app.css src/shared/tokens/app.css
```

CSS 内容は無修正（imports や url() があれば、相対パスを Vite が解決できる形に調整）。具体的には:

```bash
grep -E 'url\(|@import' src/shared/tokens/tokens.css src/shared/tokens/app.css
```

`url('./assets/...')` のような相対参照があれば、Task 11 で `public/` 配下に移すアセットへ向かうので、`url('/assets/...')`（先頭スラッシュで public ルート参照）に書換える必要がある。

- [ ] **Step 2: コミット**

```bash
git add src/shared/tokens/
git commit -m "feat(hifi/shared): move CSS to src/shared/tokens/ (Phase 1)"
```

---

## Task 11: 静的アセットを public/ に移動

**Files:**
- Move: `hifi/assets/*` → `public/assets/*`
- Read: `hifi/assets/`

- [ ] **Step 1: 移動**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
mkdir -p public/assets
git mv hifi/assets/mark.png public/assets/mark.png
git mv hifi/assets/mark.svg public/assets/mark.svg
git mv hifi/assets/mark-512-dark.png public/assets/mark-512-dark.png
git mv hifi/assets/app-icon-mac-1024.png public/assets/app-icon-mac-1024.png
git mv hifi/assets/integrations public/assets/integrations
```

- [ ] **Step 2: 参照箇所を更新**

```bash
grep -rn "hifi/assets" --include="*.tsx" --include="*.ts" --include="*.css" --include="*.html" --include="*.json" src/ index.html src-tauri/tauri.conf.json 2>/dev/null
```

検出された参照を `/assets/` に書換える（先頭スラッシュは Vite の public/ ルート）。`index.html` の favicon は既に Task 3 で `/assets/mark.png` 指定済みなので OK。

`src-tauri/tauri.conf.json` の `beforeBuildCommand` 中の `npx tauri icon hifi/assets/app-icon-mac-1024.png` を `npx tauri icon public/assets/app-icon-mac-1024.png` に書換。

- [ ] **Step 3: コミット**

```bash
git add public/ src-tauri/tauri.conf.json
git commit -m "feat(hifi): move static assets to public/assets/ (Phase 1)"
```

---

## Task 12: scripts/ と docs/ を整理

**Files:**
- Move: `hifi/scripts/check-actions.py` → `scripts/check-actions.py`
- Move: `hifi/scripts/check-ipc-mock-sync.mjs` → `scripts/check-ipc-mock-sync.mjs`
- Move: `hifi/action-map.md` → `docs/action-map.md`
- Move: `hifi/docs/*` → `docs/hifi-legacy/*`
- Move: `hifi/schemas/*` → `src/shared/schemas/*`
- Move: `hifi/preview-home*.jpg` → `docs/screenshots/`（または削除）
- Move: `hifi/README.md` の有用部分をルート README に統合（または削除）
- Modify: 移動した script の内部パス

- [ ] **Step 1: ファイル移動**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
git mv hifi/scripts/check-actions.py scripts/check-actions.py
git mv hifi/scripts/check-ipc-mock-sync.mjs scripts/check-ipc-mock-sync.mjs
git mv hifi/action-map.md docs/action-map.md
mkdir -p docs/hifi-legacy
git mv hifi/docs/* docs/hifi-legacy/
mkdir -p src/shared/schemas
git mv hifi/schemas/* src/shared/schemas/
mkdir -p docs/screenshots/legacy-previews
git mv hifi/preview-home.jpg docs/screenshots/legacy-previews/preview-home.jpg
git mv hifi/preview-home2.jpg docs/screenshots/legacy-previews/preview-home2.jpg
git mv hifi/preview-home3.jpg docs/screenshots/legacy-previews/preview-home3.jpg
git rm hifi/README.md
git rm hifi/_fix_recipes.py
```

- [ ] **Step 2: スクリプト内部パス更新**

```bash
grep -n "hifi/" scripts/check-actions.py scripts/check-ipc-mock-sync.mjs
```

`hifi/screens-*.jsx` 等への参照を `src/features/_legacy/*.tsx` 等に書換える。`action-map.md` への相対パスも `docs/action-map.md` に更新。

- [ ] **Step 3: コミット**

```bash
git add scripts/ docs/ src/shared/schemas/
git commit -m "feat(hifi): relocate scripts/docs/schemas to repo-root structure (Phase 1)"
```

---

## Task 13: tools/amc-pipeline/ を移動

**Files:**
- Move: `hifi/amc-pipeline/` → `tools/amc-pipeline/`

- [ ] **Step 1: 移動**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
mkdir -p tools
git mv hifi/amc-pipeline tools/amc-pipeline
```

- [ ] **Step 2: 参照確認**

```bash
grep -rn "hifi/amc-pipeline" --include="*.json" --include="*.md" .
```

検出された参照を `tools/amc-pipeline` に書換える（`tools/amc-pipeline/README.md` は内部相対パスで完結している想定だが、念のため確認）。

- [ ] **Step 3: コミット**

```bash
git add tools/ hifi/
git commit -m "feat(hifi): move amc-pipeline to tools/amc-pipeline (Phase 1)"
```

---

## Task 14: Tauri 設定 + Playwright 設定 + sync-web-dist 削除

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `playwright.config.js`
- Delete: `scripts/sync-web-dist.mjs`

- [ ] **Step 1: tauri.conf.json**

`src-tauri/tauri.conf.json` の `build` セクションを編集：

旧:
```json
"build": {
  "frontendDist": "../web-dist",
  "beforeBuildCommand": "npm run build:web-dist && npx tauri icon hifi/assets/app-icon-mac-1024.png"
}
```

新:
```json
"build": {
  "frontendDist": "../web-dist",
  "devUrl": "http://localhost:5173",
  "beforeDevCommand": "npm run dev",
  "beforeBuildCommand": "npm run build:web-dist && npx tauri icon ../public/assets/app-icon-mac-1024.png"
}
```

`frontendDist` は据え置き（Vite outDir = `web-dist`）、`devUrl` 追加で `tauri dev` が Vite dev server に繋がる、`beforeBuildCommand` のアイコンパスを更新。

- [ ] **Step 2: playwright.config.js**

`playwright.config.js` の `webServer` セクションを編集：

旧:
```javascript
webServer: {
  command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
  cwd: path.join(ROOT),
  url: BASE_URL,
  reuseExistingServer: !process.env.CI,
  timeout: 120000,
},
```

新:
```javascript
webServer: {
  command: `npm run preview -- --port ${PORT} --strictPort`,
  cwd: path.join(ROOT),
  url: BASE_URL,
  reuseExistingServer: !process.env.CI,
  timeout: 180000,
},
```

タイムアウトは Vite preview が初回ビルドする可能性があるので 180 秒に伸ばしてもよい。

注: `vite preview` は `web-dist/` を提供するので、playwright e2e 実行前に `npm run build` が走っていないとサーバが立ち上がらない。`webServer.command` 側で `npm run build && npm run preview ...` にチェーンするか、CI で事前 build する。簡便な解決として：

```javascript
webServer: {
  command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
  ...
}
```

- [ ] **Step 3: sync-web-dist.mjs を削除**

```bash
git rm scripts/sync-web-dist.mjs
```

`package.json` の `build:web-dist` は Task 1 で既に `vite build` に置換済みなのでそのまま。

- [ ] **Step 4: e2e specs の HIFI_ENTRY を更新**

各 e2e spec で `const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";` を `const HIFI_ENTRY = "/";` に書換える（Vite が `index.html` をルートで提供するため）。

```bash
grep -l "SHOGUN%20Hi-Fi%20UI.html" tests/e2e/
# 結果のファイル全てに対して sed 置換
sed -i.bak 's|/SHOGUN%20Hi-Fi%20UI\.html|/|g' tests/e2e/*.spec.js tests/e2e/_helpers/*.js
rm tests/e2e/*.bak tests/e2e/_helpers/*.bak 2>/dev/null
```

- [ ] **Step 5: コミット**

```bash
git add src-tauri/tauri.conf.json playwright.config.js scripts/ tests/e2e/
git commit -m "chore(hifi): switch Tauri+Playwright to Vite preview entrypoint (Phase 1)"
```

---

## Task 15: 旧 hifi/ と SHOGUN Hi-Fi UI.html を削除

**Files:**
- Delete: `hifi/` 全体（残存物）
- Delete: `SHOGUN Hi-Fi UI.html`
- Delete: `app.jsx`（リポジトリルートにある古いファイル、もし残っていれば）
- Delete: `styles.css`（リポジトリルートにある古いファイル、もし残っていれば）

- [ ] **Step 1: 残存ファイルの確認**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
ls hifi/  # 何が残っているか確認
```

- [ ] **Step 2: 削除**

```bash
git rm -r hifi/
git rm "SHOGUN Hi-Fi UI.html"
git rm "SHOGUN AI Wireframes.html" 2>/dev/null || true
git rm app.jsx 2>/dev/null || true
git rm styles.css 2>/dev/null || true
```

- [ ] **Step 3: コミット**

```bash
git commit -m "chore(hifi): remove legacy hifi/ + SHOGUN Hi-Fi UI.html (Phase 1 cutover)"
```

---

## Task 16: Vite ビルドと Playwright suite を確認

**Files:**
- なし（実行のみ）

- [ ] **Step 1: 依存再インストール（念のため）**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
npm ci
```

- [ ] **Step 2: Vite build**

```bash
npm run build 2>&1 | tail -30
```

期待: `web-dist/` が生成される。エラーが出る場合：
- 主な原因：未解決の import、CSS の url() の相対パス、JSX 構文エラー
- エラーメッセージのパスから該当ファイルを修正
- 修正したらコミット（Task 単位の細かい修正は本 Task に集約）

- [ ] **Step 3: Vite preview**

```bash
npm run preview &
sleep 3
curl -s http://127.0.0.1:4173/ | head -20
kill %1
```

`<div id="root"></div>` を含む HTML が返ってくることを確認。

- [ ] **Step 4: Playwright e2e**

```bash
npx playwright test --reporter=list 2>&1 | tail -20
```

期待: 56 tests passed（Phase 0 で確立したベースライン）。

失敗した場合：
- セレクタ系の失敗 → 旧 selector が ESM 化で変わった可能性は無いはずなので、互換シムが正しく書けているか確認（`window.SHOGUN_RUNTIME` 等が露出しているか）
- ロード系の失敗 → `index.html` から `src/main.tsx` 経由のロードが正しいか、Vite preview が `web-dist/` を提供しているか
- IPC モック系の失敗 → `src/shared/ipc/ipc-client.ts` が `mockTransport` を含み、`window.ShogunIpcClient` が露出されているか

- [ ] **Step 5: TypeScript エラー数を記録**

```bash
npm run typecheck 2>&1 | tee typecheck-phase1.log | tail -30
echo "Total errors: $(grep -c 'error TS' typecheck-phase1.log)"
```

エラー数（数百〜千件規模を想定）は Phase 1.5 の追跡対象として PR 説明に記載。

- [ ] **Step 6: コミット（修正があれば）**

修正があれば：
```bash
git add -A
git commit -m "fix(hifi): resolve Phase 1 build/runtime issues from full verification"
```

---

## Task 17: Tauri 実機 smoke ビルド（手動確認）

**Files:**
- なし（実行のみ）

- [ ] **Step 1: 未署名ビルド**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
npm run build:desktop 2>&1 | tail -20
```

期待: `src-tauri/target/release/bundle/macos/SHOGUN AI.app` が生成される。

- [ ] **Step 2: 起動して目視確認**

```bash
open "src-tauri/target/release/bundle/macos/SHOGUN AI.app"
```

確認項目:
- Home / Memory / Chat / Agents / Work / Meetings の各画面が描画される
- Settings の主要タブが開く
- IPC（mock 経由ではなく Rust 経由）が動く（メモリ検索、保存など）
- コンソールにエラーが出ていない（DevTools で確認）

- [ ] **Step 3: スクリーンショット撮影**

Phase 0 で skip したベースラインがここで取れる。各画面を撮影して `docs/screenshots/post-vite/` に保存（Phase 0 ベースラインが無い場合は post-vite だけでも OK）。

- [ ] **Step 4: 結果を PR 説明に追記**

PR 説明（draft #59 とは別の Phase 1 PR）に「Tauri 実機で全画面描画 OK」とスクショ付きで記載。

- [ ] **Step 5: コミット（スクショ）**

```bash
git add docs/screenshots/post-vite/
git commit -m "docs(hifi): add post-Vite Tauri smoke screenshots (Phase 1)"
```

---

## Task 18: Phase 1.5 — checkJs 有効化

**Files:**
- Modify: `tsconfig.json`
- Modify: 全 `.tsx`/`.ts` ファイルへの `// @ts-expect-error TODO(phase2): <feature>` マーキング

**目的:** `tsconfig.json` の `checkJs` を `true` に切替え、出てきた型エラーを `@ts-expect-error` でマーク。Phase 2 各 feature PR の DoD に「自 feature 内の `@ts-expect-error` 全消去」を含めて追跡。

- [ ] **Step 1: tsconfig 切替**

`tsconfig.json` の `"checkJs": false` を `"checkJs": true` に変更。

- [ ] **Step 2: 型エラー集計**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
npm run typecheck 2>&1 | tee typecheck-phase1-5.log
ERROR_COUNT=$(grep -c 'error TS' typecheck-phase1-5.log)
echo "Errors to mark: $ERROR_COUNT"
```

- [ ] **Step 3: 戦略 A — `_legacy/` と `app/App.tsx` に `@ts-nocheck` ファイルヘッダを一括投入**

`_legacy/` 配下のファイルは「Phase 2 で feature 別に分解する一時隔離場所」なので、TypeScript 検査を完全に止める扱いが妥当。粒度は粗いが Phase 2 進行で feature 単位に分解された時点で `@ts-nocheck` を順次外していく流れになる。

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
for FILE in src/features/_legacy/*.tsx src/app/App.tsx; do
  # 既に @ts-nocheck がついていたらスキップ
  if grep -q "@ts-nocheck" "$FILE"; then continue; fi
  # ファイル冒頭に挿入
  TMP=$(mktemp)
  echo "// @ts-nocheck TODO(phase2): split into features/<name>/ and remove this directive" > "$TMP"
  cat "$FILE" >> "$TMP"
  mv "$TMP" "$FILE"
done
```

各 feature を Phase 2 で分解する PR で `@ts-nocheck` ヘッダを除去し、必要なら個別行に `@ts-expect-error` を付け直す。

- [ ] **Step 4: 戦略 B — `shared/` 配下は個別に `@ts-expect-error`**

`shared/` 配下は Phase 1 で初めて TS 化したばかりなのでエラー数は限定的（〜数十件想定）。各エラーに対して、エラー行の直前に以下のコメントを手動挿入：

```typescript
// @ts-expect-error TODO(phase2): typing for shared/lib/<file>
```

`<file>` には対象ファイル名を入れる（後で grep して残数を追跡できるように）。

実装者は `npm run typecheck` の出力を見て、ファイル名と行番号を頼りにエディタで一件ずつマークする。エラーが 30 件以下であれば 1〜2 時間の作業。30 件超なら戦略 A と同様に `// @ts-nocheck` 戦略をファイル単位で適用してもよいが、`shared/` の TS 品質は早めに上げたいので可能な限り個別マークが望ましい。

- [ ] **Step 5: 検証**

```bash
npm run typecheck 2>&1 | tail -5
```

エラーゼロを確認。`@ts-expect-error` は使われている前提なので、未使用警告（`error TS2578: Unused @ts-expect-error directive`）が出る場合は該当行を削除。

- [ ] **Step 6: コミット**

```bash
git add tsconfig.json src/
git commit -m "chore(hifi): enable checkJs + mark Phase 2 type-debt with @ts-expect-error/@ts-nocheck"
```

これは Phase 1 PR の最終コミット（または Phase 1.5 の独立 PR にするか、Phase 1 PR 取り込みのオプション）。

---

## Task 19: Phase 1 PR を作成

**Files:**
- なし

- [ ] **Step 1: ブランチ push**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
git push -u origin feat/hifi-vite-migration
```

(新ブランチ前提。元の `docs/hifi-jsx-split-design` ブランチで作業していた場合は、Phase 1 を同じブランチに乗せるか、新ブランチに分けるかを実行者が判断。本計画は新ブランチを推奨。)

- [ ] **Step 2: PR 作成**

```bash
gh pr create --title "Hi-Fi JSX 分割 Phase 1: Vite + ESM 化（論理変更ゼロ）" --body "$(cat <<'EOF'
## Summary

22K 行の Babel-in-browser JSX 群を Vite + ESM へ移行。**論理コードは1行も変更していない**（`/* global */` → `import` の機械的置換、`export` 付与、互換シム残し、ファイル移動・拡張子変更のみ）。

## 主要変更

- `hifi/` → `src/{app, features/_legacy, shared/{icons,lib,ipc,modals,tokens}}` への再配置
- ビルドステップ追加: Vite + esbuild（Babel-in-browser 廃止）
- TypeScript 導入（`strict + allowJs`、Phase 1.5 で `checkJs: true` 有効化済み）
- ESLint flat config + `boundaries` プラグイン（warn 段階、Phase 2 で error 化）
- Tauri 設定: `frontendDist` 据え置き、`devUrl` 追加、`beforeBuildCommand` パス更新
- Playwright: `vite preview` 経由に切替

## 検証

- [x] `npm run build` green
- [x] `npm run preview` で `index.html` 配信確認
- [x] `npx playwright test` 56/56 passed
- [x] `npm run build:desktop` で .app 起動、全画面描画 OK（スクショ docs/screenshots/post-vite/）
- [x] `npm run typecheck` エラーゼロ（`@ts-expect-error TODO(phase2):` マーク済）
- [x] `npm run lint --max-warnings 0` 通過
- [x] `npm run cycles` 循環参照ゼロ

## 残タスク

- Phase 2 各 feature PR の DoD に「対応 feature 内の `@ts-expect-error` 全消去」を含めて追跡
- `_legacy/` ディレクトリは Phase 2 step 12 で削除予定

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase 1 完了の定義（DoD）

- 旧 `hifi/` ディレクトリと `SHOGUN Hi-Fi UI.html` が消えている
- `src/` 配下のディレクトリ構造が設計書通り
- `npm run build` green、`web-dist/` が生成される
- `npx playwright test` 56/56 green（Phase 0 と同じ数）
- `npm run typecheck` エラーゼロ（`@ts-expect-error` 込み）
- `npm run lint --max-warnings 0` 通過
- `npm run cycles` (`madge --circular`) ゼロ
- `npm run build:desktop` で Tauri 実機が起動し、Phase 0 のベースラインと目視で同じ
- 論理コード（`hifi/*.jsx` 内のロジック）の差分はゼロ（diff チェックで確認可能：`git diff main..HEAD -- '*.jsx' '*.tsx' | grep -v '^+import\|^-/\* global\|^+export\|^+if (typeof window'`）

完了したら次は Phase 2（feature 別の分割、Memory → Chat → Settings の順）の実装計画作成へ進む。
