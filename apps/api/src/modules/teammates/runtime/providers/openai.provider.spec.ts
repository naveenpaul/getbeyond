import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import {
  OpenAIProvider,
  createOpenAIProvider,
  type OpenAIChatClient,
} from './openai.provider';
import {
  LlmAuthError,
  LlmOverloadedError,
  LlmProviderError,
  LlmRateLimitError,
  type CreateMessageParams,
  type Message,
} from '../llm-types';

/**
 * Down-convert matrix for the OpenAI adapter (LLM provider abstraction —
 * plan P2, the riskiest surface).
 *
 * The neutral model is Anthropic-shaped (content blocks), so the OpenAI
 * adapter does real structural surgery: tool_use→tool_calls (object input →
 * JSON-string arguments), tool_result→N× role:tool (ordered), isError→content
 * envelope, plus stop_reason/usage mapping. These tests pin every cell of that
 * matrix, including round-trips and unknown enum values.
 */

type CreateFn = ReturnType<typeof vi.fn>;

/** Build a stub OpenAI chat client whose create() returns `response`. */
function makeClient(
  response: OpenAI.Chat.ChatCompletion,
  create: CreateFn = vi.fn(async () => response),
): { client: OpenAIChatClient; create: CreateFn } {
  return {
    client: {
      chat: {
        completions: { create },
      } as unknown as OpenAI['chat'],
    },
    create,
  };
}

/** Minimal ChatCompletion for response-mapping assertions. */
function chatCompletion(
  partial: Partial<OpenAI.Chat.ChatCompletion> & {
    message?: Partial<OpenAI.Chat.ChatCompletionMessage>;
    finish_reason?: OpenAI.Chat.ChatCompletion.Choice['finish_reason'];
  } = {},
): OpenAI.Chat.ChatCompletion {
  const { message, finish_reason, ...rest } = partial;
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'ok',
          refusal: null,
          ...message,
        } as OpenAI.Chat.ChatCompletionMessage,
        finish_reason: finish_reason ?? 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...rest,
  } as OpenAI.Chat.ChatCompletion;
}

const BASE_PARAMS: CreateMessageParams = {
  model: 'gpt-4o',
  systemPrompt: 'You are a researcher.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

/** Pull the request object the stub create() was called with. */
function lastRequest(
  create: CreateFn,
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  const calls = create.mock.calls as unknown[][];
  return calls[calls.length - 1][0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
}

describe('OpenAIProvider — neutral → OpenAI request mapping', () => {
  it('prepends a system message and maps model + default max_tokens', async () => {
    const { client, create } = makeClient(chatCompletion());
    await new OpenAIProvider(client).createMessage(BASE_PARAMS);

    const req = lastRequest(create);
    expect(req.model).toBe('gpt-4o');
    expect(req.max_tokens).toBe(4096);
    expect(req.messages[0]).toEqual({
      role: 'system',
      content: 'You are a researcher.',
    });
    expect(req.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('honors explicit maxTokens', async () => {
    const { client, create } = makeClient(chatCompletion());
    await new OpenAIProvider(client).createMessage({
      ...BASE_PARAMS,
      maxTokens: 1024,
    });
    expect(lastRequest(create).max_tokens).toBe(1024);
  });

  it('maps tools to function tools with parameters schema', async () => {
    const { client, create } = makeClient(chatCompletion());
    await new OpenAIProvider(client).createMessage({
      ...BASE_PARAMS,
      tools: [
        {
          name: 'brave_search',
          description: 'web search',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(lastRequest(create).tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'brave_search',
          description: 'web search',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
  });

  it('omits tools and tool_choice when not provided', async () => {
    const { client, create } = makeClient(chatCompletion());
    await new OpenAIProvider(client).createMessage(BASE_PARAMS);
    const req = lastRequest(create) as unknown as Record<string, unknown>;
    expect(req).not.toHaveProperty('tools');
    expect(req).not.toHaveProperty('tool_choice');
  });

  it.each([
    [{ type: 'auto' } as const, 'auto'],
    [{ type: 'any' } as const, 'required'],
  ])('maps %o tool_choice → %s', async (choice, expected) => {
    const { client, create } = makeClient(chatCompletion());
    await new OpenAIProvider(client).createMessage({
      ...BASE_PARAMS,
      toolChoice: choice,
    });
    expect(lastRequest(create).tool_choice).toBe(expected);
  });

  it('maps a named tool_choice to a function selection', async () => {
    const { client, create } = makeClient(chatCompletion());
    await new OpenAIProvider(client).createMessage({
      ...BASE_PARAMS,
      toolChoice: { type: 'tool', name: 'brave_search' },
    });
    expect(lastRequest(create).tool_choice).toEqual({
      type: 'function',
      function: { name: 'brave_search' },
    });
  });
});

describe('OpenAIProvider — tool_use → tool_calls down-conversion', () => {
  it('collapses an assistant turn (text + tool_use) into one message with JSON-string args', async () => {
    const { client, create } = makeClient(chatCompletion());
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me search' },
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'brave_search',
            input: { q: 'beyond', limit: 3 },
          },
        ],
      },
    ];
    await new OpenAIProvider(client).createMessage({ ...BASE_PARAMS, messages });

    const req = lastRequest(create);
    expect(req.messages[1]).toEqual({
      role: 'assistant',
      content: 'let me search',
      tool_calls: [
        {
          id: 'tu-1',
          type: 'function',
          function: {
            name: 'brave_search',
            arguments: JSON.stringify({ q: 'beyond', limit: 3 }),
          },
        },
      ],
    });
  });

  it('emits multiple tool_calls for parallel tool_use in one turn', async () => {
    const { client, create } = makeClient(chatCompletion());
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'a', input: { x: 1 } },
          { type: 'tool_use', id: 'tu-2', name: 'b', input: { y: 2 } },
        ],
      },
    ];
    await new OpenAIProvider(client).createMessage({ ...BASE_PARAMS, messages });

    const assistant = lastRequest(create)
      .messages[1] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(assistant.content).toBe('');
    expect(assistant.tool_calls).toEqual([
      {
        id: 'tu-1',
        type: 'function',
        function: { name: 'a', arguments: JSON.stringify({ x: 1 }) },
      },
      {
        id: 'tu-2',
        type: 'function',
        function: { name: 'b', arguments: JSON.stringify({ y: 2 }) },
      },
    ]);
  });

  it('stringifies empty/undefined tool_use input to {}', async () => {
    const { client, create } = makeClient(chatCompletion());
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'ping', input: undefined },
        ],
      },
    ];
    await new OpenAIProvider(client).createMessage({ ...BASE_PARAMS, messages });
    const assistant = lastRequest(create)
      .messages[1] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(assistant.tool_calls?.[0].function.arguments).toBe('{}');
  });

  it('round-trips object input → JSON string (request) → object input (response)', async () => {
    const input = { q: 'beyond', nested: { a: [1, 2] } };
    // Response echoes the same args back as the model would on a follow-up.
    const { client } = makeClient(
      chatCompletion({
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            {
              id: 'tu-9',
              type: 'function',
              function: { name: 'brave_search', arguments: JSON.stringify(input) },
            },
          ],
        },
      }),
    );
    const result = await new OpenAIProvider(client).createMessage(BASE_PARAMS);
    expect(result.content).toEqual([
      { type: 'tool_use', id: 'tu-9', name: 'brave_search', input },
    ]);
  });
});

describe('OpenAIProvider — tool_result → role:tool down-conversion', () => {
  it('expands parallel tool_result blocks into N ordered role:tool messages', async () => {
    const { client, create } = makeClient(chatCompletion());
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            content: 'result one',
            isError: false,
          },
          {
            type: 'tool_result',
            toolUseId: 'tu-2',
            content: 'result two',
            isError: false,
          },
        ],
      },
    ];
    await new OpenAIProvider(client).createMessage({ ...BASE_PARAMS, messages });

    // [0] is the system message; the two tool messages follow in array order.
    expect(lastRequest(create).messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'tu-1', content: 'result one' },
      { role: 'tool', tool_call_id: 'tu-2', content: 'result two' },
    ]);
  });

  it('wraps an isError tool_result content in an error envelope', async () => {
    const { client, create } = makeClient(chatCompletion());
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            content: 'search failed',
            isError: true,
          },
        ],
      },
    ];
    await new OpenAIProvider(client).createMessage({ ...BASE_PARAMS, messages });
    expect(lastRequest(create).messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'tu-1',
      content: 'Error: search failed',
    });
  });

  it('splits a user turn with text + tool_result into a user message then tool message', async () => {
    const { client, create } = makeClient(chatCompletion());
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'here is the result' },
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            content: 'data',
            isError: false,
          },
        ],
      },
    ];
    await new OpenAIProvider(client).createMessage({ ...BASE_PARAMS, messages });
    expect(lastRequest(create).messages.slice(1)).toEqual([
      { role: 'user', content: 'here is the result' },
      { role: 'tool', tool_call_id: 'tu-1', content: 'data' },
    ]);
  });

  it('preserves cross-turn ordering: assistant tool_calls then their results', async () => {
    const { client, create } = makeClient(chatCompletion());
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'a', input: {} },
          { type: 'tool_use', id: 'tu-2', name: 'b', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tu-1', content: 'r1', isError: false },
          { type: 'tool_result', toolUseId: 'tu-2', content: 'r2', isError: false },
        ],
      },
    ];
    await new OpenAIProvider(client).createMessage({ ...BASE_PARAMS, messages });
    const msgs = lastRequest(create).messages.slice(1); // drop system
    expect(msgs[0]).toMatchObject({ role: 'assistant' });
    expect(msgs.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'tu-1', content: 'r1' },
      { role: 'tool', tool_call_id: 'tu-2', content: 'r2' },
    ]);
  });
});

describe('OpenAIProvider — OpenAI → neutral response mapping', () => {
  it('maps text-only content to a single text block', async () => {
    const { client } = makeClient(
      chatCompletion({ message: { content: 'hello' } }),
    );
    const result = await new OpenAIProvider(client).createMessage(BASE_PARAMS);
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.model).toBe('gpt-4o');
  });

  it('maps text + tool_calls into text then tool_use blocks', async () => {
    const { client } = makeClient(
      chatCompletion({
        finish_reason: 'tool_calls',
        message: {
          content: 'thinking',
          tool_calls: [
            {
              id: 'tu-9',
              type: 'function',
              function: { name: 'fetch_url', arguments: '{"url":"https://x"}' },
            },
          ],
        },
      }),
    );
    const result = await new OpenAIProvider(client).createMessage(BASE_PARAMS);
    expect(result.content).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 'tu-9', name: 'fetch_url', input: { url: 'https://x' } },
    ]);
  });

  it('omits the text block when content is null/empty (tool-only response)', async () => {
    const { client } = makeClient(
      chatCompletion({
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            { id: 'tu-1', type: 'function', function: { name: 'a', arguments: '{}' } },
          ],
        },
      }),
    );
    const result = await new OpenAIProvider(client).createMessage(BASE_PARAMS);
    expect(result.content).toEqual([
      { type: 'tool_use', id: 'tu-1', name: 'a', input: {} },
    ]);
  });

  it('parses empty-string tool arguments to {}', async () => {
    const { client } = makeClient(
      chatCompletion({
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            { id: 'tu-1', type: 'function', function: { name: 'a', arguments: '' } },
          ],
        },
      }),
    );
    const result = await new OpenAIProvider(client).createMessage(BASE_PARAMS);
    expect(result.content).toEqual([
      { type: 'tool_use', id: 'tu-1', name: 'a', input: {} },
    ]);
  });

  it('throws a neutral error on malformed tool arguments', async () => {
    const { client } = makeClient(
      chatCompletion({
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            { id: 'tu-1', type: 'function', function: { name: 'a', arguments: '{bad' } },
          ],
        },
      }),
    );
    const err = await new OpenAIProvider(client)
      .createMessage(BASE_PARAMS)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).message).toContain('malformed tool arguments');
  });

  it.each([
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['stop', 'end'],
    ['content_filter', 'end'],
    ['length', 'max_tokens'],
    [null, 'end'],
  ] as const)('maps finish_reason %s → %s', async (reason, neutral) => {
    const { client } = makeClient(
      chatCompletion({
        finish_reason: reason as OpenAI.Chat.ChatCompletion.Choice['finish_reason'],
      }),
    );
    const result = await new OpenAIProvider(client).createMessage(BASE_PARAMS);
    expect(result.stopReason).toBe(neutral);
  });

  it('maps usage prompt/completion tokens, no cache split', async () => {
    const { client } = makeClient(
      chatCompletion({
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      }),
    );
    const result = await new OpenAIProvider(client).createMessage(BASE_PARAMS);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
  });

  it('defaults usage to 0 when the API omits it', async () => {
    const { client } = makeClient(
      chatCompletion({ usage: undefined }),
    );
    const result = await new OpenAIProvider(client).createMessage(BASE_PARAMS);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('throws when the API returns no choices', async () => {
    const { client } = makeClient(chatCompletion({ choices: [] }));
    const err = await new OpenAIProvider(client)
      .createMessage(BASE_PARAMS)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).message).toContain('no choices');
  });
});

describe('OpenAIProvider — error normalization', () => {
  it.each([
    [401, LlmAuthError],
    [403, LlmAuthError],
    [429, LlmRateLimitError],
    [529, LlmOverloadedError],
    [503, LlmOverloadedError],
    [500, LlmProviderError],
  ])('maps APIError status %i to the right neutral error', async (status, Err) => {
    const apiError = new OpenAI.APIError(
      status,
      undefined,
      `http ${status}`,
      undefined,
    );
    const create = vi.fn(async () => {
      throw apiError;
    });
    const { client } = makeClient(chatCompletion(), create);
    await expect(
      new OpenAIProvider(client).createMessage(BASE_PARAMS),
    ).rejects.toBeInstanceOf(Err);
  });

  it('wraps a non-API error as LlmProviderError', async () => {
    const create = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const { client } = makeClient(chatCompletion(), create);
    const err = await new OpenAIProvider(client)
      .createMessage(BASE_PARAMS)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).provider).toBe('openai');
    expect((err as LlmProviderError).message).toContain('socket hang up');
  });
});

describe('OpenAIProvider — misc', () => {
  it('declares capabilities', () => {
    const { client } = makeClient(chatCompletion());
    const provider = new OpenAIProvider(client);
    expect(provider.name).toBe('openai');
    expect(provider.capabilities).toEqual({
      toolUse: true,
      parallelToolUse: true,
      caching: false,
    });
  });

  it('createOpenAIProvider throws on a missing/placeholder key', () => {
    expect(() => createOpenAIProvider('')).toThrow('OPENAI_API_KEY is not set');
    expect(() => createOpenAIProvider('change-me-in-production')).toThrow(
      'OPENAI_API_KEY is not set',
    );
  });

  it('createOpenAIProvider builds a provider for a real-looking key', () => {
    const provider = createOpenAIProvider('sk-test');
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });
});
