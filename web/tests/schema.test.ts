import { describe, it, expect } from 'vitest';
import { invites, users, subscriptions, waitlist } from '../src/db/schema';

describe('schema', () => {
  it('exports all tables', () => {
    expect(invites).toBeDefined();
    expect(users).toBeDefined();
    expect(subscriptions).toBeDefined();
    expect(waitlist).toBeDefined();
  });
});
