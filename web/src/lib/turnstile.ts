/**
 * Cloudflare Turnstile verification. Opt-in: with TURNSTILE_SECRET_KEY unset
 * the check passes, so the campaign can launch without it and switch it on
 * under bot pressure with no deploy of the LP required (the LP widget is the
 * only other piece).
 *
 * When configured, verification failures fail CLOSED.
 */
export async function verifyTurnstile(
  token: unknown,
  remoteIp?: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (typeof token !== 'string' || !token) return false;

  try {
    const params = new URLSearchParams({ secret, response: token });
    if (remoteIp && remoteIp !== 'unknown') params.set('remoteip', remoteIp);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error('[turnstile]', err);
    return false;
  }
}
