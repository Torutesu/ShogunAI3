<!--
  PORTABLE REFERRAL ENGINE — copy this whole file into another project.
  Self-contained: schema + core logic + API contract + security invariants
  + porting checklist. Stack of origin: Next.js (App Router) + Drizzle ORM
  + PostgreSQL, but the design is stack-agnostic — section 9 lists what to
  swap. Extracted from SHOGUN's waitlist campaign; every non-portable
  SHOGUN detail is called out inline.
-->

# Portable Referral Engine

A referral / "skip the line" viral loop: each participant gets a public
share code and a private status token; people who join through the code
and **complete a qualifying action** count as one referral; referrers
climb a **replacement** reward ladder and a masked leaderboard, and their
queue position improves as they refer and as they answer profile
questions.

Proven properties: no lottery (all action-based → no sweepstakes law),
junk-tolerant (throwaway signups filtered by the qualifying action, not
email verification), injection/leak-hardened, and rate-limited. It has
been driven end-to-end against real Postgres.

---

## 1. The two-token invariant (never blur this)

Every participant row carries **two** credentials with strictly separate
roles. Blurring them is the one bug that breaks the whole model.

| | `ref_code` (PUBLIC) | `status_token` (PRIVATE) |
|---|---|---|
| Entropy | ~60 bits (10 chars base64url) | 192 bits (32 chars base64url) |
| Appears in | share links `/?ref=CODE`, social posts | the status-page URL only |
| Grants | attribution only (`referred_by`) | read own status, write own answers |
| If leaked | nothing — it's meant to be broadcast | that one person's dashboard |

The share button must build its URL from `ref_code`. The status page URL
holds `status_token`. **Never** let the public code be the key that reads
status or writes answers — otherwise anyone who saw a shared link can open
and tamper with the sharer's page.

---

## 2. Core concepts

- **Qualifying action** — a referral counts only after the invited person
  does something non-trivial (here: completes a 3-question profile). This
  is the anti-junk filter, replacing email verification. Swap it for
  whatever "real user" means in your product (verified email, first
  action, purchase…). Everything keys off one timestamp column:
  `qualified_at` (called `form_completed_at` in the origin code).
- **Replacement ladder** — reaching a higher tier *supersedes* the lower
  one; tiers never stack (3 + 10 ≠ 13). Put this in your rules copy.
- **Position** — ranked by (qualified referrals DESC, secondary signals
  DESC, signup time ASC). Both referring and completing the profile move
  you up, so the "answer a question, rise in line" UX is real, not fake.
- **No chance element** — every reward is earned by verifiable action, so
  the program is not a sweepstakes/lottery (avoids US state registration,
  Quebec RACJ, EU promo law, bonded official rules).

---

## 3. Schema (PostgreSQL)

Minimal portable version. Rename `participants` to your table.

```sql
CREATE TABLE participants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'pending',   -- pending|invited|converted

  -- referral engine
  ref_code       text UNIQUE,       -- PUBLIC share code
  status_token   text UNIQUE,       -- PRIVATE bearer
  referred_by    text,              -- the ref_code that referred this row
  qualified_at   timestamptz,       -- set when the qualifying action completes

  -- qualifying action = a short profile (adapt freely)
  answer_1       text,
  answer_2       text,
  answer_3       text
);

CREATE INDEX participants_ref_code_idx     ON participants (ref_code);
CREATE INDEX participants_status_token_idx ON participants (status_token);
CREATE INDEX participants_referred_by_idx  ON participants (referred_by);
```

Drizzle equivalent (origin stack):

```ts
export const participants = pgTable('participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('pending'),
  refCode: text('ref_code').unique(),
  statusToken: text('status_token').unique(),
  referredBy: text('referred_by'),
  qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
  answer1: text('answer_1'),
  answer2: text('answer_2'),
  answer3: text('answer_3'),
}, (t) => [
  index('participants_ref_code_idx').on(t.refCode),
  index('participants_status_token_idx').on(t.statusToken),
  index('participants_referred_by_idx').on(t.referredBy),
]);
```

---

## 4. Core library (copy-paste, ~stack-agnostic)

Tokens, validation, tiers, and the pure helpers have **no DB dependency**
— they port verbatim to any stack.

```ts
import { randomBytes } from 'crypto';

// --- Reward ladder. Rewards REPLACE each other; they never stack. ---
export const REFERRAL_TIERS = [
  { threshold: 3,  reward: 1,  label: '1 month free'  },
  { threshold: 10, reward: 3,  label: '3 months free' },
  { threshold: 30, reward: 6,  label: '6 months free' },
] as const;
export const TOP_REFERRER_COUNT = 10;
export const TOP_REFERRER_REWARD = { reward: 12, label: '1 year free' } as const;

// --- Tokens. Public code is short & pretty; private token is long. ---
export function generateRefCode(): string {
  return randomBytes(8).toString('base64url').slice(0, 10);   // ~60 bits
}
export function generateStatusToken(): string {
  return randomBytes(24).toString('base64url');               // 192 bits
}
export function isValidRefCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{6,16}$/.test(code);
}
export function isValidStatusToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(token);
}

// --- Ladder math. `count` = qualified referrals. ---
export function currentTier(count: number) {
  let tier: (typeof REFERRAL_TIERS)[number] | null = null;
  for (const t of REFERRAL_TIERS) if (count >= t.threshold) tier = t;
  return tier;                                    // null below the first rung
}
export function nextTier(count: number) {
  for (const t of REFERRAL_TIERS) if (count < t.threshold) return t;
  return null;                                    // null at the top
}

// --- Email masking for the public leaderboard. Output is INERT even if a
//     frontend interpolates it unescaped (alphanumeric-only visible chars). ---
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const visible = local.slice(0, 2).replace(/[^A-Za-z0-9]/g, '*');
  const tldRaw = domain?.includes('.') ? domain.slice(domain.lastIndexOf('.') + 1) : '';
  const tld = tldRaw.replace(/[^A-Za-z0-9]/g, '');
  return `${visible}***@***${tld ? '.' + tld : ''}`;
}

// --- Free-text guard: trims, rejects empties/non-strings, caps length. ---
const MAX_ANSWER_LENGTH = 1000;
export function sanitizeAnswer(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_ANSWER_LENGTH) : null;
}
```

### 4.1 Signup with referral attribution

```ts
// Invalid or self-referring codes are DROPPED silently — a bad ?ref must
// never make the signup itself fail.
export async function addParticipant(email: string, ref?: string) {
  const normalized = email.trim().toLowerCase();
  const existing = await findByEmail(normalized);
  if (existing) {
    if (!existing.refCode || !existing.statusToken) await ensureTokens(existing.id);
    return { row: existing, duplicate: true };    // returning users still get a statusUrl
  }

  let referredBy: string | null = null;
  if (ref && isValidRefCode(ref)) {
    const referrer = await findByRefCode(ref);
    if (referrer && referrer.email !== normalized) referredBy = ref;  // no self-referral
  }

  const row = await insertParticipant({
    email: normalized,
    refCode: generateRefCode(),
    statusToken: generateStatusToken(),
    referredBy,
  });
  return { row, duplicate: false };
}
```

### 4.2 The qualifying action (marks a referral valid)

```ts
// Bearer is the PRIVATE status token — never the public ref code.
export async function submitProfile(statusToken: string, answers: {
  a1?: unknown; a2?: unknown; a3?: unknown;
}) {
  const row = await findByStatusToken(statusToken);
  if (!row) return null;

  const a1 = sanitizeAnswer(answers.a1);
  const a2 = sanitizeAnswer(answers.a2);
  const a3 = sanitizeAnswer(answers.a3);

  const merged = { a1: a1 ?? row.answer1, a2: a2 ?? row.answer2, a3: a3 ?? row.answer3 };
  const complete = !!(merged.a1 && merged.a2 && merged.a3);
  const justQualified = complete && !row.qualifiedAt;   // fires exactly once

  await updateParticipant(row.id, {
    ...(a1 && { answer1: a1 }), ...(a2 && { answer2: a2 }), ...(a3 && { answer3: a3 }),
    ...(justQualified && { qualifiedAt: new Date() }),
  });
  // → if justQualified && row.referredBy: the referrer's count just moved.
  //   Fire milestone email / realtime update here (off the request path).
  return { row, justQualified };
}
```

### 4.3 Counting, ranking, leaderboard (the SQL that matters)

All parameterized — no string concatenation into SQL, ever.

```sql
-- Qualified referral count for one code
SELECT count(*)::int
FROM participants
WHERE referred_by = $1 AND qualified_at IS NOT NULL;

-- Queue position: qualified refs, then answered-questions, then signup time.
WITH scored AS (
  SELECT p.ref_code, p.created_at,
    COALESCE(r.qualified, 0) AS qualified,
    ((p.answer_1 IS NOT NULL)::int + (p.answer_2 IS NOT NULL)::int
     + (p.answer_3 IS NOT NULL)::int) AS answers
  FROM participants p
  LEFT JOIN (
    SELECT referred_by, count(*)::int AS qualified
    FROM participants
    WHERE referred_by IS NOT NULL AND qualified_at IS NOT NULL
    GROUP BY referred_by
  ) r ON r.referred_by = p.ref_code
  WHERE p.status = 'pending'
),
ranked AS (
  SELECT ref_code,
    row_number() OVER (ORDER BY qualified DESC, answers DESC, created_at ASC) AS pos,
    count(*) OVER () AS total
  FROM scored
)
SELECT pos::int, total::int FROM ranked WHERE ref_code = $1;

-- Leaderboard (mask emails in app code; never return raw email/tokens)
SELECT p.email, p.ref_code, r.qualified
FROM participants p
JOIN (
  SELECT referred_by, count(*)::int AS qualified
  FROM participants
  WHERE referred_by IS NOT NULL AND qualified_at IS NOT NULL
  GROUP BY referred_by
) r ON r.referred_by = p.ref_code
ORDER BY r.qualified DESC, p.created_at ASC
LIMIT $1;   -- clamp $1 to a sane max (e.g. 50) in code
```

---

## 5. API contract (adapt routes to your framework)

| Method + path | Auth | Purpose | Returns |
|---|---|---|---|
| `POST /signup` | origin allowlist (+ rate limit, honeypot, optional CAPTCHA) OR server webhook secret | create row, accept `ref` | `{ refCode, statusUrl }` |
| `POST /profile` | **private status token** in body | save answers → may set `qualified_at` | `{ qualified: bool }` |
| `GET /status?code=<statusToken>` | **private status token** | position, count, tier, rank | dashboard payload (NO email) |
| `GET /leaderboard` | public | top N, **masked** emails | `[{rank, maskedEmail, count}]` |
| `GET /invite-context?ref=<refCode>` | public | invited-visitor personalization | `{valid, inviter(masked), tier}` |

`POST /signup` success → **redirect the browser to `statusUrl`** (for
duplicates too). Error shape everywhere: `{ ok:false, error:"<code>" }`
with 400 / 403 / 404 / 413 / 429 / 500.

---

## 6. Security invariants (non-negotiable — all verified by live attack runs)

1. **Two-token split** (§1). Validate shape before any DB hit: a 10-char
   public code fails the status-token regex, so it can't be used as a
   bearer.
2. **Parameterized SQL only.** No string concatenation into queries.
3. **Strict email charset** — reject `<>"'`\\` etc. so a stored address
   can't carry markup/formula/header payloads downstream. Regex:
   `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$`.
4. **CSV formula-injection guard** on any export: prefix cells starting
   with `= + - @` tab/CR with `'`.
5. **Body-size cap** (~8 KB) on public POSTs → 413; reject non-object
   JSON roots.
6. **Per-IP rate limits** (fixed window; back it with the DB so it holds
   across serverless instances; fail OPEN on DB error). Behind Cloudflare
   read `CF-Connecting-IP`, not the spoofable first `X-Forwarded-For` hop.
7. **Response minimization** — status payload has no email / IP / UA;
   public endpoints expose only masked identities; private status pages
   send `X-Robots-Tag: noindex`.
8. **Self-referral & invalid ref** dropped silently at signup.
9. **Referral fraud is caught at reward time, not signup** — record a
   salted IP hash per signup and, before granting a tier, check a
   referrer's qualified invites against distinct IP hashes (many quals
   from one IP = one person farming).

---

## 7. Gamification hooks

`submitProfile` returns `justQualified`; the count query gives the live
number. Fire on the qualifying transition, off the request path:

| Trigger | Signal |
|---|---|
| answer accepted | position delta → count-up animation |
| action qualifies | `justQualified === true` → "your spot is secured" beat |
| referrer's count crosses a threshold | milestone email / realtime tick |
| tier reached | `currentTier` changes → rung lights up |
| board entry | leaderboard rank becomes non-null |

Milestone email cadence that worked: welcome, first qualified referral,
"1 more to <next reward>" nudges, and each tier confirmation — sparse on
purpose. Make the inbox and the dashboard show the **same numbers and
phrasing**.

---

## 8. Legal notes carried by this design

- Action-based only → **not a sweepstakes** (no official rules bonding,
  no US state / Quebec / EU promo registration).
- Rewards are non-transferable, no cash value → outside gift-card /
  crypto-asset regimes.
- Reward mechanics reward *link referrals*, not posting, so no `#ad`
  disclosure is needed on organic shares. If you ever pay for posts,
  require `#ad` / `#PR` as an entry condition (FTC / JP 景表法 stealth
  marketing).
- Taking any PII in the profile (company/role) → one-line purpose +
  privacy-policy link on the form (GDPR).

---

## 9. Porting checklist

- [ ] Rename `participants` and the three answer columns to your domain.
- [ ] Replace the qualifying action (3-question form) with yours; keep it
      to **one timestamp column** `qualified_at`.
- [ ] Swap Drizzle helpers (`findByRefCode`, `insertParticipant`, …) for
      your data layer — the SQL in §4.3 is the real logic; ORM is cosmetic.
- [ ] Implement rate limiting + origin allowlist + honeypot for your
      framework (see origin repo `web/src/lib/{rate-limit,waitlist-auth}.ts`).
- [ ] Wire the reward fulfillment (§8) to your billing (Stripe coupon /
      trial extension) — the engine only tracks eligibility.
- [ ] Keep §6 invariants. They're cheap and each closes a real hole.
- [ ] Reference full origin implementation:
      `web/src/lib/referral.ts`, API under `web/src/app/api/waitlist/*`,
      threat model in `SECURITY.md`, frontend contract in
      `FRONTEND_HANDOFF.md`.
