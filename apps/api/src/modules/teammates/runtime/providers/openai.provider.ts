import OpenAI from 'openai';
import type { LlmProvider } from '../llm-provider';
import {
  LlmAuthError,
  LlmOverloadedError,
  LlmProviderError,
  LlmRateLimitError,
  type ContentBlock,
  type CreateMessageParams,
  type CreateMessageResult,
  type Message,
  type ProviderCapabilities,
  type StopReason,
  type ToolChoice,
  type ToolDefinition,
  type Usage,
} from '../llm-types';

/**
 * OpenAI provider adapter (LLM provider abstraction — plan P2).
 *
 * SDK QUARANTINE: this is the only file allowed to import `openai`
 * (enforced by dependency-cruiser). It DOWN-CONVERTS the runtime's
 * Anthropic-shaped neutral types to/from the OpenAI Chat Completions API —
 * the neutral model is a superset, so the asymmetry lives entirely here and
 * nothing OpenAI-shaped leaks back out (callers see only neutral shapes).
 *
 * Down-conversion map (the interesting, risk-bearing part):
 *
 *   neutral CreateMessageParams ──▶ OpenAI.ChatCompletionCreateParams
 *     systemPrompt ──▶ a leading { role: 'system' } message
 *     messages     ──▶ chat messages, with two structural rewrites:
 *       • assistant `tool_use` block(s) ──▶ ONE assistant message whose
 *         `tool_calls[]` carry the call id/name and `input` (object) JSON-
 *         STRINGIFIED into `function.arguments`. Any text blocks in the same
 *         turn become that assistant message's `content`.
 *       • user `tool_result` block(s)  ──▶ N separate { role: 'tool' }
 *         messages (one per result), each keyed by `tool_call_id`, emitted in
 *         array order so they line up with the tool_calls that preceded them.
 *         `isError: true` wraps the content in an error envelope so the model
 *         can tell a failure from a normal result (OpenAI has no `is_error`).
 *     tools        ──▶ tools: [{ type:'function', function:{ name, description,
 *                       parameters } }]
 *     toolChoice   ──▶ tool_choice ('auto' | 'required' | named function)
 *
 *   OpenAI.ChatCompletion ──▶ neutral CreateMessageResult
 *     choice.message.content    ──▶ text block (when non-empty)
 *     choice.message.tool_calls ──▶ tool_use blocks (arguments JSON-PARSED
 *                                    back into the neutral `input` object)
 *     finish_reason             ──▶ StopReason (tool_calls/stop/length/other)
 *     usage                     ──▶ Usage (OpenAI reports no cache split, so
 *                                    cache token fields are omitted)
 */

/** Minimal client surface the provider needs — lets tests inject a stub. */
export type OpenAIChatClient = Pick<OpenAI, 'chat'>;

const PROVIDER_NAME = 'openai';

/** Envelope so the model can distinguish a failed tool result from a normal one. */
function toolResultPayload(content: string, isError: boolean): string {
  return isError ? `Error: ${content}` : content;
}

export class OpenAIProvider implements LlmProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities: ProviderCapabilities = {
    toolUse: true,
    parallelToolUse: true,
    // OpenAI has no Anthropic-style prompt-cache control surface in this
    // adapter; usage carries no cache split, so cost.ts prices fresh tokens.
    caching: false,
  };

  private readonly client: OpenAIChatClient;

  constructor(client: OpenAIChatClient) {
    this.client = client;
  }

  async createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: params.systemPrompt },
      ...toOpenAIMessages(params.messages),
    ];

    const request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      messages,
      ...(params.tools && params.tools.length > 0
        ? { tools: toOpenAITools(params.tools) }
        : {}),
      ...(params.toolChoice
        ? { tool_choice: toOpenAIToolChoice(params.toolChoice) }
        : {}),
    };

    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(request);
    } catch (err) {
      throw normalizeError(err);
    }

    const choice = completion.choices[0];
    if (!choice) {
      throw new LlmProviderError(
        'OpenAI returned no choices',
        PROVIDER_NAME,
      );
    }

    return {
      content: fromOpenAIMessage(choice.message),
      stopReason: fromOpenAIFinishReason(choice.finish_reason),
      usage: fromOpenAIUsage(completion.usage),
      model: completion.model,
    };
  }
}

/**
 * Build the provider from an API key. Mirrors `createAnthropicProvider`:
 * throws on a missing/placeholder key so app boot fails loudly rather than
 * the first run failing opaquely.
 */
export function createOpenAIProvider(apiKey: string): OpenAIProvider {
  if (!apiKey || apiKey === 'change-me-in-production') {
    throw new Error('OPENAI_API_KEY is not set');
  }
  return new OpenAIProvider(new OpenAI({ apiKey }));
}

// ───────────────────────── neutral → OpenAI ─────────────────────────

/**
 * Down-convert neutral turns to OpenAI chat messages.
 *
 * The shapes diverge structurally, so this is not a 1:1 map:
 *   • An assistant turn carrying `tool_use` blocks collapses to a SINGLE
 *     assistant message with `tool_calls[]` (plus any text as `content`).
 *   • A user turn carrying `tool_result` blocks EXPANDS to N `role:'tool'`
 *     messages — OpenAI has no notion of multiple results inside one turn.
 */
function toOpenAIMessages(
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      out.push(toOpenAIAssistantMessage(msg.content));
    } else {
      out.push(...toOpenAIUserMessages(msg.content));
    }
  }
  return out;
}

function toOpenAIAssistantMessage(
  blocks: ContentBlock[],
): OpenAI.Chat.ChatCompletionAssistantMessageParam {
  const textParts: string[] = [];
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // tool_result does not appear in an assistant turn (neutral invariant).
  }

  const message: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    // OpenAI requires `content` to be present; '' is the canonical empty.
    content: textParts.length > 0 ? textParts.join('') : '',
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return message;
}

/**
 * A neutral user turn may hold plain text AND/OR several tool_result blocks.
 * Text becomes one `role:'user'` message; each tool_result becomes its own
 * `role:'tool'` message, emitted in array order so they map back to the
 * tool_calls of the preceding assistant message.
 */
function toOpenAIUserMessages(
  blocks: ContentBlock[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_result') {
      out.push({
        role: 'tool',
        tool_call_id: block.toolUseId,
        content: toolResultPayload(block.content, block.isError),
      });
    }
    // tool_use does not appear in a user turn (neutral invariant).
  }

  if (textParts.length > 0) {
    out.unshift({ role: 'user', content: textParts.join('') });
  }
  return out;
}

function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

function toOpenAIToolChoice(
  choice: ToolChoice,
): OpenAI.Chat.ChatCompletionToolChoiceOption {
  switch (choice.type) {
    case 'auto':
      return 'auto';
    // Anthropic 'any' == OpenAI 'required' (model MUST call some tool).
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
  }
}

// ───────────────────────── OpenAI → neutral ─────────────────────────

function fromOpenAIMessage(
  message: OpenAI.Chat.ChatCompletionMessage,
): ContentBlock[] {
  const out: ContentBlock[] = [];

  if (message.content) {
    out.push({ type: 'text', text: message.content });
  }

  for (const call of message.tool_calls ?? []) {
    // We only ever send function tools, so a non-function tool call (e.g. the
    // SDK's custom-tool variant) is not something we asked for — skip it. The
    // type guard also narrows the union so `.function` is accessible.
    if (call.type !== 'function') {
      continue;
    }
    out.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    });
  }

  return out;
}

/**
 * Tool-call arguments come back as a JSON string. Parse to the neutral object
 * `input`. A malformed string is a provider contract violation — surface it as
 * a neutral error rather than letting a `SyntaxError` escape the boundary.
 */
function parseToolArguments(raw: string): unknown {
  if (raw === '') {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new LlmProviderError(
      `OpenAI returned malformed tool arguments: ${raw}`,
      PROVIDER_NAME,
      err,
    );
  }
}

function fromOpenAIFinishReason(
  reason: OpenAI.Chat.ChatCompletion.Choice['finish_reason'],
): StopReason {
  switch (reason) {
    case 'tool_calls':
    // 'function_call' is the legacy single-function-call signal; treat the
    // same as tool_calls so older models still route through the tool loop.
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    // 'stop' | 'content_filter' | null | anything unknown → finished turn.
    default:
      return 'end';
  }
}

function fromOpenAIUsage(
  usage: OpenAI.Completions.CompletionUsage | undefined,
): Usage {
  // OpenAI may omit usage (e.g. some streaming/error paths). Default to 0 so
  // cost accounting stays well-defined.
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

// ───────────────────────────── errors ──────────────────────────────────

function normalizeError(err: unknown): LlmProviderError {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return new LlmAuthError(PROVIDER_NAME, err);
    }
    if (status === 429) {
      return new LlmRateLimitError(PROVIDER_NAME, err);
    }
    if (status === 529 || status === 503) {
      return new LlmOverloadedError(PROVIDER_NAME, err);
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LlmProviderError(
    `OpenAI call failed: ${message}`,
    PROVIDER_NAME,
    err,
  );
}
