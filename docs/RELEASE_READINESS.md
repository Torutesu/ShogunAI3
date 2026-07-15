# Release readiness

This file tracks what must be true before Shogun AI is sold or broadly released.

## Current shipping posture

- **Closed beta / early paid pilot:** allowed if users understand the build may be unsigned and must provide their own LLM API keys.
- **Public paid macOS release:** blocked until Developer ID signing, notarization, updater signing, and purchase entitlement are configured outside the repo.

## Automated gate

Run before every release candidate:

```bash
npm run release:preflight
```

Run before public paid distribution:

```bash
npm run release:preflight:public
```

The beta gate checks version sync, Tauri bundle configuration, bundled legal documents, updater metadata, Info.plist usage strings, CI/release workflow presence, and placeholder package metadata. Default desktop builds intentionally leave updater artifacts disabled so unsigned beta DMGs can be produced without `TAURI_SIGNING_PRIVATE_KEY`; public releases enable updater artifacts through `src-tauri/tauri.updater.json`. The public gate additionally requires signing, updater signing, notarization configuration, and removal of unsigned-beta copy from the main README.

## Must be solved before public sale

1. **Apple Developer ID signing and notarization**
   - Configure `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and App Store Connect notarization secrets in GitHub Actions.
   - Verify a clean Mac can open the DMG without Gatekeeper bypass steps.

2. **Updater signing**
   - Configure `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
   - Confirm `latest.json` is attached to a draft release and accepted by the in-app updater.

3. **Purchase and entitlement**
   - Choose the first sales path: invite-only manual license, Stripe, Lemon Squeezy, or another reseller.
   - Decide whether entitlement is enforced in app, in account login, or only operationally during the first paid pilot.

4. **Legal/commercial review**
   - Review `LICENSE`, `PRIVACY.md`, `docs/PRIVACY.ja.md`, `docs/TERMS_OF_SERVICE.md`, and `docs/TERMS_OF_SERVICE_EN.md`.
   - Ensure the privacy documents match the current no-screenshot, text-only capture policy.

5. **Support and incident response**
   - Keep Settings -> Support diagnostics working.
   - Publish a support email or form on the download page and in purchase receipts.

6. **Clean-machine QA**
   - Install from the release DMG on a fresh macOS user account.
   - Verify consent, permissions, text capture, KIOKU ingestion/search, API-key setup, provider fallback, rate-limit pause behavior, data deletion, and update check.

## Can ship after beta

- OAuth integrations beyond the working/local paths can remain labeled as planned or coming soon.
- Team administration can stay planned unless team billing is the launch offer.
- Cloud Mirror can stay off by default until the privacy/commercial promise is settled.
