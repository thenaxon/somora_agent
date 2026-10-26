// Catalog mode for the openai-compatible engine: the turn sends the
// always-visible tools (src/tools/catalog.ts) in full, plus two
// meta-tools — tool_search and tool_call — and names the rest at the
// end of the system prompt.
//
// Why (measured 2026-10-26): a chat agent with external MCP servers
// sent ~80 schemas, ~32k tokens, on every request — five times the rest
// of its prompt. The design follows the two harnesses that face the
// same backends (vLLM/SGLang, local models): OpenClaw and Hermes.
//
//   - The `tools` array stays the same for the whole turn and across
//     turns with the same offered set. A tool found by tool_search is
//     never added to it: vLLM puts the tools block at the start of the
//     prompt, and a change there throws the prefix cache away.
//   - Every deferred tool is listed by name and one line. Without the
//     listing, models say a capability does not exist or fall back to
//     a visible tool (Hermes measured this).
//   - Lenient for weak models: a direct call to an exact deferred name
//     runs (logged as hydrated), stringified nested arguments are read
//     by the registry's rescue, unknown names get three suggestions.
//
// Gating stays where it was: only tools the turn OFFERS are listed,
// found or run. Builders get `all` — their whole set is direct.

import type OpenAI from 'openai';
import type { ToolDefinition } from '../tools/types.ts';

type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

export const TOOL_SEARCH = 'tool_search';
export const TOOL_CALL = 'tool_call';
export const META_TOOLS: ReadonlySet<string> = new Set([TOOL_SEARCH, TOOL_CALL]);

export const TOOL_SEARCH_DESCRIPTION =
  'Find tools that are not in your tool list. Your instructions end with a list of them by name: ' +
  'every tool there exists and you may use it. Search with English keywords — service, action, ' +
  'object, e.g. "reminder schedule create" or "image generate" — never a question. Each result ' +
  'gives the name, what it does and its input. Then run it with tool_call, or call it directly ' +
  'by its exact name. names: ["exact_name"] returns the full field descriptions of those tools ' +
  'instead of searching.';

export const TOOL_CALL_DESCRIPTION =
  'Run a tool that is not in your tool list — one named at the end of your instructions or ' +
  'found with tool_search. name: the exact tool name. arguments: its input as an object, as ' +
  'tool_search describes it. An error names the field that is wrong.';

export function metaToolSpecs(maxResults: number): ChatTool[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_SEARCH,
        description: TOOL_SEARCH_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            queries: {
              type: 'array',
              items: { type: 'string' },
              description: 'One query per capability, English keywords (service action object), e.g. ["reminder schedule create"].',
            },
            names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Exact tool names: returns their full input with every field description, no search.',
            },
            limit: { type: 'integer', minimum: 1, maximum: maxResults, description: `Results per query (default 5, max ${maxResults}).` },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: TOOL_CALL,
        description: TOOL_CALL_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The exact tool name.' },
            arguments: { type: 'object', description: "The tool's input as an object ({} when it takes none).", additionalProperties: true },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
  ];
}

// ── text helpers ─────────────────────────────────────────────────────

const STOP = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'by', 'is', 'it', 'this',
  'that', 'from', 'as', 'at', 'be', 'are', 'your', 'you', 'my', 'me', 'i', 'do', 'does', 'how',
  'what', 'which', 'can', 'want', 'need', 'please', 'tool', 'tools', 'mcp',
]);

/** Light stemming, enough that "images"/"image", "scheduling"/
 *  "schedule" and "reminder"/"remind" meet: plural, -ing, -ed, -er,
 *  then a final e. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  // "reminder" must meet "remind me" (sentinel's text): -er on longer
  // words only, so "user", "folder" and "server" stay whole.
  if (w.length > 6 && w.endsWith('er')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** The MCP server of a bridged hub tool (`mcp__<server>__<tool>`). */
export function serverOf(name: string): string | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  return m ? m[1]! : null;
}

/** First sentence, at most `max` characters. */
export function oneLine(description: string, max = 140): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const cut = flat.search(/(?<=[.!?])\s|—\s|;\s/);
  let first = cut > 0 ? flat.slice(0, cut).trim() : flat;
  if (first.length > max) first = `${first.slice(0, max - 1).trimEnd()}…`;
  return first.replace(/[.;—]+$/, '');
}

type JsonSchema = Record<string, unknown>;

function typeOf(s: JsonSchema | undefined, depth: number): string {
  if (!s) return 'any';
  if (Array.isArray(s.enum)) {
    const vals = (s.enum as unknown[]).map((v) => JSON.stringify(v));
    return vals.length > 6 ? `${vals.slice(0, 6).join('|')}|…` : vals.join('|');
  }
  if (s.const !== undefined) return JSON.stringify(s.const);
  const alts = (s.oneOf ?? s.anyOf) as JsonSchema[] | undefined;
  if (Array.isArray(alts)) {
    // Objects told apart by one constant field (sentinel's source.type):
    // name the field and its values — that is what the model must pick.
    const tag = discriminator(alts);
    if (tag) return `object (${tag.key}: ${tag.values.map((v) => JSON.stringify(v)).join('|')})`;
    const kinds = [...new Set(alts.map((a) => typeOf(a, depth + 1)))];
    return kinds.length > 4 ? 'object' : kinds.join('|');
  }
  const t = Array.isArray(s.type) ? (s.type as string[]).filter((x) => x !== 'null')[0] : (s.type as string | undefined);
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'array') return `${typeOf(s.items as JsonSchema | undefined, depth + 1)}[]`;
  if (t === 'object' || s.properties) {
    if (depth >= 1 || !s.properties) return 'object';
    return signature(s, depth + 1);
  }
  return t ?? 'any';
}

function discriminator(alts: JsonSchema[]): { key: string; values: unknown[] } | null {
  const props = alts.map((a) => (a.properties ?? {}) as Record<string, JsonSchema>);
  if (props.length < 2 || props.some((p) => Object.keys(p).length === 0)) return null;
  for (const key of Object.keys(props[0]!)) {
    const values = props.map((p) => p[key]?.const);
    if (values.every((v) => v !== undefined)) return { key, values };
  }
  return null;
}

/** A compact TypeScript-like view of an input schema: `{ action:
 *  "create"|"list"; id?: string }`. Nested objects one level deep;
 *  enums cut at six values. */
export function signature(schema: JsonSchema | undefined, depth = 0): string {
  const props = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema?.required as string[] | undefined) ?? []);
  const keys = Object.keys(props);
  if (keys.length === 0) return '{}';
  const parts = keys.map((k) => `${k}${required.has(k) ? '' : '?'}: ${typeOf(props[k], depth)}`);
  return `{ ${parts.join('; ')} }`;
}

// ── BM25 index over the deferred tools ───────────────────────────────

interface Doc {
  name: string;
  tf: Map<string, number>;
  len: number;
}

export interface SearchHit {
  name: string;
  server?: string;
  description: string;
  input: string;
}

export interface ToolSearchIndex {
  search(queries: readonly string[], limit: number): SearchHit[];
  sources(): Array<{ source: string; tools: number }>;
}

const K1 = 1.2;
/** Low length normalisation: tool descriptions differ tenfold in length,
 *  and the long ones are the big tools a search should find. */
const B = 0.5;

export function buildSearchIndex(defs: readonly ToolDefinition[]): ToolSearchIndex {
  const docs: Doc[] = defs.map((d) => {
    const server = serverOf(d.name);
    const tokens: string[] = [];
    const nameTokens = tokenize(server ? d.name.slice(`mcp__${server}__`.length) : d.name);
    // The name and the server count twice: they are what a model
    // searching for a capability most often names. Description words
    // count once each — a long description (sentinel's runs to a page)
    // must not win by repetition, nor lose by its length (B below).
    for (let i = 0; i < 2; i++) tokens.push(...nameTokens);
    if (server) for (let i = 0; i < 2; i++) tokens.push(...tokenize(server));
    tokens.push(...new Set(tokenize(d.description)));
    // The first sentence says what the tool is for: once more.
    tokens.push(...new Set(tokenize(oneLine(d.description, 300))));
    const props = ((d.jsonSchema as JsonSchema | undefined)?.properties ?? {}) as Record<string, unknown>;
    tokens.push(...tokenize(Object.keys(props).join(' ')));
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { name: d.name, tf, len: tokens.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  const byName = new Map(defs.map((d) => [d.name, d]));
  const N = docs.length;

  const hit = (name: string): SearchHit => {
    const d = byName.get(name)!;
    const server = serverOf(name);
    return {
      name,
      ...(server ? { server } : {}),
      description: oneLine(d.description, 200),
      input: signature(d.jsonSchema as JsonSchema | undefined),
    };
  };

  const scoreQuery = (query: string): Array<{ name: string; score: number }> => {
    const exact = query.trim();
    if (byName.has(exact)) return [{ name: exact, score: Number.POSITIVE_INFINITY }];
    const qTokens = [...new Set(tokenize(query))];
    // Answerable: words some tool actually contains. None of them — a
    // nonsense query — finds nothing instead of a near-miss list; from
    // four on a result must hold at least half (Hermes). Hermes also
    // demands the rarest word, but measured on somora's own tools that
    // sent "decide probability judge" to dream_run (the one tool saying
    // "judge"); the floor below keeps the noise out instead.
    const answerable = qTokens.filter((t) => (df.get(t) ?? 0) > 0);
    if (answerable.length === 0) return [];
    const minMatch = answerable.length >= 4 ? Math.ceil(answerable.length / 2) : 1;
    const out: Array<{ name: string; score: number }> = [];
    for (const d of docs) {
      let matched = 0;
      let score = 0;
      for (const t of answerable) {
        const f = d.tf.get(t);
        if (!f) continue;
        matched++;
        const n = df.get(t)!;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen));
      }
      if (matched >= minMatch) out.push({ name: d.name, score });
    }
    out.sort((a, b) => b.score - a.score);
    // Relevance floor: far weaker matches than the best are noise.
    const top = out[0]?.score ?? 0;
    return out.filter((r) => r.score >= top * 0.25);
  };

  return {
    search(queries, limit) {
      const best = new Map<string, number>();
      for (const q of queries) {
        for (const r of scoreQuery(q).slice(0, limit)) {
          if ((best.get(r.name) ?? -1) < r.score) best.set(r.name, r.score);
        }
      }
      return [...best.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(limit, queries.length > 1 ? limit * 2 : limit))
        .map(([name]) => hit(name));
    },
    sources() {
      const counts = new Map<string, number>();
      for (const d of defs) {
        const s = serverOf(d.name) ?? 'somora';
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      return [...counts.entries()].map(([source, tools]) => ({ source, tools }));
    },
  };
}

// ── the listing at the end of the system prompt ──────────────────────

const LISTING_HEAD =
  '## More tools, found on demand\n\n' +
  'These tools exist and you may use them, but their full descriptions are not in your tool list. ' +
  'Find one with tool_search (English keywords: service action object), then run it with ' +
  'tool_call({"name": "...", "arguments": {...}}) — or call it directly by its exact name.';

/**
 * Every deferred tool by name and one line, grouped: somora's own
 * first, then each external MCP server. Over `maxChars` the lines
 * shrink to 60 characters, then to names only, then to a count per
 * group. Same input, same bytes — it is part of the cached prefix.
 */
export function renderListing(defs: readonly ToolDefinition[], maxChars: number): string {
  const groups = new Map<string, ToolDefinition[]>();
  for (const d of defs) {
    const g = serverOf(d.name) ?? 'somora';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(d);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'somora' ? -1 : b === 'somora' ? 1 : a.localeCompare(b)));
  const title = (g: string) => (g === 'somora' ? 'somora:' : `${g} (external MCP server):`);
  const render = (lineMax: number | null): string => {
    const blocks = order.map((g) => {
      const ds = [...groups.get(g)!].sort((a, b) => a.name.localeCompare(b.name));
      if (lineMax === null) return `${title(g)} ${ds.map((d) => d.name).join(', ')}`;
      return [title(g), ...ds.map((d) => `- ${d.name} — ${oneLine(d.description, lineMax)}`)].join('\n');
    });
    return `${LISTING_HEAD}\n\n${blocks.join('\n\n')}`;
  };
  for (const lineMax of [140, 60, null] as const) {
    const text = render(lineMax);
    if (text.length <= maxChars) return text;
  }
  const counts = order.map((g) => `${title(g)} ${groups.get(g)!.length} tools — find them with tool_search`);
  return `${LISTING_HEAD}\n\n${counts.join('\n')}`;
}

// ── the plan for one turn ─────────────────────────────────────────────

export interface CatalogPlan {
  /** Definitions sent in full. */
  direct: ToolDefinition[];
  /** Offered but not sent: listed, searchable, callable. */
  deferred: ToolDefinition[];
  listing: string;
  index: ToolSearchIndex;
  metaTools: ChatTool[];
  defaultResults: number;
  maxResults: number;
}

/**
 * The turn's catalog, or null when there is nothing to defer (mode
 * `all`, a builder, or every offered tool is direct anyway) — then the
 * engine sends every schema as before.
 */
export function planCatalog(args: {
  offered: readonly ToolDefinition[];
  direct: readonly string[];
  settings: { mode: 'all' | 'catalog'; listingMaxChars: number; defaultResults: number; maxResults: number } | undefined;
}): CatalogPlan | null {
  if (!args.settings || args.settings.mode !== 'catalog') return null;
  const directSet = new Set(args.direct);
  // A tool that happens to be called like a meta-tool would be shadowed;
  // keep it direct rather than hide it.
  const direct = args.offered.filter((d) => directSet.has(d.name) || META_TOOLS.has(d.name));
  const deferred = args.offered.filter((d) => !directSet.has(d.name) && !META_TOOLS.has(d.name));
  if (deferred.length === 0) return null;
  return {
    direct,
    deferred,
    listing: renderListing(deferred, args.settings.listingMaxChars),
    index: buildSearchIndex(deferred),
    metaTools: metaToolSpecs(args.settings.maxResults),
    defaultResults: args.settings.defaultResults,
    maxResults: args.settings.maxResults,
  };
}

/** Nearest names by edit distance, for "did you mean". */
export function nearestNames(name: string, names: readonly string[], n = 3): string[] {
  const dist = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length]!;
  };
  const lower = name.toLowerCase();
  return [...names]
    .map((x) => ({ x, d: x.includes(lower) || lower.includes(x) ? 0 : dist(lower, x.toLowerCase()) }))
    .sort((a, b) => a.d - b.d || a.x.localeCompare(b.x))
    .slice(0, n)
    .map((r) => r.x);
}

/** tool_search's answer. */
export function runToolSearch(
  plan: CatalogPlan,
  offered: readonly ToolDefinition[],
  input: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  const a = (input ?? {}) as { queries?: unknown; names?: unknown; limit?: unknown; query?: unknown };
  // Lenient: a single `query` string, or `queries` as one string.
  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : typeof v === 'string' && v.trim() ? [v] : [];
  const queries = [...asList(a.queries), ...asList(a.query)];
  const names = asList(a.names);
  if (queries.length === 0 && names.length === 0) {
    return { ok: false, error: 'tool_search needs queries (English keywords, e.g. ["reminder schedule create"]) or names (exact tool names).' };
  }
  const limit = Math.min(plan.maxResults, Math.max(1, typeof a.limit === 'number' ? Math.floor(a.limit) : plan.defaultResults));
  const offeredByName = new Map(offered.map((d) => [d.name, d]));
  if (names.length > 0) {
    const tools = [];
    const notFound: Array<{ name: string; didYouMean: string[] }> = [];
    for (const n of names) {
      const d = offeredByName.get(n);
      if (!d) {
        notFound.push({ name: n, didYouMean: nearestNames(n, [...offeredByName.keys()]) });
        continue;
      }
      tools.push({ name: d.name, description: d.description, input: d.jsonSchema });
    }
    return {
      ok: true,
      data: {
        tools,
        ...(notFound.length > 0 ? { not_found: notFound } : {}),
        hint: 'Run one with tool_call({"name": ..., "arguments": {...}}) or call it directly by its name.',
      },
    };
  }
  const matches = plan.index.search(queries, limit);
  if (matches.length === 0) {
    return {
      ok: true,
      data: {
        matches: [],
        note: `No tool matches ${queries.map((q) => JSON.stringify(q)).join(', ')}. Try other English keywords (service action object), or check the list at the end of your instructions.`,
        sources: plan.index.sources(),
      },
    };
  }
  return {
    ok: true,
    data: {
      matches,
      hint: 'Run one with tool_call({"name": ..., "arguments": {...}}) or call it directly by its name. For every field description: tool_search({"names": ["<name>"]}).',
    },
  };
}

/** What the engine does with one call from the model in catalog mode. */
export type CallRoute =
  | { kind: 'search' }
  | { kind: 'run'; name: string; args: unknown; via?: 'tool_call' | 'hydrated' }
  | { kind: 'reject'; error: string };

/**
 * Route a call: tool_search answers here; tool_call unwraps to the real
 * tool; a direct call to an exact deferred name runs (hydrated); any
 * name the turn does not offer is refused with suggestions. Works for
 * mode `all` too (plan null): then only the offered check applies.
 */
export function routeCall(
  plan: CatalogPlan | null,
  offeredNames: ReadonlySet<string>,
  name: string,
  args: unknown,
): CallRoute {
  if (plan && name === TOOL_SEARCH) return { kind: 'search' };
  if (plan && name === TOOL_CALL) {
    const a = (args ?? {}) as { name?: unknown; arguments?: unknown };
    const target = typeof a.name === 'string' ? a.name.trim() : '';
    if (!target) return { kind: 'reject', error: 'tool_call needs name: the exact tool name, and arguments: its input as an object.' };
    if (META_TOOLS.has(target)) return { kind: 'reject', error: `${target} is called directly, not through tool_call.` };
    let inner: unknown = a.arguments ?? {};
    // Some models send the arguments object as JSON text.
    if (typeof inner === 'string') {
      const parsed = parseArgumentsText(inner);
      if (!parsed.ok) return { kind: 'reject', error: `tool_call arguments for ${target} must be an object; the text sent is not valid JSON (${parsed.error}).` };
      inner = parsed.value;
    }
    if (!offeredNames.has(target)) return { kind: 'reject', error: unknownToolMessage(target, offeredNames) };
    // A direct tool through tool_call: run it all the same — forgiving
    // beats a wasted round for a weak model.
    return { kind: 'run', name: target, args: inner, via: 'tool_call' };
  }
  if (!offeredNames.has(name)) return { kind: 'reject', error: unknownToolMessage(name, offeredNames, plan !== null) };
  if (plan && plan.deferred.some((d) => d.name === name)) return { kind: 'run', name, args, via: 'hydrated' };
  return { kind: 'run', name, args };
}

/** Arguments sent as JSON text. A long one from a weak model often has a
 *  closing brace too many or too few at the end (live 2026-10-26: a
 *  sentinel source with one "}" extra cost a round); up to three are
 *  mended, and the tool's own input check judges the rest. */
export function parseArgumentsText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: true, value: {} };
  const tryParse = (s: string): unknown => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(t);
  if (direct !== undefined) return { ok: true, value: direct };
  let error = '';
  try {
    JSON.parse(t);
  } catch (err) {
    error = (err as Error).message;
  }
  if (t.startsWith('{')) {
    let s = t;
    for (let i = 0; i < 3 && s.endsWith('}'); i++) {
      s = s.slice(0, -1).trimEnd();
      const v = tryParse(s);
      if (v !== undefined) return { ok: true, value: v };
    }
    for (let i = 1; i <= 3; i++) {
      const v = tryParse(t + '}'.repeat(i));
      if (v !== undefined) return { ok: true, value: v };
    }
  }
  return { ok: false, error: error.slice(0, 120) };
}

function unknownToolMessage(name: string, offered: ReadonlySet<string>, catalog = true): string {
  const near = nearestNames(name, [...offered]);
  return (
    `There is no tool '${name}' for you.` +
    (near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : '') +
    (catalog ? ' Find tools with tool_search (English keywords).' : '')
  );
}

/** Field-level help for a refused input: an unknown field gets the
 *  closest real field names. */
export function explainInvalidInput(error: string, def: ToolDefinition | undefined): string {
  if (!def) return error;
  const props = Object.keys(((def.jsonSchema as JsonSchema | undefined)?.properties ?? {}) as Record<string, unknown>);
  const unknown = [...error.matchAll(/Unrecognized key[s]?:? ((?:"[^"]+"(?:, )?)+)/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((k) => k[1]!));
  if (unknown.length === 0 || props.length === 0) return error;
  const tips = unknown.map((k) => `'${k}' → ${nearestNames(k, props, 2).join(' or ')}`);
  return `${error} Fields of ${def.name}: ${props.join(', ')}. Closest: ${tips.join('; ')}.`;
}
