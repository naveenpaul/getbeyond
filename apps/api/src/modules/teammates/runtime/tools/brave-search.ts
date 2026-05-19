import { z } from 'zod';
import type { AgentTool, ToolContext } from '../agent-tool';

/**
 * brave_search — web search via the Brave Search API (T4b.2).
 *
 * The Researcher's primary discovery tool. Every search result that the
 * model later cites becomes a `Citation` row via fetch_url; brave_search
 * itself does NOT create Citation rows (the snippet alone isn't a citation —
 * the model still needs to fetch the page to ground a claim).
 *
 * Cost-aware: each call costs ~$0.005 against Brave. The plan's Researcher
 * cost target is <$0.10 per run (10–20 search calls + a few fetches),
 * giving solo-founder Researcher syncs predictable economics.
 *
 * The HTTP client is injected so tests don't need vi.mock('fetch'); the
 * default is the global `fetch`.
 */

export const BraveSearchInputSchema = z.object({
  query: z.string().min(1, 'query is required'),
  count: z.number().int().min(1).max(20).optional(),
});

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  /** ISO-8601 timestamp; null if Brave didn't report one. */
  age: string | null;
}

export interface BraveSearchOutput {
  query: string;
  results: BraveSearchResult[];
}

export interface BraveSearchDeps {
  /** Brave API key. Defaults to `process.env.BRAVE_SEARCH_API_KEY`. */
  apiKey?: string;
  /** HTTP client. Defaults to global fetch. Tests inject a stub. */
  httpFetch?: typeof fetch;
}

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export function buildBraveSearchTool(deps: BraveSearchDeps = {}): AgentTool {
  const apiKeyFromEnv = deps.apiKey ?? process.env.BRAVE_SEARCH_API_KEY ?? '';
  const httpFetch = deps.httpFetch ?? fetch;

  return {
    name: 'brave_search',
    description:
      'Web search via Brave Search. Returns up to 10 results with title, ' +
      'url, description, and age. Use this to discover sources; call ' +
      'fetch_url on each result you want to cite (only fetched pages can be ' +
      'used as Citations for emit_draft claims).',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<BraveSearchOutput> {
      const parsed = BraveSearchInputSchema.parse(args);
      if (!apiKeyFromEnv || apiKeyFromEnv === 'change-me-in-production') {
        throw new Error(
          'brave_search: BRAVE_SEARCH_API_KEY is not configured',
        );
      }

      const url = new URL(BRAVE_SEARCH_URL);
      url.searchParams.set('q', parsed.query);
      url.searchParams.set('count', String(parsed.count ?? 10));

      const response = await httpFetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKeyFromEnv,
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `brave_search HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        );
      }

      const json = (await response.json()) as {
        web?: {
          results?: Array<{
            title?: string;
            url?: string;
            description?: string;
            age?: string;
          }>;
        };
      };

      const results: BraveSearchResult[] = (json.web?.results ?? []).map(
        (r) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          description: r.description ?? '',
          age: r.age ?? null,
        }),
      );

      return { query: parsed.query, results };
    },
  };
}

/** Default singleton — wired from RuntimeModule. */
export const braveSearchTool = buildBraveSearchTool();
