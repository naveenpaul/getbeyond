import { z } from 'zod';
import type { AgentTool, ToolContext } from '../agent-tool';

/**
 * fetch_url — fetch + extract readable text from a URL (T4b.2).
 *
 * Side effect: persists a `Citation` row pointing at the fetched URL with
 * a snippet of the extracted text. The returned payload includes the
 * Citation.id so the model can reference it in subsequent emit_draft calls.
 *
 * This is the load-bearing link in the trust chain: a claim CAN be cited
 * iff fetch_url was called on the source first. Drafts can't reference a
 * URL the model never actually loaded.
 *
 * Body-size cap: 2 MB raw HTML, then truncated to 8 KB extracted text in
 * the tool_result + Citation.excerpt. Lets the model fit dozens of
 * citations in a single context window; full text would balloon costs.
 *
 * Extraction is intentionally simple: strip <script> + <style>, collapse
 * whitespace. Readability.js-style heuristics land in a future tool tier
 * (cheerio + @mozilla/readability) when we move beyond MVP.
 */

export const FetchUrlInputSchema = z.object({
  url: z.string().url(),
});

export interface FetchUrlOutput {
  /** The Citation row's id — pass this back as citationId on emit_draft claims. */
  citationId: string;
  url: string;
  title: string | null;
  /** Cleaned text excerpt (max 8 KB). */
  excerpt: string;
  status: number;
  contentType: string | null;
}

export interface FetchUrlDeps {
  httpFetch?: typeof fetch;
  /** Soft cap on response body bytes. Above this, the body is truncated. */
  maxBytes?: number;
  /** Soft cap on extracted text length in characters. */
  maxTextLength?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TEXT = 8 * 1024;
const USER_AGENT = 'getbeyond-researcher/0.1 (+https://getbeyond.ai)';

export function buildFetchUrlTool(deps: FetchUrlDeps = {}): AgentTool {
  // Resolve the global lazily — capturing at factory-time freezes
  // `globalThis.fetch` to whatever was bound when this module loaded,
  // which breaks integration tests that override globalThis.fetch later.
  const httpFetch: typeof fetch = deps.httpFetch
    ? deps.httpFetch
    : (...args) => globalThis.fetch(...args);
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxTextLength = deps.maxTextLength ?? DEFAULT_MAX_TEXT;

  return {
    name: 'fetch_url',
    description:
      'Fetch a URL and extract readable text. Returns { citationId, url, ' +
      'title, excerpt, status }. The returned citationId can be used on ' +
      'emit_draft claims to source factual statements. Always fetch a URL ' +
      'before citing it — claims pointing at unfetched URLs are dropped.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', format: 'uri' } },
    },
    async execute(args: unknown, ctx: ToolContext): Promise<FetchUrlOutput> {
      const parsed = FetchUrlInputSchema.parse(args);
      const response = await httpFetch(parsed.url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
          'User-Agent': USER_AGENT,
        },
        redirect: 'follow',
      });

      const contentType = response.headers.get('content-type');
      const rawText = await readUpToBytes(response, maxBytes);
      const title = extractTitle(rawText);
      const excerpt = cleanExtract(rawText).slice(0, maxTextLength);

      const citation = await ctx.prisma.citation.create({
        data: {
          runId: ctx.runId,
          url: parsed.url,
          title,
          excerpt,
        },
      });

      return {
        citationId: citation.id,
        url: parsed.url,
        title,
        excerpt,
        status: response.status,
        contentType,
      };
    },
  };
}

/** Default singleton — wired from RuntimeModule. */
export const fetchUrlTool = buildFetchUrlTool();

// ─── Helpers ──────────────────────────────────────────────────────────

async function readUpToBytes(
  response: Response,
  maxBytes: number,
): Promise<string> {
  // Modest implementation: read full text but truncate. Production-grade
  // streaming-with-cap requires plumbing reader.read(); the value here is
  // not exposing the model to multi-MB blobs through tool_result, which
  // the truncation already handles.
  const text = await response.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (!match || !match[1]) return null;
  const decoded = decodeEntities(match[1].trim());
  return decoded.length > 0 ? decoded : null;
}

function cleanExtract(html: string): string {
  // Strip script + style + comments before collapsing whitespace. Good
  // enough for Researcher v1; richer extraction (cheerio + readability)
  // lands when we hit the wall on noisy pages.
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
