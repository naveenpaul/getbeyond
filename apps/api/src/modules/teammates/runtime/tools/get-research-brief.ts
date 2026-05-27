import { z } from 'zod';
import type { AgentTool, ToolContext } from '../agent-tool';

/**
 * `get_research_brief` — load a prior Researcher Draft as context for the
 * SDR Drafter. Returns the brief content + a flat list of cited claims with
 * source URLs and FRESH citationIds.
 *
 * Why fresh citationIds: Citations are scoped per-AgentRun. The model can
 * only reference citationIds created during THIS run. To let the SDR Drafter
 * cite facts that originated in a Researcher run, we copy the underlying
 * Citation rows (url + excerpt) into this run and surface the new ids to
 * the model. Cheap (one SELECT + N INSERTs at brief-load time) and keeps
 * the per-run citation invariant intact.
 *
 * Tenant-scoped via ctx.orgId — the Draft lookup includes the orgId filter
 * so a model that hallucinates a draftId from another org cannot exfiltrate.
 */
const GetResearchBriefArgsSchema = z.object({
  draftId: z.string().min(1),
});

interface BriefClaim {
  text: string;
  citationId: string | null; // null when abstained=true
  sourceUrl: string | null;
  excerpt: string | null;
  abstained: boolean;
}

interface GetResearchBriefResult {
  draftId: string;
  type: string;
  content: unknown;
  claims: BriefClaim[];
}

export const getResearchBriefTool: AgentTool = {
  name: 'get_research_brief',
  description:
    'Load a prior Researcher draft (type=research_brief) as context. ' +
    'Returns the brief content plus claims you can reference by citationId. ' +
    'Use the returned citationId values when citing facts from the brief.',
  inputSchema: {
    type: 'object',
    required: ['draftId'],
    properties: {
      draftId: {
        type: 'string',
        description: 'The Draft.id of a prior research run.',
      },
    },
  },
  async execute(
    args: unknown,
    ctx: ToolContext,
  ): Promise<GetResearchBriefResult> {
    const { draftId } = GetResearchBriefArgsSchema.parse(args);

    const draft = await ctx.prisma.draft.findFirst({
      where: {
        id: draftId,
        orgId: ctx.orgId,
        type: 'research_brief',
      },
      include: {
        claims: { include: { citation: true } },
      },
    });
    if (!draft) {
      throw new Error(
        `research_brief draft ${draftId} not found in this org`,
      );
    }

    // For each cited claim, mint a Citation in THIS run pointing at the same
    // underlying source. Abstained claims pass through as-is.
    const claims: BriefClaim[] = [];
    for (const claim of draft.claims) {
      if (claim.abstained || !claim.citation) {
        claims.push({
          text: claim.text,
          citationId: null,
          sourceUrl: null,
          excerpt: null,
          abstained: true,
        });
        continue;
      }
      const fresh = await ctx.prisma.citation.create({
        data: {
          runId: ctx.runId,
          url: claim.citation.url,
          title: claim.citation.title,
          excerpt: claim.citation.excerpt,
        },
      });
      claims.push({
        text: claim.text,
        citationId: fresh.id,
        sourceUrl: claim.citation.url,
        excerpt: claim.citation.excerpt,
        abstained: false,
      });
    }

    return {
      draftId: draft.id,
      type: draft.type,
      content: draft.content,
      claims,
    };
  },
};
