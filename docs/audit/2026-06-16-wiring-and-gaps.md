# サービス配線監査 — 2026-06-16

更新: 2026-06-16  
対象: SHOGUN AI デスクトップ（Hi-Fi + Tauri）+ `web/` 課金

---

## 1. 静的配線チェック

```bash
npm run check:actions   # PASS — registry 135 keys, runtime 6 keys, action-map 整合
```

`docs/action-map.md` と `src/shared/ipc/action-registry.ts` は一致。**未登録 action key の UI 呼び出しは検出されず。**

---

## 2. v1 で未実装（`notImplemented`）の連携

Settings → Integrations の **Connect** が warn toast を出すクラウド OAuth（ブラウザ mock / Rust 本番とも `OAUTH_V1_NOT_WIRED`）:

| Provider slug | UI 上の名前 |
|---|---|
| `slack` | Slack |
| `notion` | Notion |
| `linear` | Linear |
| `outlook` | Outlook |
| `google_drive` | Google Drive |
| `github` | GitHub |
| `claude` | Claude |
| `figma` | Figma |
| `zapier_mcp` | Zapier MCP |

**実装済み（Connect 成功パスあり）:** Gmail, Google Calendar, Arc Browser, Raycast, Obsidian, Apple Calendar / Reminders（macOS）。

参照: `src/shared/lib/integration-connectors.ts:36–46`, `docs/action-map.md` § v1 backend behavior。

---

## 3. オンボーディング / 課金ゲート（`feat/onboarding-billing-web`）

起動順: **Consent → EntitlementGate → McpSetupGate → MainApp**

| コンポーネント | 実装 | E2E |
|---|---|---|
| `EntitlementGate` | ✅ | ✅ `tests/e2e/entitlement-gate.spec.js` |
| `McpSetupGate` | ✅ | ✅ `tests/e2e/mcp-setup-gate.spec.js` |
| `web/` entitlement API | ✅ | 別途 web 統合テスト推奨 |

**ローカル dev:** `billing_config.enabled = false`（`SHOGUN_WEB_APP_URL` 未設定）→ 両ゲート bypass。

---

## 4. メモリ層（KIOKU）サマリ

詳細: [`memory-audit/four-flaws.md`](./memory-audit/four-flaws.md)

| 領域 | 状態 |
|---|---|
| DDL（edges, decay 列, captures） | ✅ 追加済 |
| Graph retrieval + ranker | ✅ MCP / `assemble_via_graph` |
| レガシー `memory.search` / Brief | ⚠️ decay / edges 未反映 |
| Extraction → edges | 🔄 ジョブ基盤あり、本番密度は要計測 |

---

## 5. E2E カバレッジ（16 specs / 2026-06-16）

| Spec | 対象 |
|---|---|
| `consent-modal` | TOS 同意 |
| `entitlement-gate` | 課金ゲート（新規） |
| `mcp-setup-gate` | MCP wizard（新規） |
| `hifi-smoke` + 11 others | 各画面・mock IPC |

**ヘルパー:**
- `tests/e2e/_helpers/preseed-consent.js` — consent + 既定で `mcpComplete`
- `tests/e2e/_helpers/preseed-gates.js` — billing / Clerk / entitlement fetch mock

---

## 6. 既知の開発環境ギャップ

| 項目 | 内容 |
|---|---|
| ESLint + `web/.next/` | ローカル `npm run lint` が build 成果物を走査すると大量エラー。CI は `src/**` のみ。`eslint.config.js` ignores に `web/.next/**` 追加を推奨。 |
| Playwright | `npx playwright install chromium` が必要 |

---

## 7. 次の監査候補

1. `web/` Stripe webhook + waitlist — 本番 env 疎通
2. Brief パイプラインが `decision_graph_hits` を非空で受け取るか（Rust → Node AMC）
3. KIOKU extraction ジョブ完了率 / edge 密度のダッシュボード（`kioku/debug_stats`）
