/**
 * Transactional email via the Resend HTTP API (free tier: 100/day,
 * 3k/month — plenty for a waiting list until it isn't, and the vendor is
 * swappable behind this one function). No SDK dependency on purpose.
 *
 * No-op without RESEND_API_KEY: every send is logged instead, so the whole
 * pipeline is testable locally and the campaign can run before email is
 * wired up.
 */
export type SendResult = { sent: boolean; skipped?: string };

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'SHOGUN <no-reply@syogun.com>';

  if (!apiKey) {
    console.log(`[email] skipped (no RESEND_API_KEY): to=${opts.to} subject="${opts.subject}"`);
    return { sent: false, skipped: 'not_configured' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: opts.to, subject: opts.subject, text: opts.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[email] resend ${res.status}: ${await res.text().catch(() => '')}`);
      return { sent: false, skipped: `http_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error('[email]', err);
    return { sent: false, skipped: 'error' };
  }
}
