# SHOGUN Hi-Fi UI

Static **SHOGUN** hi-fi prototype: React via Babel in the browser, optional Tauri IPC, mock transport when Tauri is absent. Open `SHOGUN Hi-Fi UI.html` from the parent folder.

**Memory (local-first):** The Memory index is **`memory.db`** (SQLite + **FTS5**). Rows may store an **`embedding` BLOB** (f32, L2-normalized) from OpenAI-compatible **`/v1/embeddings`** using the same API key as chat; model defaults to **`text-embedding-3-small`** (`settings.sections.llm.embeddingModel`). After ingest, embeddings run in the background except for **`capture_sampler`** / **`capture_ax`** sources (noise/cost control). **`memory.search`** accepts **`semantic: true`**: widen lexical hits, embed the query once, re-rank by cosine similarity (requires key). Legacy **`memory_items.json`** migrates once, then **`memory_items.json.migrated`**. No SHOGUN-hosted Memory sync; Chat / LLM, Clerk, OAuth still send data per their terms when used.

## Key paths

| Path | Purpose |
|------|---------|
| `lib/ipc-client.js` | Tauri `invoke` or mock (`shogun_brief_get`, `shogun_open_pack`, …) |
| `lib/shogun-api.js` | Thin wrappers around IPC commands |
| `lib/action-registry.js` | Maps UI action keys to API methods |
| `lib/morning-brief-contract.js` | Mock Morning Brief v1 (`getMorningBriefMockResponse`) |
| `lib/brief-telemetry.js` | Eval hooks: next-action click, dismiss, rating, and chat context source (`chat.completion.context`) (`shogunBriefTelemetrySink`) |
| `screens-a.jsx` | Home screen including **Morning Brief (AMC)** card |
| `action-map.md` | Action inventory; keep in sync with `scripts/check-actions.py` |
| [`../docs/END_USER_SETUP.md`](../docs/END_USER_SETUP.md) | Short **end-user** steps: Tauri app, API key, Memory embeddings & semantic search |
| [`../PRIVACY.md`](../PRIVACY.md) | Desktop v1 **privacy summary** (local data, Keychain, LLM/network) — ship or link with distribution |
| [`../docs/TERMS_OF_SERVICE.md`](../docs/TERMS_OF_SERVICE.md) | **利用規約（ベータ・日本語）** — サブスク UI の範囲、第三者サービス、免責 |
| [`../docs/TERMS_OF_SERVICE_EN.md`](../docs/TERMS_OF_SERVICE_EN.md) | **Terms of Service (beta, English)** — same scope; jurisdiction may pick authoritative text |

## External agent · credentials (no in-app OAuth)

See **`action-map.md`** for the full UI ↔ command matrix. Summary:

- **Invoke** `app_integration_import_credentials` with `provider`, `accessToken`, optional `refreshToken`, `expiresAt`, `scopes`, **`oauthClientId`**, optional **`oauthClientSecret`** (Keychain). Success emits **`credentials-imported`** (`via: "invoke"`).
- **Deep link** `shogun-ai://credentials/import?…` (same fields as query params where applicable). Emits **`credentials-imported`** (`via: "deep-link"`). **Prefer invoke** for secrets (URLs leak to logs/history).
- **Status**: `integrations.credentials_status` → `configured`, **`tokenRefreshReady`** (Google refresh possible when `refreshToken` + `oauthClientId` exist).
- **Calendar → Memory**: `calendar.sync`. Token refresh on expiry/401 when OAuth client + refresh token are stored.
- **Gmail → Memory**: `gmail.sync` (`provider: "gmail"` credentials required). Ingests inbox metadata with `provenance: connector`, `source: gmail`.
- **Background calendar**: `settings.save` on section **`integrations`** with **`googleCalendarAutoSync`** and **`googleCalendarSyncIntervalMins`** (5–1440); requires Keychain credentials.

## Privacy guardrail

- `settings.sections.privacy.allowChatServerMemoryAssembly` (default `false`; opt-in) explicitly controls whether server-side `memoryAssembly` is honored on `chat.complete` / `draft.create`. When unset or `false`, Rust ignores client-sent `memoryAssembly`.
- Settings save emits `shogun-privacy-settings-changed`; Chat / Memory / Work / Meetings / Agents reload this flag via `settings.load` without remount.
- `window.shogunBriefTelemetrySink` now persists `chat.completion.context` events to a local ring buffer (`localStorage`) and ingests compact telemetry rows to Memory (`source: telemetry_chat_context`).

## Capture (macOS desktop)

- Settings section **`capture`**: **`sampleIntervalSecs`** (4–600), **`axMinIntervalSecs`** (0–600), **`axRichCapture`**, pause/resume flags. See `action-map.md`.

## macOS distribution (Hardened Runtime)

- `src-tauri/Entitlements.plist` is wired via `bundle.macOS.entitlements` with `hardenedRuntime: true` in `tauri.conf.json` for release signing / notarization prep. See also **`docs/macos-release.md`** in the repo root.
- **Local signed build:** copy `src-tauri/tauri.signing.local.example.json` → `src-tauri/tauri.signing.local.json`, set `signingIdentity`, then from repo root run `npm run build:desktop:signed`. **CI signed build:** `docs/macos-release.md` §7 and `.github/workflows/release-macos.yml`.

## Morning Brief (AMC)

- On Home mount, calls `brief.get` and renders `data.brief` when present.
- Primary CTA per row: `next_action.mcp_tool.tool_name` (e.g. `shogun.open_pack`) with `arguments`.
- When the v2 gate is on (payload `forceV2`, `version: "2" | "2.0"`, or `sections.brief.morningBriefVersion === "2"`), Rust spawns the Node **`amc-pipeline`** as a one-shot subprocess (`node <repo>/hifi/amc-pipeline/src/cli.js --dry`), parses its **v1** JSON, and maps it to the **v2** shape (`morning-brief-v2.schema.json`) via `src-tauri/src/brief_v2_adapter.rs`. On any sidecar or mapping failure, Rust falls back to the built-in v2 stub and annotates the response with `fallbackReason`; the failure is also logged into `diagnostics::record` so it shows up under `app_diagnostics_report.recentErrors`.
- **Phase B.1** runs the pipeline on its bundled fixture; **Phase B.2** will pass real candidates (memory / calendar / meetings) and call Anthropic.

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

Repo root: `npm run check:ipc-mock` — ensures `lib/ipc-client.js` mock `switch` cases stay aligned with `app.jsx` `mockIpcInvoke` (plus `if (command === "…")` hooks in the IPC mock).

Playwright E2E (repo root): `npm run test:e2e` — includes `diagnostics.report` **summary** and **`stats.get`** (`stage: "capture"`) mocks.
