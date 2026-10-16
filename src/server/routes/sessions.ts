// Moved unchanged from src/server/index.ts, which calls registerSessionRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import { agentKnown, getExternalAgent, isExternalAgent, listExternalAgents } from '../../external/registry.ts';
import { closeExternal } from '../../external/connection.ts';
import { remSettingsFor } from '../../dream/dreams.ts';
import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { SamplingSchema, type ThinkingLevel, describeModelRefs, resolveAnyRef } from '../../config/types.ts';
import { dreamArchivedAfterReset } from '../../dream/rem-reset-run.ts';
import { SAMPLING_KEYS, mergeSampling } from '../../engine/sampling.ts';
import { codexReasoningEffort, resolveOpenAiReasoning } from '../../engine/thinking-params.ts';
import { getMemoryManager } from '../../memory/registry.ts';
import { listAgents, loadPersona } from '../../persona/loader.ts';
import { SessionSlugTakenError, appendEvent, archiveSession, createSession, getHistory, listSessions, resetSession, resolveSessionId, sessionMetaStore, unarchiveSession } from '../../storage/sessions.ts';
import type { NormalizedEvent } from '../../types/events.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { compactSessionByHand, manualCompactionText } from '../session-compact.ts';
import { readSessionJsonlRaw, renderSessionMarkdown } from '../session-export.ts';
import { acquireSessionLock, getSessionLockStatus } from '../session-queue.ts';
import { serializeSessionEvent } from '../sse-serializer.ts';
import { VALID_THINKING_LEVELS, resolveThinking } from '../thinking-resolve.ts';

export interface SessionRoutesDeps {
  nextTurnPrompt: typeof Server.nextTurnPrompt;
  publish: typeof Server.publish;
  resolveEffectiveModel: typeof Server.resolveEffectiveModel;
  streamKey: typeof Server.streamKey;
  streams: typeof Server.streams;
}

export function registerSessionRoutes(app: Hono, routeDeps: SessionRoutesDeps): void {
  const { nextTurnPrompt, publish, resolveEffectiveModel, streamKey, streams } = routeDeps;
  app.get('/agents/:agent/sessions', async (c) => {
    const agent = c.req.param('agent');
    if (!(await agentKnown(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const includeArchived = c.req.query('include_archived') === 'true';
    return c.json(await listSessions(agent, { includeArchived }));
  });

  // Cross-agent flat list. Powers the web "Sessions" tool. Each row carries
  // the agent color/icon (so the UI can render the agent column without a
  // second roundtrip), the live-subscriber count (so a green-dot marker
  // reflects "someone is chatting this right now"), and the resolved
  // dream-status. Heavy fields (messageCount, byteSize, lastEventTs) are
  // served from the per-meta cache when its jsonlMtime still matches.
  app.get('/sessions', async (c) => {
    const includeArchived = c.req.query('include_archived') === 'true';
    // External agents' conversations are somora sessions too.
    const agents: Array<{ name: string; color?: string | undefined; icon?: string | undefined; external?: string }> = [
      ...(await listAgents()),
      ...listExternalAgents().map((e) => ({ name: e.name, color: undefined, icon: e.agent.icon, external: e.system })),
    ];
    const rows: Array<Record<string, unknown>> = [];
    let liveByKey: Map<string, number> | null = null;
    for (const agentInfo of agents) {
      const sessions = await listSessions(agentInfo.name, { includeArchived });
      for (const s of sessions) {
        if (!liveByKey) {
          // Built lazily once we know we have at least one session, so the
          // empty-agents case stays cheap.
          liveByKey = new Map<string, number>();
          for (const [key, subs] of streams) {
            liveByKey.set(key, subs.size);
          }
        }
        // Must match streamKey()'s `::` separator — a single `:` here
        // meant the lookup never hit and liveSubscribers was always 0
        // (Juni-Audit 2026-06).
        const liveKey = streamKey(agentInfo.name, s.id);
        const liveSubscribers = liveByKey.get(liveKey) ?? 0;
        const dreamStatus: 'dreamed' | 'partial' | 'never' = s.dreamCoverageTs === null
          ? 'never'
          : s.dreamLagEvents === 0
            ? 'dreamed'
            : 'partial';
        rows.push({
          agent: agentInfo.name,
          agentColor: agentInfo.color,
          agentIcon: agentInfo.icon,
          ...(agentInfo.external ? { external: { system: agentInfo.external } } : {}),
          sessionId: s.id,
          slug: s.slug,
          isMain: s.isMain,
          isArchived: s.isArchived,
          createdAt: s.createdAt,
          lastActivity: s.lastActivity,
          messageCount: s.messageCount,
          byteSize: s.byteSize,
          ...(s.engine !== undefined ? { engine: s.engine } : {}),
          liveSubscribers,
          dream: {
            status: dreamStatus,
            coverageTs: s.dreamCoverageTs,
            lagEvents: s.dreamLagEvents,
          },
          ...(s.archivedAt !== undefined ? { archivedAt: s.archivedAt } : {}),
          ...(s.archiveReason !== undefined ? { archiveReason: s.archiveReason } : {}),
          ...(s.projectSlug !== undefined ? { projectSlug: s.projectSlug } : {}),
          unreadAt: s.unreadAt ?? null,
          seenAt: s.seenAt ?? null,
          // Is a turn running there right now, and how many wait behind
          // it — the question a person asks about a session they cannot
          // see ("is anything still running at <agent>?"). Lives only in
          // this process, so the session_list tool reads it from here.
          ...(() => {
            const lock = getSessionLockStatus(agentInfo.name, s.id);
            return { busy: lock.busy, queueLength: lock.queueLength, activeSince: lock.activeSince };
          })(),
        });
      }
    }
    return c.json({ sessions: rows });
  });

  app.post('/agents/:agent/sessions/:session/archive', async (c) => {
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    try {
      await archiveSession(agent, session, body.reason);
      closeExternal(agent, session);
      logger.info({ msg: 'session.archive', agent, session, reason: body.reason });
      return c.json({ archived: true, agent, session });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Session export. `?format=json` returns the raw JSONL byte-identical
  // from disk (canonical source, ideal for backups and cross-host
  // transfer). `?format=markdown` renders a human-readable transcript
  // with user/assistant turns, code-fenced tool calls, and engine_meta
  // items rendered as task lists. Default is markdown.
  // Content-Disposition prompts a download in the browser so the web
  // SessionsWindow can offer one-click "Download JSON / Markdown" links.
  app.get('/agents/:agent/sessions/:session/export', async (c) => {
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const format = (c.req.query('format') ?? 'markdown').toLowerCase();
    if (format !== 'json' && format !== 'markdown') {
      return c.json(
        { error: `unknown format '${format}' — supported: json, markdown` },
        400,
      );
    }
    const raw = readSessionJsonlRaw(agent, session);
    if (raw === null) {
      return c.json({ error: `session file not found on disk` }, 404);
    }
    const safeSession = session.replace(/[^A-Za-z0-9._-]/g, '_');
    if (format === 'json') {
      return c.body(raw, 200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${agent}-${safeSession}.jsonl"`,
      });
    }
    const md = renderSessionMarkdown(agent, session, raw);
    return c.body(md, 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${agent}-${safeSession}.md"`,
    });
  });

  app.post('/agents/:agent/sessions/:session/unarchive', async (c) => {
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    // Resolve against the include_archived view, otherwise an archived
    // session is not addressable by slug lookup. resolveSessionId works on
    // raw file existence so it's already include-archived-aware.
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    try {
      const after = await unarchiveSession(agent, session);
      logger.info({ msg: 'session.unarchive', agent, session, slug: after.slug, archived: after.isArchived });
      // The state after the call, computed the way the session list does —
      // never a success that did not happen.
      if (after.isArchived) return c.json({ error: `session '${session}' is still archived`, archived: true, agent, session }, 409);
      return c.json({ archived: false, agent, session, slug: after.slug });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/agents/:agent/sessions', async (c) => {
    const agent = c.req.param('agent');
    if (!(await agentKnown(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string };
    if (!body.slug) {
      return c.json({ error: 'body field "slug" required' }, 400);
    }
    if (body.slug === 'main') {
      return c.json({ error: '"main" is reserved — already always available' }, 400);
    }
    try {
      const id = await createSession(agent, body.slug);
      logger.info({ msg: 'session.create', agent, id, slug: body.slug });
      return c.json({ id, slug: body.slug, agent }, 201);
    } catch (err) {
      if (err instanceof SessionSlugTakenError) {
        return c.json({ error: err.message, id: err.existingId, slug: body.slug, agent, exists: true }, 409);
      }
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get('/agents/:agent/sessions/:session/model', async (c) => {
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    const ext = getExternalAgent(agent);
    if (ext) {
      // An external agent runs on its own system's model; somora only
      // names the system (docs/external-agents.md).
      const session = await resolveSessionId(agent, sessionRef);
      if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
      return c.json({ agent, session, provider: 'external', modelId: `${ext.system}/${agent}`, alias: null, engine: 'acp', contextWindow: 0, source: 'external', override: null, personaDefault: null, external: { system: ext.system } });
    }
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const meta = await sessionMetaStore.get(agent, session);
    const resolved = resolveEffectiveModel(config, persona, meta);
    if (!resolved) {
      return c.json({ error: `model for agent '${agent}' cannot be resolved` }, 500);
    }
    const override = typeof meta.modelOverride === 'string' ? meta.modelOverride : null;
    return c.json({
      agent,
      session,
      provider: resolved.providerName,
      modelId: resolved.modelId,
      alias: resolved.model.alias ?? null,
      engine: resolved.provider.engine,
      contextWindow: resolved.model.contextWindow,
      source: override ? 'session-override' : 'persona-default',
      override,
      personaDefault: persona.model ?? null,
    });
  });

  /**
   * A model switch made by an AGENT is written into the conversation it
   * affects — a person reading that session must be able to see that the
   * model changed, when, and who did it (the operator, 2026-09-21: agents may
   * switch the model of a running session; it must not happen silently).
   * A switch a person makes from their own client is already visible to
   * them and leaves no row.
   */
  async function noteSessionModelChange(
    agent: string,
    session: string,
    change: { to: string | null; resolved?: string; previous: string | null; by?: string | undefined; bySession?: string | undefined },
  ): Promise<void> {
    if (!change.by) return;
    const who = `agent ${change.by}${change.bySession ? ` (session ${change.bySession})` : ''}`;
    const text =
      change.to === null
        ? `${who} cleared this session's model override${change.previous ? ` (was ${change.previous})` : ''} — the persona default applies from the next turn.`
        : `${who} switched this session's model to ${change.to}${change.resolved ? ` (${change.resolved})` : ''}${change.previous ? `, was ${change.previous}` : ''} — takes effect with the next turn.`;
    const ev = { kind: 'engine_meta', ts: Date.now(), engine: 'somora', itemType: 'session_model', payload: { text, to: change.to, previous: change.previous, by: change.by } } as NormalizedEvent;
    await appendEvent(agent, session, ev);
    const sse = serializeSessionEvent(ev);
    if (sse) await publish(agent, session, sse);
    logger.info({ msg: 'session.model_changed_by_agent', agent, session, by: change.by, by_session: change.bySession, to: change.to, previous: change.previous });
  }

  app.put('/agents/:agent/sessions/:session/model', async (c) => {
    const agent = c.req.param('agent');
    if (isExternalAgent(agent)) return c.json({ error: `${agent} is an external agent — its model is set on its own system` }, 409);
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; by_agent?: string; by_session?: string };
    if (!body.model) return c.json({ error: 'body field "model" required' }, 400);
    const resolved = resolveAnyRef(config, body.model);
    if (!resolved) {
      return c.json({ error: `model '${body.model}' not found in config.yaml. Known: ${describeModelRefs(config)}` }, 400);
    }
    const before = await sessionMetaStore.get(agent, session);
    const previous = typeof before.modelOverride === 'string' ? before.modelOverride : null;
    await sessionMetaStore.update(agent, session, (current) => ({ ...current, modelOverride: body.model }));
    await noteSessionModelChange(agent, session, { to: body.model, resolved: `${resolved.providerName}/${resolved.modelId}`, previous, by: body.by_agent, bySession: body.by_session });
    logger.info({ msg: 'session.model_set', agent, session, model: body.model, resolved: `${resolved.providerName}/${resolved.modelId}` });
    // Tell every open client. The switch is often made from OUTSIDE the
    // window showing the session (an orchestrator agent, another client,
    // curl) — without this the header kept the old model until the
    // window was reopened, and the person could not tell whether the
    // switch had taken (report 2026-09-13).
    await publish(agent, session, {
      event: 'session_model',
      data: { model: body.model, resolved: `${resolved.providerName}/${resolved.modelId}`, source: 'session-override' },
    });
    return c.json({ agent, session, model: body.model, resolved: `${resolved.providerName}/${resolved.modelId}` });
  });

  // Compact a session by hand (`/compact [focus]`). Refused while a turn
  // runs; while it works it holds the session's lock, so a message sent
  // meanwhile waits behind it like behind any turn.
  app.post('/agents/:agent/sessions/:session/compact', async (c) => {
    const agent = c.req.param('agent');
    if (isExternalAgent(agent)) return c.json({ error: `${agent} is an external agent — its own system manages its context` }, 409);
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const sessionRef = c.req.param('session');
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { instructions?: unknown };
    const focus = typeof body.instructions === 'string' ? body.instructions.trim().slice(0, 2000) : '';
    if (getSessionLockStatus(agent, session).busy) {
      return c.json({ error: 'This session is busy (a turn or a compaction is running). Compact after it has finished.', busy: true }, 409);
    }
    const sessionMeta = await sessionMetaStore.get(agent, session);
    const resolvedModel = resolveEffectiveModel(config, persona, sessionMeta);
    if (!resolvedModel) return c.json({ error: `the session's model cannot be resolved from config.yaml` }, 400);
    const release = await acquireSessionLock(agent, session, { priority: 'user', turnId: `compact-${Date.now()}` });
    const started = Date.now();
    try {
      const outcome = await compactSessionByHand(
        {
          config,
          metaStore: sessionMetaStore,
          getHistory,
          systemPrompt: async () => (await nextTurnPrompt(agent, session, persona, sessionMeta)).assembled.text,
        },
        { agent, session, resolvedModel, ...(focus ? { focus } : {}) },
      );
      logger.info({ msg: 'session.compacted_by_hand', agent, session, engine: outcome.engine, status: outcome.status, ms: Date.now() - started, focus: Boolean(focus), ...(outcome.status === 'compacted' ? { tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter } : {}) });
      if (outcome.status === 'compacted') {
        const ev = {
          kind: 'engine_meta',
          ts: Date.now(),
          engine: 'somora',
          itemType: 'context_compacted',
          payload: {
            text: manualCompactionText(outcome, focus || undefined),
            manual: true,
            engine: outcome.engine,
            ...(outcome.tokensBefore !== undefined ? { tokensBefore: outcome.tokensBefore } : {}),
            ...(outcome.tokensAfter !== undefined ? { tokensAfter: outcome.tokensAfter } : {}),
            ...(focus ? { focus } : {}),
          },
        } as NormalizedEvent;
        await appendEvent(agent, session, ev);
        const sse = serializeSessionEvent(ev);
        if (sse) await publish(agent, session, sse);
      }
      return c.json({ agent, session, ...outcome }, outcome.status === 'unsupported' ? 400 : 200);
    } catch (err) {
      logger.warn({ msg: 'session.compact_failed', agent, session, err: (err as Error).message });
      return c.json({ error: `Compaction failed: ${(err as Error).message}` }, 502);
    } finally {
      release();
    }
  });

  // Reset a session: archive current jsonl + meta, fresh-start the
  // session id. The archived copy is resume-able under a timestamped
  // name. Used primarily for the magic `main` session, which can't be
  // re-created with a new id.
  //
  // If the agent has Dream-Mode enabled in agent.yaml, /reset also fires
  // off an async manual-dream over the just-archived range. Reset returns
  // immediately — the dream runs in background and surfaces later via
  // dream_list. Failures in the dream do NOT affect the reset itself.
  app.post('/agents/:agent/sessions/:session/reset', async (c) => {
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (isExternalAgent(agent)) {
      // Archive and start fresh; the next turn opens a new session on the
      // agent's side too. No REM: external agents do not dream here.
      const session = await resolveSessionId(agent, sessionRef);
      if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
      const release = await acquireSessionLock(agent, session, { priority: 'user' });
      let result: Awaited<ReturnType<typeof resetSession>>;
      try {
        // The reset writes fresh meta: carry the generation over.
        const before = (await sessionMetaStore.get(agent, session)) as Record<string, unknown>;
        const gen = typeof before.externalGeneration === 'number' ? before.externalGeneration : 0;
        result = await resetSession(agent, session);
        closeExternal(agent, session);
        await sessionMetaStore.update(agent, session, (m) => ({ ...m, externalGeneration: gen + 1 }));
      } finally {
        release();
      }
      logger.info({ msg: 'session.reset', agent, session, external: true, archivedId: result?.archivedId ?? null });
      return c.json({ agent, session, archivedId: result?.archivedId ?? null, dreamSpawned: false });
    }
    const persona = await loadPersona(agent);
    if (!persona) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    // Hold the session lock across the archive+recreate. Without it a
    // /reset that lands mid-turn renames the JSONL out from under a
    // streaming turn — the turn's tail events recreate the "fresh"
    // session and the engine end-write stamps the old conversation's
    // sdkSessionId into it. The lock makes reset wait for the in-flight
    // turn (and serializes concurrent resets). (Juni-Audit 2026-06.)
    const releaseReset = await acquireSessionLock(agent, session, { priority: 'user' });
    let result: Awaited<ReturnType<typeof resetSession>>;
    try {
      result = await resetSession(agent, session);
    } finally {
      releaseReset();
    }
    if (!result) {
      logger.info({ msg: 'session.reset_noop', agent, session, reason: 'no jsonl to archive' });
      return c.json({ agent, session, archivedId: null, reason: 'session has no content yet — nothing to archive' });
    }
    logger.info({ msg: 'session.reset', agent, session, archivedId: result.archivedId });

    // Spawn REM over the archived range — async, no await, no
    // ramifications for the reset response. If it fails, only the dream
    // file gets a `failed` status; user is otherwise unaffected.
    let dreamSpawned = false;
    const remSettings = remSettingsFor(persona, config);
    if (remSettings.ok) {
      const archivedId = result.archivedId;
      const remConfig = remSettings.rem;
      void (async () => {
        try {
          const mgr = await getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian });
          // Range + marker handling live in rem-reset-run.ts: a successful
          // run must stamp the archive as read, or the idle worker dreams
          // it again.
          await dreamArchivedAfterReset({ agent, archivedId, rem: remConfig, config, mgr });
        } catch (err) {
          logger.error({
            msg: 'dream.manual_run_failed',
            agent,
            archivedId,
            err: (err as Error).message,
          });
        }
      })();
      dreamSpawned = true;
    }
    return c.json({
      agent,
      session,
      archivedId: result.archivedId,
      dreamSpawned,
    });
  });

  app.delete('/agents/:agent/sessions/:session/model', async (c) => {
    const agent = c.req.param('agent');
    if (isExternalAgent(agent)) return c.json({ error: `${agent} is an external agent — its model is set on its own system` }, 409);
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const clearBody = (await c.req.json().catch(() => ({}))) as { by_agent?: string; by_session?: string };
    const beforeClear = await sessionMetaStore.get(agent, session);
    const previousOverride = typeof beforeClear.modelOverride === 'string' ? beforeClear.modelOverride : null;
    await sessionMetaStore.update(agent, session, (current) => {
      const { modelOverride: _drop, ...rest } = current;
      return rest;
    });
    if (previousOverride !== null) {
      await noteSessionModelChange(agent, session, { to: null, previous: previousOverride, by: clearBody.by_agent, bySession: clearBody.by_session });
    }
    logger.info({ msg: 'session.model_clear', agent, session });
    await publish(agent, session, { event: 'session_model', data: { model: null, source: 'persona-default' } });
    return c.json({ agent, session, cleared: true });
  });

  // Thinking endpoints — mirror /model. Effective level = session override
  // > persona default > unset (engine-default). modelSupportsReasoning
  // flag lets clients show "active vs dormant" honestly.
  app.get('/agents/:agent/sessions/:session/thinking', async (c) => {
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (isExternalAgent(agent)) {
      const session = await resolveSessionId(agent, sessionRef);
      if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
      return c.json({ agent, session, effective: null, override: null, personaDefault: null, modelDefault: null, source: 'external', modelSupportsReasoning: false, wire: null });
    }
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const meta = await sessionMetaStore.get(agent, session);
    const resolved = resolveEffectiveModel(config, persona, meta);
    const modelSupportsReasoning =
      resolved?.model.capabilities.includes('reasoning') ?? false;
    const override =
      typeof meta.thinkingOverride === 'string' &&
      VALID_THINKING_LEVELS.has(meta.thinkingOverride as ThinkingLevel)
        ? (meta.thinkingOverride as ThinkingLevel)
        : null;
    const thinking = resolveThinking(persona, meta, resolved?.model);
    const effective = thinking.level ?? null;
    // Wire value the engine sends for this level (per-model
    // `reasoning.levels`); null when identical to the level or not applicable.
    // openai-compatible: the reasoning_effort body value. codex-cli: the
    // `model_reasoning_effort=` spawn arg (2026-09-03 follow-up: the
    // adapter mapped `high → xhigh` but this route still said null, so
    // client badge and API disagreed). claude-cli has no mapping semantics.
    let wireValue: string | null = null;
    if (effective && modelSupportsReasoning && resolved) {
      if (resolved.provider.engine === 'openai-compatible') {
        wireValue = resolveOpenAiReasoning(effective, resolved.model).value ?? 'off';
      } else if (resolved.provider.engine === 'codex-cli') {
        wireValue = codexReasoningEffort(effective, resolved.model);
      }
    }
    return c.json({
      agent,
      session,
      effective,
      override,
      personaDefault: persona.thinking ?? null,
      // The active model's `reasoning.default`, if it has one.
      modelDefault: resolved?.model.reasoning?.default ?? null,
      // session-override | persona-default | model-default | engine-default
      // (nothing set: nothing is sent, the model decides — not "off").
      source: thinking.source,
      modelSupportsReasoning,
      wire: wireValue !== null && wireValue !== effective ? wireValue : null,
    });
  });

  app.put('/agents/:agent/sessions/:session/thinking', async (c) => {
    const agent = c.req.param('agent');
    if (isExternalAgent(agent)) return c.json({ error: `${agent} is an external agent — its thinking is set on its own system` }, 409);
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { level?: string };
    if (!body.level || !VALID_THINKING_LEVELS.has(body.level as ThinkingLevel)) {
      return c.json({ error: `body field "level" must be one of: off, low, medium, high` }, 400);
    }
    await sessionMetaStore.update(agent, session, (current) => ({ ...current, thinkingOverride: body.level }));
    logger.info({ msg: 'session.thinking_set', agent, session, level: body.level });
    return c.json({ agent, session, level: body.level });
  });

  app.delete('/agents/:agent/sessions/:session/thinking', async (c) => {
    const agent = c.req.param('agent');
    if (isExternalAgent(agent)) return c.json({ error: `${agent} is an external agent — its thinking is set on its own system` }, 409);
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    await sessionMetaStore.update(agent, session, (current) => {
      const { thinkingOverride: _drop, ...rest } = current;
      return rest;
    });
    logger.info({ msg: 'session.thinking_clear', agent, session });
    return c.json({ agent, session, cleared: true });
  });

  // Sampling endpoints — mirror /thinking. Effective = model default <
  // agent.yaml `sampling:` < session override, merged per key. PUT merges
  // into the override (a null value drops that key); DELETE clears it.
  app.get('/agents/:agent/sessions/:session/sampling', async (c) => {
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (isExternalAgent(agent)) {
      const session = await resolveSessionId(agent, sessionRef);
      if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
      return c.json({ agent, session, effective: null, override: null, personaDefault: null, modelDefault: null, source: 'external', engineSupportsSampling: false });
    }
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const meta = await sessionMetaStore.get(agent, session);
    const resolved = resolveEffectiveModel(config, persona, meta);
    const override =
      meta.samplingOverride && typeof meta.samplingOverride === 'object'
        ? (mergeSampling(meta.samplingOverride as Record<string, unknown>) ?? null)
        : null;
    const modelDefault = resolved?.model.sampling ?? null;
    const personaDefault = persona.sampling ?? null;
    const effective = mergeSampling(modelDefault, personaDefault, override) ?? null;
    return c.json({
      agent,
      session,
      effective,
      override,
      personaDefault,
      modelDefault,
      source: override
        ? 'session-override'
        : personaDefault
          ? 'persona-default'
          : modelDefault
            ? 'model-default'
            : 'engine-default',
      engineSupportsSampling: resolved?.provider.engine === 'openai-compatible',
    });
  });

  app.put('/agents/:agent/sessions/:session/sampling', async (c) => {
    const agent = c.req.param('agent');
    if (isExternalAgent(agent)) return c.json({ error: `${agent} is an external agent — its sampling is set on its own system` }, 409);
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
      return c.json({ error: 'body must be an object of sampling keys (temperature, top_p, …)' }, 400);
    }
    // Validate the non-null part against the schema; nulls are deletions.
    const toSet: Record<string, unknown> = {};
    const toDrop: string[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (!(SAMPLING_KEYS as readonly string[]).includes(k)) {
        return c.json({ error: `unknown sampling key '${k}' — allowed: ${SAMPLING_KEYS.join(', ')}` }, 400);
      }
      if (v === null) toDrop.push(k);
      else toSet[k] = v;
    }
    const parsed = SamplingSchema.safeParse(toSet);
    if (!parsed.success) {
      return c.json({ error: `invalid sampling value: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }, 400);
    }
    let next: Record<string, unknown> = {};
    await sessionMetaStore.update(agent, session, (current) => {
      const existing =
        current.samplingOverride && typeof current.samplingOverride === 'object'
          ? (current.samplingOverride as Record<string, unknown>)
          : {};
      next = { ...existing, ...parsed.data };
      for (const k of toDrop) delete next[k];
      if (Object.keys(next).length === 0) {
        const { samplingOverride: _drop, ...rest } = current;
        return rest;
      }
      return { ...current, samplingOverride: next };
    });
    logger.info({ msg: 'session.sampling_set', agent, session, override: next });
    return c.json({ agent, session, override: Object.keys(next).length > 0 ? next : null });
  });

  app.delete('/agents/:agent/sessions/:session/sampling', async (c) => {
    const agent = c.req.param('agent');
    if (isExternalAgent(agent)) return c.json({ error: `${agent} is an external agent — its sampling is set on its own system` }, 409);
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    await sessionMetaStore.update(agent, session, (current) => {
      const { samplingOverride: _drop, ...rest } = current;
      return rest;
    });
    logger.info({ msg: 'session.sampling_clear', agent, session });
    return c.json({ agent, session, cleared: true });
  });
}
