import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison. Both inputs are hashed first so the
 * comparison length is fixed and length differences leak nothing.
 */
export function secureCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
