# SHOGUN Waiting List — Referral Campaign (Ops)

Implementation of the pre-launch viral waiting-list campaign. Design decisions
are final — see the constraints section before proposing changes.

## How it works

1. Visitor lands on syogun.com (optionally via `?ref=CODE`). The ref code is
   kept in `sessionStorage` so it survives navigation before signup.
2. Signup is **email only** (`POST /api/waitlist` with `{ email, ref? }`).
   The API stores `referred_by`, generates a personal `ref_code`, and returns
   `statusUrl`. The LP redirects there.
3. The status page (`/waitlist/[code]`) shows queue position and asks the
   three questions, one at a time. Answering all three sets
   `form_completed_at` — this is what makes the signup **qualified**.
4. A referral counts for the referrer only when the invited person has
   completed the form. No email verification, by design: the form is the
   junk filter.
5. Queue position is ranked by qualified referrals DESC, answered questions
   DESC, signup time ASC — so both answering and inviting genuinely move
   people up.

## Reward ladder (replacement, never additive)

| Qualified invites | Reward |
|---|---|
| 3 | 1 month free |
| 10 | 3 months free |
| 30 | 6 months free |
| Top 10 referrers at campaign close | 1 year free |

Reaching a higher tier supersedes the lower one. 3 + 10 does not make
4 months. This is stated in the official rules and on the status page.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/waitlist` | webhook secret (server) or origin allowlist + rate limit (+ optional Turnstile) | signup, accepts `ref` |
| `POST /api/waitlist/profile` | private status token | save answers, sets `form_completed_at` when all 3 present |
| `GET /api/waitlist/status?code=` | private status token | position, invites, tier, rank |
| `GET /api/waitlist/leaderboard` | public | top 10, emails masked |
| `GET /api/admin/waitlist/fraud` | admin key | referral-farming report, run before granting rewards |

Two credentials per row: the **public** `ref_code` rides on share links
and only attributes signups; the **private** `status_token` (192 bits) is
the bearer for the status page and answer writes. Full threat model:
[`SECURITY.md`](./SECURITY.md).

## Migration

```bash
psql "$DATABASE_URL" -f web/drizzle/0002_referral_campaign.sql
psql "$DATABASE_URL" -f web/drizzle/0003_security.sql
psql "$DATABASE_URL" -f web/drizzle/0004_growth.sql
```

Pre-campaign rows get their ref code + status token lazily on their next
duplicate signup, or backfill with `ensureTokens()`.

## Reward fulfillment

Free months are granted at launch as Stripe coupons/trial extensions on the
winner's subscription. Rewards are non-transferable and have no cash value —
this keeps them outside gift-card / prepaid-instrument and crypto-asset
regimes. Do not build any transfer or exchange mechanism.

Top-10 winners are determined once, at campaign close, from qualified
referral counts (ties broken by earlier signup). Announce the close date
before closing.

## KPI — read this before reporting numbers

**Raw signup count is not the KPI.** Throwaway addresses are accepted by
design, so the vanity number will inflate. The internal real number is
`form_completed_at IS NOT NULL` count:

```sql
SELECT count(*) FILTER (WHERE form_completed_at IS NOT NULL) AS real_signups,
       count(*) AS raw_signups
FROM waitlist;
```

Expect post-launch CVR against raw signups to look terrible. That is priced
in; report CVR against form-completed only.

## Legal constraints baked into this design (do not undo)

- **No lottery / no chance.** Every reward is earned by verifiable actions.
  This keeps the program out of sweepstakes law (NY/FL registration,
  Quebec RACJ, EU promotion regimes) and removes the need for bonded
  official rules. Adding any random drawing re-triggers all of it.
- **Keitōhyōji-hō (景表法):** waiting-list signup is not attached to a
  purchase → open kensho, no prize cap. If any reward ever becomes
  purchaser-only, it falls under sōzuke rules (20% of transaction value) —
  keep purchaser promos structurally separate.
- **Stealth-marketing rules (JP 2023-10) / FTC Endorsement Guides:** any
  future mechanic that rewards posting/RTs must require `#ad` or
  `#sponsored` in the participant's post as an entry condition. The current
  link-referral mechanic does not reward posting itself, so organic shares
  need no disclosure.
- **X platform rules:** never prompt repeated RTs of the same post or
  multi-account entry. One account, one entry. Ranking by referral link is
  the compliant (and higher-K) mechanic.
- **GDPR:** company/role answers are personal data. The form carries a
  one-line purpose statement + privacy policy link. Keep it.

## Copy

Full EN/JA copy pack: [`copy-en-ja.md`](./copy-en-ja.md).
Official rules (English): [`official-rules.md`](./official-rules.md).
Measurement plan + email automation: [`ANALYTICS.md`](./ANALYTICS.md).
Threat model: [`SECURITY.md`](./SECURITY.md).
Copy rules (competitor naming, banned words, tone, colors) are in the
campaign brief and apply to every user-facing string.
