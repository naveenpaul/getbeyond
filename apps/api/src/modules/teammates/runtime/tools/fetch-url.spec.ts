import { describe, expect, it, vi } from 'vitest';
import { buildFetchUrlTool, type FetchUrlOutput } from './fetch-url';
import type { AgentTool, ToolContext } from '../agent-tool';

// Test helper: cast the tool's execute() return to the typed output. The
// AgentTool contract is `unknown` at the boundary; tests want the concrete
// shape so the assertions are type-safe.
async function runFetch(
  tool: AgentTool,
  args: { url: string },
  ctx: ToolContext,
): Promise<FetchUrlOutput> {
  return tool.execute(args, ctx) as Promise<FetchUrlOutput>;
}

function htmlResponse(html: string, init: { status?: number } = {}): Response {
  return new Response(html, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

interface FakeCitation {
  id: string;
  runId: string;
  url: string;
  title: string | null;
  excerpt: string;
}

function makeCtx(): { ctx: ToolContext; citations: FakeCitation[] } {
  const citations: FakeCitation[] = [];
  let counter = 0;
  const ctx: ToolContext = {
    runId: 'run-1',
    orgId: 'org-A',
    prisma: {
      citation: {
        create: vi.fn(
          async ({ data }: { data: Omit<FakeCitation, 'id'> }) => {
            const row: FakeCitation = { id: `cit-${++counter}`, ...data };
            citations.push(row);
            return row;
          },
        ),
      },
    } as never,
  };
  return { ctx, citations };
}

describe('fetch_url', () => {
  it('extracts title + readable excerpt + creates a Citation row', async () => {
    const html = `
      <html>
        <head><title>Acme Inc — homepage</title><style>.x{color:red}</style></head>
        <body>
          <script>window.foo = 1</script>
          <h1>Welcome to Acme</h1>
          <p>We are a <strong>SaaS startup</strong> founded in 2022.</p>
        </body>
      </html>
    `;
    const httpFetch = vi.fn(async () => htmlResponse(html));
    const { ctx, citations } = makeCtx();
    const tool = buildFetchUrlTool({ httpFetch });

    const result = await runFetch(tool, { url: 'https://acme.com' }, ctx);
    expect(result).toMatchObject({
      citationId: 'cit-1',
      url: 'https://acme.com',
      title: 'Acme Inc — homepage',
      status: 200,
    });
    expect(result.excerpt).toContain('Welcome to Acme');
    expect(result.excerpt).toContain('SaaS startup');
    // <script> + <style> stripped.
    expect(result.excerpt).not.toContain('window.foo');
    expect(result.excerpt).not.toContain('color:red');

    expect(citations).toHaveLength(1);
    expect(citations[0]?.runId).toBe('run-1');
    expect(citations[0]?.url).toBe('https://acme.com');
    expect(citations[0]?.title).toBe('Acme Inc — homepage');
  });

  it('handles missing <title> (returns null + still creates Citation)', async () => {
    const html = '<html><body><p>No title here</p></body></html>';
    const { ctx, citations } = makeCtx();
    const tool = buildFetchUrlTool({ httpFetch: vi.fn(async () => htmlResponse(html)) });

    const result = await runFetch(tool, { url: 'https://no-title.example' }, ctx);
    expect(result.title).toBeNull();
    expect(citations[0]?.title).toBeNull();
  });

  it('truncates the excerpt to maxTextLength characters', async () => {
    const longBody = 'word '.repeat(10_000);
    const html = `<html><body>${longBody}</body></html>`;
    const { ctx } = makeCtx();
    const tool = buildFetchUrlTool({
      httpFetch: vi.fn(async () => htmlResponse(html)),
      maxTextLength: 100,
    });
    const result = await runFetch(tool, { url: 'https://x.example' }, ctx);
    expect(result.excerpt.length).toBeLessThanOrEqual(100);
  });

  it('decodes HTML entities in title + excerpt', async () => {
    const html =
      '<html><head><title>Acme &amp; Co.</title></head><body><p>2 &lt; 3 &amp; 4 &gt; 1</p></body></html>';
    const { ctx } = makeCtx();
    const tool = buildFetchUrlTool({ httpFetch: vi.fn(async () => htmlResponse(html)) });
    const result = await runFetch(tool, { url: 'https://e.example' }, ctx);
    expect(result.title).toBe('Acme & Co.');
    expect(result.excerpt).toContain('2 < 3 & 4 > 1');
  });

  it('rejects non-URL input at the Zod boundary', async () => {
    const tool = buildFetchUrlTool({ httpFetch: vi.fn() });
    const { ctx } = makeCtx();
    await expect(
      tool.execute({ url: 'not-a-url' }, ctx),
    ).rejects.toThrow();
  });

  it('records the actual HTTP status returned (including 4xx)', async () => {
    const { ctx, citations } = makeCtx();
    const httpFetch = vi.fn(async () => htmlResponse('<title>Not Found</title>', { status: 404 }));
    const tool = buildFetchUrlTool({ httpFetch });
    const result = await runFetch(
      tool,
      { url: 'https://missing.example/page' },
      ctx,
    );
    expect(result.status).toBe(404);
    // Even on 404 we record the Citation so the audit log shows what was attempted.
    expect(citations).toHaveLength(1);
  });

  it('uses a User-Agent identifying getbeyond', async () => {
    const httpFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        htmlResponse('<title>x</title>'),
    );
    const { ctx } = makeCtx();
    const tool = buildFetchUrlTool({ httpFetch });
    await tool.execute({ url: 'https://x.example' }, ctx);
    const call = httpFetch.mock.calls[0];
    expect(call?.[1]?.headers).toMatchObject({
      'User-Agent': expect.stringContaining('getbeyond'),
    });
  });

  it('caps the raw body to maxBytes before extracting', async () => {
    const massive = '<html><body>' + 'a'.repeat(100_000) + '</body></html>';
    const httpFetch = vi.fn(async () => htmlResponse(massive));
    const { ctx } = makeCtx();
    const tool = buildFetchUrlTool({ httpFetch, maxBytes: 1000, maxTextLength: 8000 });
    const result = await runFetch(tool, { url: 'https://big.example' }, ctx);
    // Extracted text is bounded by the truncated input, so much shorter than 100k.
    expect(result.excerpt.length).toBeLessThan(2000);
  });
});
