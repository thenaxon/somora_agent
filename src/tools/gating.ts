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
