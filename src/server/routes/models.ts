// Moved unchanged from src/server/index.ts, which calls registerModelRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { modelUnavailable, resetModelAvailability } from '../../engine/model-availability.ts';
import { getMemoryManager } from '../../memory/registry.ts';
import { loadPersona } from '../../persona/loader.ts';
import { isToolAllowed } from '../../tools/gating.ts';
import { config } from '../server-state.ts';

export interface ModelRoutesDeps {
  tools: typeof Server.tools;
}

export function registerModelRoutes(app: Hono, routeDeps: ModelRoutesDeps): void {
  const { tools } = routeDeps;
  app.get('/models', (c) => {
    const list: Array<{
      provider: string;
      id: string;
      alias: string | null;
      engine: string;
      contextWindow: number;
      capabilities: string[];
      ref: string;
      /** Set while the model is marked unreachable (model-availability.ts):
       *  since/until as epoch ms, the failure that caused the mark. */
      unavailable?: { since: number; until: number; reason: string };
    }> = [];
    for (const [providerName, provider] of Object.entries(config.providers)) {
      for (const model of provider.models) {
        const mark = modelUnavailable(`${providerName}/${model.id}`);
        list.push({
          provider: providerName,
          id: model.id,
          alias: model.alias ?? null,
          engine: provider.engine,
          contextWindow: model.contextWindow,
          capabilities: model.capabilities,
          ref: model.alias ?? `${providerName}/${model.id}`,
          ...(mark ? { unavailable: { since: mark.since, until: mark.until, reason: mark.reason } } : {}),
        });
      }
    }
    return c.json(list);
  });

  // Forget every "model unavailable" mark: the next cascade tries the
  // primaries again. What a config reload does as a side effect, on its own.
  app.post('/models/availability/reset', (c) => {
    const cleared = resetModelAvailability();
    return c.json({ ok: true, cleared, retryUnavailableMinutes: config.fallback.retryUnavailableMinutes });
  });

  // Tool catalog + invocation endpoints (DECISION #31). 127.0.0.1-only,
  // useful for poking tools without an LLM in the loop.
  //   GET  /tools                                    — list registered tools
  //   POST /agents/:agent/tools/:name                — invoke a tool
  app.get('/tools', (c) =>
    c.json({
      count: tools.list().length,
      tools: tools.list().map((t) => ({
        name: t.name,
        toolset: t.toolset,
        description: t.description,
        inputSchema: t.jsonSchema,
        maxResultSizeChars: t.maxResultSizeChars ?? null,
        hasAvailabilityCheck: Boolean(t.available),
      })),
    }),
  );

  app.post('/agents/:agent/tools/:name', async (c) => {
    const agent = c.req.param('agent');
    const name = c.req.param('name');
    const persona = await loadPersona(agent);
    if (!persona) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    // The agent's own tool locks hold here as in a chat turn: this route
    // ran any tool as any agent, so a lock set in Abilities could be
    // stepped around through it (feedback report 2026-09-16).
    const tool = tools.get(name);
    if (tool && !isToolAllowed(name, tool.toolset, persona.toolGating)) {
      return c.json(
        { ok: false, error: `tool '${name}' is turned off for agent '${agent}' (Abilities window, or tools: in its agent.yaml)` },
        403,
      );
    }
    const input = await c.req.json().catch(() => ({}));
    const result = await tools.invoke(name, input, {
      agent,
      getMemoryManager: () => getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian }),
      config,
    });
    if (!result.ok) {
      return c.json(result, 400);
    }
    return c.json(result);
  });
}
