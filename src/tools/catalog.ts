// The tool catalog: which of a turn's tools sit in the model's direct
// list and which wait behind the engine's tool search.
//
// Engines that defer tools (claude-cli behind ToolSearch, codex-cli
// behind its tool search / Code Mode) used to decide on their own:
// codex-cli had a list of 20, claude-cli deferred every somora tool.
// Measured 2026-10-26: 1,908 ToolSearch calls by claude-cli agents, and
// ask_user was never used by a chat agent — a tool the model must
// search for, it rarely thinks of. One list now serves both:
//
//   - codex-cli: every tool not in the set gets `deferLoading`;
//   - claude-cli: the MCP child marks the set `anthropic/alwaysLoad`;
//   - grok-cli: offers only search_tool/use_tool, nothing to mark;
//   - openai-compatible: sees every tool today. When it gets a catalog
//     with a load tool (the parked plan: direct list + catalog + load),
//     run-turn's `alwaysVisibleTools` is the list it starts from.
//
// The set is always cut to the tools the turn OFFERS — after Abilities
// (agent.yaml tools:), the session's deny list, builder mode/phase and
// availability. A tool the agent may not use is never listed, whatever
// the catalog says.

/** The everyday core: chosen by use (calls per tool across all agents,
 *  2026-10) against size (tokens of name + description + schema). Big
 *  tools used by few agents — sentinel, browser — stay deferred. */
export const DEFAULT_ALWAYS_VISIBLE: readonly string[] = [
  'exec',
  'process',
  'tmux',
  'file_read',
  'file_write',
  'file_patch',
  'file_list',
  'file_search',
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_get',
  'memory_write',
  'time_now',
  'agent_ask',
  'agent_ask_result',
  'spawn_subagent',
  'subagent_result',
  'somora_docs_read',
  'skill',
  // Offered only in a turn a person started (ask-attended.ts); when it
  // is offered, the model should not have to search for it.
  'ask_user',
];

/** Direct while the agent holds the dream/wiki review loop: the review
 *  is the whole turn then. dream_run (starting a dream) is not part of
 *  a review. */
export const REVIEW_LOOP_TOOLS: readonly string[] = [
  'dream_list',
  'dream_get',
  'dream_apply',
  'dream_dismiss',
  'dream_review',
  'wiki_edit',
];

/** Additions and removals for one engine or one model. */
export interface ToolListPatch {
  add?: readonly string[];
  remove?: readonly string[];
  /** openai-compatible: send every schema (`all`) or the catalog (`catalog`). */
  mode?: 'all' | 'catalog';
}

export type CatalogMode = 'all' | 'catalog';

/** config.yaml `toolCatalog`. */
export interface ToolCatalogConfig {
  alwaysVisible: readonly string[];
  /** Keyed by engine: claude-cli, codex-cli, grok-cli, openai-compatible. */
  engines?: Readonly<Record<string, ToolListPatch>>;
  /** Keyed by model alias or `<provider>/<modelId>`. */
  models?: Readonly<Record<string, ToolListPatch>>;
  search?: { listingMaxChars: number; defaultResults: number; maxResults: number };
}

export interface AlwaysVisibleOptions {
  /** A builder's tool set is small and short-described: all of it is direct. */
  kind?: 'chat' | 'builder';
  /** The agent holds the dream/wiki review loop (dream/loop-state.ts). */
  inReviewLoop?: boolean;
  /** The engine that answers this turn. */
  engine?: string;
  /** Names the answering model goes by: its alias and `<provider>/<modelId>`. */
  modelRefs?: readonly string[];
  catalog?: ToolCatalogConfig;
  /** Legacy `codexCli.directTools`: replaces the base list for codex-cli. */
  legacyCodexDirect?: readonly string[];
}

function applyPatch(set: Set<string>, patch: ToolListPatch | undefined): void {
  if (!patch) return;
  for (const n of patch.add ?? []) set.add(n);
  for (const n of patch.remove ?? []) set.delete(n);
}

/**
 * The tools of this turn that sit in the model's direct list, in the
 * order they are offered. `offered` is the turn's tool list after every
 * gate; nothing outside it is ever returned.
 */
export function alwaysVisibleTools(offered: readonly string[], opts: AlwaysVisibleOptions = {}): string[] {
  if (opts.kind === 'builder') return [...offered];
  const base =
    opts.engine === 'codex-cli' && opts.legacyCodexDirect
      ? opts.legacyCodexDirect
      : (opts.catalog?.alwaysVisible ?? DEFAULT_ALWAYS_VISIBLE);
  const wanted = new Set(base);
  if (opts.inReviewLoop) for (const n of REVIEW_LOOP_TOOLS) wanted.add(n);
  if (opts.engine) applyPatch(wanted, opts.catalog?.engines?.[opts.engine]);
  for (const ref of opts.modelRefs ?? []) applyPatch(wanted, opts.catalog?.models?.[ref]);
  return offered.filter((n) => wanted.has(n));
}

/**
 * How the openai-compatible engine sends this turn's tools: `all`
 * (every schema, the default) or `catalog` (the always-visible list
 * plus tool_search/tool_call, the rest named at the end of the system
 * prompt). A model's setting wins over its engine's; a builder always
 * gets `all` — its whole set is direct anyway.
 */
export function catalogMode(
  opts: Pick<AlwaysVisibleOptions, 'kind' | 'engine' | 'modelRefs' | 'catalog'>,
): CatalogMode {
  if (opts.kind === 'builder' || opts.engine !== 'openai-compatible') return 'all';
  for (const ref of opts.modelRefs ?? []) {
    const m = opts.catalog?.models?.[ref]?.mode;
    if (m) return m;
  }
  return opts.catalog?.engines?.[opts.engine]?.mode ?? 'all';
}
