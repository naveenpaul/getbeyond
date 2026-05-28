import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../agent-tool';
import { getResearchBriefTool } from './get-research-brief';

/**
 * Unit tests for `get_research_brief`. Mock prisma — the sdr-drafter
 * integration spec exercises the happy + abstained-claim paths against a
 * live DB; here we cover the error branches.
 */

function makeCtx(): ToolContext & {
  prismaDraftFindFirst: ReturnType<typeof vi.fn>;
  prismaCitationCreate: ReturnType<typeof vi.fn>;
} {
  const draftFindFirst = vi.fn();
  const citationCreate = vi.fn();
  return {
    runId: 'run-2',
    orgId: 'org-1',
    prisma: {
      draft: { findFirst: draftFindFirst },
      citation: { create: citationCreate },
    } as unknown as ToolContext['prisma'],
    prismaDraftFindFirst: draftFindFirst,
    prismaCitationCreate: citationCreate,
  };
}

describe('get_research_brief tool', () => {
  it('throws when the draftId does not exist in the org', async () => {
    const ctx = makeCtx();
    ctx.prismaDraftFindFirst.mockResolvedValueOnce(null);

    await expect(
      getResearchBriefTool.execute({ draftId: 'cuid_missing' }, ctx),
    ).rejects.toThrow(/research_brief draft cuid_missing not found in this org/);
  });

  it('copies cited claims into the current run with fresh citationIds', async () => {
    const ctx = makeCtx();
    ctx.prismaDraftFindFirst.mockResolvedValueOnce({
      id: 'draft-prior',
      type: 'research_brief',
      content: { headline: 'Acme' },
      claims: [
        {
          text: 'Acme raised $5M Series A.',
          abstained: false,
          citation: {
            url: 'https://acme.example/funding',
            title: 'Series A announcement',
            excerpt: 'Acme closed a $5M Series A in March 2026.',
          },
        },
      ],
    });
    ctx.prismaCitationCreate.mockResolvedValueOnce({ id: 'new-cit-1' });

    const result = (await getResearchBriefTool.execute(
      { draftId: 'draft-prior' },
      ctx,
    )) as { draftId: string; claims: Array<{ citationId: string | null }> };

    expect(result.draftId).toBe('draft-prior');
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.citationId).toBe('new-cit-1');
    expect(ctx.prismaCitationCreate).toHaveBeenCalledWith({
      data: {
        runId: 'run-2',
        url: 'https://acme.example/funding',
        title: 'Series A announcement',
        excerpt: 'Acme closed a $5M Series A in March 2026.',
      },
    });
  });

  it('passes through abstained claims with null citation', async () => {
    const ctx = makeCtx();
    ctx.prismaDraftFindFirst.mockResolvedValueOnce({
      id: 'draft-prior',
      type: 'research_brief',
      content: {},
      claims: [
        {
          text: 'No public funding info located.',
          abstained: true,
          citation: null,
        },
      ],
    });

    const result = (await getResearchBriefTool.execute(
      { draftId: 'draft-prior' },
      ctx,
    )) as { claims: Array<{ citationId: string | null; abstained: boolean }> };

    expect(result.claims[0]?.abstained).toBe(true);
    expect(result.claims[0]?.citationId).toBeNull();
    expect(ctx.prismaCitationCreate).not.toHaveBeenCalled();
  });

  it('treats claims with no citation row as abstained', async () => {
    const ctx = makeCtx();
    ctx.prismaDraftFindFirst.mockResolvedValueOnce({
      id: 'draft-prior',
      type: 'research_brief',
      content: {},
      claims: [
        {
          text: 'Orphan claim — citation row missing.',
          abstained: false,
          citation: null, // citationId was set but the row was deleted
        },
      ],
    });

    const result = (await getResearchBriefTool.execute(
      { draftId: 'draft-prior' },
      ctx,
    )) as { claims: Array<{ citationId: string | null; abstained: boolean }> };

    expect(result.claims[0]?.abstained).toBe(true);
    expect(result.claims[0]?.citationId).toBeNull();
  });

  it('throws on malformed args', async () => {
    const ctx = makeCtx();
    await expect(
      getResearchBriefTool.execute({ wrong: 'shape' }, ctx),
    ).rejects.toThrow();
  });
});
