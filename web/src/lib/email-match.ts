import { normalizeEmail } from '@/lib/invites';

export function emailsMatch(a: string, b: string): boolean {
  return normalizeEmail(a) === normalizeEmail(b);
}
