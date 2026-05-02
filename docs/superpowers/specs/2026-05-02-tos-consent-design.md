# TOS / Privacy Consent Flow — Design

## Goal

Add a first-launch (and version-change) consent modal that requires the user to accept the bundled Terms of Service and Privacy Policy before SHOGUN AI's main UI becomes accessible. Includes an optional telemetry opt-in toggle. Decline quits the app. Acceptance is persisted in `settings.json` keyed by document version so future revisions trigger a re-prompt.

This is the second item in the production-hardening branch series for ShogunAI3 (audit dated 2026-05-02). Branch: `feat/tos-consent`. Single PR.

## Context — Why This Is Needed

The audit on 2026-05-02 identified that:

- The repository ships `docs/TERMS_OF_SERVICE_EN.md`, `docs/TERMS_OF_SERVICE.md`, `PRIVACY.md`, and `docs/PRIVACY.ja.md` as bundled legal documents, but **no UI flow exists to obtain user acceptance of them**. A grep for `consent|accept.*terms|tos` in `hifi/` found no first-launch acceptance path.
- The audit's High-priority list flagged the absence of a consent flow as one of the top blockers to a production release.
- Telemetry collection via PostHog (per `posthog-setup-report.md` and `hifi/amc-pipeline/`) is mentioned in `PRIVACY.md` but the application has no opt-in mechanism. GDPR and the Japanese Personal Information Protection Act both require explicit consent for telemetry.

This work delivers the consent modal and persistence. PostHog runtime gating ("only initialize if `telemetryOptIn === true`") is **out of scope** for this PR and will be tracked separately.

## Decisions

These were resolved during brainstorming on 2026-05-02:

| # | Question | Decision |
|---|---|---|
| 1 | What is being consented to | Terms of Service + Privacy Policy + Telemetry opt-in (optional) |
| 2 | Trigger condition | Until accepted; re-prompt when document version changes |
| 3 | Decline behavior | Quit the app via `app_handle.exit(0)` after a 1500ms goodbye screen |
| 4 | Modal display | Single scrollable modal with full text of both documents inline |
| 5 | Language selection | Auto-detect from system locale; manual `[JP / EN]` switch in the modal header |
| 6 | Version source | Hardcoded constants in `hifi/lib/legal-versions.js`; updated manually when documents are revised |
| 7 | Telemetry default | Opt-in default OFF. This PR adds the toggle only — PostHog runtime gating is a separate follow-up PR |
| 8 | Persistence shape | Flat schema in `settings.json` under `sections.legal` |
| 9 | Markdown rendering | Tiny self-contained converter in `hifi/lib/markdown-mini.js` (target ≤40 lines, supports headings / bold / lists / links only) — no external dependency |

## Architecture

### Initialization Sequence

1. App starts → `hifi/app.jsx` `App` component mounts.
2. In a `useEffect`, the app:
   - Invokes `app_settings_load` to read `sections.legal`.
   - Reads `navigator.language` to pick the initial display language (`ja` if it starts with `ja`, otherwise `en`).
3. While the load is pending, render a minimal loading splash (no flash of unstyled content, no flash of the main UI).
4. After the load resolves:
   - **If** `legal.termsAcceptedVersion === TERMS_VERSION` AND `legal.privacyAcceptedVersion === PRIVACY_VERSION` → render the main app as normal.
   - **Else** → render the Consent Modal; do NOT render the main app behind it.
5. The Consent Modal calls `legal_docs_load(lang)` to get the markdown text, runs it through `markdown-mini`, and shows it in a scrollable region.
6. **On Accept** → invoke `app_settings_save` with payload:
   ```json
   {
     "section": "legal",
     "termsAcceptedVersion": "<TERMS_VERSION>",
     "privacyAcceptedVersion": "<PRIVACY_VERSION>",
     "telemetryOptIn": <bool>,
     "acceptedAt": "<ISO 8601 UTC>"
   }
   ```
   On success, dismiss the modal and render the main app.
7. **On Decline** → swap the modal body for a goodbye message, hide the buttons, wait 1500ms, then invoke `app_quit`.

### Consent Gate vs Main App

The gate is implemented inside `App` so that the existing component hierarchy is preserved. The pattern:

```jsx
function App() {
  const [legal, setLegal] = useState({ status: 'loading' });
  // useEffect: load settings + locale, set legal to { status: 'ok' } or { status: 'consent_needed', currentLang }
  if (legal.status === 'loading') return <LoadingSplash />;
  if (legal.status === 'error') return <SettingsErrorScreen onQuit={...} />;
  if (legal.status === 'consent_needed') return <ConsentModal lang={...} onAccept={...} onDecline={...} />;
  // status === 'ok' — render the rest of App as today
  return <RestOfApp ... />;
}
```

This keeps the gate logic localized; no global routing changes.

## File Structure

### New files

- **`hifi/lib/legal-versions.js`** — sets `window.SHOGUN_LEGAL_VERSIONS = { TERMS_VERSION, PRIVACY_VERSION }`. Single responsibility: hold the canonical version strings the consent flow compares against.

- **`hifi/lib/markdown-mini.js`** — exports `window.shogunMarkdownMini(text) → htmlString`. Single responsibility: convert the limited markdown subset used by the bundled legal docs (`# heading`, `**bold**`, `- list`, `[text](url)`) to safe HTML. Escapes any other HTML in the input.

- **`hifi/components/consent-modal.jsx`** — exports `window.ConsentModal`. Single responsibility: render the consent UI, manage local state (current language, agree-checkbox, telemetry-toggle, decline-pending), invoke the `onAccept` / `onDecline` callbacks.

- **`src-tauri/src/legal_docs.rs`** — Rust module exposing `legal_docs_load(lang)` Tauri command. Returns `{ terms: String, privacy: String }`. Reads from the bundled resource directory.

- **`tests/e2e/consent-modal.spec.js`** — Playwright spec covering the 6 scenarios listed in "Testing" below.

### Modified files

- **`SHOGUN Hi-Fi UI.html`** — add three `<script>` tags before the existing `app.jsx` script: `legal-versions.js`, `markdown-mini.js`, `consent-modal.jsx`.

- **`hifi/app.jsx`** — wrap the existing `App` body in the consent gate described above. Keep current behavior unchanged when `legal.status === 'ok'`.

- **`src-tauri/src/lib.rs`** — register `legal_docs::legal_docs_load` and `commands::app_quit` in the `invoke_handler` list.

- **`src-tauri/src/commands.rs`** — add `app_quit` command that calls `app_handle.exit(0)`.

- **`src-tauri/tauri.conf.json`** — add `bundle.resources` entries so the four legal markdown files are packaged with the app: `docs/TERMS_OF_SERVICE_EN.md`, `docs/TERMS_OF_SERVICE.md`, `PRIVACY.md`, `docs/PRIVACY.ja.md`. Without this, `legal_docs_load` will fail in a packaged build.

### Files NOT changed

- `src-tauri/src/settings_store.rs` — the `ensure_shape` function should NOT auto-create `legal: {}` on load; the absence of the section is the signal that consent is needed. Default-initializing it would silently treat first-launch as "accepted nothing" which would be ambiguous. The store handles arbitrary section keys already.

## Component Spec

### `ConsentModal`

**Props:**
- `initialLang: 'en' | 'ja'`
- `termsVersion: string`
- `privacyVersion: string`
- `onAccept(payload: { telemetryOptIn: bool })` — called when the user clicks Accept; the wrapper component is responsible for invoking `app_settings_save`
- `onDecline()` — called when the user clicks Decline; wrapper is responsible for the goodbye screen + `app_quit`

**Local state:**
- `lang: 'en' | 'ja'` (initial = `initialLang`)
- `docs: { terms: string, privacy: string } | null` (loaded via `legal_docs_load` on mount and on lang change)
- `agreed: bool` (the "I agree to the Terms and Privacy Policy" checkbox)
- `telemetryOptIn: bool` (the optional checkbox; default `false`)
- `decliningUntil: number | null` (timestamp; when set, modal shows goodbye screen until current time exceeds it, then calls `onDecline`)
- `loadError: string | null`
- `saveError: string | null`

**Layout:**
- Backdrop: `swm-backdrop` (reuse existing class).
- Modal container: `swm-modal` (reuse).
- Header: SHOGUN AI mark + title "Welcome to SHOGUN AI" + right-aligned `[JP | EN]` pill toggle.
- Body: short intro paragraph + scrollable region containing the rendered markdown of TOS then Privacy.
- Footer:
  - `<input type="checkbox">` "I agree to the Terms of Service and Privacy Policy" (`agreed`)
  - `<input type="checkbox">` "Send anonymous usage telemetry (optional)" (`telemetryOptIn`)
  - Two buttons: `[Decline & Quit]` (always enabled), `[Accept & Continue]` (disabled until `agreed === true`)

**Decline screen state:** when `decliningUntil !== null`, replace body and footer with a centered "Goodbye. SHOGUN AI requires acceptance of the Terms to continue." message. The 1500ms timer is set when the user clicks Decline; on expiry, `onDecline()` is called.

### `markdown-mini` rules (in order)

1. Escape `&`, `<`, `>` in the raw input first.
2. Replace `^# (.+)$` → `<h2>$1</h2>` (multi-line, no `<h1>` to avoid clashing with the modal's outer headings).
3. Replace `^## (.+)$` → `<h3>$1</h3>`.
4. Replace `\*\*(.+?)\*\*` → `<strong>$1</strong>`.
5. Convert consecutive `^- (.+)$` lines into `<ul><li>...</li></ul>`.
6. Replace `\[([^\]]+)\]\(([^)]+)\)` → `<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>`.
7. Convert remaining double-newline runs into `<p>...</p>` blocks.

This is **not** a general markdown processor. It covers exactly the constructs used by the four bundled documents at the time of writing.

### `legal_docs_load(lang)`

- Input: `lang` — `"en"` or `"ja"`.
- Behavior:
  - If `lang === "ja"` → read `docs/TERMS_OF_SERVICE.md` and `docs/PRIVACY.ja.md` from the resource directory.
  - Otherwise → read `docs/TERMS_OF_SERVICE_EN.md` and `PRIVACY.md`.
  - Return `Ok(json!({ "terms": <string>, "privacy": <string> }))` on success.
  - Return `Err(String)` if either file cannot be read.

Use `tauri::path::resource_dir` to resolve the bundled resources, falling back to the manifest dir during `tauri dev`.

### `app_quit()`

```rust
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}
```

The function returns `Ok(())` even though `exit` does not return, so the JS side can still await without a TypeError if the runtime hands control back before the process dies.

## Persistence Schema

`settings.json` after acceptance:

```json
{
  "sections": {
    "legal": {
      "termsAcceptedVersion": "2026-04-19",
      "privacyAcceptedVersion": "2026-04-19",
      "telemetryOptIn": false,
      "acceptedAt": "2026-05-02T12:34:56Z"
    },
    "general": { ... },
    ...
  }
}
```

Before acceptance, the `legal` key is **absent**. The consent gate's check is:

```js
const v = settings?.sections?.legal;
const ok = v
  && v.termsAcceptedVersion === TERMS_VERSION
  && v.privacyAcceptedVersion === PRIVACY_VERSION;
```

`telemetryOptIn` is **not** part of the `ok` check — the user may toggle it later from the Settings UI without re-prompting (Settings UI integration is out of scope for this PR; the value is stored, that's all).

## Version Constants

`hifi/lib/legal-versions.js`:

```js
window.SHOGUN_LEGAL_VERSIONS = {
  TERMS_VERSION: '2026-04-19',
  PRIVACY_VERSION: '2026-04-19',
};
```

These match the `Last updated:` lines in the bundled documents at the time of this PR. When the documents are revised, both this constants file and the corresponding `Last updated:` line must be updated together. CI enforcement of this pairing is out of scope for this PR.

## Error Handling

| Failure | UI | Recovery |
|---|---|---|
| `app_settings_load` rejects | Full-screen error: "Failed to load settings: \<message>. Please restart the app." with a single `[Quit]` button. | None — the app refuses to render anything else. Quitting and restarting is the only path. |
| `legal_docs_load` rejects | Inside the modal, replace the doc viewport with: "Failed to load legal documents: \<message>. Please reinstall the application." Accept is disabled; Decline still works. | None — the modal cannot be completed without the docs. |
| `app_settings_save` rejects on Accept | Inline red banner above the footer: "Could not save consent: \<message>. Please try again." Re-enable the Accept button. | User clicks Accept again. |
| Markdown contains constructs `markdown-mini` does not handle | The construct renders as escaped text (e.g., `*italic*` shows as literal `*italic*`). No crash. | Acceptable; documents are short and authored by us. |

## Testing

### Rust unit tests (`#[cfg(test)]` in `src-tauri/src/legal_docs.rs`)

- `loads_english_docs_returns_both_files`
- `loads_japanese_docs_returns_both_files`
- `unknown_language_falls_back_to_english`
- `missing_resource_returns_err`

These read fixture files from a temp directory; the production resource resolution is wrapped in a small helper that takes a `&Path` so tests can inject the temp dir.

### Rust unit test (`src-tauri/src/settings_store.rs` existing test module)

- `legal_section_round_trips_through_save_and_load` — write the four-field legal payload, reload, assert equality.

### Playwright E2E (`tests/e2e/consent-modal.spec.js`)

Each test starts with a fresh temp settings directory. The exact mechanism (Tauri data-dir override via env var, or per-test cleanup of `~/Library/Application Support/ai.shogun.desktop/`) is left to the implementation plan to nail down based on what `playwright.config.js` supports today:

1. **`first_launch_shows_modal`** — start app, verify `swm-modal` is visible and main nav is not.
2. **`accept_dismisses_modal_and_persists`** — check the agree box, click Accept, verify modal disappears, main nav appears, `settings.json` contains the four `legal` fields.
3. **`relaunch_after_accept_skips_modal`** — accept once, restart the app (Playwright reload), verify the modal does not appear.
4. **`version_bump_reprompts`** — accept with `TERMS_VERSION='2026-04-19'`, then in a new app launch override `TERMS_VERSION='2026-12-01'` (test harness env var), verify modal reappears.
5. **`decline_quits_app`** — click Decline, verify the goodbye screen renders, verify `app_quit` IPC is invoked. (`app_quit` is mocked in the test harness so the test process survives.)
6. **`telemetry_opt_in_toggle_persists`** — toggle telemetry on, accept, verify `settings.json.sections.legal.telemetryOptIn === true`.

Mocking `app_quit` in tests requires a small extension to `hifi/lib/ipc-client.js` (or whatever the test harness uses) to allow per-test command override. If this turns out to be invasive, the implementation plan will simplify the decline test to verify only the goodbye-screen render and skip the IPC assertion.

## Out of Scope

- **PostHog runtime gating** — the telemetry toggle is stored in settings but the actual PostHog initialization in `hifi/amc-pipeline/` is not yet wired to it. Tracked as a follow-up PR.
- **Settings UI to view / change consents** — users cannot revisit telemetry choice from inside the app yet (only by deleting `settings.json`). A "Privacy Controls" panel addition is a follow-up.
- **CI version-pair enforcement** — the rule "if you change a `.md` legal doc, you must bump the constant in `legal-versions.js`" is not enforced by CI in this PR.
- **Multilingual beyond JP/EN** — the locale detection is binary.
- **Clerk-specific disclosure text** — Clerk-enabled builds need an extra paragraph in the modal disclosing Clerk data processing. Tracked separately because the Clerk build flag isn't configured in CI today.
- **Telemetry granularity** — the toggle is one boolean for "all telemetry," not per-event.

## Acceptance Criteria

- On first launch (no `legal` section in `settings.json`), the consent modal appears and the main app UI is not accessible behind it.
- Clicking Accept with the agree checkbox checked persists the four-field `legal` section and dismisses the modal.
- After Accept, restarting the app does not show the modal.
- Bumping `TERMS_VERSION` or `PRIVACY_VERSION` in `legal-versions.js` causes the modal to reappear on the next launch.
- Clicking Decline shows the goodbye screen and calls `app_quit` after 1500ms.
- The language pill `[JP | EN]` switches the displayed text live without re-mounting the modal.
- All Rust unit tests added in this PR pass.
- All Playwright E2E specs added in this PR pass when run against a test build.
- This PR's design spec (this file) and implementation plan (to be written next) are committed to the same branch as the code.
- No PostHog initialization changes are made in this PR (out of scope).
