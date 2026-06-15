# Onboarding & Billing Flow — Design

## Goal

Implement a staged SaaS onboarding path for SHOGUN AI:

**LP (external) → Waitlist → Invite email → Web signup → Stripe card → App download → MCP setup → 7-day trial (starts at checkout) → Auto billing**

The existing LP at [shogunai.lovable.app](https://shogunai.lovable.app/) stays on **invite-only / waitlist** during gradual rollout. Invited users enter paid onboarding via a dedicated web page (`app.shogun.ai/invite?token=xxx`).

## Decisions

Resolved during brainstorming on 2026-06-15:

| # | Question | Decision |
|---|---|---|
| 1 | LP location | External Lovable site: `shogunai.lovable.app` (connect later) |
| 2 | Rollout strategy | **B — Gradual:** keep waitlist; admin sends invite emails to selected users |
| 3 | Invite entry point | **A — Dedicated web page:** `app.shogun.ai/invite?token=xxx` |
| 4 | Trial start timing | **A — At Stripe Checkout:** `trial_period_days: 7` when card is registered |
| 5 | Execution model | **Hybrid:** Web for signup + billing; Desktop for MCP wizard + entitlement gate |
| 6 | Web stack | New `web/` subproject in ShogunAI3 repo (Next.js App Router) |
| 7 | Auth | Reuse existing **Clerk** (same application as desktop) |
| 8 | Payments | **Stripe** Checkout + Customer Portal + Webhooks |
| 9 | Database | **Postgres** (Neon or Supabase) |

## Open Items (before production)

| Item | Status |
|---|---|
| Monthly price / Stripe Price ID | TBD — use env var `STRIPE_PRICE_ID` |
| Domain `app.shogun.ai` DNS | TBD — deploy target Vercel |
| Stripe / Clerk production keys | TBD |
| DMG download URL | TBD — GitHub Releases or CDN env var |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ External                                                         │
│  shogunai.lovable.app (LP, waitlist)                            │
└────────────────────────────┬────────────────────────────────────┘
                             │ Request Invite (Phase 4 webhook)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ web/ — Next.js on Vercel (app.shogun.ai)                        │
│                                                                  │
│  /invite?token=xxx  →  Clerk SignUp  →  Stripe Checkout         │
│  /welcome           →  DMG download link                         │
│  /account           →  subscription status + Customer Portal     │
│                                                                  │
│  API Routes:                                                     │
│    POST /api/admin/invites      (admin auth)                     │
│    GET  /api/invites/validate   (public, token check)            │
│    POST /api/checkout/session   (Clerk JWT required)             │
│    POST /api/webhooks/stripe    (Stripe signature)               │
│    GET  /api/entitlement        (Clerk JWT, desktop client)      │
│                                                                  │
│  Postgres: waitlist, invites, users, subscriptions               │
└────────────────────────────┬────────────────────────────────────┘
                             │ Stripe webhooks
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stripe                                                           │
│  Checkout (trial_period_days: 7) → Subscription → auto charge    │
└────────────────────────────┬────────────────────────────────────┘
                             │ DMG download
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ ShogunAI3 Desktop (Tauri)                                        │
│                                                                  │
│  AppCore: Consent → EntitlementGate → McpSetupWizard → MainApp  │
│  Entitlement: GET /api/entitlement (Clerk session JWT)           │
│  Offline grace: 24h from last successful check                   │
└─────────────────────────────────────────────────────────────────┘
```

### Design principles (aligned with cloud architecture)

1. **Local is source of truth** — entitlement only gates app access; memory stays on device.
2. **Minimal server data** — store Clerk user ID, Stripe IDs, subscription status only. No capture data.
3. **BYOK preserved** — billing is separate from LLM key storage (Keychain).

---

## Invite Flow

### Admin creates invite

1. Admin calls `POST /api/admin/invites` with `{ email }` (protected by `ADMIN_API_KEY` header).
2. Server generates a cryptographically random token (32 bytes, base64url).
3. Server inserts row into `invites` with `expires_at = now() + 7 days`.
4. Response includes full URL: `https://app.shogun.ai/invite?token=<token>`.

Admin sends this URL via email manually (Phase 1). Phase 2 adds optional Resend/SendGrid integration.

### User redeems invite

1. `GET /invite?token=xxx` — page calls `GET /api/invites/validate?token=xxx`.
2. If invalid/expired/used → error UI with support link.
3. If valid → show Clerk `<SignUp />` restricted to the invite email (prefilled, read-only).
4. On Clerk signup complete → redirect to `/checkout`.
5. `/checkout` creates Stripe Checkout Session with:
   - `mode: 'subscription'`
   - `trial_period_days: 7`
   - `payment_method_collection: 'always'`
   - `customer_email` or existing Stripe customer
   - `success_url: /welcome?session_id={CHECKOUT_SESSION_ID}`
   - `cancel_url: /checkout?canceled=1`
6. Stripe webhook `checkout.session.completed` → upsert `users` + `subscriptions`, mark invite `used_at`.
7. `/welcome` shows download button + MCP setup instructions.

### Email match enforcement

After Clerk signup, server verifies `Clerk.user.primaryEmailAddress` matches `invites.email` (case-insensitive). Mismatch → block checkout and show error.

---

## Database Schema

```sql
CREATE TABLE waitlist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  invited_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'invited', 'converted'))
);

CREATE TABLE invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token         TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  clerk_user_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX invites_token_idx ON invites (token);
CREATE INDEX invites_email_idx ON invites (email);

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id       TEXT NOT NULL UNIQUE,
  email               TEXT NOT NULL,
  stripe_customer_id  TEXT UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id),
  stripe_subscription_id  TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL
                          CHECK (status IN ('trialing','active','past_due','canceled','unpaid')),
  trial_end               TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_user_id_idx ON subscriptions (user_id);
```

---

## API Contracts

### `GET /api/invites/validate?token=`

**Response 200 (valid):**
```json
{ "ok": true, "email": "user@example.com", "expiresAt": "2026-06-22T00:00:00Z" }
```

**Response 404:**
```json
{ "ok": false, "error": "invalid_or_expired" }
```

### `POST /api/checkout/session`

**Headers:** `Authorization: Bearer <clerk_session_jwt>`

**Body:**
```json
{ "inviteToken": "..." }
```

**Response 200:**
```json
{ "url": "https://checkout.stripe.com/..." }
```

### `GET /api/entitlement`

**Headers:** `Authorization: Bearer <clerk_session_jwt>`

**Response 200:**
```json
{
  "status": "trialing",
  "trialEnd": "2026-06-22T00:00:00Z",
  "currentPeriodEnd": "2026-07-22T00:00:00Z",
  "manageUrl": "https://billing.stripe.com/..."
}
```

**Response 200 (no subscription):**
```json
{ "status": "none" }
```

Entitlement is **granted** when `status` is `trialing` or `active`.

### Stripe Webhooks handled

| Event | Action |
|---|---|
| `checkout.session.completed` | Create/update user + subscription; mark invite used |
| `customer.subscription.updated` | Sync status, trial_end, current_period_end |
| `customer.subscription.deleted` | Set status `canceled` |
| `invoice.payment_failed` | Set status `past_due` |

---

## Web Pages

| Route | Purpose |
|---|---|
| `/invite` | Token validation + Clerk SignUp |
| `/checkout` | Create Stripe session + redirect |
| `/welcome` | Post-checkout success + DMG link |
| `/account` | Subscription status + Stripe Customer Portal |

UI should match SHOGUN brand (dark, minimal). Japanese + English via `Accept-Language` or toggle (consistent with LP).

---

## Desktop Changes

### Entitlement Gate (`AppCore.tsx`)

Insert after legal consent gate, before `MainApp`:

```
Consent OK → EntitlementGate → MainApp (or McpSetupWizard first)
```

**EntitlementGate states:**

| State | UI |
|---|---|
| `loading` | Splash |
| `unauthenticated` | Clerk sign-in (reuse `ShogunClerkAuth`) |
| `no_subscription` | Paywall: open `app.shogun.ai/checkout` in browser |
| `expired` | Same paywall + manage billing link |
| `ok` | Proceed to MCP wizard or MainApp |

**Offline grace:** Cache last successful entitlement response in `settings.json` under `sections.billing` with `checkedAt`. If API unreachable and `checkedAt` within 24h, allow access.

### MCP Setup Wizard

New component modeled on `PaneCloudMirror.tsx` 4-step wizard:

1. **Detect Claude Desktop** — check `~/Library/Application Support/Claude/claude_desktop_config.json`
2. **Locate binary** — default `{app bundle}/Contents/MacOS/shogun-mcp` or dev path
3. **Write config** — merge `shogun` MCP server entry (backup existing JSON)
4. **Verify** — run smoke test or show manual test instructions

Persist completion in `settings.json` → `sections.onboarding.mcpComplete = true`.

Gate order: Entitlement OK → if `!mcpComplete` show wizard → MainApp.

### New Tauri commands (optional Phase 3)

| Command | Purpose |
|---|---|
| `mcp_detect_claude_config` | Return path + parsed JSON |
| `mcp_write_claude_config` | Merge shogun entry with backup |
| `mcp_binary_path` | Resolve shogun-mcp path |

---

## LP Integration (Phase 4 — later)

Keep LP CTA as **Request Invite**. Phase 4 adds:

1. Lovable form webhook → `POST /api/waitlist` → insert `waitlist` row.
2. Admin dashboard or CLI to bulk-invite from waitlist.
3. Optional: auto-invite when spots available (counter on LP).

No LP changes required for Phase 1–3.

---

## Security

| Concern | Mitigation |
|---|---|
| Invite token guessing | 32-byte random token; rate-limit validate endpoint |
| Admin API abuse | `ADMIN_API_KEY` env var; IP allowlist optional |
| Stripe webhook spoofing | Verify `stripe-signature` header |
| Email mismatch | Enforce invite email === Clerk primary email |
| Desktop entitlement bypass | Server-side check; 24h offline grace only |

---

## Implementation Phases

| Phase | Scope | Deliverable |
|---|---|---|
| **1** | `web/` subproject | Invite → SignUp → Stripe → Welcome |
| **2** | Desktop entitlement gate | App blocks without trialing/active sub |
| **3** | MCP setup wizard | Post-signup Claude Desktop connection |
| **4** | LP waitlist webhook | Auto-ingest from Lovable form |

Plans:

- Phase 1: `docs/superpowers/plans/2026-06-15-onboarding-billing-web.md`
- Phase 2: `docs/superpowers/plans/2026-06-15-onboarding-entitlement-gate.md` (to be written)
- Phase 3: `docs/superpowers/plans/2026-06-15-mcp-setup-wizard.md` (to be written)

---

## Testing Strategy

### Web (Phase 1)

- Unit: invite token validation, email match logic
- Integration: Stripe webhook handler with `stripe-mock` or test fixtures
- E2E: Playwright flow invite → signup (Clerk test user) → Stripe test mode checkout

### Desktop (Phase 2–3)

- Vitest: EntitlementGate state machine
- Manual: trialing / expired / offline grace scenarios
- MCP wizard: fixture JSON read/write tests in Rust

---

## References

- LP: https://shogunai.lovable.app/
- Existing Clerk: `src/shared/lib/clerk-auth.ts`, `.env.example`
- Cloud Mirror wizard pattern: `src/features/settings/panels/PaneCloudMirror.tsx`
- MCP setup docs: `docs/mcp-claude-desktop-setup.md`
- Cloud architecture principles: `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md`
