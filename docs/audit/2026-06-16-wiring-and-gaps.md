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
| `github` | GitHub |
| `claude` | Claude |
| `figma` | Figma |
| `zapier_mcp` | Zapier MCP |

**実装済み（Connect 成功パスあり）:** Gmail, Google Calendar, Google Drive, Arc Browser, Raycast, Obsidian, Apple Calendar / Reminders（macOS）。

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

詳細: [`memory-audit/four-flaws.md`](../memory-audit/four-flaws.md)

| 領域 | 状態 |
|---|---|
| DDL（edges, decay 列, captures） | ✅ 追加済 |
| Graph retrieval + ranker | ✅ デフォルト `read_path: graph` — chat / brief / timeline / search |
| `memory.search` / Brief v2 digest | ✅ `assemble_memory_hits` 経路（graph 失敗時 legacy フォールバック） |
| KIOKU → Brief | ✅ `decision_graph_hits` + graph digest 補完（`graph_supplemented`） |
| Extraction → edges | 🔄 ジョブ基盤 + billing ブロック時 re-queue UI。**edges 密度は Anthropic クレジット復旧待ち** |
| レガシー経路のみ | ⚠️ `meetings_only` scope、明示 `read_path: legacy` 時は decay/edges 薄い |

**Home UI:** Memory digest カードに `Graph retrieval` バッジ + `read_path` 表示。

---

## 5. E2E カバレッジ（2026-06-16 更新）

| Spec | 対象 |
|---|---|
| `consent-modal` | TOS 同意 |
| `entitlement-gate` | 課金ゲート |
| `mcp-setup-gate` | MCP wizard |
| `hifi-smoke` | graph read_path、chat/brief `memoryReadPath`、`graph_supplemented` 等 |

**ヘルパー:**
- `tests/e2e/_helpers/preseed-consent.js` — consent + 既定で `mcpComplete`
- `tests/e2e/_helpers/preseed-gates.js` — billing / Clerk / entitlement fetch mock

**実DB smoke（任意）:** `scripts/verify-timeline-graph-real.sh`

---

## 6. 既知の開発環境ギャップ

| 項目 | 内容 |
|---|---|
| ESLint + `web/.next/` | ✅ `eslint.config.js` ignores に `web/.next/**` 追加済（2026-06-16） |
| Playwright | `npx playwright install chromium` が必要（サンドボックス外推奨） |

---

## 7. 次の監査候補

1. `web/` Stripe webhook + waitlist — 本番 env 疎通
2. Anthropic クレジット復旧後 — extraction worker ON → edge 密度計測（Settings → KIOKU Graph）
3. four-flaws 本丸 — 意味的重複除去、legacy-only ランキング強化
4. OAuth v1 未配線 9 件（Slack, Notion, Linear 等）
