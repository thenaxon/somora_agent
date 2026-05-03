// Web tools — search via Brave Search API. web_fetch follows in a
// later commit (needs SSRF guard + content extraction).
//
// Provider choice: Brave-only for now, intentional. Adding more providers
// later means extending `config.web.<provider>.apiKey` and adding a
// runtime selector in the handler. Today the model never picks the
// provider — somora's tool surface is provider-agnostic.

import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import type { ToolDefinition } from '../types.ts';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

// 4-letter prefix → Brave's freshness enum (pd/pw/pm/py).
const FRESHNESS_MAP: Record<string, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

const SearchInput = z
  .object({
    query: z.string().min(1).max(400),
    count: z.number().int().min(1).max(20).optional(),
    country: z
      .string()
      .length(2)
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe('2-letter country code (ISO-3166), e.g. "AT", "DE", "US".'),
    freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  })
  .strict();

interface SearchHit {
  title: string;
  url: string;
  description: string;
  age?: string;
  language?: string;
}

interface SearchOutput {
  count: number;
  results: SearchHit[];
}

interface BraveResultRaw {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
  language?: string;
}

interface BraveResponseRaw {
  web?: {
    results?: BraveResultRaw[];
  };
}

export const webSearch: ToolDefinition<z.infer<typeof SearchInput>, SearchOutput> = {
  name: 'web_search',
  toolset: 'web',
  description:
    'Search the web for current information. Use this for facts that may have ' +
    'changed after your training cutoff, current events, recent product info, ' +
    'or to verify time-sensitive claims. Returns up to 10 hits by default with ' +
    'title, URL, and a snippet description. Pass URLs from results to web_fetch ' +
    '(when available) to read full page content. ' +
    'NEVER answer questions about current state of websites, news, prices, or ' +
    'people\'s recent activities from training data — search first. ' +
    'Optional `country` (2-letter code), `freshness` (day|week|month|year), and ' +
    '`count` (1-20).',
  inputSchema: SearchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query — keywords, question, or operators (site:, filetype:, "exact phrase").',
      },
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Maximum number of results (default 10).',
      },
      country: {
        type: 'string',
        pattern: '^[A-Za-z]{2}$',
        description: '2-letter country code (ISO-3166), e.g. "AT", "DE", "US". Defaults to global.',
      },
      freshness: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: 'Restrict results to content from the last day/week/month/year. Omit for any age.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  // Hidden when no Brave API key is configured — the model never sees a
  // tool it can't use, instead of getting "API key missing" errors.
  available: ({ config }) => Boolean(config.web?.brave?.apiKey),
  // Search results are typically <10 KB; cap at 50 KB so a future
  // pathologically chatty Brave response can't dominate context.
  maxResultSizeChars: 50_000,
  async handler(input, ctx): Promise<SearchOutput> {
    const apiKey = ctx.config.web?.brave?.apiKey;
    if (!apiKey) {
      // available() should have prevented us from getting here — but
      // belt-and-suspenders for the direct-invoke debug endpoint.
      throw new Error('web_search not configured: set config.web.brave.apiKey');
    }

    const params = new URLSearchParams({ q: input.query });
    if (input.count !== undefined) params.set('count', String(input.count));
    if (input.country) params.set('country', input.country.toUpperCase());
    if (input.freshness) params.set('freshness', FRESHNESS_MAP[input.freshness]!);

    const url = `${BRAVE_ENDPOINT}?${params.toString()}`;
    const start = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'X-Subscription-Token': apiKey,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new Error(`brave search request failed: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Brave returns 401 for bad keys, 422 for malformed queries, 429 for rate-limit.
      // Surface the status so the model gets a useful error string.
      throw new Error(`brave search ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as BraveResponseRaw;
    const raw = data.web?.results ?? [];

    const results: SearchHit[] = raw.slice(0, input.count ?? 10).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.description ?? '',
      ...(r.page_age ? { age: r.page_age } : {}),
      ...(r.language ? { language: r.language } : {}),
    }));

    logger.info({
      msg: 'tool.web_search',
      agent: ctx.agent,
      query: input.query,
      count: results.length,
      ms: Date.now() - start,
    });

    return { count: results.length, results };
  },
};

export function webTools(): ToolDefinition[] {
  return [webSearch] as ToolDefinition[];
}
