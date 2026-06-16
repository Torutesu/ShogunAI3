import { describe, it, expect } from 'vitest';
import { isValidWaitlistEmail } from '../src/lib/waitlist';

describe('isValidWaitlistEmail', () => {
  it('accepts normal emails', () => {
    expect(isValidWaitlistEmail('user@example.com')).toBe(true);
    expect(isValidWaitlistEmail('  User@Example.COM ')).toBe(true);
  });

  it('rejects invalid emails', () => {
    expect(isValidWaitlistEmail('')).toBe(false);
    expect(isValidWaitlistEmail('not-an-email')).toBe(false);
    expect(isValidWaitlistEmail('@missing-local.com')).toBe(false);
  });
});
