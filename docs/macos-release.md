# macOS distribution (Tauri v2)

This document outlines Developer ID signing, notarization, and shipping. Replace team IDs and certificate names with your own.

## Unsigned path (no Apple Developer account)

If you don't have an Apple Developer enrollment yet, you can still ship beta builds:

- **Local build**: `npm run build:desktop` → `src-tauri/target/release/bundle/dmg/Shogun AI_<version>_aarch64.dmg`
- **CI**: `.github/workflows/release-macos.yml` auto-detects missing `APPLE_CERTIFICATE` and falls back to unsigned. Tag `v*` push still creates a draft Release; the body explains the Gatekeeper bypass to users.
- **Limitations**:
  - First launch shows "App could not be verified" — users must right-click → Open (macOS 14) or use System Settings → Privacy & Security → Open Anyway (macOS 15+)
  - Not recommended for general public distribution; suitable for closed beta / friends-and-family
  - Tauri auto-updater may refuse to apply unsigned updates — users will need to re-download new builds manually

Skip §3-§7 below until you enroll in the Apple Developer Program.

## Prerequisites

- Enrolled in the Apple Developer Program
- A **Developer ID Application** certificate and private key in Keychain
- `notarytool` available (App Store Connect API key, or Apple ID with app-specific password)

## 1. Align versions

Keep these in sync:

- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `[package] version`

## 2. Sync frontend and build

From the repository root:

```bash
npm ci
npm run build:web-dist
npm run build:desktop
```

Assets are copied to `build.frontendDist` (`../web-dist` per `tauri.conf.json`).

## 3. Signing (Tauri)

Committed `tauri.conf.json` keeps **`hardenedRuntime`** and **`entitlements`** but omits **`signingIdentity`** so CI and contributors build unsigned by default.

### 3a. Local machine (Keychain identity)

Either merge a signing identity at build time:

```bash
npm run build:desktop -- -c '{"bundle":{"macOS":{"signingIdentity":"Developer ID Application: Your Name (TEAMID)"}}}'
```

Or copy `src-tauri/tauri.signing.local.example.json` to **`src-tauri/tauri.signing.local.json`** (gitignored), edit the identity string, then:

```bash
npm run build:desktop:signed
```

### 3b. CI (`.p12` + password)

When **`APPLE_CERTIFICATE`** (base64 of the `.p12`) and **`APPLE_CERTIFICATE_PASSWORD`** are set, Tauri CLI can import the certificate and infer the signing identity — you do not need `signingIdentity` in JSON. See [Tauri · macOS code signing](https://v2.tauri.app/distribute/sign-macos/).

Use the repo’s `src-tauri/Entitlements.plist` (path set in `tauri.conf.json`) and extend only as needed: network, Apple Events / Automation if you script other apps, **Accessibility** if you ship AX-based capture, Keychain via standard APIs, etc.

## 4. Notarization (`notarytool`)

Submit a zip of the app:

```bash
xcrun notarytool submit path/to/Shogun.zip \
  --apple-id "you@example.com" \
  --team-id "XXXXXXXXXX" \
  --password "@keychain:AC_NOTARY_PASSWORD" \
  --wait
```

Then staple:

```bash
xcrun stapler staple "path/to/shogun-ai.app"
```

## 5. DMG / distribution

Ship the generated `.dmg` or a stapled `.app`. Include or link: **[`PRIVACY.md`](../PRIVACY.md)** (data / Keychain / LLM) and **[`docs/TERMS_OF_SERVICE.md`](TERMS_OF_SERVICE.md)** (beta scope, billing UI disclaimer, third-party services).

**CI vs local:** Default `tauri build` in **`ci.yml`** is **unsigned** (no `signingIdentity` in committed config). Artifacts are fine for smoke tests; for end-user distribution, use §3 (local or `.p12` secrets) and §4 / optional §7 for notarization.

## 6. Manual gate on a clean Mac (recommended)

1. First launch with default Gatekeeper; verify quarantine warnings if any.  
2. Verify memory ingest/search, settings persistence, LLM chat (after key setup), and data deletion.  
3. **Integrations**: Google Calendar uses agent-imported Keychain tokens; optional **background sync** (`integrations` settings) and **token refresh** when `oauthClientId` + `refreshToken` are present. Cloud **Connect** rows may still return `notImplemented` — expect warn toasts.  
4. **Capture**: macOS sampler respects **sample interval** and optional **AX min interval**; grant **Accessibility** if using AX-rich capture.  
5. **Clerk**: if enabled, redirect URLs must include the app’s custom scheme (see `tauri.conf.json` / env). **Hummingbird**: `app.open_hummingbird` runs `open -a Hummingbird` — app must be installed.  
6. **Diagnostics**: Settings → Support **Report** should write a JSON file and return a **`summary`** (capture, accessibility trust, calendar integration flags).  

## CI

`.github/workflows/ci.yml` runs `check:actions`, `check:ipc-mock`, `check:rust`, `build:web-dist`, Playwright E2E, and an **unsigned** `tauri build`.

## 7. GitHub Actions: signed release

Workflow: [`.github/workflows/release-macos.yml`](../.github/workflows/release-macos.yml).

**Triggers:**

- **Tag push `v*`** — `tauri-action` builds, signs, (optionally) notarizes, and creates a **draft GitHub Release** with the DMG attached. When the Tauri updater plugin is enabled, `latest.json` is attached alongside so existing installs update automatically once the Release is published.
- **Manual** — Actions → *Release macOS (signed)* → **Run workflow**. Produces a signed DMG as a workflow artifact; does not touch Releases. Use this to sanity-check the signing path without cutting a release.

Day-to-day recommended flow: run `/release` from Claude Code (see [`.claude/commands/release.md`](../.claude/commands/release.md)) — it bumps the three version files, drafts brand-safe notes, tags, pushes, and watches the run. The manual dispatch stays as a fallback.

| Repository secret | Required | Purpose |
|-------------------|----------|---------|
| `APPLE_CERTIFICATE` | **Yes** | Base64-encoded **Developer ID Application** `.p12` (export cert + private key from Keychain). |
| `APPLE_CERTIFICATE_PASSWORD` | **Yes** | Password used when exporting the `.p12`. |
| `TAURI_SIGNING_PRIVATE_KEY` | Yes once the updater plugin ships | Tauri updater signing key (generate with `npx tauri signer generate -w ~/.tauri/shogun.key`). Used to sign the `.app.tar.gz` so clients can verify `latest.json`. Env var is passed through now; the build emits no updater artifacts until the plugin is enabled. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Yes once the updater plugin ships | Passphrase for the updater signing key (blank string if you generated it without one). |
| `APPLE_API_KEY_P8_BASE64` | No | Base64-encoded **App Store Connect API** private key (`.p8` contents). |
| `APPLE_API_KEY_ID` | No | Key ID (e.g. `ABC123DEFG`) for notarization. |
| `APPLE_API_ISSUER` | No | Issuer UUID from App Store Connect → Users and Access → Keys. |

If the three `APPLE_API_*` optional secrets are all set, the workflow writes the `.p8` to a temp path and exports **`APPLE_API_KEY_PATH`**, **`APPLE_API_KEY`**, **`APPLE_API_ISSUER`** for Tauri's notarization step (see Tauri changelog: API key auth for `notarytool`). Otherwise the build is **signed only**; staple or re-run notarization locally per §4 if needed.

For day-to-day verification, use unsigned **`ci.yml`**; use **`release-macos.yml`** only when the required secrets are configured on the repository.
