import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { sendEmail } from '@/lib/email';
import { findByRefCode, qualifiedReferralCount } from '@/lib/referral';

/**
 * Gamified lifecycle emails. Sent at most once per (person, kind) — the
 * notifications table's unique constraint is claimed BEFORE sending, so a
 * crashed send is dropped rather than duplicated (at-most-once; a missed
 * nudge is cheaper than a double send).
 *
 * Cadence is deliberately sparse — welcome, first invite, one-away nudges,
 * and tier confirmations. Every extra email trains people to ignore them.
 */

type WaitlistRow = {
  id: string;
  email: string;
  locale: string | null;
  statusToken: string | null;
  referredBy: string | null;
  emailOptOutAt: Date | null;
};

export type MilestoneKind =
  | 'invite_1'
  | 'near_tier_3' | 'tier_3'
  | 'near_tier_10' | 'tier_10'
  | 'near_tier_30' | 'tier_30';

/** Milestone triggered by reaching `count` qualified invites, if any. */
export function milestoneFor(count: number): MilestoneKind | null {
  switch (count) {
    case 1: return 'invite_1';
    case 2: return 'near_tier_3';
    case 3: return 'tier_3';
    case 9: return 'near_tier_10';
    case 10: return 'tier_10';
    case 29: return 'near_tier_30';
    case 30: return 'tier_30';
    default: return null;
  }
}

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
}

function links(row: WaitlistRow) {
  return {
    statusUrl: `${baseUrl()}/waitlist/${row.statusToken}`,
    unsubscribeUrl: `${baseUrl()}/api/waitlist/unsubscribe?token=${row.statusToken}`,
  };
}

function footer(lang: 'en' | 'ja', unsubscribeUrl: string): string {
  return lang === 'ja'
    ? `\n\n—\nSHOGUN — Select KK\n配信停止: ${unsubscribeUrl}`
    : `\n\n—\nSHOGUN — Select KK\nUnsubscribe: ${unsubscribeUrl}`;
}

function langOf(row: WaitlistRow): 'en' | 'ja' {
  return row.locale === 'ja' ? 'ja' : 'en';
}

function milestoneEmail(kind: MilestoneKind, lang: 'en' | 'ja', statusUrl: string) {
  const en: Record<MilestoneKind, { subject: string; body: string }> = {
    invite_1: {
      subject: 'Your first invite counted.',
      body: `Someone joined through your link and answered their questions.\n\nThat's 1 qualified invite. 2 more locks 1 month of SHOGUN free at launch.\n\nYour line: ${statusUrl}`,
    },
    near_tier_3: {
      subject: '1 more invite to 1 month free.',
      body: `2 qualified invites. The next one locks 1 month of SHOGUN free at launch.\n\nYour link is on your status page: ${statusUrl}`,
    },
    tier_3: {
      subject: '3 invites. 1 month earned.',
      body: `Three people joined through your link and answered their questions.\n\nThat locks 1 month of SHOGUN free at launch.\n\nNext rung: 10 invites — 3 months free. Rewards replace as you climb.\n\nYour line: ${statusUrl}`,
    },
    near_tier_10: {
      subject: '1 more invite to 3 months free.',
      body: `9 qualified invites. The next one replaces your reward with 3 months free.\n\nYour line: ${statusUrl}`,
    },
    tier_10: {
      subject: '10 invites. Your first quarter is free.',
      body: `Ten qualified invites. Your reward is now 3 months free — it replaces the 1 month you held before.\n\nNext rung: 30 invites — 6 months free. The top 10 referrers at close take a full year.\n\nYour line: ${statusUrl}`,
    },
    near_tier_30: {
      subject: '1 more invite to 6 months free.',
      body: `29 qualified invites. The next one replaces your reward with 6 months free.\n\nYour line: ${statusUrl}`,
    },
    tier_30: {
      subject: '30 invites. Half a year, on us.',
      body: `Thirty qualified invites. 6 months of SHOGUN free at launch — the top of the ladder short of the board.\n\nThe top 10 referrers at campaign close take 1 year free.\n\nYour line: ${statusUrl}`,
    },
  };

  const ja: Record<MilestoneKind, { subject: string; body: string }> = {
    invite_1: {
      subject: '最初の有効招待が入りました。',
      body: `あなたのリンクから1人が登録し、質問に回答しました。\n\n有効招待1人。あと2人で1ヶ月無料が確定します。\n\nあなたのステータス: ${statusUrl}`,
    },
    near_tier_3: {
      subject: 'あと1人で1ヶ月無料。',
      body: `有効招待2人。次の1人で1ヶ月無料が確定します。\n\nあなたのリンクはステータスページに: ${statusUrl}`,
    },
    tier_3: {
      subject: '有効招待3人。1ヶ月無料を獲得。',
      body: `あなたのリンクから3人が登録し、質問に回答しました。\n\nローンチ時のSHOGUN 1ヶ月無料が確定です。\n\n次の段階は10人招待で3ヶ月無料。特典は加算ではなく置換です。\n\nあなたのステータス: ${statusUrl}`,
    },
    near_tier_10: {
      subject: 'あと1人で3ヶ月無料。',
      body: `有効招待9人。次の1人で特典が3ヶ月無料に置き換わります。\n\nあなたのステータス: ${statusUrl}`,
    },
    tier_10: {
      subject: '有効招待10人。最初の3ヶ月が無料に。',
      body: `有効招待が10人に到達。特典は3ヶ月無料に置き換わりました。\n\n次は30人で6ヶ月無料。最終的なリファラル上位10人は1年無料です。\n\nあなたのステータス: ${statusUrl}`,
    },
    near_tier_30: {
      subject: 'あと1人で6ヶ月無料。',
      body: `有効招待29人。次の1人で特典が6ヶ月無料に置き換わります。\n\nあなたのステータス: ${statusUrl}`,
    },
    tier_30: {
      subject: '有効招待30人。半年分を無料で。',
      body: `有効招待が30人に到達。ローンチ時から6ヶ月無料が確定です。\n\nこの上は最終順位のみ。リファラル上位10人が1年無料を獲得します。\n\nあなたのステータス: ${statusUrl}`,
    },
  };

  return (lang === 'ja' ? ja : en)[kind];
}

function welcomeEmail(lang: 'en' | 'ja', statusUrl: string) {
  if (lang === 'ja') {
    return {
      subject: '順番待ちに入りました。列の飛ばし方。',
      body: `SHOGUN の waiting list に登録されました。招待は毎週、順番にお送りします。\n\n列は飛ばせます。あなたのリンクから登録して3問に回答した人が1招待としてカウントされ、\n\n・3人招待 — 1ヶ月無料\n・10人招待 — 3ヶ月無料\n・30人招待 — 6ヶ月無料\n・リファラル上位10人 — 1年無料\n\n特典は加算ではなく置換。到達した最上位の段階が適用されます。\n\nあなたのステータスとリンク: ${statusUrl}`,
    };
  }
  return {
    subject: "You're in line. Here's how to skip it.",
    body: `You're on the SHOGUN waiting list. Invites go out weekly, in order.\n\nThe line can be skipped. Each person who joins through your link and answers their three questions counts as one invite:\n\n- 3 invites — 1 month free\n- 10 invites — 3 months free\n- 30 invites — 6 months free\n- Top 10 referrers — 1 year free\n\nRewards replace as you climb — the highest tier you reach is the one you get.\n\nYour status and link: ${statusUrl}`,
  };
}

/**
 * Claim (waitlistId, kind) atomically; true only for the first caller.
 */
async function claimNotification(waitlistId: string, kind: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.execute(sql`
    INSERT INTO notifications (waitlist_id, kind)
    VALUES (${waitlistId}::uuid, ${kind})
    ON CONFLICT (waitlist_id, kind) DO NOTHING
    RETURNING id
  `);
  return (rows as unknown as unknown[]).length > 0;
}

/** Welcome email for a fresh signup. */
export async function notifySignup(row: WaitlistRow): Promise<void> {
  if (!row.statusToken) return;
  try {
    if (!(await claimNotification(row.id, 'welcome'))) return;
    const lang = langOf(row);
    const { statusUrl, unsubscribeUrl } = links(row);
    const t = welcomeEmail(lang, statusUrl);
    await sendEmail({ to: row.email, subject: t.subject, text: t.body + footer(lang, unsubscribeUrl) });
  } catch (err) {
    console.error('[notify/signup]', err);
  }
}

/**
 * Called when a signup completes the 3-question form. If they were
 * referred, their referrer's qualified count just moved — nudge or
 * congratulate the referrer at the milestones.
 */
export async function notifyReferrerProgress(referredBy: string | null): Promise<void> {
  if (!referredBy) return;
  try {
    const referrer = await findByRefCode(referredBy);
    if (!referrer?.statusToken || referrer.emailOptOutAt) return;

    const count = await qualifiedReferralCount(referredBy);
    const kind = milestoneFor(count);
    if (!kind) return;
    if (!(await claimNotification(referrer.id, kind))) return;

    const lang = langOf(referrer);
    const { statusUrl, unsubscribeUrl } = links(referrer);
    const t = milestoneEmail(kind, lang, statusUrl);
    await sendEmail({ to: referrer.email, subject: t.subject, text: t.body + footer(lang, unsubscribeUrl) });
  } catch (err) {
    console.error('[notify/referrer]', err);
  }
}
