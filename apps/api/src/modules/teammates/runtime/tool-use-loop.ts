import type Anthropic from '@anthropic-ai/sdk';
import type { Prisma, PrismaClient } from '@prisma/client';
import { callModel, type AnthropicMessagesClient } from './call-model';
import {
  ClaimContractError,
  EMIT_DRAFT_TOOL,
  EmitDraftArgsSchema,
  persistDraftFromEmitArgs,
} from './claim-contract';
import { BudgetExceededError } from './cost';
import type { AgentTool } from './agent-tool';

/**
 * The teammate tool-use loop (T4b.1).
 *
 * Drives an AgentRun from "running" to a terminal state. The model alternates
 * between text/tool_use responses; the loop dispatches tool calls and feeds
 * results back until either:
 *
 *   - the model invokes `emit_draft` with valid claims → status=completed,
 *     Draft + Claims persisted.
 *   - a bound trips (maxToolCalls / maxWallSecs / budget) → status=abstained,
 *     `reason` records which bound.
 *   - the model finishes a turn with no tool calls AND no draft → status=abstained,
 *     reason=no_draft_emitted (the model gave up without producing output).
 *   - the loop throws → caller (the teammate service) decides whether to mark
 *     status=failed.
 *
 * Why this shape:
 *   - emit_draft is appended to the tool list automatically. Teammates declare
 *     their own tools (brave_search, fetch_url, …); they don't import the
 *     terminator.
 *   - Every tool call writes a ToolCall row keyed on `(runId, toolSeq)` — the
 *     schema's unique constraint catches accidental double-inserts under retry.
 *     The toolSeq monotonic-increments per loop iteration; the modelCallId
 *     backref ties the call to the model turn that decided to invoke it
 *     (per eng-review Issue 6B).
 *   - Tool execution errors don't abort the loop — they get reported back to
 *     the model as `is_error: true` tool_result blocks so the model can try
 *     a different approach. Only budget overruns + bound trips actually abort.
 *   - Malformed emit_draft args (Zod parse fails) → reported to the model as
 *     a tool error so it can retry with valid shape, NOT a loop abort.
 *   - All-claims-dropped (ClaimContractError code=no_valid_claims) → also
 *     reported to the model so it can supply citations and retry. The user
 *     never sees a Draft built from hallucinated claims.
 */

export interface RunAgentParams {
  /** AgentRun.id — must already exist with status='running'. */
  runId: string;
  orgId: string;
  /** Teammate name persisted on Draft.teammate (e.g. 'researcher'). */
  teammate: string;
  modelName: string;
  systemPrompt: string;
  userPrompt: string;
  /** Teammate's tool allowlist. emit_draft is appended automatically. */
  tools: AgentTool[];
  budgetCents: number;
  maxToolCalls: number;
  maxWallSecs: number;
  prisma: PrismaClient;
  anthropic: AnthropicMessagesClient;
  /** Clock override for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface RunAgentResult {
  status: 'completed' | 'abstained';
  /** When status=abstained, names the bound or reason. */
  reason?: string;
  /** Persisted Draft.id (only when status=completed). */
  draftId?: string;
  toolCallCount: number;
  /** Final AgentRun.costCents. */
  costCents: number;
}

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const now = params.now ?? (() => Date.now());
  const startedAtMs = now();

  // Build the model-side tool list: teammate tools + emit_draft.
  const anthropicTools: Anthropic.Tool[] = [
    ...params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    })),
    EMIT_DRAFT_TOOL as unknown as Anthropic.Tool,
  ];

  // Lookup for dispatch.
  const toolsByName = new Map<string, AgentTool>();
  for (const t of params.tools) toolsByName.set(t.name, t);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: params.userPrompt },
  ];

  let toolSeq = 0;
  let toolCallCount = 0;

  while (true) {
    if (toolCallCount >= params.maxToolCalls) {
      return abortRun(
        params.prisma,
        params.runId,
        'exceeded_maxToolCalls',
        toolCallCount,
      );
    }
    const elapsedSecs = (now() - startedAtMs) / 1000;
    if (elapsedSecs > params.maxWallSecs) {
      return abortRun(
        params.prisma,
        params.runId,
        'exceeded_maxWallSecs',
        toolCallCount,
      );
    }

    let modelResult;
    try {
      modelResult = await callModel(params.prisma, params.anthropic, {
        runId: params.runId,
        modelName: params.modelName,
        systemPrompt: params.systemPrompt,
        messages,
        tools: anthropicTools,
        budgetCents: params.budgetCents,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return abortRun(
          params.prisma,
          params.runId,
          'exceeded_budget',
          toolCallCount,
        );
      }
      throw err;
    }

    const { message, modelCallId } = modelResult;
    messages.push({ role: 'assistant', content: message.content });

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      // Model produced only text + ended the turn — but never emitted a draft.
      // That's a failure mode worth surfacing (prompts probably need work).
      return abortRun(
        params.prisma,
        params.runId,
        'no_draft_emitted',
        toolCallCount,
      );
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      toolSeq++;
      toolCallCount++;

      if (toolUse.name === 'emit_draft') {
        const emitOutcome = await handleEmitDraft({
          prisma: params.prisma,
          orgId: params.orgId,
          teammate: params.teammate,
          runId: params.runId,
          toolUse,
          toolSeq,
          modelCallId,
        });
        if (emitOutcome.status === 'completed') {
          const run = await params.prisma.agentRun.update({
            where: { id: params.runId },
            data: {
              status: 'completed',
              completedAt: new Date(),
              outputDraftId: emitOutcome.draftId,
            },
          });
          return {
            status: 'completed',
            draftId: emitOutcome.draftId,
            toolCallCount,
            costCents: run.costCents,
          };
        }
        // model retries — feed the error back
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: emitOutcome.modelMessage,
          is_error: true,
        });
        continue;
      }

      // Regular tool dispatch.
      const tool = toolsByName.get(toolUse.name);
      if (!tool) {
        await persistToolCall(params.prisma, {
          runId: params.runId,
          toolSeq,
          modelCallId,
          toolName: toolUse.name,
          args: toolUse.input,
          result: { error: 'unknown_tool' },
          durationMs: 0,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Unknown tool: "${toolUse.name}". Available: ${[...toolsByName.keys(), 'emit_draft'].join(', ')}`,
          is_error: true,
        });
        continue;
      }

      const tStart = now();
      let result: unknown;
      let isError = false;
      try {
        result = await tool.execute(toolUse.input, {
          runId: params.runId,
          orgId: params.orgId,
          prisma: params.prisma,
        });
      } catch (err) {
        isError = true;
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      const durationMs = now() - tStart;
      await persistToolCall(params.prisma, {
        runId: params.runId,
        toolSeq,
        modelCallId,
        toolName: toolUse.name,
        args: toolUse.input,
        result,
        durationMs,
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
        is_error: isError,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

/**
 * Handle an emit_draft tool call. Three outcomes:
 *   - { status: 'completed', draftId } — persisted, exit the loop.
 *   - { status: 'retry', modelMessage } — feed back to the model.
 */
async function handleEmitDraft(params: {
  prisma: PrismaClient;
  orgId: string;
  teammate: string;
  runId: string;
  toolUse: Anthropic.ToolUseBlock;
  toolSeq: number;
  modelCallId: string;
}): Promise<
  | { status: 'completed'; draftId: string }
  | { status: 'retry'; modelMessage: string }
> {
  const parsed = EmitDraftArgsSchema.safeParse(params.toolUse.input);
  if (!parsed.success) {
    await persistToolCall(params.prisma, {
      runId: params.runId,
      toolSeq: params.toolSeq,
      modelCallId: params.modelCallId,
      toolName: 'emit_draft',
      args: params.toolUse.input,
      result: { error: 'zod_validation_failed', issues: parsed.error.issues },
      durationMs: 0,
    });
    return {
      status: 'retry',
      modelMessage:
        `emit_draft args failed validation: ` +
        parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
    };
  }

  try {
    const persistResult = await persistDraftFromEmitArgs(params.prisma, {
      runId: params.runId,
      orgId: params.orgId,
      teammate: params.teammate,
      args: parsed.data,
    });
    await persistToolCall(params.prisma, {
      runId: params.runId,
      toolSeq: params.toolSeq,
      modelCallId: params.modelCallId,
      toolName: 'emit_draft',
      args: parsed.data,
      result: persistResult,
      durationMs: 0,
    });
    return { status: 'completed', draftId: persistResult.draftId };
  } catch (err) {
    if (err instanceof ClaimContractError && err.code === 'no_valid_claims') {
      await persistToolCall(params.prisma, {
        runId: params.runId,
        toolSeq: params.toolSeq,
        modelCallId: params.modelCallId,
        toolName: 'emit_draft',
        args: parsed.data,
        result: { error: 'no_valid_claims' },
        durationMs: 0,
      });
      return {
        status: 'retry',
        modelMessage:
          'All claims were dropped — each claim needs a citationId from a ' +
          'Citation row created earlier in this run (via fetch_url, ' +
          'brave_search, etc.) OR abstained=true. Retry with valid claims.',
      };
    }
    throw err;
  }
}

async function persistToolCall(
  prisma: PrismaClient,
  params: {
    runId: string;
    toolSeq: number;
    modelCallId: string;
    toolName: string;
    args: unknown;
    result: unknown;
    durationMs: number;
    costCents?: number;
  },
): Promise<void> {
  await prisma.toolCall.create({
    data: {
      runId: params.runId,
      toolSeq: params.toolSeq,
      modelCallId: params.modelCallId,
      toolName: params.toolName,
      args: params.args as Prisma.InputJsonValue,
      result: params.result as Prisma.InputJsonValue,
      durationMs: params.durationMs,
      costCents: params.costCents ?? 0,
    },
  });
}

async function abortRun(
  prisma: PrismaClient,
  runId: string,
  reason: string,
  toolCallCount: number,
): Promise<RunAgentResult> {
  const run = await prisma.agentRun.update({
    where: { id: runId },
    data: { status: 'abstained', reason, completedAt: new Date() },
  });
  return {
    status: 'abstained',
    reason,
    toolCallCount,
    costCents: run.costCents,
  };
}
