# Waitlist Campaign — Security Model

Threat model and controls for the referral waiting-list backend
(`web/src/app/api/waitlist*`, `web/src/lib/{referral,waitlist,rate-limit,
request-meta,secure-compare,turnstile,waitlist-auth}.ts`). Verified
end-to-end against a live Postgres + `next dev` instance — see the
verification matrix at the bottom.

## Token model — the core invariant

Every waitlist row has TWO credentials, and they must never swap roles:

| | `ref_code` | `status_token` |
|---|---|---|
| Visibility | **Public** — printed in share links (`syogun.com/?ref=CODE`), posted on X | **Private** — only in the owner's status URL |
| Entropy | 10 chars base64url (~60 bits) | 32 chars base64url (192 bits) |
| Grants | Attribution only: `referred_by` on new signups | Read own status, write own answers |

Why: the ref code is broadcast by design. If it also keyed the status
page (as a naive design would), anyone who saw a share link could open
the sharer's status page and overwrite their form answers. The API
enforces the split at the validation layer — a 10-char ref code fails the
status-token regex before any DB lookup.

## Entry paths for `POST /api/waitlist`

1. **Server-to-server webhook** — `x-waitlist-webhook-secret` header,
   compared in constant time (`secureCompare`: SHA-256 both sides, then
   `timingSafeEqual`). This secret must never ship in browser code. If it
   ever did (e.g. an early LP embed), rotate it.
2. **Browser, direct from LP** — no secret. Gated by:
   - **Origin allowlist** (`syogun.com`, `www`, Lovable, configured
     origins). Origin can't be forged *from a browser*, which is the actor
     that matters for CSRF-style abuse; non-browser callers fall through to:
   - **Per-IP rate limit** — 30 signups/hour/IP (below).
   - **Turnstile** (optional) — off until `TURNSTILE_SECRET_KEY` is set;
     fails closed once configured. Can be switched on under bot pressure
     without an LP redeploy beyond adding the widget.
   - **Honeypot** — hidden `website` field; a filled value returns fake
     success and stores nothing.

`/api/waitlist/profile` and `/api/waitlist/status` take the status token
as bearer and are rate-limited per IP (120/h and 300/h). The leaderboard
is public, masked, and CDN-cached for 60s.

## Rate limiting

Fixed-window counters in Postgres (`rate_limits` table, one upsert per
check) so limits hold across serverless instances — in-memory counters
don't on Vercel. **Fails open** on DB errors: losing a real signup to a
limiter outage is worse than letting a burst through (bursts are junk-
filtered by form completion anyway). Limits are env-tunable
(`RATE_LIMIT_SIGNUP/PROFILE/STATUS`); defaults are deliberately generous
because NAT'd offices and events share IPs.

## Privacy / GDPR

- **Raw IPs are never stored.** Signups record an HMAC-SHA256 of the IP
  (`IP_HASH_SALT`, server-side) truncated to 128 bits — enough to
  correlate farming, useless to reverse.
- Status API returns **no email** — an accidentally forwarded status URL
  leaks queue position and invite count, nothing personal.
- Leaderboard masks emails (`ja***@***.com`) and carries no codes/tokens.
- The form screen carries the purpose line + privacy policy link.
- User-agent stored truncated to 256 chars, for fraud review only.

## Referral fraud

Signup accepts throwaway emails **by design** (viral coefficient beats
purity pre-launch), so enforcement is moved to reward fulfillment:

- Self-referral and invalid codes are silently dropped at signup (the
  signup itself must never fail because of a bad ref).
- Qualified = form completed. A script can fake this, but every fake
  signup burns rate limit and leaves an IP-hash trail.
- `GET /api/admin/waitlist/fraud` (admin key, constant-time compared)
  reports per-referrer: qualified count, distinct IP hashes, max from one
  IP, and a `suspicious` flag (distinct IPs × 3 < qualified). Run it
  before granting any tier reward and before naming the top 10. The
  official rules reserve disqualification for exactly this.

## Headers

All routes: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, HSTS, minimal
`Permissions-Policy`. `/waitlist/*` additionally gets a strict CSP
(`default-src 'self'`, `frame-ancestors 'none'`) — scoped there because
Clerk-backed pages need looser script/frame policies.

## What was verified (33 automated checks, all passing)

Live `next dev` + Postgres 16, migrations 0001–0003 applied:

- Rejections: no origin/secret → 403, wrong secret → 401, foreign origin
  → 403, unknown token → 404.
- Happy path: webhook and browser signups, statusUrl/refCode issuance,
  3-question completion → qualified count → tier (3 invites = 1 month) →
  leaderboard.
- Token split: public ref code rejected as bearer for both status reads
  and profile writes.
- Honeypot: fake success, zero rows stored.
- Self-referral: accepted as duplicate signup, not credited.
- Rate limit: 31st signup from one IP within the hour → 429, counter
  visible in `rate_limits`.
- Fraud report: 5 qualified invites from one IP → `suspicious: true`;
  3 invites from 3 IPs → `false`. No key → 401.
- No PII leaks: no raw IPs in DB, no email in status payload or signup
  echo, masked leaderboard, no tokens in public responses.
- Headers: CSP present on `/waitlist/*`, nosniff everywhere.

Re-run: `web/` with a scratch `DATABASE_URL`, apply the three migrations,
start `next dev`, then drive the same curl matrix (kept in session notes;
the unit-test layer in `web/tests/security.test.ts` covers the pure
functions permanently).

## Deliberately NOT done

- **Email verification / activation gating** — campaign design decision:
  signup friction kills viral coefficient; the form is the filter.
- **CAPTCHA always-on** — Turnstile stays dormant until bot pressure is
  real; every point of friction costs signups.
- **IP-based blocking of referrals** — shared IPs (offices, events,
  mobile CGNAT) make it false-positive-prone; signals are recorded and
  reviewed at fulfillment instead, where a human decides.
