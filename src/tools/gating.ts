// Per-agent tool visibility (design: private/mcp-hub-design.md §4.6).
// One filter, applied at BOTH tool-list surfaces — the in-process
// per-turn ToolInvoker (openai-compat) and the MCP child's tools/list
// (somora and external-server proxy mode) — so every engine sees
// the identical gated set.
//
// Pattern forms (config lives in each agent's agent.yaml `tools:`):
//   web_search           exact tool name
//   toolset:exec         every tool of a toolset tag
//   mcp__parallel__*     trailing-* glob on the name (server wildcard)
// Semantics: deny beats allow; empty/missing allow = everything not
// denied; missing section entirely = no restriction.

import type { Toolset } from './types.ts';

export interface ToolGating {
  deny: string[];
  allow: string[];
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
  'exec',
  'process',
  'todo_write',
  'ask_user',
  'plan_write',
  'spawn_subagent',
  'subagent_result',
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
 * The gating a persona's turn actually runs with: the kind's defaults
 * merged with what agent.yaml says. Chat agents: agent.yaml as is.
 * Builders: allow = kind list ∪ agent.yaml allow, deny = agent.yaml
 * deny — so an operator adds a tool by naming it in `allow` and removes
 * one by naming it in `deny`, and the matrix in the web shows the result.
 */
export function effectiveToolGating(kind: AgentKind, own: ToolGating | undefined): ToolGating | undefined {
  if (kind !== 'builder') {
    // The builder-only tools (task list, question, plan file) need the
    // task panel and the builder phases; a chat agent never sees them
    // unless its own allow-list names one explicitly.
    const namesBuilderTool = (own?.allow ?? []).some((p) => BUILDER_ONLY_TOOLS.has(p));
    if (namesBuilderTool) return own;
    return { deny: [...(own?.deny ?? []), 'toolset:builder'], allow: own?.allow ?? [] };
  }
  const allow = [...BUILDER_TOOL_ALLOW, ...(own?.allow ?? [])];
  return { deny: own?.deny ?? [], allow: [...new Set(allow)] };
}

export function isToolAllowed(
  name: string,
  toolset: Toolset | undefined,
  gating: ToolGating | undefined,
): boolean {
  if (!gating) return true;
  if (gating.deny.some((p) => matchesToolPattern(p, name, toolset))) return false;
  if (gating.allow.length === 0) return true;
  return gating.allow.some((p) => matchesToolPattern(p, name, toolset));
}
