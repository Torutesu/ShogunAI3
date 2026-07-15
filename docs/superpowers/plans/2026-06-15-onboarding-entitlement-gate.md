# Desktop Entitlement Gate (Phase 2) Implementation Plan

> **Status:** Implemented on branch `feat/onboarding-billing-web`

**Goal:** Block app access until the user has an active trial or subscription, verified via the web `GET /api/entitlement` endpoint.

**Architecture:** `EntitlementGate` in `AppCore` runs after TOS consent. When `SHOGUN_WEB_APP_URL` is set, Clerk session JWT is sent to the web API. Results are cached in `settings.json` → `sections.billing` with 24h offline grace.

---

## Files changed

| File | Change |
|---|---|
| `src/app/EntitlementGate.tsx` | Gate UI + entitlement check loop |
| `src/app/AppCore.tsx` | Wrap `MainApp` with `EntitlementGate` |
| `src/shared/lib/entitlement.ts` | Fetch, cache, grace logic |
| `src/shared/lib/entitlement.test.ts` | Unit tests (7) |
| `src/shared/lib/clerk-auth.ts` | `getSessionToken()` |
| `src-tauri/src/auth.rs` | `billing_config()` |
| `src-tauri/src/commands/auth.rs` | `billing_config`, `billing_open_url` |
| `src-tauri/src/settings_store.rs` | `sections.billing` defaults |
| `.env.example` | `SHOGUN_WEB_APP_URL` |

---

## Configuration

```bash
# .env (repo root, for Tauri build)
SHOGUN_WEB_APP_URL=https://app.shogun.ai   # use localhost only for local web dev
CLERK_PUBLISHABLE_KEY=...
CLERK_FRONTEND_API=...
```

When `SHOGUN_WEB_APP_URL` is **empty**, the gate is bypassed (local dev without billing).

---

## Gate states

| State | Behavior |
|---|---|
| bypass | No web URL configured → MainApp |
| unauthenticated | Sign in / Sign up via Clerk |
| paywall | Open `{webAppUrl}/account` in browser |
| ok | trialing or active → MainApp |
| error | Retry button |

---

## Manual test checklist

- [ ] Without `SHOGUN_WEB_APP_URL`: app loads normally after consent
- [ ] With URL + signed out: sign-in screen appears
- [ ] With URL + signed in + no sub: paywall with Manage billing
- [ ] With URL + trialing sub: MainApp loads
- [ ] Disconnect network within 24h of last check: app still loads (cache grace)
- [ ] After 24h offline with no network: paywall or error

---

## Next: Phase 3 — MCP Setup Wizard

See `docs/superpowers/specs/2026-06-15-onboarding-billing-flow-design.md` § MCP Setup Wizard.
