// Web tools — web_search through the configured search providers
// (search-providers.ts: Brave, SearXNG, in the operator's order) and
// web_fetch (fetch.ts). The model never picks the provider: one tool,
// one schema; the result says which provider answered.

import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import type { ToolDefinition } from '../types.ts';
import { webFetch } from './fetch.ts';
import { providerCall, searchInOrder, searchOrder, type SearchHit } from './search-providers.ts';

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

interface SearchOutput {
  count: number;
  results: SearchHit[];
  /** Which provider answered: brave or searxng. */
  provider: string;
  /** Set when a provider before it failed: which, and why. */
  fallbackFrom?: Array<{ provider: string; error: string }>;
  /** Options this provider could not apply (SearXNG has no country). */
  ignored?: string[];
}

export const webSearch: ToolDefinition<z.infer<typeof SearchInput>, SearchOutput> = {
  name: 'web_search',
  // Changes nothing: may run beside other such calls of a round.
  concurrent: true,
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
        description: '2-letter country code (ISO-3166), e.g. "AT", "DE", "US". Defaults to global. Not every search provider applies it; the result then lists it under `ignored`.',
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
  // Hidden when no provider is configured — the model never sees a
  // tool it can't use, instead of getting "API key missing" errors.
  available: ({ config }) => searchOrder(config).length > 0,
  // Search results are typically <10 KB; cap at 50 KB so a
  // pathologically chatty response can't dominate context.
  maxResultSizeChars: 50_000,
  async handler(input, ctx): Promise<SearchOutput> {
    const order = searchOrder(ctx.config);
    const start = Date.now();
    let outcome;
    try {
      outcome = await searchInOrder(order, input, providerCall(ctx.config));
    } catch (err) {
      logger.warn({ msg: 'tool.web_search_failed', agent: ctx.agent, query: input.query, order, error: (err as Error).message, ms: Date.now() - start });
      throw err;
    }
    const fallbackFrom = outcome.failed.length > 0 ? outcome.failed : undefined;
    logger.info({
      msg: 'tool.web_search',
      agent: ctx.agent,
      query: input.query,
      provider: outcome.provider,
      ...(fallbackFrom ? { fallbackFrom } : {}),
      count: outcome.results.length,
      ms: Date.now() - start,
    });
    return {
      count: outcome.results.length,
      results: outcome.results,
      provider: outcome.provider,
      ...(fallbackFrom ? { fallbackFrom } : {}),
      ...(outcome.ignored?.length ? { ignored: outcome.ignored } : {}),
    };
  },
};

export function webTools(): ToolDefinition[] {
  return [webSearch, webFetch] as ToolDefinition[];
}
