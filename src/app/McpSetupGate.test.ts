import { describe, it, expect } from 'vitest';

function isMcpComplete(sections: Record<string, unknown> | null | undefined): boolean {
  const raw = sections && sections.onboarding;
  if (!raw || typeof raw !== 'object') return false;
  return Boolean((raw as Record<string, unknown>).mcpComplete);
}

describe('isMcpComplete', () => {
  it('returns true when mcpComplete is set', () => {
    expect(isMcpComplete({ onboarding: { mcpComplete: true } })).toBe(true);
  });

  it('returns false when missing', () => {
    expect(isMcpComplete({ onboarding: { complete: true } })).toBe(false);
    expect(isMcpComplete(null)).toBe(false);
  });
});
