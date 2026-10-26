// Moved unchanged from src/server/index.ts, which calls registerAgentRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`; nextTurnPrompt are read from it
// per request (index.ts sets them up later or changes them).

import { renameAgent } from '../../persona/rename.ts';
import { writeAgentA2A } from '../../persona/a2a-store.ts';
import { AgentRenamingError } from '../../persona/rename-lock.ts';
import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { readPersonaFiles, writePersonaFile } from '../../persona/files.ts';
import { remSettingsFor } from '../../dream/dreams.ts';
import { externalAgentEntries } from './external.ts';
import { writeAgentDreams } from '../../persona/dreams-store.ts';
import { listAgents, loadPersona } from '../../persona/loader.ts';
import { resolveSessionId, sessionMetaStore } from '../../storage/sessions.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { planCatalog } from '../../engine/openai-tool-catalog.ts';
import { turnAlwaysVisible, turnCatalogSettings } from '../turn-tool-catalog.ts';

export interface AgentRoutesDeps {
  readonly nextTurnPrompt: typeof Server.nextTurnPrompt;
  readonly syncDreamers: typeof Server.syncDreamers;
  /** Agent rename: take a name out of the REM worker, reload config.yaml. */
  readonly remUnregister?: (agent: string) => void;
  readonly reloadConfig?: () => Promise<void>;
}

export function registerAgentRoutes(app: Hono, routeDeps: AgentRoutesDeps): void {
  // Verbose-mode helper: returns the persona's compiled system prompt.
  // Used by /verbose system in the TUI to surface what the model is
  // actually seeing as instructions. Static per agent (does not change
  // per turn — ephemeralContext is per-turn and rides on the memory SSE).
  app.get('/agents/:agent/system-prompt', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    return c.json({ agent, systemPrompt: persona.systemPrompt });
  });

  // somora's own agents, then the external ones (docs/external-agents.md).
  app.get('/agents', async (c) => c.json([...(await listAgents()), ...externalAgentEntries()]));

  /** The `dreams` switch as a client shows it: on/off, and what REM
   *  runs on (the agent's own model, the central one, or none). */
  function dreamsInfo(persona: Awaited<ReturnType<typeof loadPersona>>) {
    if (!persona) return null;
    const rem = remSettingsFor(persona, config);
    return {
      on: persona.dreams,
      remModel: rem.ok ? rem.rem.model : null,
      remModelFrom: rem.ok ? rem.modelFrom : null,
      ...(persona.dreams && !rem.ok ? { problem: 'no REM model: set rem.model in config.yaml or in the agent.yaml' } : {}),
    };
  }

  // The `dreams` switch (private/dream-switch/KONZEPT.md). Applies at
  // once: REM is (un)registered, Deep reads its participants live, the
  // tools follow from the agent's next turn.
  app.get('/agents/:agent/dreams', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    return c.json({ agent, ...dreamsInfo(persona)! });
  });
  app.put('/agents/:agent/dreams', async (c) => {
    const agent = c.req.param('agent');
    if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null;
    if (!body || typeof body.on !== 'boolean') return c.json({ error: 'body must be { on: boolean }' }, 400);
    try {
      await writeAgentDreams(agent, body.on);
    } catch (err) {
      if (err instanceof AgentRenamingError) return c.json({ error: err.message }, 409);
      return c.json({ error: `could not write agent.yaml: ${(err as Error).message}` }, 500);
    }
    await routeDeps.syncDreamers();
    const persona = await loadPersona(agent);
    logger.info({ msg: 'agent.dreams_switched', agent, on: body.on });
    return c.json({ ok: true, agent, ...dreamsInfo(persona)! });
  });

  /** The `a2a` switch as a client shows it (docs/a2a.md): on/off, who may
   *  reach the agent, its address, and what keeps it from working. */
  function a2aInfo(persona: Awaited<ReturnType<typeof loadPersona>>) {
    if (!persona) return null;
    const peers = Object.entries(config.a2a.peers)
      .filter(([, p]) => !p.agents || p.agents.includes(persona.name))
      .map(([name]) => name);
    const base = config.a2a.publicUrl?.replace(/\/+$/, '');
    return {
      on: persona.a2a,
      available: persona.kind !== 'builder',
      peers,
      ...(base ? { url: `${base}/a2a/agents/${encodeURIComponent(persona.name)}` } : {}),
      ...(persona.kind === 'builder'
        ? { problem: 'a builder is not reachable over A2A; other systems reach it with somora acp' }
        : persona.a2a && peers.length === 0
          ? { problem: 'no peer may reach this agent: add one under a2a.peers in config.yaml' }
          : {}),
    };
  }

  // The `a2a` switch: other agent systems may send this agent tasks.
  app.get('/agents/:agent/a2a', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    return c.json({ agent, ...a2aInfo(persona)! });
  });
  app.put('/agents/:agent/a2a', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null;
    if (!body || typeof body.on !== 'boolean') return c.json({ error: 'body must be { on: boolean }' }, 400);
    if (body.on && persona.kind === 'builder') return c.json({ error: 'a builder is not reachable over A2A; other systems reach it with somora acp' }, 409);
    try {
      await writeAgentA2A(agent, body.on);
    } catch (err) {
      if (err instanceof AgentRenamingError) return c.json({ error: err.message }, 409);
      return c.json({ error: `could not write agent.yaml: ${(err as Error).message}` }, 500);
    }
    logger.info({ msg: 'agent.a2a_switched', agent, on: body.on });
    return c.json({ ok: true, agent, ...a2aInfo(await loadPersona(agent))! });
  });

  // Rename an agent, somora's own or external (docs/agents.md#renaming-an-agent).
  // `dryRun` lists what would change. 409 while the agent is busy or the
  // name is taken, 404 for an unknown agent.
  app.post('/agents/:agent/rename', async (c) => {
    const agent = c.req.param('agent');
    const body = (await c.req.json().catch(() => null)) as { to?: unknown; dryRun?: unknown } | null;
    if (!body || typeof body.to !== 'string') return c.json({ error: 'body must be { to: string, dryRun?: boolean }' }, 400);
    const report = await renameAgent(agent, body.to.trim(), {
      config,
      syncDreamers: routeDeps.syncDreamers,
      ...(routeDeps.remUnregister ? { remUnregister: routeDeps.remUnregister } : {}),
      ...(routeDeps.reloadConfig ? { reloadConfig: routeDeps.reloadConfig } : {}),
    }, { dryRun: body.dryRun === true });
    if (!report.ok) {
      const status = /^no agent/.test(report.error ?? '') ? 404 : /busy|already exists|being renamed|YAML anchor/.test(report.error ?? '') ? 409 : /not a valid|the new name is the old/.test(report.error ?? '') ? 400 : 500;
      return c.json(report, status);
    }
    return c.json(report);
  });

  // ── Persona files + prompt preview (web Agent window) ───────────────
  // Read the three persona files (+ agent.yaml read-only) with hashes and
  // sizes against config.promptBudgets; write one under an optimistic
  // lock (baseHash) because the agents self-edit these files.
  app.get('/agents/:agent/persona', async (c) => {
    const agent = c.req.param('agent');
    if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const files = await readPersonaFiles(agent);
    const personaChars = files.filter((f) => !f.readOnly).reduce((n, f) => n + f.chars, 0);
    const persona = await loadPersona(agent);
    const kind = persona?.kind ?? 'chat';
    return c.json({
      agent,
      kind,
      dreams: dreamsInfo(persona),
      a2a: a2aInfo(persona),
      files,
      budgets: config.promptBudgets,
      totals: { personaChars },
    });
  });

  app.put('/agents/:agent/persona/:file', async (c) => {
    const agent = c.req.param('agent');
    const file = c.req.param('file');
    const body = (await c.req.json().catch(() => null)) as { content?: unknown; baseHash?: unknown } | null;
    if (!body || typeof body.content !== 'string' || typeof body.baseHash !== 'string') {
      return c.json({ error: 'body {content: string, baseHash: string} required' }, 400);
    }
    let r;
    try {
      r = await writePersonaFile(agent, file, body.content, body.baseHash);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (!r.ok) {
      return c.json(
        { error: r.error, ...(r.currentHash ? { currentHash: r.currentHash, currentContent: r.currentContent } : {}) },
        r.status,
      );
    }
    logger.info({ msg: 'persona.saved', agent, file, chars: body.content.length, backup: r.backup });
    return c.json({ ok: true, hash: r.hash, backup: r.backup, chars: body.content.length });
  });

  // The system prompt exactly as the next turn on `session` would send it,
  // split into its parts, plus the tool schemas the agent can see (they
  // travel on the API tool channel, not in this text — but they cost
  // context all the same). Read-only: the wiki snapshot is not persisted.
  app.get('/agents/:agent/prompt-preview', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const sessionRef = c.req.query('session') || 'main';
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const sessionMeta = await sessionMetaStore.get(agent, session);
    const { assembled, available, previewModel } = await routeDeps.nextTurnPrompt(agent, session, persona, sessionMeta);
    const schemaChars = (list: readonly { name: string; description: string; jsonSchema: unknown }[]) =>
      list.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.jsonSchema }).length, 0);
    const toolSchemaChars = schemaChars(available);
    // What the openai-compatible engine would actually send: in catalog
    // mode the always-visible tools plus tool_search/tool_call, and the
    // rest by name at the end of the system prompt.
    const plan =
      previewModel && previewModel.provider.engine === 'openai-compatible'
        ? planCatalog({
            offered: available,
            direct: turnAlwaysVisible({ config, agent, kind: persona.kind, offered: available.map((t) => t.name) })(previewModel),
            settings: turnCatalogSettings({ config, kind: persona.kind })(previewModel),
          })
        : null;
    return c.json({
      agent,
      session,
      text: assembled.text,
      chars: assembled.text.length,
      parts: assembled.parts.map((p) => ({ key: p.key, label: p.label, chars: p.text.length })),
      tools: {
        count: available.length,
        schemaChars: toolSchemaChars,
        names: available.map((t) => t.name),
        ...(previewModel?.provider.engine === 'openai-compatible'
          ? {
              catalog: plan
                ? {
                    mode: 'catalog',
                    direct: plan.direct.length,
                    deferred: plan.deferred.length,
                    sentSchemaChars: schemaChars(plan.direct) + JSON.stringify(plan.metaTools).length,
                    listingChars: plan.listing.length + 2,
                  }
                : { mode: 'all', direct: available.length, deferred: 0, sentSchemaChars: toolSchemaChars, listingChars: 0 },
            }
          : {}),
      },
      budgets: config.promptBudgets,
      notIncluded: [
        'tool schemas (sent on the API tool channel; counted above, engines load them direct or deferred)',
        'memory recall injected per turn',
        'the conversation history',
        "the engine's own built-in instructions (Claude Code, Codex)",
      ],
    });
  });
}
