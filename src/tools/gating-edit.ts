// What a click in the Abilities window does to an agent's `tools:` and
// `skills:` rules (design: private/abilities-gating/DESIGN.md).
//
// Computed here, on the server, so every client gets the same result and
// the rules stay something the window can always edit again:
//
//   one tool on    → drop its own deny; still off (its family is off, or
//                    a builder's default) → name it under allow
//   one tool off   → drop its own allow; still on → name it under deny
//   a family off   → chat: one rule for it (`toolset:<tag>` or
//                    `mcp__<server>__*`), its single entries dropped — so
//                    tools the family gains later are off too
//   a family on    → chat: rule and single entries dropped; whatever is
//                    still off is named under allow
//   builder        → a family switch is the single switch for each tool
//                    (a builder's default is off, new tools stay off)
//
// Skills work the same; their one family is "all skills" with rule `*`.

import { ALL_SKILLS, isSkillAllowed, type SkillGating } from '../skills/gating.ts';
import { effectiveToolGating, isLegacyAllowList, isToolAllowed, type AgentKind, type ToolGating } from './gating.ts';
import type { Toolset } from './types.ts';

export interface CatalogTool {
  name: string;
  toolset?: Toolset;
  mcpServer?: string;
}

/** The family rule for a group of tools the window shows together. */
export function groupRuleFor(tool: CatalogTool): string | null {
  if (tool.mcpServer) return `mcp__${tool.mcpServer}__*`;
  if (tool.toolset && tool.toolset !== 'mcp') return `toolset:${tool.toolset}`;
  return null;
}

const without = (list: string[], drop: Iterable<string>): string[] => {
  const d = new Set(drop);
  return list.filter((x) => !d.has(x));
};

function visibleTool(kind: AgentKind, own: ToolGating, t: CatalogTool): boolean {
  return isToolAllowed(t.name, t.toolset, effectiveToolGating(kind, own));
}

/** One tool to the wanted state, changing as little as possible. */
function setTool(kind: AgentKind, own: ToolGating, t: CatalogTool, want: boolean): ToolGating {
  let g = { deny: [...own.deny], allow: [...own.allow] };
  if (visibleTool(kind, g, t) === want) return g;
  if (want) {
    g.deny = without(g.deny, [t.name]);
    if (!visibleTool(kind, g, t)) g.allow = [...g.allow, t.name];
  } else {
    g.allow = without(g.allow, [t.name]);
    if (visibleTool(kind, g, t)) g.deny = [...g.deny, t.name];
  }
  return g;
}

export interface ToolToggle {
  kind: AgentKind;
  own: ToolGating;
  /** The tools to switch. */
  tools: CatalogTool[];
  visible: boolean;
  /** True when the click was on a family's eye (the tools are that whole family). */
  group?: boolean;
}

/** The old "only these" form, rewritten as "everything off (`*`), these
 *  on" — the same tools, but an edit can no longer empty the list and so
 *  turn every tool on. */
export function explicitTools(kind: AgentKind, own: ToolGating): ToolGating {
  if (kind === 'builder' || !isLegacyAllowList(own) || own.deny.includes('*')) return { deny: [...own.deny], allow: [...own.allow] };
  return { deny: [...own.deny, '*'], allow: [...own.allow] };
}

export function toggleTools(input: ToolToggle): ToolGating {
  const op = { ...input, own: explicitTools(input.kind, input.own) };
  const rule = op.group && op.kind !== 'builder' && op.tools.length > 0 ? groupRuleFor(op.tools[0]!) : null;
  // A family rule only when every tool clicked belongs to that one family.
  const sameFamily = rule !== null && op.tools.every((t) => groupRuleFor(t) === rule);
  if (rule && sameFamily) {
    const names = op.tools.map((t) => t.name);
    let g: ToolGating = { deny: without(op.own.deny, [...names, rule]), allow: without(op.own.allow, names) };
    if (!op.visible) {
      g.deny = [...g.deny, rule];
      return g;
    }
    // Back on: anything still hidden (a wider rule, written by hand) gets
    // its own exception, so the click does what it shows.
    for (const t of op.tools) if (!visibleTool(op.kind, g, t)) g = setTool(op.kind, g, t, true);
    return g;
  }
  let g: ToolGating = { deny: [...op.own.deny], allow: [...op.own.allow] };
  for (const t of op.tools) g = setTool(op.kind, g, t, op.visible);
  return g;
}

// ─── skills ─────────────────────────────────────────────────────────

function skillGatingFor(kind: AgentKind, own: SkillGating): SkillGating {
  return kind === 'builder' ? { ...own, defaultDeny: true } : own;
}

function setSkill(kind: AgentKind, own: SkillGating, name: string, want: boolean): SkillGating {
  let g: SkillGating = { deny: [...own.deny], allow: [...own.allow] };
  const vis = () => isSkillAllowed(name, skillGatingFor(kind, g));
  if (vis() === want) return g;
  if (want) {
    g.deny = without(g.deny, [name]);
    if (!vis()) g.allow = [...g.allow, name];
  } else {
    g.allow = without(g.allow, [name]);
    if (vis()) g.deny = [...g.deny, name];
  }
  return g;
}

export interface SkillToggle {
  kind: AgentKind;
  own: SkillGating;
  /** Every skill the agent could have (the eye covers all of them). */
  all: string[];
  names: string[];
  visible: boolean;
  /** The click was on the "all skills" eye. */
  group?: boolean;
}

/** Same for skills: a chat agent's "only these" list becomes `*` off,
 *  these on. */
export function explicitSkills(kind: AgentKind, own: SkillGating): SkillGating {
  if (kind === 'builder' || own.allow.length === 0 || own.deny.includes(ALL_SKILLS)) return { deny: [...own.deny], allow: [...own.allow] };
  return { deny: [...own.deny, ALL_SKILLS], allow: [...own.allow] };
}

export function toggleSkills(input: SkillToggle): SkillGating {
  const op = { ...input, own: explicitSkills(input.kind, input.own) };
  if (op.group && op.kind !== 'builder') {
    if (!op.visible) return { deny: [ALL_SKILLS], allow: [] };
    // All on: no rule, no single denies, no old "only these" list.
    return { deny: without(op.own.deny, [ALL_SKILLS, ...op.all]), allow: [] };
  }
  let g: SkillGating = { deny: [...op.own.deny], allow: [...op.own.allow] };
  for (const n of op.names) g = setSkill(op.kind, g, n, op.visible);
  return g;
}
