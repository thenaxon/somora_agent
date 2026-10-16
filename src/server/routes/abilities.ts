// Moved unchanged from src/server/index.ts, which calls registerAbilitiesRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { getMemoryManager } from '../../memory/registry.ts';
import { loadPersona } from '../../persona/loader.ts';
import { writeAgentSkillGating } from '../../persona/skill-gating-store.ts';
import { writeAgentToolGating } from '../../persona/tool-gating-store.ts';
import { isSkillAllowed } from '../../skills/gating.ts';
import { loadAvailableSkills } from '../../skills/load.ts';
import { toggleSkills, toggleTools } from '../../tools/gating-edit.ts';
import { type AgentKind, BUILDER_TOOL_ALLOW, followsDreams, gatingToStore, isBuilderOnly, isImpliedRule, isToolAllowed } from '../../tools/gating.ts';
import type { ToolContext } from '../../tools/types.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import type { Context } from 'hono';

export interface AbilitiesRoutesDeps {
  tools: typeof Server.tools;
}

export function registerAbilitiesRoutes(app: Hono, routeDeps: AbilitiesRoutesDeps): void {
  const { tools } = routeDeps;
  // --- Per-agent tool visibility (web UI Agents×Tools matrix — design
  // §4.6). GET reads registry + persona gating; PUT splices the tools:
  // block into agent.yaml server-side (thin-client rule: the UI never
  // touches files itself).

  /** Context and tool list the Abilities routes share — the GET and the
   *  click route must see exactly the same tools. */
  async function abilitiesToolCatalog(agent: string) {
    const ctx: ToolContext = {
      agent,
      getMemoryManager: () =>
        getMemoryManager(agent, {
          config: config.memory,
          obsidian: config.obsidian,
          wiki: config.wiki,
        }),
      config,
    };
    return tools.listConfigured(ctx);
  }

  /** Rules in agent.yaml the window did not write: a pattern other than a
   *  whole family (`toolset:<tag>`) or a whole server (`mcp__<server>__*`)
   *  or everything (`*`). Shown as a note; the window stays editable. */
  function handWrittenToolRules(raw: { deny: string[]; allow: string[] } | null, kind: AgentKind): string[] {
    if (!raw) return [];
    const own = (p: string) => isImpliedRule(kind, p) || p === '*' || p.startsWith('toolset:') || /^mcp__[^_*]+(?:_[^_*]+)*__\*$/.test(p);
    return [...raw.deny, ...raw.allow].filter((p) => p.includes('*') && !own(p));
  }

  app.get('/agents/:agent/tools', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    // What the turn runs with (kind defaults merged in for a builder) —
    // this decides `visible`. The pattern check below looks at the block
    // as WRITTEN in agent.yaml: a builder's kind allow-list is not
    // hand-written policy and must not lock the matrix.
    const gating = persona.toolGating ?? null;
    const raw = persona.toolGatingRaw ?? null;
    // Toggling in the matrix only manipulates exact-name denies. Pattern
    // rules (globs, toolset:, allow-lists) are hand-written policy — the
    // UI shows them read-only instead of guessing how to edit them.
    // The window is always editable now; hand-written patterns it did not
    // write are reported so it can show them as a note.
    const handWritten = handWrittenToolRules(raw, persona.kind);
    const hasPatternRules = false;
    // Only tools this agent could actually use are listed. A tool whose
    // config doesn't exist has nothing to configure, and offering a
    // switch that changes nothing is worse than offering none: flipping
    // it looks like it did something.
    //
    // `listConfigured`, not `listAvailable` — this screen is a persistent
    // setting, and the loop-holder narrowing that listAvailable applies
    // is a state of this minute. Tools must not vanish from the settings
    // because the agent is mid-wiki-loop.
    const configured = await abilitiesToolCatalog(agent);
    return c.json({
      agent,
      kind: persona.kind,
      dreams: persona.dreams,
      handWrittenRules: handWritten,
      // The kind's own list — the web shows a builder these as its set and
      // everything else under "more".
      kindDefaults: persona.kind === 'builder' ? [...BUILDER_TOOL_ALLOW] : null,
      // The block as WRITTEN in agent.yaml, which is what a client edits and
      // PUTs back. The effective gating (kind defaults merged in: a chat
      // agent's implied `toolset:builder` deny, a builder's kind allow-list)
      // only decides `visible` below. Returning it here made every save in
      // the Abilities window write those defaults into agent.yaml again.
      gating: raw,
      hasPatternRules,
      tools: configured.map((t) => ({
        name: t.name,
        toolset: t.toolset,
        ...(t.origin ? { mcpServer: t.origin.mcpServer } : {}),
        description: t.description.slice(0, 140),
        visible: isToolAllowed(t.name, t.toolset, gating ?? undefined),
        availableNow: true,
        // Follows the agent's dreams switch, not a click here.
        ...(followsDreams(t.toolset) ? { lockedBy: 'dreams' as const } : {}),
      })),
    });
  });

  app.put('/agents/:agent/tools', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as {
      deny?: string[];
      allow?: string[];
    } | null;
    if (!body || !Array.isArray(body.deny) || !Array.isArray(body.allow)) {
      return c.json({ error: 'body must be { deny: string[], allow: string[] }' }, 400);
    }
    try {
      await writeAgentToolGating(agent, gatingToStore(persona.kind, { deny: body.deny, allow: body.allow }));
      logger.info({
        msg: 'agents.tool_gating_updated',
        agent,
        deny: body.deny.length,
        allow: body.allow.length,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /** Clicks on one agent run one after another: each reads agent.yaml,
   *  works out the new rules and writes — two at once would lose one. */
  const abilityLocks = new Map<string, Promise<unknown>>();
  function withAbilityLock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const run = (abilityLocks.get(agent) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    abilityLocks.set(agent, tail);
    void tail.then(() => { if (abilityLocks.get(agent) === tail) abilityLocks.delete(agent); });
    return run;
  }

  // One click in the Abilities window (docs/api.md). The server works out
  // the rules (src/tools/gating-edit.ts) so every client edits the same way
  // and the file stays something the window can edit again.
  app.post('/agents/:agent/tools/toggle', async (c) => {
    const agent = c.req.param('agent');
    const body = (await c.req.json().catch(() => null)) as { names?: unknown; visible?: unknown; group?: unknown } | null;
    return withAbilityLock(agent, () => toggleToolsRoute(c, agent, body));
  });
  async function toggleToolsRoute(c: Context, agent: string, body: { names?: unknown; visible?: unknown; group?: unknown } | null) {
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    if (!body || !Array.isArray(body.names) || body.names.length === 0 || !body.names.every((n) => typeof n === 'string') || typeof body.visible !== 'boolean') {
      return c.json({ error: 'body must be { names: string[], visible: boolean, group?: boolean }' }, 400);
    }
    const catalog = await abilitiesToolCatalog(agent);
    const byName = new Map(catalog.map((t) => [t.name, t]));
    const unknown = (body.names as string[]).filter((n) => !byName.has(n));
    if (unknown.length > 0) return c.json({ error: `unknown tool(s): ${unknown.join(', ')}` }, 400);
    const locked = (body.names as string[]).filter((n) => followsDreams(byName.get(n)!.toolset));
    if (locked.length > 0) {
      return c.json({ error: `${locked.join(', ')} follow${locked.length === 1 ? 's' : ''} the agent's dreams switch — turn dreaming on or off in the Agent window`, lockedBy: 'dreams' }, 409);
    }
    const builderOnly = persona.kind === 'builder' ? [] : (body.names as string[]).filter((n) => isBuilderOnly(n, byName.get(n)!.toolset));
    if (builderOnly.length > 0) return c.json({ error: `builder-only tool(s), never offered to a chat agent: ${builderOnly.join(', ')}` }, 400);
    const picked = (body.names as string[]).map((n) => {
      const t = byName.get(n)!;
      return { name: t.name, toolset: t.toolset, ...(t.origin ? { mcpServer: t.origin.mcpServer } : {}) };
    });
    const own = persona.toolGatingRaw ?? { deny: [], allow: [] };
    const next = gatingToStore(persona.kind, toggleTools({ kind: persona.kind, own, tools: picked, visible: body.visible, group: body.group === true }));
    try {
      await writeAgentToolGating(agent, next);
      logger.info({ msg: 'agents.tool_toggled', agent, names: picked.length, visible: body.visible, group: body.group === true, deny: next.deny.length, allow: next.allow.length });
      return c.json({ ok: true, gating: next });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  app.post('/agents/:agent/skills/toggle', async (c) => {
    const agent = c.req.param('agent');
    const body = (await c.req.json().catch(() => null)) as { names?: unknown; visible?: unknown; group?: unknown } | null;
    return withAbilityLock(agent, () => toggleSkillsRoute(c, agent, body));
  });
  async function toggleSkillsRoute(c: Context, agent: string, body: { names?: unknown; visible?: unknown; group?: unknown } | null) {
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    if (!body || !Array.isArray(body.names) || body.names.length === 0 || !body.names.every((n) => typeof n === 'string') || typeof body.visible !== 'boolean') {
      return c.json({ error: 'body must be { names: string[], visible: boolean, group?: boolean }' }, 400);
    }
    const all = (await loadAvailableSkills(config)).map((s) => s.name);
    const unknown = (body.names as string[]).filter((n) => !all.includes(n));
    if (unknown.length > 0) return c.json({ error: `unknown skill(s): ${unknown.join(', ')}` }, 400);
    const g = persona.skillGating;
    const own = { deny: [...(g?.deny ?? [])], allow: [...(g?.allow ?? [])] };
    const next = toggleSkills({ kind: persona.kind, own, all, names: body.names as string[], visible: body.visible, group: body.group === true });
    try {
      await writeAgentSkillGating(agent, next);
      logger.info({ msg: 'agents.skill_toggled', agent, names: (body.names as string[]).length, visible: body.visible, group: body.group === true, deny: next.deny.length, allow: next.allow.length });
      return c.json({ ok: true, gating: next });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  // Per-agent skill visibility — the Abilities matrix's second half.
  // Same contract as /agents/:agent/tools: GET lists every skill on this
  // instance with the agent's `visible` flag, PUT writes exact-name
  // deny/allow into agent.yaml `skills:`. A legacy allow-list
  // (`skills: [a, b]`) shows up as `allow` and flips the matrix
  // read-only, like hand-written tool patterns do — the operator wrote
  // a policy, the UI doesn't second-guess it. Takes effect on the next
  // turn (the registry is rebuilt per turn), no restart.
  app.get('/agents/:agent/skills', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const gating = persona.skillGating ?? null;
    // A builder's allow-list is the matrix itself (default none, each
    // switch adds a name), so it never locks the window.
    // Always editable; the click route rewrites an old "only these" list
    // into `*` plus exceptions the first time it changes something.
    const hasPatternRules = false;
    const skills = await loadAvailableSkills(config);
    return c.json({
      agent,
      kind: persona.kind,
      gating,
      hasPatternRules,
      skills: skills
        .map((s) => ({
          name: s.name,
          description: s.description.slice(0, 140),
          available: s.available,
          ...(s.unavailableReason ? { unavailableReason: s.unavailableReason } : {}),
          visible: isSkillAllowed(s.name, gating ?? undefined),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  app.put('/agents/:agent/skills', async (c) => {
    const agent = c.req.param('agent');
    if (!(await loadPersona(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as {
      deny?: string[];
      allow?: string[];
    } | null;
    if (!body || !Array.isArray(body.deny) || !Array.isArray(body.allow)) {
      return c.json({ error: 'body must be { deny: string[], allow: string[] }' }, 400);
    }
    try {
      await writeAgentSkillGating(agent, { deny: body.deny, allow: body.allow });
      logger.info({
        msg: 'agents.skill_gating_updated',
        agent,
        deny: body.deny.length,
        allow: body.allow.length,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
}
