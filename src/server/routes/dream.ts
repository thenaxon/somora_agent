// Moved unchanged from src/server/index.ts, which calls registerDreamRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`; deepWorker, lucidWorker, remWorker are read from it
// per request (index.ts sets them up later or changes them).

import { syncRemRegistration } from '../../dream/dreams.ts';
import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { getLoopState } from '../../dream/loop-state.ts';
import { pendingLucidSummary } from '../../dream/lucid-storage.ts';
import { listDreams } from '../../dream/storage.ts';
import { listAgents, loadPersona } from '../../persona/loader.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';

export interface DreamRoutesDeps {
  readonly deepWorker: typeof Server.deepWorker;
  readonly lucidWorker: typeof Server.lucidWorker;
  readonly remWorker: typeof Server.remWorker;
}

export function registerDreamRoutes(app: Hono, routeDeps: DreamRoutesDeps): void {
  // Wiki-Promotion manueller Trigger. Same handler the dream_run tool
  // calls in-process; exposed over HTTP so the MCP child (claude-cli /
  // codex-cli) can fall back to it when its own ToolRegistry lacks the
  // injected deepWorker. See `private/wiki-design.md`.
  //
  // Body: `{wait?: boolean}` — wait=false (default) returns immediately
  // Read-only snapshot of the active dream_review loop, if any. TUI
  // polls this for the status-line indicator. Returns 200 with body
  // `{active: false}` when no loop is held; `{active: true, agent,
  // dreamId, startedAt}` otherwise.
  app.get('/dream/loop-state', (c) => {
    const state = getLoopState();
    if (!state) return c.json({ active: false });
    return c.json({
      active: true,
      agent: state.agent,
      dreamId: state.dreamId,
      startedAt: state.startedAt,
      lastActivityAt: state.lastActivityAt,
    });
  });

  // Snapshot of all three dream phases. AgentDock polls this every 30s for
  // per-agent REM activity + pending-review counts, plus the server-global
  // DEEP/LUCID running state. REM is filesystem-driven (running/completed
  // dream files under .dreams/); DEEP/LUCID expose isRunning() on their
  // worker. LUCID also surfaces the active loopHolder when present.
  app.get('/dream-states', async (c) => {
    const agents = await listAgents();
    const rem: Record<string, { active: boolean; pendingCount: number }> = {};
    await Promise.all(
      agents.map(async (a) => {
        try {
          const dreams = await listDreams(a.name);
          const active = dreams.some((d) => d.meta.status === 'running');
          const pendingCount = dreams.filter((d) => d.meta.status === 'completed').length;
          rem[a.name] = { active, pendingCount };
        } catch {
          rem[a.name] = { active: false, pendingCount: 0 };
        }
      }),
    );
    const lucidLoop = getLoopState();
    // Lucid review-backlog (additive fields, 2026-07-29 feedback): the
    // only approval-gated phase besides REM was invisible in every
    // client — a completed run with pending findings produced no UI
    // trace at all. Unlike REM this is server-global, not per-agent.
    let lucidPending = { pendingRuns: 0, pendingFindings: 0 } as Awaited<
      ReturnType<typeof pendingLucidSummary>
    >;
    try {
      lucidPending = await pendingLucidSummary();
    } catch {
      // dir unreadable → keep zeros; don't fail the whole snapshot
    }
    return c.json({
      rem,
      deep: { active: routeDeps.deepWorker.isRunning() },
      lucid: {
        active: routeDeps.lucidWorker.isRunning(),
        ...(lucidLoop ? { loopHolder: lucidLoop.agent } : {}),
        pendingRuns: lucidPending.pendingRuns,
        pendingFindings: lucidPending.pendingFindings,
        ...(lucidPending.oldestPendingAt !== undefined
          ? { oldestPendingAt: lucidPending.oldestPendingAt }
          : {}),
      },
    });
  });

  // after firing the worker; wait=true awaits the run and returns
  // outcome counts.
  // Catch up one agent's unread conversations now — after a worker
  // outage the idle timer alone took days (one session per 30 silent
  // minutes, reset by every chat message). Same cycle as the timer path.
  app.post('/agents/:agent/dream/run-rem', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    // The switch decides, and the worker is brought in line with it here
    // too, so a file edited by hand needs no restart.
    const settings = syncRemRegistration(routeDeps.remWorker, agent, persona, config);
    if (!settings.ok) {
      return c.json(
        settings.reason === 'does-not-dream'
          ? { error: `agent '${agent}' does not dream (dreams: false in its agent.yaml) — turn it on in the Agent window`, reason: 'does-not-dream' }
          : { error: `no REM model for '${agent}' — set rem.model in config.yaml or in its agent.yaml`, reason: 'no-model' },
        409,
      );
    }
    const outcome = await routeDeps.remWorker.runNow(agent);
    logger.info({ msg: 'dream.rem.run_now', agent, outcome });
    if (outcome === 'not_registered') return c.json({ error: `REM worker has no entry for '${agent}'` }, 409);
    const message =
      outcome === 'started'
        ? 'REM started in the background; it works through the unread sessions one after another. Findings appear in dream_list.'
        : outcome === 'busy'
          ? 'REM is already running for this agent.'
          : 'Nothing to catch up — every session is read through.';
    return c.json({ agent, outcome, started: outcome === 'started', message });
  });

  app.post('/dream/run-deep', async (c) => {
    if (!config.wiki.enabled) {
      return c.json({ error: 'config.wiki.enabled is false — wiki layer not active' }, 400);
    }
    let wait = false;
    let force = false;
    try {
      const body = await c.req.json().catch(() => ({}));
      wait = Boolean((body as { wait?: unknown }).wait);
      force = Boolean((body as { force?: unknown }).force);
    } catch {
      /* empty body is fine */
    }
    if (!wait) {
      void routeDeps.deepWorker.runNow({ force }).catch(() => {
        /* errors logged in worker */
      });
      return c.json({
        started: true,
        wait: false,
        force,
        message:
          'Deep started in background. Tail ~/.somora/logs/ for dream.deep.done.',
      });
    }
    const result = await routeDeps.deepWorker.runNow({ force });
    const counts = result.outcomes.reduce(
      (acc, o) => {
        acc[o.kind] = (acc[o.kind] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    return c.json({
      wait: true,
      force,
      candidatesSeen: result.candidatesSeen,
      cachedSkips: result.cachedSkips,
      durationMs: result.durationMs,
      counts,
      outcomes: result.outcomes,
    });
  });

  // Lucid manueller Trigger. Mirrors /dream/run-deep
  // shape: body {wait?:bool}; default fire-and-forget.
  app.post('/dream/run-lucid', async (c) => {
    if (!config.wiki.enabled) {
      return c.json({ error: 'config.wiki.enabled is false — wiki layer not active' }, 400);
    }
    let wait = false;
    let force = false;
    try {
      const body = await c.req.json().catch(() => ({}));
      wait = Boolean((body as { wait?: unknown }).wait);
      force = Boolean((body as { force?: unknown }).force);
    } catch {
      /* empty body */
    }
    if (!wait) {
      void routeDeps.lucidWorker.runNow({ force }).catch(() => {
        /* errors logged */
      });
      return c.json({
        started: true,
        wait: false,
        message: 'Lucid started in background.',
      });
    }
    const result = await routeDeps.lucidWorker.runNow({ force });
    return c.json({
      wait: true,
      runId: result.runId,
      findingsCount: result.findingsCount,
      pagesScanned: result.pagesScanned,
      durationMs: result.durationMs,
      status: result.status,
    });
  });
}
