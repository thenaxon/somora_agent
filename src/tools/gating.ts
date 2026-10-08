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
//   0. chat agent and a builder-only tool (todo_write, ask_user,
//      plan_write) → off, whatever the rules say
//   1. named in deny          → off
//   2. matched by allow       → on
//   3. matched by a deny rule for a family or server → off
//   4. builder: on when in its own set (BUILDER_TOOL_ALLOW), else off
//   5. chat: an allow list from the old "only these" form → off;
//      otherwise on
// The Abilities window only ever writes names and the family/server
// rules it offers, so it can always edit what it wrote.

import type { Toolset } from './types.ts';

export interface ToolGating {
  deny: string[];
  allow: string[];
  /** Set on the gating a turn runs with (effectiveToolGating): decides
   *  the default for tools no rule names. Missing = chat. */
  kind?: AgentKind;
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

/** Tools of the `builder` toolset — hidden from chat agents by default. */
export const BUILDER_ONLY_TOOLS: ReadonlySet<string> = new Set(['todo_write', 'ask_user', 'plan_write']);

/**
 * The gating a persona's turn runs with: agent.yaml's rules plus the
 * kind, which supplies the default for tools no rule names (a builder's
 * own set; for a chat agent everything but the builder-only tools).
 */
export function effectiveToolGating(kind: AgentKind, own: ToolGating | undefined): ToolGating {
  return { deny: [...(own?.deny ?? [])], allow: [...(own?.allow ?? [])], kind };
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
  const builder = gating.kind === 'builder';
  if (!builder && isBuilderOnly(name, toolset)) return false;
  if (gating.deny.includes(name)) return false;
  if (gating.allow.some((p) => matchesToolPattern(p, name, toolset))) return true;
  if (gating.deny.some((p) => isGroupRule(p) && matchesToolPattern(p, name, toolset))) return false;
  if (builder) return BUILDER_TOOL_ALLOW.includes(name);
  return !isLegacyAllowList(gating);
}

/** The task list, question and plan file belong to the builder kind: a
 *  chat agent never gets them, not even through an allow entry. */
export function isBuilderOnly(name: string, toolset: Toolset | undefined): boolean {
  return toolset === 'builder' || BUILDER_ONLY_TOOLS.has(name);
}
