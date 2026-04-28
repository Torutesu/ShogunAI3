# OAuth Helper Tauri Integration Design

**Status:** Draft
**Date:** 2026-04-27
**Related:** `scripts/oauth-google.mjs` (commit `c8234bd`, the existing CLI helper)

## Problem

Today, connecting Gmail / Google Calendar requires:

1. Open a separate terminal.
2. Run `node scripts/oauth-google.mjs`, which spawns a localhost HTTP server on port 8723, opens the system browser, and prints `invoke('app_integration_import_credentials', {...})` commands.
3. Open Tauri DevTools (Cmd+Opt+I).
4. Manually paste two `invoke` commands per provider into the console.

This is fragile, error-prone, and makes the in-app "Connect" buttons in `Settings → Integrations` dishonest — they currently show `v1: In-app OAuth is not wired` and only return validation messages.

We move the OAuth flow into Tauri so a single click on Connect runs the full flow and the user never touches DevTools.

## Goals

- Single click in Settings → Integrations → Gmail / Google Calendar starts the consent flow and saves tokens automatically.
- No new credential storage path — reuse the existing `app_integration_import_credentials` save.
- No new Google Cloud Console configuration — same `localhost:8723/callback` redirect_uri.
- Dev-friendly: works with the existing `scripts/.env.google-oauth` (no extra setup).
- Honest UI when CLIENT_ID/SECRET aren't configured (no silent failure).

## Non-Goals

- **Production credential management.** CLIENT_ID/SECRET handling for non-dev users (bundled credentials, settings-UI input, PKCE-only flows) is out of scope. Defer to a later phase.
- **Other providers (Slack/Notion/GitHub/Linear/Zoom).** Their existing agent-based import paths stay unchanged.
- **Hot reload of OAuth credentials.** Each click re-reads `.env.google-oauth`, but no file-watch.
- **Removing `scripts/oauth-google.mjs`.** It stays as the CLI fallback (and is referenced by CI verification gates added in `c8234bd`).
- **Embedded webview-based OAuth.** Google explicitly disallows this for the Gmail / Calendar OAuth scopes (anti-MITM rule). Use system browser via `localhost` callback (matches `oauth-google.mjs`'s proven pattern).

## § 1. Architecture & Data Flow

### File layout

| File | Change | Responsibility |
|---|---|---|
| `src-tauri/src/oauth_flow.rs` (new) | Create | OAuth flow body: `.env.google-oauth` parsing, localhost HTTP server, auth URL builder, code-for-token exchange, error types, unit tests. |
| `src-tauri/src/commands.rs` | Modify | Add `shogun_oauth_google_start` Tauri command. Internally calls `oauth_flow::run` then re-uses the existing credentials-import path for both `gmail` and `google_calendar`. |
| `src-tauri/src/lib.rs` | Modify | `mod oauth_flow;` + `tauri::generate_handler!` registration. |
| `src-tauri/Cargo.toml` | Modify | Add deps as needed (`tiny_http` for the local server, `open` for browser launch, `getrandom` if not transitive). |
| `hifi/lib/shogun-api.js` | Modify | Add `oauthGoogleStart` API call wrapper. |
| `hifi/lib/action-registry.js` | Modify | Register `oauth.google.start` action. |
| `hifi/app.jsx` | Modify | Runtime API export + action map entry + `mockIpcInvoke` stub. |
| `hifi/lib/ipc-client.js` | Modify | Mock case returning a fixed `{ ok: true, provider }` for dev-without-Tauri. |
| `hifi/settings-modal.jsx` | Modify | Wire Gmail / Google Calendar "Connect" buttons to `oauth.google.start`. Update subtitle / OAuth-Setup drawer copy. Add not-configured modal. Loading + success/error toasts. |

### Runtime flow

1. User clicks `Connect` on Gmail or Google Calendar in Settings → Integrations.
2. Frontend dispatches `runRuntimeActionA('oauth.google.start', { provider: 'gmail' })`.
3. Rust `shogun_oauth_google_start`:
   - Validates provider ∈ {`gmail`, `google_calendar`}.
   - Acquires the in-flight mutex (`oauth_flow::IN_FLIGHT`); if already held → `Err("oauth_already_in_progress")`.
   - Calls `oauth_flow::load_env()` → reads `<repo>/scripts/.env.google-oauth` → returns `{ client_id, client_secret }` or `Err("oauth_credentials_not_configured")`.
   - Generates 32-byte hex `state` for CSRF protection.
   - Binds `TcpListener::bind(("127.0.0.1", 8723))` → on AddrInUse → `Err("oauth_port_busy")`.
   - Builds auth URL with all standard params (`client_id`, `redirect_uri=http://localhost:8723/callback`, `response_type=code`, `scope=gmail.readonly+calendar.readonly`, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, `state`).
   - Calls `open::that(&auth_url)` to launch the system browser. Failures here are non-fatal — flow continues, frontend can paste `auth_url` into clipboard.
   - Awaits a `/callback` GET (180-second timeout via `tokio::time::timeout`).
   - On callback: validates `state`, extracts `code`, POSTs to `https://oauth2.googleapis.com/token` with `grant_type=authorization_code`, `redirect_uri`, `code`, client creds. Parses tokens.
   - Calls existing `commands::app_integration_import_credentials_inner(...)` (or equivalent — extract a Rust-level function from the existing IPC handler so we can call it without re-entering Tauri's IPC layer) for `provider: "gmail"` AND `provider: "google_calendar"` so a single OAuth grants both.
   - Returns `{ ok: true, provider, scopes: [...], expires_at: <epoch_seconds>, refresh_token_present: bool }` to the frontend (no token bodies).
4. Frontend on success:
   - Toast `Connected to Gmail` / `Gmail に接続しました` (or Calendar variant).
   - Re-fetch `app_integration_credentials_status` for both providers and update the existing status display.
5. Frontend on error: toast with mapped friendly message; for `oauth_credentials_not_configured`, show a dedicated modal with the env-file hint instead.

### Single-flight invariant

`oauth_flow::IN_FLIGHT` is a `parking_lot::Mutex<()>` (or a `tokio::sync::Mutex`) that's held for the duration of one OAuth attempt. The frontend `Connect` button is also disabled while waiting. Two-layer protection means:

- A second click in the same window: blocked client-side.
- A second window or DevTools-issued IPC: blocked server-side with `oauth_already_in_progress`.

## § 2. Secrets & Logging

### `.env.google-oauth` resolution

- Path: relative to the repo root via `Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("scripts/.env.google-oauth")` (stable across `cargo run` / `tauri dev` / `tauri build`).
- Read lazily on each `shogun_oauth_google_start` call (no startup cost; no file-watch needed).
- Parse format identical to `oauth-google.mjs::loadEnv`: `KEY=VALUE` lines, comments / blank lines skipped, surrounding single/double quotes stripped.
- File missing → `Err("oauth_credentials_not_configured")` (frontend opens the not-configured modal).
- File present but `CLIENT_ID` or `CLIENT_SECRET` missing/empty → same error.

### Log masking

- `log::debug!` and lower never print raw `access_token`, `refresh_token`, or `oauthClientSecret`.
- Mask helper: input `≤ 8` chars → `*` × len; otherwise `head4 + ('*' × (len-8)) + tail4`. (Mirrors `oauth-google.mjs::maskSecret`.)
- Token-exchange errors include the HTTP status and Google's `error` code (e.g., `invalid_grant`) but NOT the response body (which can echo secrets).

### Frontend exposure

- IPC return value contains: `provider`, `scopes` (string array), `expires_at` (epoch seconds, optional), `refresh_token_present` (bool). No token strings.
- The `app_integration_credentials_status` IPC continues to be the source of truth for "configured" status.

### State parameter

- 32 bytes from `getrandom::getrandom` → hex-encoded.
- Held in memory only for the duration of the flow; lost on process exit.
- Verified strictly equal on callback receipt; mismatch → `Err("oauth_state_mismatch")`.

## § 3. UI

### `Settings → Integrations` pane

#### Subtitle

- Old: `v1: In-app OAuth is not wired. Google Calendar tokens can be imported by an external agent (Keychain); use Refresh / Sync below. Other Connect rows show an honest notice where applicable.`
- New (en): `In-app OAuth: Click Connect on Gmail / Google Calendar to start the consent flow. CLIENT_ID/SECRET are read from scripts/.env.google-oauth (dev). For other providers, agent-based import is still supported (see legacy notes below).`
- New (jp): `In-app OAuth: Gmail / Google カレンダーの Connect を押すと同意フローが始まります。CLIENT_ID/SECRET は scripts/.env.google-oauth から読みます (dev)。他プロバイダは agent 経由 import を引き続きサポート (下記レガシー手順)。`

#### Gmail / Google Calendar `Connect` button

- Click handler changes from `run('integrations.connect', { provider })` to:
  ```js
  await run('oauth.google.start', { provider }, { silentError: false });
  ```
- During the call:
  - Button label becomes `Connecting…` / `接続中…` and `disabled={true}`.
  - On the same row, a small `cancel` link appears that calls `oauth.google.cancel` (out of scope; defer — for now the user can wait the timeout).
- On success:
  - Button returns to default state.
  - Toast: `Connected to Gmail` / `Gmail に接続しました` (or Calendar variant).
  - Re-fetch `app_integration_credentials_status` for the provider; the existing status row updates.
- On error:
  - Toast with friendly message (see § 4 error table).
  - Button returns to default state.

#### `OAuth Setup ▾` drawer

- Existing 3-step instructions (agent-based) stay, but folded under a `Legacy / agent path` heading.
- New first line in the drawer (en): `In-app: click Connect above. This drawer is for the agent-based fallback (production / multi-user, when scripts/.env.google-oauth is unavailable).`
- New first line (jp): `アプリ内: 上の Connect を押す。このドロワは agent 経由の代替手順 (本番 / 複数ユーザ、scripts/.env.google-oauth が使えない場合)。`

#### `oauth_credentials_not_configured` modal

- Rendered as a small modal (re-uses existing `s-modal` / `ConfirmWriteModal` pattern if straightforward; otherwise a simple full-screen overlay).
- Title: `OAuth credentials not configured`.
- Body explains that `scripts/.env.google-oauth` is missing and shows the copy-paste setup:
  ```
  cp scripts/.env.google-oauth.example scripts/.env.google-oauth
  # Then fill CLIENT_ID and CLIENT_SECRET from Google Cloud Console.
  ```
- Buttons: `Copy command` (clipboard), `Close`.

### Other providers (Slack / Notion / GitHub / Linear / Zoom)

No change. Their existing `Connect` buttons keep calling `integrations.connect` and showing the agent-based instructions. Only Gmail and Google Calendar gain the in-app OAuth flow in this phase.

### i18n

All new copy bilingual via the existing `<span className="en-only">` / `<span className="jp">` pattern.

## § 4. Error Handling

| Scenario | Detection | Result / UI |
|---|---|---|
| `.env.google-oauth` missing | `oauth_flow::load_env` | `Err("oauth_credentials_not_configured")` → frontend opens the not-configured modal (not a toast). |
| `.env.google-oauth` present but `CLIENT_ID` / `CLIENT_SECRET` empty | Same | Same. |
| Port 8723 in use | `TcpListener::bind` returns `AddrInUse` | `Err("oauth_port_busy")` → toast `Already connecting — please wait or restart` / `接続中です — 待つかアプリ再起動を` |
| `open::that` fails (no browser, headless env) | Browser launcher | Non-fatal. Continue waiting on callback. Toast `Open this URL in your browser:` + `auth_url` copied to clipboard automatically. |
| User cancels in browser → `?error=access_denied` | Callback handler | Server closes; `Err("oauth_user_cancelled")` → toast `OAuth was cancelled` / `OAuth がキャンセルされました` |
| `state` mismatch (CSRF / stale callback) | Callback handler | `Err("oauth_state_mismatch")` → toast `Security check failed; please try again` / `セキュリティ確認に失敗 — もう一度お試しください` |
| 180 s timeout | `tokio::time::timeout` | Server closes; `Err("oauth_timeout")` → toast `OAuth timed out. Try again.` / `OAuth がタイムアウトしました — 再試行してください` |
| Token endpoint 4xx (`invalid_grant` etc.) | `exchange_code` | `Err("oauth_token_exchange_failed:<status>:<google_error_code>")` → toast `Token exchange failed [400 invalid_grant]. Check CLIENT_SECRET.` (Google's error code is a short enum, safe to surface; full body is not.) |
| Token endpoint network error (DNS, connect refused, TLS) | `exchange_code` | `Err("oauth_network_error")` → toast `Network error during token exchange` / `トークン交換でネットワークエラー` |
| Tokens received but `refresh_token` absent | Post-exchange validation | Flow succeeds (access_token works). Warning logged. UI shows a `⚠ refresh_token missing — re-grant required after expiry` chip on the integration row. |
| `app_integration_import_credentials_inner` save fails | Existing logic | Error propagates. Toast `Failed to save credentials` / `認証情報の保存に失敗` |
| Provider not `gmail` / `google_calendar` | Command entry | `Err("oauth_invalid_provider")` |
| Concurrent click while in-flight | `IN_FLIGHT` mutex (server) + `disabled` button (client) | Server: `Err("oauth_already_in_progress")` → toast `Already connecting`. Client: button disabled, click is a no-op. |

## § 5. Testing

### Rust unit tests (`oauth_flow.rs`)

- `parse_env_basic` — well-formed `.env`, comments and blank lines, single-quoted and double-quoted values.
- `parse_env_missing_keys` — file present, `CLIENT_ID` empty → expected error variant.
- `parse_env_missing_file` — file absent → expected error variant.
- `build_auth_url` — query string contains `client_id`, `redirect_uri=http%3A%2F%2Flocalhost%3A8723%2Fcallback`, `response_type=code`, `scope=...gmail.readonly+...calendar.readonly`, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, `state=<provided>`.
- `parse_callback_query_ok` — `?code=X&state=Y` → `(code: X, state: Y, error: None)`.
- `parse_callback_query_user_cancel` — `?error=access_denied&state=Y` → `error_kind: UserCancelled`.
- `parse_callback_query_no_code` — `?state=Y` → error.
- `mask_secret_short` (≤ 8 chars) — all asterisks.
- `mask_secret_long` (> 8 chars) — head4 + asterisks + tail4.
- `exchange_code_ok` (with `mockito` or a hand-rolled `tiny_http` mock) — 200 + JSON → tokens.
- `exchange_code_4xx` — 401 → `oauth_token_exchange_failed`.
- `exchange_code_network_error` — `mockito` simulates connection refused → `oauth_network_error`.

### Rust integration test (`#[ignore]`-gated)

- Full happy path: spawn the server, kick off `oauth_flow::run` in a `tokio::spawn`, simulate a fake browser hitting `/callback?code=fake&state=<captured>`, mock the token endpoint (`mockito`) to return `{access_token, refresh_token, expires_in, scope}`, assert `oauth_flow::run` resolves with the expected token tuple.
- Timeout path: don't hit `/callback`, advance time → expect `oauth_timeout`.

### Frontend smoke / Playwright

- Open Settings → Integrations, click Gmail Connect.
- Mock IPC returns `{ ok: true, provider: 'gmail', scopes: ['gmail.readonly'], expires_at: <future>, refresh_token_present: true }`.
- Assert toast `Connected to Gmail` is visible.
- Mock IPC returns `{ ok: false, error: 'oauth_credentials_not_configured' }` → assert the not-configured modal appears.
- Mock IPC returns `{ ok: false, error: 'oauth_token_exchange_failed:400:invalid_grant' }` → assert the toast contains `400 invalid_grant`.

May be `test.fixme` if the existing async-mount race blocks (cluster precedent). Bodies preserved as documentation.

### Manual smoke

1. Ensure `.env.google-oauth` is filled.
2. `npm run dev:desktop`.
3. Settings → Integrations → Gmail → Connect → Google consent in browser → return to app, "Connected to Gmail" toast.
4. Status row shows `tokenRefreshReady: true`.
5. Calendar Connect: same flow.
6. Delete `.env.google-oauth`. Click Connect → not-configured modal appears with copy-able command.
7. Restore `.env.google-oauth`, click Connect twice in rapid succession → second click is no-op (button disabled), or the second IPC errors with `oauth_already_in_progress` if the disabled state somehow misses.

### Static checks

- `npm run check:actions` — confirms `oauth.google.start` registered.
- `npm run check:ipc-mock` — mock matches action map (60 commands now: 59 + 1 new).
- `cargo test --lib oauth_flow` — unit tests pass.

## § 6. Rollout

No feature flag. No DB migration. No new credential storage. The bundled `scripts/.env.google-oauth.example` template is unchanged.

`scripts/oauth-google.mjs` stays as the CLI fallback. Add a one-line note in its `--help` output: `(Tip: use Settings → Integrations → Connect for in-app OAuth.)`. The CI verification gate (`c8234bd`) keeps testing the CLI helper independently.

## Open Questions / Future Work

- **Production credential UX**: how a non-dev user supplies CLIENT_ID/SECRET. Three plausible directions (Settings UI input, bundled credentials, PKCE-only flow). Defer to a dedicated phase once the in-app UX has stabilized.
- **`oauth.google.cancel` action**: a way to abort the flow before timeout (e.g., user closes the consent tab). Currently only the 180-second timeout cancels. Defer.
- **Multi-account**: today's storage assumes one account per provider. Multi-account would require listing tokens per account and per-row UI selectors. Defer.
- **Other Google scopes**: Drive, Docs, etc. Would extend the SCOPES constant; trivial once the flow is stable. Defer.
- **Other OAuth providers** (Slack, Notion, GitHub): each has its own OAuth peculiarities; doable with the same Rust framework once needs arise.

## Success Criteria

1. From a clean install, the user can complete a Gmail OAuth connection in fewer than four clicks (Settings → Integrations → Connect → Google consent → Allow) without ever opening DevTools or a terminal.
2. The same one-click flow works for Google Calendar (or, equivalently, a single Gmail connect grants both — this is the current `oauth-google.mjs` behavior because the SCOPES list contains both, and credentials are saved for both providers).
3. A misconfigured environment (missing `.env.google-oauth`) shows an actionable modal, not a silent failure.
4. The IPC `oauth.google.start` cannot be exploited to leak tokens to the frontend — the IPC return shape contains no token strings.
5. All new unit + integration tests pass; `check:actions` and `check:ipc-mock` are green.
6. `scripts/oauth-google.mjs` continues to function as a CLI fallback (existing CI gate remains green).
