# Hi-Fi UI JSX 分割 — Phase 2 ロードマップ

> **For agentic workers:** これは Phase 2 全体の見取り図です。各 Step は独立した PR として実装します。bite-sized 化された実装計画は `2026-05-09-hifi-jsx-split-phase2-stepN-<name>.md` を参照。

**前提:** Phase 1 PR (#62) がマージ済み。`_legacy/` 配下の8ファイルが `// @ts-nocheck` 付きで残っている。

**Phase 2 のゴール:** `_legacy/` を解体し、各画面を `src/features/<feature>/` に正規化。ロジック変更ゼロ + 型を厚くしながら、`@ts-nocheck` を 1 ファイルずつ剥がす。各 PR で Phase 0 の e2e 56 tests がそのまま green を維持すること。

## 完了条件（Phase 2 全体）

- `src/features/_legacy/` ディレクトリが消えている
- 全 `.tsx`/`.ts` が `max-lines: 1000` 以下、原則 600 行以下
- `// @ts-nocheck TODO(phase2):` の出現がゼロ
- `madge --circular` ゼロ維持
- ESLint `boundaries/element-types` を **error** に昇格
- `eslint-plugin-boundaries` の `feature` 同士 import 禁止が機械的に効いている
- e2e 56 tests green、Tauri 実機で全画面描画 OK

## 全12 Step（順序）

| Step | Feature | 対象 _legacy ファイル | 規模 | リスク | 推定所要 |
|---|---|---|---|---|---|
| 1 | shared/icons 仕上げ（型・JSDoc・barrel整理） | (Phase 1 で済) | 小 | 低 | 0.5日 |
| 2 | shared/lib + shared/ipc を本格 TS 化 | shared/lib/*.ts, shared/ipc/*.ts | 中 | 中（IPC 型） | 2〜3日 |
| 3 | morning-brief | screens-morning-brief.tsx (289) | 小 | 低 | 0.5日 |
| 4 | memory/debug | screens-memory-debug.tsx (632) | 小 | 低 | 0.5日 |
| 5 | chat | screens-b.tsx (719) | 小 | 低 | 1日 |
| 6 | agents | screens-agents.tsx (1670) | 中 | 低 | 1〜2日 |
| 7 | work + capture + integrations + settings-screen | screens-c.tsx (1507) | 中 | 中（4 画面同居） | 2日 |
| 8 | home + memory | screens-a.tsx (4167) | 大 | 中（Memory ビューが多い） | 3日 |
| 9 | meetings | screens-meetings.tsx (3220) | 大 | 中（録音・STT 副作用） | 3日 |
| 10 | settings-modal（modal 全タブ） | settings-modal.tsx (4712) | **最大** | 中（タブ間状態） | 4〜5日 |
| 11 | app shell 最終整理 | App.tsx (4846) → app/{shell,providers,hooks}/ | 中 | 低 | 2日 |
| 12 | _legacy/ 削除 + max-lines/boundaries を error 化 | — | 小 | なし | 0.5日 |

合計推定 **20〜25日**（ソロ作業前提、レビュー時間込み）。

## 推奨実行順序の根拠

1. **小さい順**: Step 3 → 5 で feature-folder パターンを確立してから大物に進む。
2. **依存方向**: shared/ を厚くしてから feature/ が import するのが自然 → Step 2 を先行。
3. **app shell は最後**: feature が出揃ってから Sidebar/CommandPalette/Providers に切り出すと依存が綺麗にまとまる。
4. **settings-modal は最大ファイル**: 9 (meetings) で得た「副作用が多い大物」のノウハウを使って取り組む。

## 各 PR の標準 DoD（Done の定義）

| 項目 | 検証方法 |
|---|---|
| 対象 feature 配下に `index.ts`, `<Feature>Screen.tsx`, `components/`, `hooks/`, `lib/`, `types.ts` が揃っている | ディレクトリ確認 |
| 対応する `_legacy` ファイルが削除済み | `ls src/features/_legacy/` |
| `// @ts-nocheck` ヘッダがその feature の全ファイルから消えている | `grep -rn "@ts-nocheck" src/features/<name>/` がゼロ |
| Vitest の hooks + 純関数テストが追加されている（カバレッジは feature ごとに合理的範囲で） | `npm run test:unit` |
| e2e 56 tests green | `npm run test:e2e` |
| `npm run typecheck` ゼロエラー | コマンド実行 |
| `npm run lint --max-warnings 0` 通過 | コマンド実行 |
| `npm run cycles`（madge）ゼロ | コマンド実行 |
| Tauri 実機 smoke で該当画面が描画される（スクショ添付） | 手動 + PR コメント |

## feature 内の標準レイアウト（再掲）

```
src/features/<feature>/
├─ index.ts            ← 公開エントリ。Screen と必要な型のみ
├─ <Feature>Screen.tsx ← ルート画面
├─ components/         ← この feature 専用のコンポーネント
├─ hooks/              ← この feature 専用の hooks
├─ lib/                ← この feature 専用の純関数・契約
└─ types.ts            ← feature 内で共有する型
```

`index.ts` には Screen と最小限の公開型のみ並べ、内部 `components/`/`hooks/`/`lib/` は外向きに公開しない（ESLint `import/no-internal-modules` で機械的に強制）。

## 横断ルール（全 Step 共通）

- **import 方向**: `app → feature → shared` の単方向のみ。`feature → feature` は禁止（`shared/` 経由）。Step 12 で `boundaries/element-types` を `warn` → `error` に昇格して機械的に閉じる。
- **window 互換シム**: 各 feature 化が完了したファイルからは `window.X = X` の書き出しを**残したまま**にして良い（Phase 3 で外す）。逆に `window.X` を読む側のコードは Step 12 の最終整理で全面削除して `import` に統一。
- **新規コード**: 必ず `.tsx`/`.ts`、`// @ts-nocheck` 禁止。
- **テスト**: feature 内 hooks と純関数は Vitest で `renderHook` / 純関数の代表ケース。コンポーネントは role/name クエリで（snapshot 禁止）。

## ロールバック戦略

各 Step が独立 PR なので、何か問題が起きたらその PR だけ revert すれば前のステートに戻れる。`_legacy/` は Step 12 まで残るので、最悪 1 feature ずつ切り戻すこともできる。
