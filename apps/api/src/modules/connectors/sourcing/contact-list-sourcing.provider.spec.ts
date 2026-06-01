import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { ContactListSourcingProvider } from './contact-list-sourcing.provider';
import type { IcpCriteria } from './sourcing-provider';

const ICP: IcpCriteria = {
  keywords: [],
  employeeCountMin: null,
  employeeCountMax: null,
  fundingStages: [],
  industries: [],
  locations: [],
};

interface MemberRow {
  addedAt: Date;
  contact: {
    id: string;
    company: string | null;
    linkedinUrl: string | null;
    title: string | null;
  };
}

function member(
  id: string,
  company: string | null,
  extra: Partial<MemberRow['contact']> = {},
): MemberRow {
  return {
    addedAt: new Date(0),
    contact: {
      id,
      company,
      linkedinUrl: extra.linkedinUrl ?? null,
      title: extra.title ?? null,
    },
  };
}

describe('ContactListSourcingProvider', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let prisma: PrismaService;

  beforeEach(() => {
    findMany = vi.fn();
    prisma = {
      contactListMember: { findMany },
    } as unknown as PrismaService;
  });

  it('maps list members to candidate companies', async () => {
    findMany.mockResolvedValue([
      member('c1', 'Acme Inc', { linkedinUrl: 'https://lnkd.in/acme', title: 'CEO' }),
    ]);
    const provider = new ContactListSourcingProvider(prisma, 'org-1', 'list-1');

    const { candidates } = await provider.findCandidates(ICP);

    expect(candidates).toEqual([
      {
        name: 'Acme Inc',
        domain: null,
        linkedinUrl: 'https://lnkd.in/acme',
        employeeCount: null,
        fundingStage: null,
        raw: { contactId: 'c1', contactTitle: 'CEO' },
      },
    ]);
  });

  it('de-duplicates by company name, case-insensitively', async () => {
    findMany.mockResolvedValue([
      member('c1', 'Acme'),
      member('c2', 'acme'), // same company, different person/case
      member('c3', 'Globex'),
    ]);
    const provider = new ContactListSourcingProvider(prisma, 'org-1', 'list-1');

    const { candidates, summary } = await provider.findCandidates(ICP);

    expect(candidates.map((c) => c.name)).toEqual(['Acme', 'Globex']);
    expect(summary).toContain('3 contact(s)');
    expect(summary).toContain('2 unique companies');
  });

  it('skips members with no company name', async () => {
    findMany.mockResolvedValue([
      member('c1', 'Acme'),
      member('c2', null),
      member('c3', '   '),
    ]);
    const provider = new ContactListSourcingProvider(prisma, 'org-1', 'list-1');

    const { candidates } = await provider.findCandidates(ICP);

    expect(candidates.map((c) => c.name)).toEqual(['Acme']);
  });

  it('honors the limit after de-duplication', async () => {
    findMany.mockResolvedValue([
      member('c1', 'A'),
      member('c2', 'B'),
      member('c3', 'C'),
    ]);
    const provider = new ContactListSourcingProvider(prisma, 'org-1', 'list-1');

    const { candidates, summary } = await provider.findCandidates(ICP, { limit: 2 });

    expect(candidates.map((c) => c.name)).toEqual(['A', 'B']);
    expect(summary).toContain('capped to 2');
  });

  it('scopes the query to the org (cross-org isolation)', async () => {
    findMany.mockResolvedValue([]);
    const provider = new ContactListSourcingProvider(prisma, 'org-1', 'list-1');

    await provider.findCandidates(ICP);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { listId: 'list-1', list: { orgId: 'org-1' } },
      }),
    );
  });

  it('returns an empty pool with a clear summary when nothing is accessible', async () => {
    findMany.mockResolvedValue([]);
    const provider = new ContactListSourcingProvider(prisma, 'org-1', 'missing');

    const { candidates, summary } = await provider.findCandidates(ICP);

    expect(candidates).toEqual([]);
    expect(summary).toBe('No accessible companies found in list missing');
  });
});
