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

  it('rejects markup/quoting payloads that would survive into exports or emails', () => {
    expect(isValidWaitlistEmail('<script>@evil.com')).toBe(false);
    expect(isValidWaitlistEmail('"a b"@evil.com')).toBe(false);
    expect(isValidWaitlistEmail("o'brien`@evil.com")).toBe(false);
    expect(isValidWaitlistEmail('a\\b@evil.com')).toBe(false);
    expect(isValidWaitlistEmail('=1+1@evil.com')).toBe(false);
    expect(isValidWaitlistEmail('user@evil.com>')).toBe(false);
    // and still accepts normal plus-addressing
    expect(isValidWaitlistEmail('user+tag@example.co.jp')).toBe(true);
  });
});
