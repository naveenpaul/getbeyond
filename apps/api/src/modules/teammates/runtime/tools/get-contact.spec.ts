import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../agent-tool';
import { getContactTool } from './get-contact';

/**
 * Unit tests for the `get_contact` runtime tool. Mock prisma — the
 * sdr-drafter integration suite exercises the happy path against a live
 * DB; here we cover the error branches the integration tests can't
 * conveniently reach.
 */

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const findFirst = vi.fn();
  return {
    runId: 'run-1',
    orgId: 'org-1',
    prisma: {
      contact: { findFirst },
    } as unknown as ToolContext['prisma'],
    ...overrides,
  };
}

describe('get_contact tool', () => {
  it('throws when the contactId does not exist in the org', async () => {
    const ctx = makeCtx();
    (
      ctx.prisma.contact.findFirst as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);

    await expect(
      getContactTool.execute({ contactId: 'cuid_missing' }, ctx),
    ).rejects.toThrow(/Contact cuid_missing not found in this org/);
  });

  it('returns the resolved profile when the contact exists', async () => {
    const ctx = makeCtx();
    (
      ctx.prisma.contact.findFirst as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: 'c1',
      normalizedEmail: 'sarah@acme.com',
      firstName: 'Sarah',
      lastName: 'Patel',
      title: 'VP Sales',
      company: 'Acme',
      linkedinUrl: null,
    });

    const result = (await getContactTool.execute(
      { contactId: 'c1' },
      ctx,
    )) as { id: string; displayName: string; primaryEmail: string };

    expect(result.id).toBe('c1');
    expect(result.displayName).toBe('Sarah Patel');
    expect(result.primaryEmail).toBe('sarah@acme.com');
  });

  it('falls back to email when both first + last name are absent', async () => {
    const ctx = makeCtx();
    (
      ctx.prisma.contact.findFirst as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: 'c2',
      normalizedEmail: 'lead@beta.com',
      firstName: null,
      lastName: null,
      title: null,
      company: null,
      linkedinUrl: null,
    });

    const result = (await getContactTool.execute(
      { contactId: 'c2' },
      ctx,
    )) as { displayName: string };

    expect(result.displayName).toBe('lead@beta.com');
  });

  it('falls back to contact id when no name and no email exist', async () => {
    const ctx = makeCtx();
    (
      ctx.prisma.contact.findFirst as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: 'c3',
      normalizedEmail: null,
      firstName: null,
      lastName: null,
      title: null,
      company: null,
      linkedinUrl: null,
    });

    const result = (await getContactTool.execute(
      { contactId: 'c3' },
      ctx,
    )) as { displayName: string; primaryEmail: string | null };

    expect(result.displayName).toBe('c3');
    expect(result.primaryEmail).toBeNull();
  });

  it('throws on missing contactId arg (Zod parse fails)', async () => {
    const ctx = makeCtx();
    await expect(
      getContactTool.execute({ wrong: 'shape' }, ctx),
    ).rejects.toThrow();
  });
});
