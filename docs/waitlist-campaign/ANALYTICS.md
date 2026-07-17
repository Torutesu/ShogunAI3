# Waitlist Campaign — Measurement & Email Automation

Everything here is free-tier. Hosting assumption: LP on **Cloudflare
Pages** (`lp/deploy.sh`, already wired), the Next.js app on Vercel or any
Node host — the code detects both edges.

## The three measurement layers

### 1. Server-side attribution (always on, zero config, zero consent)

Every signup row records, without any client script:

| Column | Source | Answers |
|---|---|---|
| `signup_country` | `CF-IPCountry` (Cloudflare) / `x-vercel-ip-country` | which countries convert |
| `utm_source/medium/campaign` | `?utm_*` on the LP, carried through signup | which channels convert |
| `referred_by` | `?ref=` | referral vs organic split |
| `locale` | LP language (`lang`) → fallback Accept-Language | EN/JA mix |
| `form_completed_at` | the 3-question form | the real KPI |
| `signup_ip_hash` | HMAC of IP (never raw) | fraud review only |

This is the layer you trust: ad blockers can't remove it, no cookie
banner is involved (aggregate ops data, hashed IPs), and it survives any
analytics-vendor decision.

**Dashboard:** `GET /api/admin/waitlist/stats` (admin key) returns
totals, per-day series (30d), country and UTM breakdowns, tiers-reached
counts, and `viralShare` (referred / raw — above 0.5 the loop feeds
itself). Pipe it to `jq`, a spreadsheet, or a later internal page:

```bash
curl -s https://app.../api/admin/waitlist/stats -H "x-admin-api-key: $ADMIN_API_KEY" | jq .totals
```

### 2. Cloudflare Web Analytics (LP traffic — free, no code)

The LP is on Cloudflare Pages, so enable **Web Analytics** in the
Cloudflare dashboard (Pages project → Metrics, or Analytics → Web
Analytics). Cookie-less, no consent banner needed, auto-injected — gives
pageviews, referrers, countries, and Core Web Vitals for the LP itself.
This covers "who lands", layer 1 covers "who converts".

### 3. PostHog funnel events (free tier, optional but wired)

Already integrated behind env keys — no key, no script, no cost:

- LP (`window.SHOGUN_POSTHOG_KEY`): `waitlist_signup`
  `{duplicate, referred, utm_*}`
- Status page (`NEXT_PUBLIC_POSTHOG_KEY`): pageviews +
  `waitlist_form_answered` `{question}`, `waitlist_link_copied`,
  `waitlist_share_x`

The funnel to watch: LP view → `waitlist_signup` → `waitlist_form_answered`
×3 → `waitlist_link_copied` / `waitlist_share_x`. Drop-off between signup
and first answer is the number to fight — that's the qualification gate.

### GA4?

Not recommended for launch: layer 1+2 already answer geography/channel
questions without a consent banner, GA4 requires one in the EU (and
loses ~30% of traffic to ad blockers), and its referral data is worse
than our server-side `referred_by`. If marketing later needs Google Ads
integration, add GA4 with Consent Mode then — nothing here conflicts.

## UTM conventions

Tag every push: `?utm_source=x&utm_medium=social&utm_campaign=launch`
(`x`, `producthunt`, `hn`, `newsletter`, …). Referral links get UTMs
automatically only if the sharer's template includes them — the share
templates deliberately keep bare URLs, so referral traffic shows up as
`utm_source=direct` + `referred=true`, which is the correct reading.

## Email automation (gamification loop)

Sender: Resend HTTP API (free: 100/day, 3k/month), `RESEND_API_KEY` +
`EMAIL_FROM`. **Unset = every send is logged, not sent** — the pipeline
runs in dev/preview safely. Vendor is swappable behind
`src/lib/email.ts`'s single function.

| Trigger | Kind | Email |
|---|---|---|
| fresh signup | `welcome` | status link + full ladder |
| 1st qualified invite | `invite_1` | "Your first invite counted." |
| 2 invites | `near_tier_3` | "1 more to 1 month free." |
| 3 invites | `tier_3` | tier confirmation |
| 9 invites | `near_tier_10` | "1 more to 3 months free." |
| 10 invites | `tier_10` | tier confirmation |
| 29 invites | `near_tier_30` | "1 more to 6 months free." |
| 30 invites | `tier_30` | tier confirmation |

Design properties:

- **Idempotent** — `notifications` table claims `(person, kind)` with a
  unique constraint BEFORE sending; concurrent qualifying signups can't
  double-send. At-most-once: a crashed send is dropped, not retried.
- **Off the critical path** — sends run via `after()`, post-response.
- **Sparse on purpose** — nudges only at one-away points. More email =
  trained-to-ignore.
- **Opt-out** — every footer links
  `GET /api/waitlist/unsubscribe?token=…` (one click, works from mail
  clients, keeps the waitlist entry). Milestone emails respect it;
  required under 特定電子メール法 / CAN-SPAM anyway.
- **EN/JA** — template language follows the signup's `locale`.
- The final top-10 email (campaign close) is deliberately manual — it
  requires the human fraud review first (`/api/admin/waitlist/fraud`).

Resend setup: verify the `syogun.com` sending domain (SPF + DKIM records
in Cloudflare DNS), set `EMAIL_FROM=SHOGUN <no-reply@syogun.com>`. Watch
the 100/day free cap against signup volume; the welcome email is the
first thing to throttle if it's ever hit (milestones are rarer and worth
more).

## Cloudflare deployment notes

- LP: already Cloudflare Pages (`lp/deploy.sh`). `_headers` carries the
  security headers.
- App behind Cloudflare: client IP is read from `CF-Connecting-IP`
  (first XFF hop is client-spoofable behind Cloudflare — already
  handled in `request-meta.ts`). No other change needed.
- If the app itself moves to Cloudflare (Workers/Pages): `postgres`-js
  needs Hyperdrive or a serverless driver (Neon/Supabase pooler), and
  Clerk/Stripe SDKs need the edge-compatible setup — treat that as its
  own migration, not a flag flip.
