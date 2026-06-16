import { describe, it, expect } from 'vitest';
import { generateInviteToken, normalizeEmail } from '../src/lib/invites';
import { emailsMatch } from '../src/lib/email-match';

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

describe('emailsMatch', () => {
  it('matches normalized emails', () => {
    expect(emailsMatch('User@Example.com', 'user@example.com')).toBe(true);
    expect(emailsMatch('a@b.com', 'c@d.com')).toBe(false);
  });
});
