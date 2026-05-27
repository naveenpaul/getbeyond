import type { PrismaClient } from '@prisma/client';
import type { AnthropicMessagesClient } from '../runtime/call-model';
import { runAgent, type RunAgentResult } from '../runtime/tool-use-loop';
import type { AgentTool } from '../runtime/agent-tool';
import { braveSearchTool } from '../runtime/tools/brave-search';
import { fetchUrlTool } from '../runtime/tools/fetch-url';
import { getContactTool } from '../runtime/tools/get-contact';
import { getResearchBriefTool } from '../runtime/tools/get-research-brief';
import type { RunEvent } from '../runtime/run-event-bus';
import {
  buildSdrDrafterUserPrompt,
  SDR_DRAFTER_SYSTEM_PROMPT,
} from './sdr-drafter.prompts';

/**
 * SDR Drafter teammate service (T9.5).
 *
 * Mirrors researcher.service.ts. The only meaningful differences:
 *   - Tool allowlist adds get_contact + get_research_brief (read-only
 *     internal data accessors).
 *   - draftRecipient is resolved server-side from contactId and threaded
 *     through to persistDraftFromEmitArgs so Draft.recipient is populated
 *     without trusting model output.
 *
 * Same model defaults as the Researcher (claude-sonnet-4-6 — drafting
 * needs reasoning over the brief, not Haiku's speed).
 */

export interface SdrDrafterInput {
  orgId: string;
  triggeredBy: string;
  contactId: string;
  /** Pre-existing AgentRun.id when running async via the worker. */
  runId?: string;
  briefDraftId?: string | null;
  goal?: string | null;
  modelName?: string;
  budgetCents?: number;
  maxToolCalls?: number;
  maxWallSecs?: number;
}

export interface SdrDrafterDeps {
  prisma: PrismaClient;
  anthropic: AnthropicMessagesClient;
  tools?: AgentTool[];
  emitEvent?: (event: RunEvent) => void;
}

export interface SdrDrafterResult {
  runId: string;
  status: RunAgentResult['status'];
  reason?: string;
  draftId?: string;
  costCents: number;
  toolCallCount: number;
}

export const SDR_DRAFTER_NAME = 'sdr-drafter';

const DEFAULTS = {
  modelName: 'claude-sonnet-4-6',
  budgetCents: 50,
  maxToolCalls: 15,
  maxWallSecs: 120,
} as const;

export async function runSdrDrafter(
  deps: SdrDrafterDeps,
  input: SdrDrafterInput,
): Promise<SdrDrafterResult> {
  // Resolve recipient up front so we can fail fast if the Contact is missing
  // or cross-org. The AuthGuard already enforced orgId on the controller; this
  // is the second-level guarantee that the Drafter never writes a Draft with
  // a recipient from the wrong tenant.
  const contact = await deps.prisma.contact.findFirst({
    where: { id: input.contactId, orgId: input.orgId },
  });
  if (!contact) {
    throw new Error(`Contact ${input.contactId} not found in org ${input.orgId}`);
  }
  if (!contact.normalizedEmail) {
    throw new Error(
      `Contact ${input.contactId} has no email — cannot draft outreach`,
    );
  }
  const recipientName =
    [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
    null;

  let runId = input.runId;
  if (!runId) {
    const run = await deps.prisma.agentRun.create({
      data: {
        orgId: input.orgId,
        teammate: SDR_DRAFTER_NAME,
        triggeredBy: input.triggeredBy,
        status: 'running',
        inputContext: {
          contactId: input.contactId,
          briefDraftId: input.briefDraftId ?? null,
          goal: input.goal ?? null,
        } satisfies Record<string, unknown>,
      },
    });
    runId = run.id;
  }

  const tools = deps.tools ?? [
    getContactTool,
    getResearchBriefTool,
    braveSearchTool,
    fetchUrlTool,
  ];

  const result = await runAgent({
    runId,
    orgId: input.orgId,
    teammate: SDR_DRAFTER_NAME,
    modelName: input.modelName ?? DEFAULTS.modelName,
    systemPrompt: SDR_DRAFTER_SYSTEM_PROMPT,
    userPrompt: buildSdrDrafterUserPrompt({
      contactId: input.contactId,
      briefDraftId: input.briefDraftId ?? null,
      goal: input.goal ?? null,
    }),
    tools,
    budgetCents: input.budgetCents ?? DEFAULTS.budgetCents,
    maxToolCalls: input.maxToolCalls ?? DEFAULTS.maxToolCalls,
    maxWallSecs: input.maxWallSecs ?? DEFAULTS.maxWallSecs,
    prisma: deps.prisma,
    anthropic: deps.anthropic,
    emitEvent: deps.emitEvent,
    draftRecipient: {
      contactId: contact.id,
      email: contact.normalizedEmail,
      name: recipientName,
    },
  });

  return {
    runId,
    status: result.status,
    reason: result.reason,
    draftId: result.draftId,
    costCents: result.costCents,
    toolCallCount: result.toolCallCount,
  };
}
