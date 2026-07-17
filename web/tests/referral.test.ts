import { describe, it, expect } from 'vitest';
import {
  answersCompleted,
  currentTier,
  generateRefCode,
  isValidRefCode,
  maskEmail,
  nextTier,
  sanitizeAnswer,
  REFERRAL_TIERS,
  TOP_REFERRER_REWARD,
} from '../src/lib/referral';

describe('generateRefCode', () => {
  it('returns a 10-char base64url string that validates', () => {
    const code = generateRefCode();
    expect(code).toHaveLength(10);
    expect(isValidRefCode(code)).toBe(true);
  });
});

describe('isValidRefCode', () => {
  it('rejects garbage', () => {
    expect(isValidRefCode('')).toBe(false);
    expect(isValidRefCode('a')).toBe(false);
    expect(isValidRefCode('has spaces!')).toBe(false);
    expect(isValidRefCode('x'.repeat(40))).toBe(false);
  });
});

describe('tier ladder', () => {
  it('replaces, never stacks: highest reached tier wins', () => {
    expect(currentTier(0)).toBeNull();
    expect(currentTier(2)).toBeNull();
    expect(currentTier(3)?.months).toBe(1);
    expect(currentTier(9)?.months).toBe(1);
    expect(currentTier(10)?.months).toBe(3);
    expect(currentTier(29)?.months).toBe(3);
    expect(currentTier(30)?.months).toBe(6);
    expect(currentTier(500)?.months).toBe(6);
  });

  it('nextTier points at the next rung, null at the top', () => {
    expect(nextTier(0)?.threshold).toBe(3);
    expect(nextTier(3)?.threshold).toBe(10);
    expect(nextTier(10)?.threshold).toBe(30);
    expect(nextTier(30)).toBeNull();
  });

  it('ladder is 3/10/30 with 1/3/6 free months, top reward is 12', () => {
    expect(REFERRAL_TIERS.map((t) => t.threshold)).toEqual([3, 10, 30]);
    expect(REFERRAL_TIERS.map((t) => t.months)).toEqual([1, 3, 6]);
    expect(TOP_REFERRER_REWARD.months).toBe(12);
  });
});

describe('answersCompleted', () => {
  it('counts non-empty answers', () => {
    expect(answersCompleted({ answerTimeSink: null, answerCompanyRole: null, answerWhy: null })).toBe(0);
    expect(answersCompleted({ answerTimeSink: 'other', answerCompanyRole: null, answerWhy: null })).toBe(1);
    expect(answersCompleted({ answerTimeSink: 'other', answerCompanyRole: 'founder', answerWhy: 'memory' })).toBe(3);
  });
});

describe('maskEmail', () => {
  it('keeps two chars of local part and the TLD only', () => {
    expect(maskEmail('jane@gmail.com')).toBe('ja***@***.com');
    expect(maskEmail('a@b.co.jp')).toBe('a***@***.jp');
  });
});

describe('sanitizeAnswer', () => {
  it('trims, rejects empties and non-strings, caps length', () => {
    expect(sanitizeAnswer('  hello ')).toBe('hello');
    expect(sanitizeAnswer('')).toBeNull();
    expect(sanitizeAnswer('   ')).toBeNull();
    expect(sanitizeAnswer(42)).toBeNull();
    expect(sanitizeAnswer(undefined)).toBeNull();
    expect(sanitizeAnswer('x'.repeat(2000))).toHaveLength(1000);
  });
});
