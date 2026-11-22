// The providers behind web_search (docs/tools.md "Web search"): Brave by
// API key, and a SearXNG instance the operator runs. The model sees one
// tool with one schema; which provider answers is configuration.
//
// Order: `web.search.order` when set, else Brave first, then SearXNG —
// each only when configured. Every search starts at the top of the
// order again; the next provider answers only when the one before
// FAILED (no answer in time, a network error, 5xx, 429, a refused key).
// A query the provider rejects as malformed (400, Brave's VALIDATION) fails as it is:
// the next provider would get the same bad query. Nothing is asked in
// parallel, so a search costs one provider's quota unless one fails.
//
// The design follows OpenClaw (one tool, providers behind it, a provider
// attribution on every result, fallback only on failure) with one
// difference it lacks: the order is the operator's, so a SearXNG
// instance can be asked first and Brave kept as the reserve.
//
// A SearXNG instance may itself use Brave as one of its engines. Then a
// Brave outage also thins SearXNG's results, and its Brave queries count
// against the same quota — it is a second path, not an independent one.

import type { Config, WebSearchProviderId } from '../../config/types.ts';

export interface SearchInput {
  query: string;
  count?: number;
  country?: string;
  freshness?: 'day' | 'week' | 'month' | 'year';
}

export interface SearchHit {
  title: string;
  url: string;
  description: string;
  age?: string;
  language?: string;
}

export interface ProviderAnswer {
  results: SearchHit[];
  /** Options of the call this provider cannot apply, said in the result. */
  ignored?: string[];
}

/** A provider's failure, and whether the next provider may step in. */
export class SearchProviderError extends Error {
  constructor(
    readonly provider: WebSearchProviderId,
    message: string,
    /** false: the query itself was rejected — another provider would be too. */
    readonly tryNext: boolean,
  ) {
    super(message);
  }
}

/** How long one provider may take. A SearXNG instance waits for its
 *  slowest engine, so a few seconds is normal; this bounds a hang. */
export const PROVIDER_TIMEOUT_MS = 30_000;

/** Statuses that say the query itself is wrong, not the provider. Not
 *  404: that is a wrong address (a moved instance), so the next
 *  provider may well answer. */
const QUERY_REJECTED = new Set([400, 413, 414, 422]);

export function statusTriesNext(status: number): boolean {
  return !QUERY_REJECTED.has(status);
}

/** The providers to ask, in order. Empty: web_search is not available. */
export function searchOrder(config: Config): WebSearchProviderId[] {
  const web = config.web;
  const configured = (id: WebSearchProviderId): boolean =>
    id === 'brave' ? Boolean(web?.brave?.apiKey) : Boolean(web?.searxng?.baseUrl);
  const order = web?.search?.order ?? (['brave', 'searxng'] as WebSearchProviderId[]);
  return order.filter(configured);
}

interface RawAnswer {
  status: number;
  ok: boolean;
  body: string;
}

/**
 * One request with its whole answer read inside the time limit. fetch()
 * resolves at the headers; a server that sends them and then stalls
 * must still end in a timeout here, or the next provider never gets
 * its turn.
 */
async function timedRequest(provider: WebSearchProviderId, url: string, init: RequestInit, timeoutMs: number): Promise<RawAnswer> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    throw new SearchProviderError(
      provider,
      ac.signal.aborted
        ? `${provider} search timed out after ${Math.round(timeoutMs / 1000)}s`
        : `${provider} search request failed: ${(err as Error).message}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

// ── Brave ─────────────────────────────────────────────────────────────

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_FRESHNESS: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

interface BraveResponseRaw {
  web?: { results?: Array<{ title?: string; url?: string; description?: string; page_age?: string; language?: string }> };
}

/** Brave's error body: `{error: {code, detail}}`, when it is one. */
export function braveError(body: string): { code?: string; detail?: string } {
  try {
    const e = (JSON.parse(body) as { error?: { code?: unknown; detail?: unknown } }).error;
    return {
      ...(typeof e?.code === 'string' ? { code: e.code } : {}),
      ...(typeof e?.detail === 'string' ? { detail: e.detail } : {}),
    };
  } catch {
    return {};
  }
}

/** `endpoint` is for tests; somora always asks Brave's own. */
export async function braveSearch(input: SearchInput, apiKey: string, timeoutMs = PROVIDER_TIMEOUT_MS, endpoint = BRAVE_ENDPOINT): Promise<ProviderAnswer> {
  const params = new URLSearchParams({ q: input.query });
  if (input.count !== undefined) params.set('count', String(input.count));
  if (input.country) params.set('country', input.country.toUpperCase());
  if (input.freshness) params.set('freshness', BRAVE_FRESHNESS[input.freshness]!);
  const res = await timedRequest(
    'brave',
    `${endpoint}?${params.toString()}`,
    { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } },
    timeoutMs,
  );
  if (!res.ok) {
    const body = res.body;
    const { code, detail } = braveError(body);
    // Brave answers 422 for a bad query AND for a bad key (measured
    // 2026-11-22: code VALIDATION vs SUBSCRIPTION_TOKEN_INVALID); only
    // its VALIDATION code says the query itself is wrong. 429 is the
    // quota or the rate.
    const tryNext = res.status === 422 ? code !== 'VALIDATION' : statusTriesNext(res.status);
    const what = detail ? `${detail}${code ? ` (${code})` : ''}` : body.slice(0, 300);
    throw new SearchProviderError('brave', `brave search ${res.status}: ${what}`, tryNext);
  }
  const data = parseJson<BraveResponseRaw>(res.body);
  if (!data) throw new SearchProviderError('brave', 'brave search answered with something that is not JSON', true);
  const raw = data.web?.results ?? [];
  return {
    results: raw.slice(0, input.count ?? 10).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.description ?? '',
      ...(r.page_age ? { age: r.page_age } : {}),
      ...(r.language ? { language: r.language } : {}),
    })),
  };
}

// ── SearXNG ───────────────────────────────────────────────────────────

interface SearxngResponseRaw {
  results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string | null }>;
  /** [[engine, reason], ...] — engines that did not answer this time. */
  unresponsive_engines?: Array<[string, string]>;
}

/** `<baseUrl>/search`, whether or not the address already ends in it.
 *  Built from the parsed address, so the path and the parameters never
 *  run into each other (the config refuses `?` and `#` in it anyway). */
export function searxngEndpoint(baseUrl: string, params?: URLSearchParams): string {
  const u = new URL(baseUrl);
  const path = u.pathname.replace(/\/+$/, '');
  u.pathname = /\/search$/i.test(path) ? path : `${path}/search`;
  u.search = params ? params.toString() : '';
  u.hash = '';
  return u.toString();
}

export async function searxngSearch(input: SearchInput, baseUrl: string, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<ProviderAnswer> {
  const params = new URLSearchParams({ q: input.query, format: 'json' });
  // SearXNG's time_range takes the same four words as the tool.
  if (input.freshness) params.set('time_range', input.freshness);
  const res = await timedRequest('searxng', searxngEndpoint(baseUrl, params), { headers: { Accept: 'application/json' } }, timeoutMs);
  if (!res.ok) {
    const body = res.body;
    // A fresh instance only serves HTML and refuses format=json with 403.
    const hint = res.status === 403 ? ' (does the instance allow JSON? add `json` to search.formats in its settings.yml)' : '';
    throw new SearchProviderError('searxng', `searxng search ${res.status}${hint}: ${body.slice(0, 200)}`, statusTriesNext(res.status));
  }
  const data = parseJson<SearxngResponseRaw>(res.body);
  if (!data || !Array.isArray(data.results)) {
    throw new SearchProviderError('searxng', 'searxng search answered with something that is not its JSON (is the address right?)', true);
  }
  const unresponsive = data.unresponsive_engines ?? [];
  if (data.results.length === 0 && unresponsive.length > 0) {
    // Nothing found because nothing answered is a failure, not an empty web.
    const names = unresponsive.map((e) => (Array.isArray(e) ? `${e[0]} (${e[1]})` : String(e))).join(', ');
    throw new SearchProviderError('searxng', `searxng search found nothing: its engines did not answer: ${names.slice(0, 300)}`, true);
  }
  const results = data.results
    .filter((r) => typeof r.url === 'string' && r.url.length > 0)
    .slice(0, input.count ?? 10)
    .map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.content ?? '',
      ...(r.publishedDate ? { age: r.publishedDate } : {}),
    }));
  return { results, ...(input.country ? { ignored: ['country'] } : {}) };
}

// ── In order ──────────────────────────────────────────────────────────

export interface SearchOutcome extends ProviderAnswer {
  provider: WebSearchProviderId;
  /** Providers asked before this one, and why each failed. */
  failed: Array<{ provider: WebSearchProviderId; error: string }>;
}

export type ProviderCall = (id: WebSearchProviderId, input: SearchInput) => Promise<ProviderAnswer>;

export function providerCall(config: Config): ProviderCall {
  return (id, input) => {
    if (id === 'brave') return braveSearch(input, config.web!.brave!.apiKey);
    return searxngSearch(input, config.web!.searxng!.baseUrl);
  };
}

/**
 * Ask the providers in order until one answers. Throws when none does,
 * with every provider's error, the first one first — it names the
 * provider the operator put on top.
 */
export async function searchInOrder(order: WebSearchProviderId[], input: SearchInput, call: ProviderCall): Promise<SearchOutcome> {
  const failed: SearchOutcome['failed'] = [];
  for (const id of order) {
    try {
      const answer = await call(id, input);
      return { ...answer, provider: id, failed };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ provider: id, error });
      const tryNext = err instanceof SearchProviderError ? err.tryNext : true;
      if (!tryNext) break;
    }
  }
  if (failed.length === 0) throw new Error('web_search not configured: set web.brave.apiKey or web.searxng.baseUrl');
  throw new Error(failed.map((f) => f.error).join(' | '));
}
