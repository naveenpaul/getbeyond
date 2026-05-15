import { describe, expect, it } from 'vitest';
import {
  getOrgContext,
  getOrgContextOrNull,
  withOrgContext,
  type OrgContext,
} from './org-context';

const CTX: OrgContext = { orgId: 'org_A', userId: 'usr_1', role: 'owner' };
const NESTED_CTX: OrgContext = {
  orgId: 'org_B',
  userId: 'usr_2',
  role: 'member',
};

describe('withOrgContext + getOrgContext', () => {
  it('exposes the context inside the callback', () => {
    withOrgContext(CTX, () => {
      expect(getOrgContext()).toEqual(CTX);
    });
  });

  it('returns the value the callback returns', () => {
    const result = withOrgContext(CTX, () => 'inner-return-value');
    expect(result).toBe('inner-return-value');
  });

  it('nested withOrgContext replaces outer context for inner scope only', () => {
    withOrgContext(CTX, () => {
      expect(getOrgContext().orgId).toBe('org_A');
      withOrgContext(NESTED_CTX, () => {
        expect(getOrgContext().orgId).toBe('org_B');
      });
      expect(getOrgContext().orgId).toBe('org_A');
    });
  });

  it('async work inside the context keeps the same context across awaits', async () => {
    await withOrgContext(CTX, async () => {
      expect(getOrgContext()).toEqual(CTX);
      await new Promise((resolve) => setImmediate(resolve));
      expect(getOrgContext()).toEqual(CTX);
    });
  });
});

describe('getOrgContext (strict)', () => {
  it('throws when called outside any withOrgContext', () => {
    expect(() => getOrgContext()).toThrow(/No active OrgContext/);
  });

  it('error message explains how to fix it', () => {
    try {
      getOrgContext();
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('withOrgContext');
    }
  });
});

describe('getOrgContextOrNull', () => {
  it('returns null when no context is active', () => {
    expect(getOrgContextOrNull()).toBeNull();
  });

  it('returns the context when inside withOrgContext', () => {
    withOrgContext(CTX, () => {
      expect(getOrgContextOrNull()).toEqual(CTX);
    });
  });

  it('returns null again after the callback exits', () => {
    withOrgContext(CTX, () => {
      expect(getOrgContextOrNull()).toEqual(CTX);
    });
    expect(getOrgContextOrNull()).toBeNull();
  });
});
