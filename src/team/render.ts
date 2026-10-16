// Renders the per-agent `# Your team` block. Pure and deterministic:
// same team + same agent → byte-identical output, so the system prompt
// stays prefix-cache-stable until team.yaml actually changes.
//
// Lives in the SYSTEM PROMPT on purpose, never in a tool description:
// Claude Code measured that a mutable agent list inside the tool schema
// busts the whole tool cache (≈10 % of cache-creation tokens).

import type { ResolvedTeam, ResolvedTeamAgent } from './types.ts';

/** Soft cap for `somora team check` / GET /team/check — every agent
 *  carries its block in every turn. */
export const TEAM_BLOCK_SOFT_MAX_CHARS = 3000;

function joinPhrases(list: string[]): string {
  return list.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('; ');
}

function chartLines(team: ResolvedTeam, self: string): string[] {
  const p = team.principal;
  const head =
    `${p.name} — ${p.title ?? 'Principal'} (human)` + (p.about ? `: ${p.about.replace(/\s+/g, ' ').trim()}` : '');
  const lines: string[] = [head];
  const walk = (parent: string, prefix: string): void => {
    const kids = team.order.filter((n) => team.agents[n]!.reportsTo === parent);
    kids.forEach((name, i) => {
      const last = i === kids.length - 1;
      const a = team.agents[name]!;
      lines.push(
        `${prefix}${last ? '└── ' : '├── '}${name} — ${a.title}` +
          (a.external ? ` (external · ${a.external.label})` : '') +
          (a.active ? '' : ' (currently inactive)') +
          (name === self ? '  ← you' : ''),
      );
      walk(name, `${prefix}${last ? '    ' : '│   '}`);
    });
  };
  walk('principal', '');
  return lines;
}

/** What every colleague is told about a builder (docs/builder.md). */
export const BUILDER_HANDOVER_HINT =
  'Builder — hand over a COMPLETE order in one message (builder_dispatch: repository or project with its folder, ' +
  'what to build, what done means, where the report goes) and wait for the report; no interim check-ins, no ' +
  'corrections into running work — a correction is a new message into its session.';

/** What every colleague is told, once, about the external agents that
 *  take work (docs/a2a.md). One shared line, not one per agent: every
 *  agent carries this block in every turn. */
export function externalAgentsNote(names: string[]): string {
  return (
    `External agents (${names.join(', ')}) work in other systems, with their own memory and tools and no access to ours: ` +
    'hand them a self-contained task with agent_ask or spawn_subagent (sent over A2A) and all the context it needs; ' +
    'text only, slower than a colleague here, and a stop may not reach them.'
  );
}

/** …and about those that take no work: the principal chats with them. */
export function externalChatOnlyNote(names: string[]): string {
  return `Chat only, do not involve: ${names.join(', ')} (external agents the principal talks to directly; they take no work from agents).`;
}

/** An external agent agents cannot hand work to. */
function chatOnly(a: { external?: { a2a: boolean } | undefined }): boolean {
  return a.external !== undefined && !a.external.a2a;
}

function involveLine(a: ResolvedTeamAgent): string | null {
  const parts: string[] = [];
  if (a.kind === 'builder') parts.push(BUILDER_HANDOVER_HINT);
  if (a.involveFor.length > 0) parts.push(joinPhrases(a.involveFor) + '.');
  if (a.notFor.length > 0) parts.push(`Not for: ${joinPhrases(a.notFor)}.`);
  if (a.notes) parts.push(a.notes.replace(/\s+/g, ' ').trim());
  if (parts.length === 0) return null;
  const name = a.external ? `${a.name} (${a.title}; external · ${a.external.label})` : `${a.name} (${a.title})`;
  return `- ${name}: ${parts.join(' ')}`;
}

/**
 * The short form a builder gets: who to consult, one line each, and the
 * team rules. No org chart, no superior prose — a builder takes orders
 * from whoever handed it the task and consults colleagues for their
 * specialty (see src/server/builder-prompt.ts).
 */
export function renderTeamBlockCompact(team: ResolvedTeam, self: string): string | null {
  const colleagues = team.order.filter((n) => n !== self && team.agents[n]!.active && !chatOnly(team.agents[n]!));
  if (colleagues.length === 0 && team.rules.length === 0) return null;
  const out: string[] = ['# Your team', '', `Principal (human): ${team.principal.name}${team.principal.title ? `, ${team.principal.title}` : ''}.`];
  if (colleagues.length > 0) {
    out.push(
      'Colleagues you can consult with agent_ask — a question in their specialty, not a hand-off; the agent or person who gave you the task is your client:',
    );
    out.push(
      colleagues
        .map((n) => {
          const a = team.agents[n]!;
          return a.external ? `${n} (${a.title}; external · ${a.external.label}, over A2A — self-contained tasks, full context)` : `${n} (${a.title})`;
        })
        .join(', ') + '.',
    );
  }
  if (team.rules.length > 0) {
    out.push('', 'Rules:');
    for (const r of team.rules) out.push(`- ${r}`);
  }
  return out.join('\n').trimEnd();
}

/**
 * The block for `self`. Returns null only when the team is empty. An
 * agent that exists but is not in the file still gets the full
 * picture, plus a line saying it is not placed yet.
 */
export function renderTeamBlock(team: ResolvedTeam, self: string): string | null {
  if (team.order.length === 0 && team.unlisted.length === 0) return null;
  const me = team.agents[self];
  const principal = team.principal.name;
  const out: string[] = ['# Your team', '', 'Org chart (you are marked with ←):', ...chartLines(team, self)];

  if (team.unlisted.length > 0) {
    const list = team.unlisted.map((u) => (u.name === self ? `${u.name} (${u.title}) ← you` : `${u.name} (${u.title})`));
    out.push(`Not in the org chart yet: ${list.join(', ')}.`);
    for (const u of team.unlisted) {
      if (u.name === self) continue;
      if (u.kind === 'builder') out.push(`- ${u.name}: ${BUILDER_HANDOVER_HINT}`);
    }
  }
  out.push('');

  if (me) {
    if (me.reportsTo === 'principal') {
      out.push(`Your superior: ${principal}, the principal — you report to them directly; their word is final.`);
    } else {
      out.push(
        `Your superior: ${me.reportsTo} — escalate there first; ${me.reportsTo}'s briefings are authoritative ` +
          `inside your lane. The principal (${principal}) has the final say over everyone.`,
      );
    }
    if (!me.active) {
      out.push(
        'You are currently marked inactive in the team — colleagues were told not to involve you. ' +
          'You were addressed anyway, so work normally, but do not pull colleagues in unless asked.',
      );
    }
    const tag = (n: string): string => (team.agents[n]!.active ? n : `${n} (inactive)`);
    const peers = team.order.filter((n) => n !== self && team.agents[n]!.reportsTo === me.reportsTo);
    out.push(`Your peers (same superior): ${peers.length > 0 ? peers.map(tag).join(', ') : 'none'}.`);
    out.push(`Your reports: ${me.children.length > 0 ? me.children.map(tag).join(', ') : 'none'}.`);
  } else {
    out.push(
      `You are not placed in the org chart yet — the operator maintains it in team.yaml. ` +
        `Until then treat ${principal}, the principal, as your superior.`,
    );
  }
  out.push('');

  const colleagues = team.order.filter((n) => n !== self && team.agents[n]!.active && !chatOnly(team.agents[n]!));
  const inactive = team.order.filter((n) => n !== self && !team.agents[n]!.active);
  const chatOnlyAgents = team.order.filter((n) => n !== self && team.agents[n]!.active && chatOnly(team.agents[n]!));
  if (colleagues.length > 0) {
    out.push('Who to involve — via agent_ask; their reply comes back to your session:');
    const plain: string[] = [];
    for (const n of colleagues) {
      const a = team.agents[n]!;
      const line = involveLine(a);
      if (line) out.push(line);
      else plain.push(a.external ? `${n} (${a.title}; external · ${a.external.label})` : `${n} (${a.title})`);
    }
    if (plain.length > 0) out.push(`- ${plain.join(', ')}.`);
  }
  // External agents, placed or not: one shared note each way.
  const unplaced = team.unlisted.filter((u) => u.name !== self && u.external);
  const workers = [...colleagues.filter((n) => team.agents[n]!.external), ...unplaced.filter((u) => u.external!.a2a).map((u) => u.name)];
  const chatters = [...chatOnlyAgents, ...unplaced.filter((u) => !u.external!.a2a).map((u) => u.name)];
  if (workers.length > 0) out.push(externalAgentsNote(workers));
  if (inactive.length > 0) {
    out.push(`Currently inactive — do not involve: ${inactive.join(', ')}. Go one level up instead.`);
  }
  if (chatters.length > 0) out.push(externalChatOnlyNote(chatters));
  if (colleagues.length > 0 || inactive.length > 0 || chatters.length > 0 || workers.length > 0) out.push('');

  if (team.rules.length > 0) {
    out.push('Rules:');
    for (const r of team.rules) out.push(`- ${r}`);
  }
  return out.join('\n').trimEnd();
}
