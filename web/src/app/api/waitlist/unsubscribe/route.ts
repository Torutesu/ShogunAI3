import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { waitlist } from '@/db/schema';
import { isValidStatusToken } from '@/lib/referral';

// One-click opt-out from campaign emails, linked from every email footer.
// GET because it must work from a mail client. The status token is the
// bearer; opting out never removes the waitlist entry itself.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')?.trim() ?? '';
  if (!isValidStatusToken(token)) {
    return new Response('Invalid link.', { status: 400 });
  }

  try {
    const db = getDb();
    const [row] = await db
      .update(waitlist)
      .set({ emailOptOutAt: new Date() })
      .where(eq(waitlist.statusToken, token))
      .returning();

    if (!row) return new Response('Invalid link.', { status: 404 });

    return new Response(
      `<!doctype html><html><body style="background:#080808;color:#fff;font-family:system-ui;padding:48px;text-align:center">
<p>Unsubscribed. You stay on the waiting list; we just stop emailing.</p>
<p style="color:#999">配信を停止しました。waiting list の登録はそのまま残ります。</p>
</body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  } catch (err) {
    console.error('[waitlist/unsubscribe]', err);
    return new Response('Something broke — try again.', { status: 500 });
  }
}
