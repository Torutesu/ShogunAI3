# SHOGUN Web — Onboarding & Billing

Invite-only onboarding web app for SHOGUN AI.

## Flow

1. LP waitlist signup → `POST /api/waitlist` (from [shogunai.lovable.app](https://shogunai.lovable.app/))
   - Accepts optional `ref` (referrer code); returns `refCode` + `statusUrl`
   - Post-signup: `/waitlist/[code]` — 3-question form, referral link, tier ladder, leaderboard
   - Campaign design + ops: `docs/waitlist-campaign/README.md`
2. Admin invites from waitlist → `POST /api/admin/waitlist/invite`
3. User opens `/invite?token=...` → Clerk signup
4. Redirect to `/checkout` → Stripe Checkout (7-day trial)
5. Success → `/welcome` with DMG download link

## Setup

```bash
cd web
cp .env.example .env
# Fill in Clerk, Stripe, DATABASE_URL, ADMIN_API_KEY, WAITLIST_WEBHOOK_SECRET

npm install
npm run db:migrate   # requires DATABASE_URL
npm run dev          # http://localhost:3001
```

## LP waitlist webhook (Lovable)

Point your LP form webhook at:

```
POST https://app.shogun.ai/api/waitlist
```

Headers:

```
Content-Type: application/json
x-waitlist-webhook-secret: <WAITLIST_WEBHOOK_SECRET>
```

Body:

```json
{ "email": "user@example.com" }
```

Response:

```json
{ "ok": true, "duplicate": false, "email": "user@example.com", "status": "pending" }
```

CORS is enabled for `https://shogunai.lovable.app` if the LP calls the API directly from the browser.

### Lovable setup (manual)

1. Deploy `web/` to Vercel with env vars set
2. In Lovable, add a form submit action (webhook / edge function) that POSTs to `/api/waitlist`
3. Keep the LP CTA as **Request Invite** — no LP code changes required if using server-side webhook

## Admin: view waitlist

```bash
curl "http://localhost:3001/api/admin/waitlist?status=pending" \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

## Admin: invite from waitlist

Single email:

```bash
curl -X POST http://localhost:3001/api/admin/waitlist/invite \
  -H "Content-Type: application/json" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"email":"user@example.com"}'
```

Next N pending:

```bash
curl -X POST http://localhost:3001/api/admin/waitlist/invite \
  -H "Content-Type: application/json" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"limit":5}'
```

## Admin: direct invite (bypass waitlist)

```bash
curl -X POST http://localhost:3001/api/admin/invites \
  -H "Content-Type: application/json" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"email":"user@example.com"}'
```

## Stripe webhooks (local)

```bash
stripe listen --forward-to localhost:3001/api/webhooks/stripe
```

Design: `docs/superpowers/specs/2026-06-15-onboarding-billing-flow-design.md`
