// Per-agent tool visibility (design: private/abilities-gating/DESIGN.md).
// One filter, applied at every tool-list surface — the in-process
// per-turn ToolInvoker (openai-compat), Codex dynamic tools and the MCP
// child's tools/list — so every engine sees the identical set.
//
// agent.yaml `tools:` holds two lists of rules:
//   deny:  web_search            one tool off
//          toolset:exec          a whole family off, tools added later too
//          mcp__parallel__*      every tool of an MCP server off, ditto
//   allow: mcp__parallel__fetch  one tool on — also inside a family that
//                                is off (an exception), and for a builder
//                                a tool beyond its own set
//
// A tool is decided in this order (isToolAllowed):
//   0. chat agent and a builder-only tool (todo_write, plan_write)
//      → off, whatever the rules say
//   1. named in deny          → off
//   2. matched by allow       → on
//   3. matched by a deny rule for a family or server → off
//   4. builder: on when in its own set (BUILDER_TOOL_ALLOW), else off
//   5. chat: an allow list from the old "only these" form → off;
//      otherwise on
// Before all of them: the dream tools and the wiki writing tools follow
// the agent's `dreams` switch (followsDreams), whatever the rules say —
// one switch, not a second one in the Abilities window that can contradict
// it (private/dream-switch/KONZEPT.md).
// The Abilities window only ever writes names and the family/server
// rules it offers, so it can always edit what it wrote.

import type { Toolset } from './types.ts';

export interface ToolGating {
  deny: string[];
  allow: string[];
  /** Set on the gating a turn runs with (effectiveToolGating): decides
   *  the default for tools no rule names. Missing = chat. */
  kind?: AgentKind;
  /** Rules for this session alone that beat every allow — the
   *  `subagents.tools.deny` list on a session started as a sub-agent
   *  (withSessionDeny). */
  sessionDeny?: string[];
  /** The agent's `dreams` switch, set on the gating a turn runs with:
   *  the tools that follow it (followsDreams) are on exactly when it is. */
  dreams?: boolean;
}

/** Tools that follow the `dreams` switch instead of the rules: the dream
 *  tools (review and apply findings, start a phase) and the wiki writing
 *  tools. An agent that does not dream reads the wiki, never writes it. */
export function followsDreams(toolset: Toolset | undefined): boolean {
  return toolset === 'dream' || toolset === 'wiki';
}

/** A rule for a whole family or server: `toolset:<tag>` or `<prefix>*`. */
export function isGroupRule(pattern: string): boolean {
  return pattern.startsWith('toolset:') || pattern.endsWith('*');
}

export function matchesToolPattern(pattern: string, name: string, toolset: Toolset | undefined): boolean {
  if (pattern.startsWith('toolset:')) {
    return toolset !== undefined && pattern.slice('toolset:'.length) === toolset;
  }
  if (pattern.endsWith('*')) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return pattern === name;
}

/**
 * What a Builder agent (agent.yaml `kind: builder`) sees by default: the
 * coding harness set — files, shell, task list, questions, helpers,
 * consulting colleagues, skills, the web page it was pointed at, the
 * project it is pinned to, and read-only memory. Everything else
 * (memory writes, dreaming, sentinel, browser, media, tmux, docs, wiki,
 * external MCP servers) is off unless the agent's own `tools.allow`
 * names it. A short list is the point: a local model that is offered 48
 * tools (~19k tokens of schema per request) stops using any of them
 * well; a coding harness offers ten to twenty.
 */
export const BUILDER_TOOL_ALLOW: readonly string[] = [
  'file_read',
  'file_write',
  'file_patch',
  'file_search',
  'file_list',
  'analyze_file',
  'exec',
  'process',
  'todo_write',
  'ask_user',
  'plan_write',
  'spawn_subagent',
  'subagent_result',
  'subagent_cancel',
  'agent_ask',
  'agent_ask_result',
  'skill',
  'skill_list',
  'web_fetch',
  'web_search',
  'project_get',
  'project_list',
  'project_create',
  'project_focus',
  'memory_search',
  'memory_get',
  'time_now',
];

export type AgentKind = 'chat' | 'builder';

/** Tools of the `builder` toolset — hidden from chat agents by default.
 *  `ask_user` is not one of them: every agent may ask the person, in a
 *  turn the person started (sessionOffersAsk). */
export const BUILDER_ONLY_TOOLS: ReadonlySet<string> = new Set(['todo_write', 'plan_write']);

/**
 * The gating a persona's turn runs with: agent.yaml's rules plus the
 * kind, which supplies the default for tools no rule names (a builder's
 * own set; for a chat agent everything but the builder-only tools).
 */
export function effectiveToolGating(kind: AgentKind, own: ToolGating | undefined, dreams?: boolean): ToolGating {
  return { deny: [...(own?.deny ?? [])], allow: [...(own?.allow ?? [])], kind, ...(dreams !== undefined ? { dreams } : {}) };
}

/** A chat agent's allow list from the old "only these tools" form: some
 *  entry stands on its own instead of being an exception to a family
 *  that is off. Kept meaning "only these" so such files do not open up. */
export function isLegacyAllowList(gating: ToolGating): boolean {
  if (gating.allow.length === 0) return false;
  const groups = gating.deny.filter(isGroupRule);
  return gating.allow.some((a) => !groups.some((g) => patternCovers(g, a)));
}

/** Family of a tool by name, for deciding whether a `toolset:` rule
 *  covers an allow entry. Set by registerAllTools; unknown → undefined. */
let toolsetOf: (name: string) => Toolset | undefined = () => undefined;
export function setToolsetLookup(fn: (name: string) => Toolset | undefined): void {
  toolsetOf = fn;
}

/** Does group rule `g` cover the allow entry `a` (a name or a narrower
 *  pattern)? An unknown family counts as not covered: the file is then
 *  read in the old "only these" form, which closes rather than opens. */
function patternCovers(g: string, a: string): boolean {
  if (g.endsWith('*')) return a.startsWith(g.slice(0, -1));
  if (g.startsWith('toolset:')) return toolsetOf(a) === g.slice('toolset:'.length);
  return false;
}

/** A rule the kind already implies: a chat agent's `toolset:builder`
 *  deny is added by effectiveToolGating on every turn. Written into
 *  agent.yaml (every Abilities save did that until 2026-10-08) it adds
 *  nothing, and as a `toolset:` rule it switched the Abilities matrix to
 *  read-only for that agent. */
export function isImpliedRule(kind: AgentKind, pattern: string): boolean {
  return kind !== 'builder' && pattern === 'toolset:builder';
}

/** What a save writes: the client's rules without repeats and without
 *  rules the kind implies. */
export function gatingToStore(kind: AgentKind, gating: ToolGating): ToolGating {
  return {
    deny: [...new Set(gating.deny)].filter((p) => !isImpliedRule(kind, p)),
    allow: [...new Set(gating.allow)],
  };
}

export function isToolAllowed(
  name: string,
  toolset: Toolset | undefined,
  gating: ToolGating | undefined,
): boolean {
  if (!gating) return true;
  if (gating.sessionDeny?.some((p) => matchesToolPattern(p, name, toolset))) return false;
  if (gating.dreams !== undefined && followsDreams(toolset)) return gating.dreams;
  const builder = gating.kind === 'builder';
  if (!builder && isBuilderOnly(name, toolset)) return false;
  if (gating.deny.includes(name)) return false;
  if (gating.allow.some((p) => matchesToolPattern(p, name, toolset))) return true;
  if (gating.deny.some((p) => isGroupRule(p) && matchesToolPattern(p, name, toolset))) return false;
  if (builder) return BUILDER_TOOL_ALLOW.includes(name);
  return !isLegacyAllowList(gating);
}

/** Default of `subagents.tools.deny`: a sub-agent's report reaches its
 *  parent on its own, and an extra agent_ask to the parent comes back
 *  as an echo of the parent's own reply (agent report, 2026-10-13;
 *  468 sub sessions used it 5 times, every time to report to the parent). */
export const DEFAULT_SUBAGENT_TOOL_DENY: readonly string[] = ['agent_ask', 'agent_ask_result', 'agent_ask_cancel'];

/** A session spawn_subagent started (meta `spawn.kind` sub or self-sub) —
 *  for good, also for later turns in it. */
export function isSubagentSession(meta: unknown): boolean {
  const spawn = (meta as { spawn?: { kind?: unknown } } | null | undefined)?.spawn;
  return spawn?.kind === 'sub' || spawn?.kind === 'self-sub';
}

/** Meta key of a session that carries work agents hand each other over
 *  A2A (docs/a2a.md) — an external agent's `a2a-<asker>` conversation. */
export const A2A_QUIET_KEY = 'a2aQuiet';

/** Meta key of a session another agent system talks to over A2A
 *  (docs/a2a.md): `{ peer, contextId }`. */
export const A2A_PEER_KEY = 'a2aPeer';

/** A session another agent system sends tasks to over A2A. */
export function isPeerSession(meta: unknown): boolean {
  const p = (meta as Record<string, unknown> | null | undefined)?.[A2A_PEER_KEY] as { peer?: unknown } | undefined;
  return typeof p?.peer === 'string';
}

/** A session nobody needs a dot for: a sub-agent's, or one where agents
 *  hand each other work over A2A. Its answer reaches the person through
 *  the asking agent's conversation. */
export function isQuietSession(meta: unknown): boolean {
  return isSubagentSession(meta) || (meta as Record<string, unknown> | null | undefined)?.[A2A_QUIET_KEY] === true;
}

/** The rules a session adds on top of its agent's: `subagents.tools.deny`
 *  for a sub-agent session, `a2a.tools.deny` for one another agent system
 *  sends tasks to, nothing otherwise. */
export function sessionToolDeny(
  config: { subagents?: { tools?: { deny?: readonly string[] } }; a2a?: { tools?: { deny?: readonly string[] } } } | undefined,
  meta: unknown,
): string[] {
  if (isPeerSession(meta)) return [...(config?.a2a?.tools?.deny ?? DEFAULT_A2A_INBOUND_TOOL_DENY)];
  if (!isSubagentSession(meta)) return [];
  return [...(config?.subagents?.tools?.deny ?? DEFAULT_SUBAGENT_TOOL_DENY)];
}

/** Default of `a2a.tools.deny`, kept here beside the sub-agent one so the
 *  gating has no config import. Same as config/types.ts. A task from
 *  another system sets off no further agent work: no asking colleagues,
 *  no sub-agents (they could carry another agent's persona), no builder
 *  orders, no switching another session's model, no Sentinel triggers
 *  (they wake agents, and an outside system should not leave schedules
 *  behind). Found missing in the live tests of 2026.1016.8 and .9. */
export const DEFAULT_A2A_INBOUND_TOOL_DENY: readonly string[] = ['agent_ask', 'agent_ask_result', 'agent_ask_cancel', 'spawn_subagent', 'spawn_subagents', 'builder_dispatch', 'session_model', 'sentinel'];

/** The agent's gating with a session's own rules on top. */
export function withSessionDeny(gating: ToolGating | undefined, deny: readonly string[]): ToolGating | undefined {
  if (deny.length === 0) return gating;
  return { ...(gating ?? { deny: [], allow: [] }), sessionDeny: [...deny] };
}

/** Entries of a deny list that name nothing: not a tool somora has, not
 *  a known family, not a pattern. MCP tools (`mcp__…`) count as known —
 *  their server may simply be down. */
export function unknownToolRules(rules: readonly string[], knownNames: ReadonlySet<string>, knownToolsets: ReadonlySet<string>): string[] {
  return rules.filter((r) => {
    if (r.startsWith('toolset:')) return !knownToolsets.has(r.slice('toolset:'.length));
    if (r.endsWith('*') || r.startsWith('mcp__')) return false;
    return !knownNames.has(r);
  });
}

/** The task list, question and plan file belong to the builder kind: a
 *  chat agent never gets them, not even through an allow entry. */
export function isBuilderOnly(name: string, toolset: Toolset | undefined): boolean {
  return toolset === 'builder' || BUILDER_ONLY_TOOLS.has(name);
}
