import { NextRequest } from 'next/server';

export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

/**
 * Bounded JSON body reader for public POST endpoints. Next route handlers
 * impose no body limit of their own, so an unauthenticated caller could
 * otherwise feed a multi-hundred-MB body straight into memory. 8 KB fits
 * every legitimate payload here (largest: three 1000-char answers).
 * Also rejects non-object roots so field picks never hit arrays/primitives.
 */
export async function readJsonBody(req: NextRequest, maxBytes = 8192): Promise<JsonBodyResult> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'payload_too_large' }, { status: 413 }),
    };
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'invalid_json' }, { status: 400 }),
    };
  }

  if (text.length > maxBytes) {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'payload_too_large' }, { status: 413 }),
    };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        response: Response.json({ ok: false, error: 'invalid_json' }, { status: 400 }),
      };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: Response.json({ ok: false, error: 'invalid_json' }, { status: 400 }),
    };
  }
}
