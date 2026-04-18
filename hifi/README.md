# SHOGUN Hi-Fi UI

Static **SHOGUN** hi-fi prototype: React via Babel in the browser, optional Tauri IPC, mock transport when Tauri is absent. Open `SHOGUN Hi-Fi UI.html` from the parent folder.

## Key paths

| Path | Purpose |
|------|---------|
| `lib/ipc-client.js` | Tauri `invoke` or mock (`shogun_brief_get`, `shogun_open_pack`, …) |
| `lib/shogun-api.js` | Thin wrappers around IPC commands |
| `lib/action-registry.js` | Maps UI action keys to API methods |
| `lib/morning-brief-contract.js` | Mock Morning Brief v1 (`getMorningBriefMockResponse`) |
| `lib/brief-telemetry.js` | Eval hooks: next-action click, dismiss, rating (`shogunBriefTelemetrySink`) |
| `screens-a.jsx` | Home screen including **Morning Brief (AMC)** card |
| `action-map.md` | Action inventory; keep in sync with `scripts/check-actions.py` |

## External agent · credentials (no in-app OAuth)

See **`action-map.md`** for the full UI ↔ command matrix. Summary:

- **Invoke** `app_integration_import_credentials` with `provider`, `accessToken`, optional `refreshToken`, `expiresAt`, `scopes`, **`oauthClientId`**, optional **`oauthClientSecret`** (Keychain). Success emits **`credentials-imported`** (`via: "invoke"`).
- **Deep link** `shogun-ai://credentials/import?…` (same fields as query params where applicable). Emits **`credentials-imported`** (`via: "deep-link"`). **Prefer invoke** for secrets (URLs leak to logs/history).
- **Status**: `integrations.credentials_status` → `configured`, **`tokenRefreshReady`** (Google refresh possible when `refreshToken` + `oauthClientId` exist).
- **Calendar → Memory**: `calendar.sync`. Token refresh on expiry/401 when OAuth client + refresh token are stored.
- **Background calendar**: `settings.save` on section **`integrations`** with **`googleCalendarAutoSync`** and **`googleCalendarSyncIntervalMins`** (5–1440); requires Keychain credentials.

## Capture (macOS desktop)

- Settings section **`capture`**: **`sampleIntervalSecs`** (4–600), **`axMinIntervalSecs`** (0–600), **`axRichCapture`**, pause/resume flags. See `action-map.md`.

## macOS distribution (Hardened Runtime)

- `src-tauri/Entitlements.plist` is wired via `bundle.macOS.entitlements` with `hardenedRuntime: true` in `tauri.conf.json` for release signing / notarization prep. See also **`docs/macos-release.md`** in the repo root.

## Morning Brief (AMC)

- On Home mount, calls `brief.get` and renders `data.brief` when present.
- Primary CTA per row: `next_action.mcp_tool.tool_name` (e.g. `shogun.open_pack`) with `arguments`.
- Production: implement `shogun_brief_get` in Rust/Tauri to return the same JSON shape as `amc-pipeline` (`version`, `headline`, `posture`, `items`, `deferred_count`).

## AMC pipeline (Node)

Candidate pool → LLM → rank → summary lives in **`amc-pipeline/`**. **System prompts are English**; brief text still follows AMC (JP/EN operator). **Model IDs:** set `ANTHROPIC_MODEL` / `ANTHROPIC_SUMMARY_MODEL` (defaults: `claude-opus-4-7` + `claude-sonnet-4-6` per Anthropic docs — see pipeline README).

```bash
cd amc-pipeline && npm install && npm run validate
```

Details: [amc-pipeline/README.md](./amc-pipeline/README.md).

## Checks

```bash
python3 scripts/check-actions.py
```

Playwright E2E (repo root): `npm run test:e2e` — includes `diagnostics.report` **summary** and **`stats.get`** (`stage: "capture"`) mocks.
