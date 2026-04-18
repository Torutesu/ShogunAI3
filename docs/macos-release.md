# macOS distribution (Tauri v2)

This document outlines Developer ID signing, notarization, and shipping. Replace team IDs and certificate names with your own.

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

Add macOS bundle settings under `bundle` in `src-tauri/tauri.conf.json`. Example (use real values):

```json
"bundle": {
  "macOS": {
    "signingIdentity": "Developer ID Application: Your Name (TEAMID)",
    "entitlements": "Entitlements.plist",
    "hardenedRuntime": true
  }
}
```

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

Ship the generated `.dmg` or a stapled `.app`. Document that LLM calls send the user's API key and prompt to the configured HTTPS endpoint (see `PRIVACY.md`).

## 6. Manual gate on a clean Mac (recommended)

1. First launch with default Gatekeeper; verify quarantine warnings if any.  
2. Verify memory ingest/search, settings persistence, LLM chat (after key setup), and data deletion.  
3. **Integrations**: Google Calendar uses agent-imported Keychain tokens; optional **background sync** (`integrations` settings) and **token refresh** when `oauthClientId` + `refreshToken` are present. Cloud **Connect** rows may still return `notImplemented` — expect warn toasts.  
4. **Capture**: macOS sampler respects **sample interval** and optional **AX min interval**; grant **Accessibility** if using AX-rich capture.  
5. **Clerk**: if enabled, redirect URLs must include the app’s custom scheme (see `tauri.conf.json` / env). **Hummingbird**: `app.open_hummingbird` runs `open -a Hummingbird` — app must be installed.  
6. **Diagnostics**: Settings → Support **Report** should write a JSON file and return a **`summary`** (capture, accessibility trust, calendar integration flags).  

## CI

`.github/workflows/ci.yml` runs `check:actions`, `check:rust`, and `build:web-dist`. Signed `tauri build` is usually run locally or in a protected workflow with secrets.
