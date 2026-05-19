import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBraveSearchTool,
  type BraveSearchOutput,
} from './brave-search';
import type { AgentTool, ToolContext } from '../agent-tool';

type FetchInput = string | URL | Request;
type FetchSpy = ReturnType<
  typeof vi.fn<(url: FetchInput, init?: RequestInit) => Promise<Response>>
>;
function fetchSpy(
  impl: (url: FetchInput, init?: RequestInit) => Promise<Response>,
): FetchSpy {
  return vi.fn(impl);
}

async function runSearch(
  tool: AgentTool,
  args: { query: string; count?: number },
  ctx: ToolContext,
): Promise<BraveSearchOutput> {
  return tool.execute(args, ctx) as Promise<BraveSearchOutput>;
}

function fakeJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeCtx(): ToolContext {
  return { runId: 'run-1', orgId: 'org-A', prisma: {} as never };
}

beforeEach(() => {
  process.env.BRAVE_SEARCH_API_KEY = 'test-key';
});

afterEach(() => {
  delete process.env.BRAVE_SEARCH_API_KEY;
});

describe('brave_search', () => {
  it('returns normalized results from a successful Brave response', async () => {
    const httpFetch = vi.fn(async () =>
      fakeJsonResponse({
        web: {
          results: [
            {
              title: 'Acme Inc',
              url: 'https://acme.com',
              description: 'A SaaS startup',
              age: '2026-04-12',
            },
            {
              title: 'Acme on TechCrunch',
              url: 'https://techcrunch.com/acme',
              description: 'Raised $5M',
            },
          ],
        },
      }),
    );
    const tool = buildBraveSearchTool({ httpFetch });
    const result = await tool.execute({ query: 'Acme funding' }, fakeCtx());
    expect(result).toEqual({
      query: 'Acme funding',
      results: [
        {
          title: 'Acme Inc',
          url: 'https://acme.com',
          description: 'A SaaS startup',
          age: '2026-04-12',
        },
        {
          title: 'Acme on TechCrunch',
          url: 'https://techcrunch.com/acme',
          description: 'Raised $5M',
          age: null,
        },
      ],
    });
  });

  it('attaches the X-Subscription-Token header from the env var', async () => {
    const httpFetch = fetchSpy(async () =>
      fakeJsonResponse({ web: { results: [] } }),
    );
    const tool = buildBraveSearchTool({ httpFetch });
    await tool.execute({ query: 'x' }, fakeCtx());
    const call = httpFetch.mock.calls[0];
    expect(call?.[1]?.headers).toMatchObject({
      'X-Subscription-Token': 'test-key',
    });
  });

  it('serializes query + count as URL params', async () => {
    const httpFetch = fetchSpy(async () =>
      fakeJsonResponse({ web: { results: [] } }),
    );
    const tool = buildBraveSearchTool({ httpFetch });
    await tool.execute({ query: 'startup funding 2026', count: 5 }, fakeCtx());
    const url = new URL(String(httpFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('q')).toBe('startup funding 2026');
    expect(url.searchParams.get('count')).toBe('5');
  });

  it('defaults count to 10 when not provided', async () => {
    const httpFetch = fetchSpy(async () =>
      fakeJsonResponse({ web: { results: [] } }),
    );
    const tool = buildBraveSearchTool({ httpFetch });
    await tool.execute({ query: 'x' }, fakeCtx());
    const url = new URL(String(httpFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('count')).toBe('10');
  });

  it('throws on a non-2xx response, surfacing the status', async () => {
    const httpFetch = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    );
    const tool = buildBraveSearchTool({ httpFetch });
    await expect(tool.execute({ query: 'x' }, fakeCtx())).rejects.toThrow(
      /HTTP 429/,
    );
  });

  it('refuses to run when BRAVE_SEARCH_API_KEY is unset', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    const tool = buildBraveSearchTool({ httpFetch: vi.fn() });
    await expect(tool.execute({ query: 'x' }, fakeCtx())).rejects.toThrow(
      /not configured/,
    );
  });

  it('rejects empty query at the Zod boundary', async () => {
    const tool = buildBraveSearchTool({ httpFetch: vi.fn() });
    await expect(tool.execute({ query: '' }, fakeCtx())).rejects.toThrow();
  });

  it('rejects count outside [1, 20]', async () => {
    const tool = buildBraveSearchTool({ httpFetch: vi.fn() });
    await expect(
      tool.execute({ query: 'x', count: 0 }, fakeCtx()),
    ).rejects.toThrow();
    await expect(
      tool.execute({ query: 'x', count: 25 }, fakeCtx()),
    ).rejects.toThrow();
  });

  it('handles missing web.results gracefully (returns empty array)', async () => {
    const httpFetch = fetchSpy(async () => fakeJsonResponse({}));
    const tool = buildBraveSearchTool({ httpFetch });
    const result = await runSearch(tool, { query: 'x' }, fakeCtx());
    expect(result.results).toEqual([]);
  });
});
