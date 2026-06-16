# Onboarding Billing Web (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `web/` Next.js app that powers invite-only onboarding: validate invite token → Clerk signup → Stripe Checkout (7-day trial) → welcome/download page.

**Architecture:** New `web/` subproject in the ShogunAI3 repo. Next.js App Router with API routes, Drizzle ORM + Postgres, Clerk for auth, Stripe for billing. Admin creates invites via API key–protected endpoint.

**Tech Stack:** Next.js 15, TypeScript, Drizzle ORM, Postgres (Neon), Clerk (`@clerk/nextjs`), Stripe (`stripe`), Vitest, Playwright

**Design spec:** `docs/superpowers/specs/2026-06-15-onboarding-billing-flow-design.md`

---

## File Structure

```
web/
├── package.json
├── tsconfig.json
├── next.config.ts
├── drizzle.config.ts
├── .env.example
├── src/
│   ├── app/
│   │   ├── layout.tsx              # ClerkProvider, global styles
│   │   ├── page.tsx                # redirect → /account or marketing stub
│   │   ├── invite/page.tsx         # token validation + SignUp
│   │   ├── checkout/page.tsx       # create session + redirect
│   │   ├── welcome/page.tsx        # success + DMG download
│   │   ├── account/page.tsx        # sub status + portal link
│   │   └── api/
│   │       ├── admin/invites/route.ts
│   │       ├── invites/validate/route.ts
│   │       ├── checkout/session/route.ts
│   │       ├── entitlement/route.ts
│   │       └── webhooks/stripe/route.ts
│   ├── db/
│   │   ├── index.ts                # drizzle client
│   │   └── schema.ts               # tables from design spec
│   ├── lib/
│   │   ├── invites.ts              # token gen, validate, mark used
│   │   ├── stripe.ts               # stripe client singleton
│   │   ├── admin-auth.ts           # ADMIN_API_KEY check
│   │   └── email-match.ts          # invite email vs clerk email
│   └── middleware.ts               # Clerk middleware
├── drizzle/
│   └── 0001_init.sql               # generated migration
└── tests/
    ├── invites.test.ts
    └── webhook.test.ts
```

---

### Task 1: Scaffold `web/` Next.js project

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/next.config.ts`
- Create: `web/.env.example`

- [ ] **Step 1: Create directory and init package**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
mkdir -p web/src/app
cd web
npm init -y
npm install next@15 react react-dom @clerk/nextjs stripe drizzle-orm postgres
npm install -D typescript @types/react @types/node drizzle-kit vitest @vitejs/plugin-react
```

- [ ] **Step 2: Add scripts to `web/package.json`**

```json
{
  "name": "shogun-web",
  "private": true,
  "scripts": {
    "dev": "next dev --port 3001",
    "build": "next build",
    "start": "next start",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create `web/.env.example`**

```bash
# Clerk (same app as desktop)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...

# Database
DATABASE_URL=postgresql://user:pass@host/shogun

# Admin
ADMIN_API_KEY=change-me-in-production

# App URLs
NEXT_PUBLIC_APP_URL=http://localhost:3001
NEXT_PUBLIC_DMG_DOWNLOAD_URL=https://github.com/org/shogun/releases/latest/download/ShogunAI.dmg
```

- [ ] **Step 5: Verify dev server starts**

```bash
cd web && npm run dev
```

Expected: Next.js starts on port 3001 (may show default page after layout added in Task 2).

---

### Task 2: Database schema + Drizzle

**Files:**
- Create: `web/drizzle.config.ts`
- Create: `web/src/db/schema.ts`
- Create: `web/src/db/index.ts`

- [ ] **Step 1: Write failing schema export test**

Create `web/tests/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { invites, users, subscriptions, waitlist } from '../src/db/schema';

describe('schema', () => {
  it('exports all tables', () => {
    expect(invites).toBeDefined();
    expect(users).toBeDefined();
    expect(subscriptions).toBeDefined();
    expect(waitlist).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test
```

Expected: FAIL — cannot find module `../src/db/schema`

- [ ] **Step 3: Implement `web/src/db/schema.ts`**

```typescript
import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';

export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  invitedAt: timestamp('invited_at', { withTimezone: true }),
  status: text('status').notNull().default('pending'),
});

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: text('token').notNull().unique(),
  email: text('email').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  clerkUserId: text('clerk_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('invites_token_idx').on(t.token),
  index('invites_email_idx').on(t.email),
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  status: text('status').notNull(),
  trialEnd: timestamp('trial_end', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('subscriptions_user_id_idx').on(t.userId),
]);
```

- [ ] **Step 4: Implement `web/src/db/index.ts`**

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });
```

- [ ] **Step 5: Create `web/drizzle.config.ts`**

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 6: Run tests**

```bash
cd web && npm test
```

Expected: PASS

- [ ] **Step 7: Generate migration (requires DATABASE_URL in `.env`)**

```bash
cd web && npm run db:generate && npm run db:migrate
```

---

### Task 3: Invite token library

**Files:**
- Create: `web/src/lib/invites.ts`
- Create: `web/tests/invites.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { generateInviteToken, normalizeEmail } from '../src/lib/invites';

describe('generateInviteToken', () => {
  it('returns 43-char base64url string', () => {
    const token = generateInviteToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `web/src/lib/invites.ts`**

```typescript
import { randomBytes } from 'crypto';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { db } from '@/db';
import { invites } from '@/db/schema';

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function validateInviteToken(token: string) {
  const row = await db.query.invites.findFirst({
    where: and(
      eq(invites.token, token),
      isNull(invites.usedAt),
      gt(invites.expiresAt, new Date()),
    ),
  });
  if (!row) return null;
  return { email: row.email, expiresAt: row.expiresAt };
}

export async function createInvite(email: string, expiresInDays = 7) {
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  const [row] = await db.insert(invites).values({
    token,
    email: normalizeEmail(email),
    expiresAt,
  }).returning();
  return row;
}

export async function markInviteUsed(token: string, clerkUserId: string) {
  await db.update(invites)
    .set({ usedAt: new Date(), clerkUserId })
    .where(eq(invites.token, token));
}
```

- [ ] **Step 4: Run tests — expect PASS**

---

### Task 4: Admin invite API

**Files:**
- Create: `web/src/lib/admin-auth.ts`
- Create: `web/src/app/api/admin/invites/route.ts`

- [ ] **Step 1: Implement admin auth helper**

```typescript
// web/src/lib/admin-auth.ts
import { NextRequest } from 'next/server';

export function assertAdmin(req: NextRequest): Response | null {
  const key = req.headers.get('x-admin-api-key');
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
```

- [ ] **Step 2: Implement POST handler**

```typescript
// web/src/app/api/admin/invites/route.ts
import { NextRequest } from 'next/server';
import { assertAdmin } from '@/lib/admin-auth';
import { createInvite } from '@/lib/invites';

export async function POST(req: NextRequest) {
  const denied = assertAdmin(req);
  if (denied) return denied;

  const body = await req.json();
  const email = String(body.email || '').trim();
  if (!email.includes('@')) {
    return Response.json({ ok: false, error: 'invalid_email' }, { status: 400 });
  }

  const invite = await createInvite(email);
  const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
  return Response.json({
    ok: true,
    inviteUrl: `${base}/invite?token=${invite.token}`,
    email: invite.email,
    expiresAt: invite.expiresAt,
  });
}
```

- [ ] **Step 3: Manual test**

```bash
curl -X POST http://localhost:3001/api/admin/invites \
  -H "Content-Type: application/json" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"email":"test@example.com"}'
```

Expected: `{ "ok": true, "inviteUrl": "..." }`

---

### Task 5: Invite validate API + invite page

**Files:**
- Create: `web/src/app/api/invites/validate/route.ts`
- Create: `web/src/app/invite/page.tsx`
- Create: `web/src/middleware.ts`
- Create: `web/src/app/layout.tsx`

- [ ] **Step 1: Validate API**

```typescript
// web/src/app/api/invites/validate/route.ts
import { NextRequest } from 'next/server';
import { validateInviteToken } from '@/lib/invites';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') || '';
  if (!token) {
    return Response.json({ ok: false, error: 'missing_token' }, { status: 400 });
  }
  const invite = await validateInviteToken(token);
  if (!invite) {
    return Response.json({ ok: false, error: 'invalid_or_expired' }, { status: 404 });
  }
  return Response.json({ ok: true, email: invite.email, expiresAt: invite.expiresAt });
}
```

- [ ] **Step 2: Clerk middleware**

```typescript
// web/src/middleware.ts
import { clerkMiddleware } from '@clerk/nextjs/server';

export default clerkMiddleware();
export const config = {
  matcher: ['/checkout(.*)', '/welcome(.*)', '/account(.*)', '/api/checkout(.*)', '/api/entitlement(.*)'],
};
```

- [ ] **Step 3: Root layout with ClerkProvider**

```tsx
// web/src/app/layout.tsx
import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'SHOGUN AI' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body style={{ margin: 0, background: '#0a0908', color: '#f5f0eb', fontFamily: 'system-ui, sans-serif' }}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
```

- [ ] **Step 4: Invite page with SignUp**

```tsx
// web/src/app/invite/page.tsx
'use client';

import { SignUp } from '@clerk/nextjs';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function InvitePage() {
  const params = useSearchParams();
  const token = params.get('token') || '';
  const [state, setState] = useState<'loading' | 'valid' | 'invalid'>('loading');
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (!token) { setState('invalid'); return; }
    fetch(`/api/invites/validate?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) { setEmail(data.email); setState('valid'); }
        else setState('invalid');
      })
      .catch(() => setState('invalid'));
  }, [token]);

  if (state === 'loading') return <main style={{ padding: 48 }}>Loading…</main>;
  if (state === 'invalid') return <main style={{ padding: 48 }}>Invalid or expired invite.</main>;

  return (
    <main style={{ padding: 48, maxWidth: 480, margin: '0 auto' }}>
      <h1>SHOGUN AI — Early Access</h1>
      <p>Signed up as <strong>{email}</strong></p>
      <SignUp
        routing="hash"
        forceRedirectUrl={`/checkout?inviteToken=${encodeURIComponent(token)}`}
        initialValues={{ emailAddress: email }}
      />
    </main>
  );
}
```

---

### Task 6: Stripe Checkout session

**Files:**
- Create: `web/src/lib/stripe.ts`
- Create: `web/src/lib/email-match.ts`
- Create: `web/src/app/api/checkout/session/route.ts`
- Create: `web/src/app/checkout/page.tsx`

- [ ] **Step 1: Stripe singleton**

```typescript
// web/src/lib/stripe.ts
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-04-30.basil',
});
```

- [ ] **Step 2: Checkout session API**

```typescript
// web/src/app/api/checkout/session/route.ts
import { auth, currentUser } from '@clerk/nextjs/server';
import { stripe } from '@/lib/stripe';
import { validateInviteToken, normalizeEmail, markInviteUsed } from '@/lib/invites';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const user = await currentUser();
  const primaryEmail = user?.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress;
  if (!primaryEmail) return Response.json({ ok: false, error: 'no_email' }, { status: 400 });

  const { inviteToken } = await req.json();
  const invite = inviteToken ? await validateInviteToken(String(inviteToken)) : null;
  if (!invite) return Response.json({ ok: false, error: 'invalid_invite' }, { status: 403 });
  if (normalizeEmail(primaryEmail) !== normalizeEmail(invite.email)) {
    return Response.json({ ok: false, error: 'email_mismatch' }, { status: 403 });
  }

  const base = process.env.NEXT_PUBLIC_APP_URL!;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: primaryEmail,
    line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
    subscription_data: { trial_period_days: 7 },
    payment_method_collection: 'always',
    success_url: `${base}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout?inviteToken=${encodeURIComponent(String(inviteToken))}`,
    metadata: { clerkUserId: userId, inviteToken: String(inviteToken) },
  });

  return Response.json({ ok: true, url: session.url });
}
```

- [ ] **Step 3: Checkout page (auto-redirect)**

```tsx
// web/src/app/checkout/page.tsx
'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function CheckoutPage() {
  const params = useSearchParams();
  const inviteToken = params.get('inviteToken') || '';
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteToken }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.url) window.location.href = data.url;
        else setError(data.error || 'checkout_failed');
      })
      .catch(() => setError('network_error'));
  }, [inviteToken]);

  if (error) return <main style={{ padding: 48 }}>Checkout error: {error}</main>;
  return <main style={{ padding: 48 }}>Redirecting to secure checkout…</main>;
}
```

---

### Task 7: Stripe webhook handler

**Files:**
- Create: `web/src/app/api/webhooks/stripe/route.ts`
- Create: `web/tests/webhook.test.ts` (handler unit tests with mocked stripe events)

- [ ] **Step 1: Webhook route**

Implement handler per design spec:
- Verify signature with `STRIPE_WEBHOOK_SECRET`
- On `checkout.session.completed`: upsert `users`, insert `subscriptions` with status `trialing`, call `markInviteUsed`
- On `customer.subscription.updated/deleted`: sync subscription row

- [ ] **Step 2: Local webhook test with Stripe CLI**

```bash
stripe listen --forward-to localhost:3001/api/webhooks/stripe
# Complete a test checkout; verify rows in DB
```

---

### Task 8: Welcome + Account + Entitlement API

**Files:**
- Create: `web/src/app/welcome/page.tsx`
- Create: `web/src/app/account/page.tsx`
- Create: `web/src/app/api/entitlement/route.ts`

- [ ] **Step 1: Welcome page with DMG download**

```tsx
// web/src/app/welcome/page.tsx
export default function WelcomePage() {
  const dmg = process.env.NEXT_PUBLIC_DMG_DOWNLOAD_URL!;
  return (
    <main style={{ padding: 48, maxWidth: 560, margin: '0 auto' }}>
      <h1>Welcome to SHOGUN AI</h1>
      <p>Your 7-day trial has started. Download the app and connect Claude Desktop.</p>
      <a href={dmg} style={{ display: 'inline-block', marginTop: 24, padding: '12px 24px', background: '#c9a227', color: '#0a0908', textDecoration: 'none', borderRadius: 8 }}>
        Download for macOS
      </a>
      <ol style={{ marginTop: 32, lineHeight: 1.8 }}>
        <li>Install and open SHOGUN AI</li>
        <li>Sign in with the same account</li>
        <li>Complete MCP setup in the app</li>
      </ol>
    </main>
  );
}
```

- [ ] **Step 2: Entitlement API (for Phase 2 desktop)**

Return `{ status, trialEnd, currentPeriodEnd }` from latest subscription row for authenticated Clerk user.

- [ ] **Step 3: Account page**

Show subscription status + link to Stripe Customer Portal session.

---

### Task 9: End-to-end smoke test

- [ ] **Step 1: Create invite via admin API**
- [ ] **Step 2: Open invite URL in browser**
- [ ] **Step 3: Complete Clerk signup (test user)**
- [ ] **Step 4: Complete Stripe test checkout (card 4242…)**
- [ ] **Step 5: Verify webhook wrote subscription row**
- [ ] **Step 6: Welcome page shows download link**

---

## Self-Review Checklist

| Spec requirement | Task |
|---|---|
| Invite token generation | Task 3 |
| Admin invite API | Task 4 |
| Invite validate + page | Task 5 |
| Email match enforcement | Task 6 |
| Stripe 7-day trial checkout | Task 6 |
| Webhook sync | Task 7 |
| Welcome / download | Task 8 |
| Entitlement API (desktop prep) | Task 8 |
| Waitlist table (Phase 4) | Task 2 schema only |

No TBD placeholders in task steps above. Phase 2 (desktop gate) and Phase 3 (MCP wizard) are separate plans.

---

## Execution Handoff

After Phase 1 plan is complete, proceed to:

- Phase 2: `docs/superpowers/plans/2026-06-15-onboarding-entitlement-gate.md`
- Phase 3: `docs/superpowers/plans/2026-06-15-mcp-setup-wizard.md`
