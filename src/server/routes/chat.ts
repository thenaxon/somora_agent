// Moved unchanged from src/server/index.ts, which calls registerChatRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`; remWorker are read from it
// per request (index.ts sets them up later or changes them).

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { listAllModels, resolveAnyRef } from '../../config/types.ts';
import { agentKnown, isExternalAgent } from '../../external/registry.ts';
import { createSession, getHistory, listSessions, resolveSessionId, sessionMetaStore } from '../../storage/sessions.ts';
import { markSeen, subscribeActivity } from '../activity-stream.ts';
import { completeAskCall, failAskCall, getAskCall, markAskCallPending, markAskCallRunning, registerAskCall, waitForAskCall } from '../ask-calls.ts';
import { findWaitCycle, registerWait } from '../ask-wait-graph.ts';
import { triggerChatAbort } from '../chat-aborts.ts';
import { paginateHistory } from '../history-page.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { DequeuedError, getSessionLockStatus, listSessionWaiters } from '../session-queue.ts';
import { streamSSEH2Safe } from '../sse-h2-safe.ts';
import { destroySocketOf, remoteOf, startSseHeartbeat } from '../sse-liveness.ts';
import { startTurn } from '../start-turn.ts';
import { pushSteer, steerableTurn } from '../steer-inbox.ts';
import { shortToolName } from '../tool-format.ts';
import type { TurnOrigin } from '../turn-origin-kind.ts';
import { getTurnOrigin } from '../turn-origin.ts';
import { REMOVED_BY_USER, dequeueWork, getWork, listWork, openWork, pendingWakesFor, wakeReplyTargetFor, withdrawWork } from '../work-ledger.ts';
import { randomUUID } from 'node:crypto';

export interface ChatRoutesDeps {
  defaultAgentFallback: typeof Server.defaultAgentFallback;
  publish: typeof Server.publish;
  readonly remWorker: typeof Server.remWorker;
  subscribe: typeof Server.subscribe;
}

export function registerChatRoutes(app: Hono, routeDeps: ChatRoutesDeps): void {
  const { defaultAgentFallback, publish, subscribe } = routeDeps;
  app.get('/agents/:agent/sessions/:session/work', async (c) => {
    const agent = c.req.param('agent');
    const ref = c.req.param('session');
    if (!(await agentKnown(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, ref);
    if (!session) return c.json({ error: `session '${ref}' not found for agent '${agent}'` }, 404);
    const view = (it: ReturnType<typeof getWork>) =>
      it
        ? {
            id: it.id,
            kind: it.origin.kind,
            ...(it.origin.kind === 'wake' ? { about: it.origin.about } : {}),
            state: it.state,
            preview: it.preview,
            target: it.target,
            ...(it.requester ? { requester: it.requester } : {}),
            enqueuedAt: it.enqueuedAt,
            ...(it.startedAt !== undefined ? { startedAt: it.startedAt } : {}),
            ...(it.finishedAt !== undefined ? { finishedAt: it.finishedAt } : {}),
            ...(it.turnId ? { turnId: it.turnId } : {}),
            ...(it.error ? { error: it.error } : {}),
          }
        : null;
    const lock = getSessionLockStatus(agent, session);
    const active = lock.busy && lock.activeWorkId ? view(getWork(lock.activeWorkId)) : null;
    const queued = listSessionWaiters(agent, session).map((w) => ({
      ...(view(w.workId ? getWork(w.workId) : undefined) ?? { id: w.turnId ?? null, kind: w.priority === 'user' ? 'human' : 'agent', state: 'queued', preview: '' }),
      position: w.position,
      enqueuedAt: w.enqueuedAt,
    }));
    const here = { agent, session };
    const pendingWakes = pendingWakesFor(here).map((it) => ({ ...view(it)!, about: it.origin.kind === 'agent' ? 'a2a' : it.origin.kind === 'subagent' ? 'subagent' : 'job' }));
    const children = listWork({ requester: here, states: ['queued', 'running'] })
      .filter((it) => it.origin.kind === 'subagent' || it.origin.kind === 'agent')
      .map((it) => view(it));
    return c.json({
      asOf: Date.now(),
      agent,
      session,
      busy: lock.busy,
      ...(lock.busy && !active ? { activeTurnId: lock.activeTurnId ?? null } : {}),
      active,
      queued,
      pendingWakes,
      children,
    });
  });

  app.get('/chat/history', async (c) => {
    const agent = c.req.query('agent');
    const sessionRef = c.req.query('session');
    if (!agent || !sessionRef) {
      return c.json({ error: 'query params "agent" and "session" required' }, 400);
    }
    if (!(await agentKnown(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const id = await resolveSessionId(agent, sessionRef);
    if (!id) {
      return c.json({ error: `session '${sessionRef}' not found for agent '${agent}'` }, 404);
    }
    // Pagination (Phase 1 web lazy-load): when `limit` is given the
    // server returns only the LAST `limit` events plus a `hasMore` +
    // `oldestTs` marker; subsequent calls supply `before=<oldestTs>` to
    // pull the next older window. Without `limit` the response is the
    // full session — backwards compatible for older clients (TUI
    // hydrates everything anyway, web only opts into paging when it
    // explicitly asks for it).
    //
    // Tool names are normalized through shortToolName so clients render
    // `memory_search` instead of `mcp__somora__memory_search`
    // (claude-cli + codex-cli wrap MCP tools with that prefix). Live SSE
    // already strips it via the per-turn serializer; this endpoint is
    // the parity for the load-from-JSONL path.
    const rawAll = await getHistory(agent, id);
    const all = rawAll.map((e) =>
      e.kind === 'tool_call' ? { ...e, tool: shortToolName(e.tool) } : e,
    );
    const limitParam = c.req.query('limit');
    const beforeParam = c.req.query('before');
    if (!limitParam && !beforeParam) {
      return c.json({ agent, session: id, events: all, hasMore: false });
    }
    const limit = Math.max(1, Math.min(2000, Number(limitParam) || 200));
    const before = beforeParam ? Number(beforeParam) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(before)) {
      return c.json({ error: 'query param "before" must be a numeric timestamp (ms)' }, 400);
    }
    // Same-ts groups are never split across pages — a strict `ts <
    // before` cursor otherwise loses the group remainder forever
    // (Juni-Audit 2026-06; see history-page.ts).
    const page = paginateHistory(all, limit, before);
    return c.json({
      agent,
      session: id,
      events: page.events,
      hasMore: page.hasMore,
      ...(page.oldestTs !== null ? { oldestTs: page.oldestTs } : {}),
    });
  });

  app.get('/chat/stream', async (c) => {
    const sessionRef = c.req.query('session') ?? 'main';
    const agent = c.req.query('agent') ?? (await defaultAgentFallback());
    if (!agent) {
      return c.json({ error: 'no agents configured — create one in ~/.somora/agents/' }, 400);
    }
    if (!(await agentKnown(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) {
      return c.json({ error: `session '${sessionRef}' not found for agent '${agent}'` }, 404);
    }
    return streamSSEH2Safe(c, async (stream) => {
      const remote = remoteOf(c);
      const connectedAt = Date.now();
      logger.info({ msg: 'sse.connect', agent, session, remote });
      // Teardown runs from ANY side — client abort (onAbort), server-side
      // eviction after a publish timeout (evict hook), or a dead verdict
      // from the heartbeat watcher. Guard against double-execution; on
      // eviction/dead additionally close the stream and destroy the
      // socket so the client's EventSource sees EOF (or nothing keeps
      // buffering into a vanished peer) and auto-reconnects instead of
      // idling on heartbeats that carry no events.
      let stopHeartbeat: (() => void) | undefined;
      let done = false;
      let resolveDone: () => void = () => {};
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve; // executor runs synchronously — safe before any await
      });
      const finish = (reason: 'disconnect' | 'evicted' | 'dead', detail?: string): void => {
        if (done) return;
        done = true;
        stopHeartbeat?.();
        unsub();
        logger.info({
          msg: reason === 'evicted' ? 'sse.evicted_closed' : 'sse.disconnect',
          agent,
          session,
          remote,
          reason,
          ...(detail ? { detail } : {}),
          durationMs: Date.now() - connectedAt,
        });
        resolveDone();
      };
      const unsub = subscribe(
        agent,
        session,
        async (event) => {
          // `?? null` is a guard, not decoration: JSON.stringify(undefined)
          // returns undefined, hono's SSE writer calls .split on it and
          // throws, and publish() reads that throw as a dead subscriber and
          // evicts this stream. One malformed event must degrade to an empty
          // frame, never disconnect a watching client (2026-09-12).
          await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data ?? null) });
        },
        () => {
          finish('evicted');
          try {
            stream.close();
          } catch {
            /* already closed */
          }
        },
      );
      await stream.writeSSE({ event: 'status', data: JSON.stringify({ msg: 'connected', session }) });
      // Heartbeat keeps TCP alive past Undici's idle-body timeout (~5 min default)
      // and gives the client a positive signal the link is still healthy.
      // Its writes are watched: a write that fails or never completes
      // means the peer is gone (see sse-liveness.ts).
      stopHeartbeat = startSseHeartbeat(stream, {
        intervalMs: config.sse.heartbeatMs,
        deadAfterMs: config.sse.deadAfterMs,
        onDead: (why, detail) => {
          finish('dead', `${why}${detail ? ': ' + detail : ''}`);
          try {
            stream.close();
          } catch {
            /* already closed */
          }
          destroySocketOf(c);
        },
      });
      stream.onAbort(() => finish('disconnect'));
      await donePromise;
    });
  });

  // Cross-agent activity feed. One subscription per client (TUI / web /
  // mobile) gives streaming dots for every busy agent + unread badges
  // for every session with movement since lastSeenAt. See
  // src/server/activity-stream.ts for the event vocabulary.
  app.get('/activity/stream', async (c) => {
    return streamSSEH2Safe(c, async (stream) => {
      const remote = remoteOf(c);
      const connectedAt = Date.now();
      logger.info({ msg: 'activity.connect', remote });
      const unsub = subscribeActivity(async (event) => {
        // `?? null` is a guard, not decoration: JSON.stringify(undefined)
        // returns undefined, hono's SSE writer calls .split on it and
        // throws, and publish() reads that throw as a dead subscriber and
        // evicts this stream. One malformed event must degrade to an empty
        // frame, never disconnect a watching client (2026-09-12).
        await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data ?? null) });
      });
      await stream.writeSSE({ event: 'status', data: JSON.stringify({ msg: 'connected' }) });
      let done = false;
      let resolveDone: () => void = () => {};
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const finish = (reason: 'disconnect' | 'dead', detail?: string) => {
        if (done) return;
        done = true;
        stopHeartbeat();
        unsub();
        logger.info({ msg: 'activity.disconnect', remote, reason, ...(detail ? { detail } : {}), durationMs: Date.now() - connectedAt });
        resolveDone();
      };
      const stopHeartbeat = startSseHeartbeat(stream, {
        intervalMs: config.sse.heartbeatMs,
        deadAfterMs: config.sse.deadAfterMs,
        onDead: (why, detail) => {
          finish('dead', `${why}${detail ? ': ' + detail : ''}`);
          try {
            stream.close();
          } catch {
            /* already closed */
          }
          destroySocketOf(c);
        },
      });
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          finish('disconnect');
          resolve();
        });
      });
    });
  });

  // "I am looking at this session right now" — clears the unread badge
  // across every other open client by broadcasting a `seen` event on
  // /activity/stream. Body is optional: `{ts?: ISO}` lets a client
  // state an older timestamp (e.g. "I scrolled away N seconds ago");
  // the default is now. Server clamps to `max(current, ts)` so a late
  // arrival can't regress the seen marker.
  app.post('/sessions/:agent/:session/seen', async (c) => {
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (!(await agentKnown(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) {
      return c.json({ error: `session '${sessionRef}' not found for agent '${agent}'` }, 404);
    }
    let providedTs: string | undefined;
    try {
      const body = (await c.req.json().catch(() => null)) as { ts?: string } | null;
      if (body && typeof body.ts === 'string') providedTs = body.ts;
    } catch {
      /* empty body fine */
    }
    const seenAt = await markSeen(agent, session, providedTs);
    return c.json({ ok: true, agent, session, seenAt });
  });

  // Human turns waiting for a busy session lock, by server turnId. Lets
  // DELETE /chat/queue/:turnId hand the message back to the composer —
  // the operator's 2026-08-26 ask: "solange queued praktisch nochmal zurücknehmen
  // und umschreiben". Entries live only between POST /chat/send and the
  // moment the lock is granted; A2A and sentinel turns are never listed.

  // DELETE /chat/queue/:id — take a waiting turn back before it starts,
  // whoever queued it (Phase 2). `:id` is the work-ledger id: the turnId
  // of a human turn, the call_id of an agent_ask, the task_id of a spawn.
  // A person (no body) may remove anything; an agent (body
  // `{ requesting_agent }`) only what it asked for itself → 403 otherwise.
  // 200 with the original text (+ attachment refs) for a human turn, 409
  // when the lock already went to it (use /chat/abort for that), 404 when
  // nothing waits under that id. Nothing is written to the session — the
  // message never became a turn; the requester of an agent item reads
  // `failed` with the reason. Other open clients get `turn_dequeued`, and
  // fresh `turn_queued` counts for the human waiters that moved up.
  app.delete('/chat/queue/:turnId', async (c) => {
    const id = c.req.param('turnId');
    const body = (await c.req.json().catch(() => ({}))) as { requesting_agent?: unknown; withdraw_running?: unknown };
    const by = typeof body.requesting_agent === 'string' && body.requesting_agent.length > 0 ? { agent: body.requesting_agent } : 'human';
    const outcome = dequeueWork(id, by);
    if (outcome.status === 'unknown') {
      return c.json(
        { ok: false, reason: 'unknown', error: `no queued turn '${id}' — it already started, finished, or was never queued` },
        404,
      );
    }
    if (outcome.status === 'forbidden') {
      return c.json({ ok: false, reason: 'forbidden', id, error: `'${id}' was not queued by ${(by as { agent: string }).agent}` }, 403);
    }
    if (outcome.status === 'running') {
      // The soft take-back of a running call by the agent that made it
      // (`withdraw_running: true`, what agent_ask_cancel sends): the
      // outcome wakes no one, and the target is told to stop through its
      // steer inbox when its turn reads one. The turn itself is not
      // aborted — that stays the person's Stop.
      if (by !== 'human' && body.withdraw_running === true) {
        const w = withdrawWork(id, by);
        if (w.status === 'forbidden') {
          return c.json({ ok: false, reason: 'forbidden', id, error: `'${id}' was not sent by ${by.agent}` }, 403);
        }
        if (w.status === 'withdrawn') {
          const { agent, session } = w.item.target;
          // An external agent's turn is a task over A2A (docs/a2a.md): no
          // steer inbox to read, so taking it back stops the turn, which
          // sends CancelTask to the other side.
          if (isExternalAgent(agent)) {
            const stopped = triggerChatAbort(agent, session).aborted;
            logger.info({ msg: 'chat.withdraw_external', agent, session, withdraw: id, stopped });
            return c.json({
              ok: true,
              state: 'withdrawn',
              id,
              turnId: w.item.turnId ?? null,
              agent,
              session,
              steered: false,
              stopped,
              ranMs: w.item.startedAt ? Date.now() - w.item.startedAt : null,
            });
          }
          const running = steerableTurn(agent, session);
          const steerable = !!running && (!w.item.turnId || running.turnId === w.item.turnId);
          let steerId: string | undefined;
          if (running && steerable) {
            const text =
              `${by.agent} takes back the request it sent you (call ${id}) — it is no longer needed. ` +
              'Stop working on it now: deliver no result for it, leave nothing half-done, cancel any ' +
              'sub-agents you started for it (subagent_cancel), and end your turn with one short line ' +
              'saying you stopped.';
            const m = pushSteer(agent, session, {
              text,
              origin: { kind: 'agent', from: { agent: by.agent }, callId: id },
              from_agent: by.agent,
            });
            steerId = m.id;
            logger.info({ msg: 'chat.steer', steerId: m.id, agent, session, turnId: running.turnId, engine: running.engine, withdraw: id });
            void publish(agent, session, {
              event: 'steer_queued',
              data: { steerId: m.id, text, ts: m.ts, turnId: running.turnId, origin: { kind: 'agent', from: { agent: by.agent }, callId: id } },
            });
          }
          return c.json({
            ok: true,
            state: 'withdrawn',
            id,
            turnId: w.item.turnId ?? null,
            agent,
            session,
            steered: !!steerId,
            ...(steerId ? { steerId } : {}),
            ranMs: w.item.startedAt ? Date.now() - w.item.startedAt : null,
          });
        }
      }
      return c.json({ ok: false, reason: 'already_started', turnId: id, id }, 409);
    }
    const item = outcome.item;
    const { agent, session } = item.target;
    for (const w of listSessionWaiters(agent, session)) {
      if (w.priority === 'user' && w.turnId) {
        void publish(agent, session, { event: 'turn_queued', data: { turnId: w.turnId, ahead: w.position, workId: w.workId ?? w.turnId, kind: 'human' } });
      }
    }
    logger.info({ msg: 'chat.queue.dequeued', id, kind: item.origin.kind, agent, session, by: by === 'human' ? 'human' : by.agent });
    return c.json({
      ok: true,
      turnId: id,
      id,
      kind: item.origin.kind,
      agent,
      session,
      ...(item.origin.kind === 'human' ? { text: item.text ?? '', attachments: item.attachments ?? [] } : {}),
    });
  });

  app.post('/chat/send', async (c) => {
    const body = (await c.req.json()) as {
      agent?: string;
      session?: string;
      text?: string;
      /**
       * A2A attribution. When set, this turn's user_message is treated
       * as written by the named somora agent (not by the human user).
       * Used by the `agent_ask` tool to post a question into another
       * agent's session. Persists in JSONL as user_message.from_agent.
       */
      from_agent?: string;
      /** A2A: the session the writing agent wrote from (with from_agent).
       *  Names the reply-back target for the receiver's agent_ask. */
      from_session?: string;
      /** A2A correlation UUID. Persisted on user_message.agent_ask_call_id. */
      agent_ask_call_id?: string;
      /** Sub-agent nesting depth (0 = top-level). */
      subagent_depth?: number;
      /** Phase Y.B — files the user attached to this turn. Each entry is
       *  the response shape returned by POST /attachments. Bytes are NOT
       *  inline; the server resolves hash → ~/.somora/attachments path. */
      attachments?: Array<{ hash: string; name: string; mime: string; size: number }>;
      /** Voice — set when the client filled the input via STT (mic-button
       *  on web/mobile). Persists on user_message.input.modality and
       *  unlocks the auto-TTS hook (in concert with autoPlayRequested). */
      input_modality?: 'text' | 'voice';
      /** Voice — provider tag for the STT path used (e.g. "omlx"). */
      stt_provider?: string;
      /** Voice — does the client want a spoken reply for this turn?
       *  Driven by the per-session "auto-play" toggle in the chat header.
       *  Only honored together with `input_modality === 'voice'`. */
      auto_play_requested?: boolean;
      /** Steering — hand the text to the turn that is running right now
       *  (see steer-inbox.ts) instead of queuing a turn of its own. Falls
       *  back to queuing when nothing steerable runs; the response says
       *  which happened (`steered`). */
      steer?: boolean;
    };
    const agent = body.agent ?? (await defaultAgentFallback());
    if (!agent) {
      return c.json({ error: 'no agents configured — create one in ~/.somora/agents/' }, 400);
    }
    const sessionRef = body.session ?? 'main';
    const text = body.text ?? '';
    const fromAgent =
      typeof body.from_agent === 'string' && body.from_agent.length > 0 ? body.from_agent : undefined;
    const agentAskCallId =
      typeof body.agent_ask_call_id === 'string' && body.agent_ask_call_id.length > 0
        ? body.agent_ask_call_id
        : undefined;
    const subagentDepth =
      typeof body.subagent_depth === 'number' && body.subagent_depth > 0 ? body.subagent_depth : 0;

    if (!(await agentKnown(agent))) {
      logger.warn({ msg: 'chat.send.unknown_agent', agent });
      return c.json({ error: `agent '${agent}' not found — create ~/.somora/agents/${agent}/AGENTS.md` }, 404);
    }

    const session = await resolveSessionId(agent, sessionRef);
    if (!session) {
      return c.json(
        {
          error: `session '${sessionRef}' not found for agent '${agent}' — create one via POST /agents/${agent}/sessions { "slug": "${sessionRef}" }`,
        },
        404,
      );
    }

    // Generate the turn-lifecycle id up here so the HTTP-layer log line
    // already carries it. runChatTurn re-uses this same id for every
    // subsequent stage log (turn.started / .engine_init / .first_event /
    // .completed / .failed). Forensic chain from HTTP acceptance through
    // engine completion.
    const turnId = randomUUID();
    logger.info({
      msg: 'chat.send',
      turnId,
      agent,
      session,
      ref: sessionRef,
      len: text.length,
    });

    // Fire-and-forget. Acquire the per-session lock with priority='user'
    // (default for /chat/send unless from_agent is set, in which case the
    // call is acting as A2A and yields to actual user turns). Release in
    // the finally block — forgetting deadlocks future turns on the session.
    const priority: 'user' | 'agent' = fromAgent ? 'agent' : 'user';
    // Who wrote this. A third-party client may post as another agent
    // (from_agent, optionally from_session + agent_ask_call_id — the
    // documented A2A shape of this route); a sub-agent depth makes it a
    // brief; everything else is a person typing (or dictating, when the
    // client filled the box through its microphone).
    const fromSession =
      fromAgent && typeof body.from_session === 'string' && body.from_session.length > 0
        ? body.from_session
        : undefined;
    const origin: TurnOrigin = fromAgent
      ? { kind: 'agent', from: { agent: fromAgent, ...(fromSession ? { session: fromSession } : {}) }, ...(agentAskCallId ? { callId: agentAskCallId } : {}) }
      : subagentDepth > 0
        ? { kind: 'subagent', depth: subagentDepth }
        : { kind: 'human', via: body.input_modality === 'voice' ? 'voice-stt' : 'chat' };
    // Steering: with `steer: true` and a turn running that can read its
    // letterbox, the text goes INTO that turn (before its next step)
    // instead of waiting behind it. Otherwise it queues as usual and the
    // response says so (`steered: false`). agent_ask calls never steer:
    // their answer must come from a turn of their own.
    if (body.steer === true && !agentAskCallId) {
      const running = steerableTurn(agent, session);
      if (running) {
        const m = pushSteer(agent, session, {
          text,
          origin,
          ...(fromAgent ? { from_agent: fromAgent } : {}),
          ...(fromAgent && fromSession ? { from_session: fromSession } : {}),
        });
        logger.info({ msg: 'chat.steer', steerId: m.id, agent, session, turnId: running.turnId, engine: running.engine });
        void publish(agent, session, {
          event: 'steer_queued',
          data: { steerId: m.id, text, ts: m.ts, turnId: running.turnId, origin },
        });
        routeDeps.remWorker.resetActivity(agent);
        return c.json({ ok: true, steered: true, steerId: m.id, turnId: running.turnId }, 202);
      }
    }

    // An agent_ask call id posted here is a call like any other: register
    // it so agent_ask_result finds it in the registry, not only in the
    // target's history (birdseye L17).
    // The ledger item: a human turn keeps its text while it waits (so
    // DELETE /chat/queue can hand it back); an agent_ask call posted here
    // is a call like any other.
    const workId = agentAskCallId && fromAgent ? agentAskCallId : turnId;
    if (agentAskCallId && fromAgent) {
      registerAskCall({
        call_id: agentAskCallId,
        from_agent: fromAgent,
        ...(fromSession ? { from_session: fromSession } : {}),
        target_agent: agent,
        target_session: session,
        text,
      });
    } else {
      openWork({
        id: turnId,
        origin,
        target: { agent, session },
        requester: origin.kind === 'human' ? { human: true } : undefined,
        text,
        ...(body.attachments && body.attachments.length > 0 ? { attachments: body.attachments } : {}),
        wake: 'never',
      });
    }
    void (async () => {
      logger.info({ msg: 'turn.queued', turnId, agent, session, priority });
      try {
        const result = await startTurn({
          agent,
          session,
          text,
          turnId,
          workId,
          origin,
          // startTurn broadcasts `turn_queued` when the lock is busy, so a
          // client that accepted this turn's optimistic bubble (matched by
          // the turnId from the HTTP response below) tags it as queued.
          beforeRun: () => {
            if (agentAskCallId && fromAgent) markAskCallRunning(agentAskCallId);
            return true;
          },
          ...(body.attachments && body.attachments.length > 0
            ? { attachments: body.attachments }
            : {}),
          ...(body.input_modality === 'voice' ? { inputModality: 'voice' as const } : {}),
          ...(body.stt_provider ? { sttProvider: body.stt_provider } : {}),
          ...(body.auto_play_requested ? { autoPlayRequested: true } : {}),
        });
        if (agentAskCallId && fromAgent && result) completeAskCall(agentAskCallId, result);
      } catch (err) {
        if (err instanceof DequeuedError) {
          // Taken back by the user before it started — nothing ran,
          // nothing to persist. The route that dequeued it already
          // broadcast turn_dequeued.
          logger.info({ msg: 'chat.dequeued', turnId, agent, session });
          return;
        }
        logger.error({
          msg: 'chat.send.run_failed',
          turnId,
          agent,
          session,
          err: (err as Error).message,
        });
        if (agentAskCallId && fromAgent) failAskCall(agentAskCallId, (err as Error).message);
        void publish(agent, session, { event: 'status', data: { msg: `turn failed: ${(err as Error).message}` } });
      }
    })();

    // User just spoke → cancel any in-flight auto-dream for this agent
    // and reset the idle countdown. (resetActivity is also called inside
    // runChatTurn, but doing it here ensures the cancel happens BEFORE
    // the turn even starts processing.)
    routeDeps.remWorker.resetActivity(agent);

    // turnId is echoed back so clients can pair the optimistic bubble
    // they just rendered with future SSE events (turn_queued while
    // waiting, user_message once the lock is acquired and the turn
    // actually starts). Used by the queue-indicator UX added with
    // 2026.05.23.x. `steered: false` only when steering was asked for
    // and nothing steerable was running.
    return c.json({ ok: true, turnId, ...(body.steer === true ? { steered: false } : {}) }, 202);
  });

  // /chat/abort — cancel an in-flight turn for (agent, session). Triggered
  // by TUI ESC while streaming. Idempotent: returns aborted=false when no
  // turn is running. Doesn't block — the engine adapter sees the signal
  // and bails out, then runChatTurn's finally releases the controller.
  //
  // The session ref MUST be resolved the same way /chat/send resolves it:
  // the abort registry is keyed by the canonical session id, so a raw
  // slug here silently missed the registry and the abort was a no-op
  // (aborted:false, no log — the operator's 2026-07-22 report, live-reproduced
  // 2026-07-27: slug → false while the turn ran, canonical id → clean
  // abort). Falls back to the raw ref when resolution fails so turns
  // registered under non-canonical ids (spawn-async bypass sessions)
  // stay abortable.
  app.post('/chat/abort', async (c) => {
    const agent = c.req.query('agent') ?? (await defaultAgentFallback());
    if (!agent) {
      return c.json({ error: 'no agents configured' }, 400);
    }
    const sessionRef = c.req.query('session') ?? 'main';
    const session = (await resolveSessionId(agent, sessionRef)) ?? sessionRef;
    const turnId = c.req.query('turnId') || undefined;
    const result = triggerChatAbort(agent, session, turnId);
    if (!result.aborted) {
      logger.info({
        msg: 'chat.abort.no_active_turn',
        agent,
        session,
        ref: sessionRef,
        hint: 'nothing registered under this session — turn already finished, or the ref does not match the running turn',
      });
    }
    return c.json({ agent, session, ...result });
  });

  // /chat/send-sync — same input as /chat/send, but blocks until the turn
  // completes and returns the result as JSON instead of streaming events
  // to SSE subscribers. Used by spawn_subagent's MCP-passthrough path so
  // that claude-cli/codex-cli MCP-served tools can delegate by HTTPing
  // back to the localhost server (the in-process runChatTurn isn't
  // reachable from the MCP child process).
  //
  // 127.0.0.1-only by virtue of how the server is bound; same trust
  // posture as the existing debug endpoints.
  // /a2a/ask-result — outcome of an agent_ask call by call_id. Backs the
  // agent_ask_result tool. Primary source is the in-memory registry fed
  // by /chat/send-sync below; after a restart the target session's JSONL
  // is the fallback (user_message.agent_ask_call_id is persisted), which
  // needs agent + session from the caller. wait_until_done blocks
  // server-side and is cycle-checked like /spawn-result.
  app.get('/a2a/ask-result', async (c) => {
    const callId = c.req.query('call_id');
    if (!callId) return c.json({ error: 'call_id query required' }, 400);
    const waitFlag = c.req.query('wait_until_done');
    const wantWait = waitFlag === '1' || waitFlag === 'true';
    const timeoutMs = (() => {
      const def = config.agentLoop.longTaskDefaultTimeoutMs;
      const max = config.agentLoop.longTaskMaxTimeoutMs;
      const raw = c.req.query('timeout_ms');
      if (!raw) return def;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
    })();

    let entry = getAskCall(callId);
    if (entry) {
      if (wantWait && entry.finished_at === undefined) {
        const waiterAgent = c.req.query('waiter_agent') || undefined;
        const waiterSession = c.req.query('waiter_session') || undefined;
        const waiter =
          waiterAgent && waiterSession ? { agent: waiterAgent, session: waiterSession } : undefined;
        const target = { agent: entry.target_agent, session: entry.target_session };
        if (waiter) {
          const cycle = findWaitCycle(waiter, target);
          if (cycle) {
            logger.warn({
              msg: 'a2a.circular_wait_rejected',
              via: 'ask-result',
              from: `${waiter.agent}/${waiter.session}`,
              to: `${target.agent}/${target.session}`,
              chain: cycle,
            });
            return c.json(
              {
                call_id: callId,
                state: entry.state,
                target_agent: entry.target_agent,
                target_session: entry.target_session,
                started_at: entry.started_at,
                circular_wait: true,
                chain: cycle,
                source: 'registry',
              },
              409,
            );
          }
        }
        const releaseWait = waiter ? registerWait(waiter, target) : undefined;
        try {
          entry = (await waitForAskCall(callId, timeoutMs)) ?? entry;
        } finally {
          releaseWait?.();
        }
        // Waiting through to the answer IS fetching it — read it again
        // through getAskCall so the late-answer wake stays off. Without
        // this the asker got the answer here and, three seconds later,
        // a wake about the same answer (birdseye L4).
        if (entry.finished_at !== undefined) entry = getAskCall(callId) ?? entry;
      }
      return c.json({
        call_id: entry.call_id,
        state: entry.state,
        target_agent: entry.target_agent,
        target_session: entry.target_session,
        started_at: entry.started_at,
        ...(entry.finished_at !== undefined ? { finished_at: entry.finished_at } : {}),
        ...(entry.result ? { response: entry.result.finalText, outcome: entry.result.outcome } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        source: 'registry',
      });
    }

    // History fallback — the registry is process-local; after a restart
    // the persisted user_message (agent_ask_call_id) is all that is left.
    const agent = c.req.query('agent');
    const sessionRef = c.req.query('session');
    if (!agent || !sessionRef) {
      return c.json({ error: `call '${callId}' not in the live registry; pass agent + session to read the target session` }, 404);
    }
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found for agent '${agent}'` }, 404);
    const events = await getHistory(agent, session);
    const idx = events.findIndex((e) => e.kind === 'user_message' && e.agent_ask_call_id === callId);
    if (idx < 0) return c.json({ error: `no user_message with call_id '${callId}' in ${agent}/${session}` }, 404);
    const startedAt = events[idx]!.ts;
    let response: string | undefined;
    let error: string | undefined;
    let finishedAt: number | undefined;
    for (const e of events.slice(idx + 1)) {
      if (e.kind === 'user_message') break;
      if (e.kind === 'assistant_message') response = e.text;
      else if (e.kind === 'error') error = e.message;
      else if (e.kind === 'turn_end') {
        finishedAt = e.ts;
        break;
      }
    }
    const lock = getSessionLockStatus(agent, session);
    const state =
      finishedAt !== undefined ? (error && !response ? 'failed' : 'done') : lock.busy ? 'running' : 'unknown';
    return c.json({
      call_id: callId,
      state,
      target_agent: agent,
      target_session: session,
      started_at: startedAt,
      ...(finishedAt !== undefined ? { finished_at: finishedAt } : {}),
      ...(response !== undefined ? { response } : {}),
      ...(error ? { error } : {}),
      source: 'history',
    });
  });

  // /a2a/turn-origin — who wrote the message the turn on agent/session
  // is currently answering. agent_ask (running in an MCP child of that
  // turn) asks this before defaulting its target session: a reply to the
  // asker goes to the session the question came from. Two sources:
  //   - live A2A turn: run-turn registered from_agent/from_session
  //   - sub-agent session: spawn meta carries parent_agent/parent_session
  //   - wake turn about an agent's answer: the session that answered
  // Returns { origin: null } when the turn is a plain human/system turn.
  app.get('/a2a/turn-origin/:agent/:session', async (c) => {
    const agent = c.req.param('agent');
    const session = c.req.param('session');
    const live = getTurnOrigin(agent, session);
    if (live) return c.json({ origin: { ...live, kind: 'a2a' } });
    const meta = (await sessionMetaStore.get(agent, session)) as {
      spawn?: { parent_agent?: unknown; parent_session?: unknown };
    };
    const pa = meta.spawn?.parent_agent;
    const ps = meta.spawn?.parent_session;
    if (typeof pa === 'string' && typeof ps === 'string' && ps !== '?') {
      return c.json({ origin: { agent: pa, session: ps, kind: 'subagent' } });
    }
    // Woken with another agent's answer: a reply belongs to the session
    // that answer came from.
    const woken = wakeReplyTargetFor({ agent, session });
    if (woken) return c.json({ origin: { ...woken, kind: 'wake' } });
    return c.json({ origin: null });
  });

  app.post('/chat/send-sync', async (c) => {
    const body = (await c.req.json()) as {
      agent?: string;
      session?: string;
      text?: string;
      from_agent?: string;
      from_session?: string;
      waiter_agent?: string;
      waiter_session?: string;
      agent_ask_call_id?: string;
      subagent_depth?: number;
      model?: string;
      max_rounds?: number;
      /** Create `session` (a slug) on the target when it does not exist
       *  yet — opt-in, so a typo in a slug stays a 404 with the list of
       *  existing sessions instead of a silent new session. */
      create_session?: boolean;
      /** Model (alias or provider/id) pinned on the session IF this call
       *  creates it. Ignored — with a note — when the session exists. */
      create_model?: string;
      /** Refs from POST /attachments, same shape as on /chat/send. This
       *  route is the A2A path, so it is how one agent hands another a
       *  picture it must actually SEE — a path in the message text is
       *  just text to a model (2026-09-11 report). A target whose model
       *  has no eyes gets the vision worker's description instead, the
       *  same as a chat attachment. */
      attachments?: Array<{ hash: string; name: string; mime: string; size: number }>;
      /** `agent_ask wait:false` (Phase 2): register the call, start the
       *  turn in the background, answer 202 at once with the call_id. The
       *  asker is woken when the answer lands. */
      detach?: boolean;
    };
    const agent = body.agent ?? (await defaultAgentFallback());
    if (!agent) {
      return c.json({ error: 'no agents configured' }, 400);
    }
    const sessionRef = body.session ?? 'main';
    let text = body.text ?? '';
    const fromAgent =
      typeof body.from_agent === 'string' && body.from_agent.length > 0 ? body.from_agent : undefined;
    const fromSession =
      fromAgent && typeof body.from_session === 'string' && body.from_session.length > 0
        ? body.from_session
        : undefined;
    // waiter_* identify the CALLER TURN that blocks on this request, for
    // circular-wait detection. Deliberately separate from from_agent:
    // from_agent changes message semantics in the target's session (the
    // user_message is labeled as A2A), while waiter_* is pure wait-graph
    // bookkeeping. agent_ask sends both; spawn_subagent's wait:true HTTP
    // fallback sends only waiter_* (a sub's task text must stay a plain
    // user task, not an A2A message).
    const waiterAgent =
      typeof body.waiter_agent === 'string' && body.waiter_agent.length > 0
        ? body.waiter_agent
        : undefined;
    const waiterSession =
      typeof body.waiter_session === 'string' && body.waiter_session.length > 0
        ? body.waiter_session
        : undefined;
    const agentAskCallId =
      typeof body.agent_ask_call_id === 'string' && body.agent_ask_call_id.length > 0
        ? body.agent_ask_call_id
        : undefined;
    const subagentDepth =
      typeof body.subagent_depth === 'number' && body.subagent_depth > 0 ? body.subagent_depth : 0;
    const modelOverride =
      typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined;
    const maxRoundsOverride =
      typeof body.max_rounds === 'number' && body.max_rounds > 0 ? body.max_rounds : undefined;

    if (!(await agentKnown(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    let session = await resolveSessionId(agent, sessionRef);
    let sessionCreated = false;
    let sessionModel: string | undefined;
    let sessionNote: string | undefined;
    let creationNote: string | undefined;
    const createModel =
      typeof body.create_model === 'string' && body.create_model.length > 0 ? body.create_model : undefined;
    if (!session && body.create_session === true) {
      // Opt-in creation of a named project session (2026-09-07: "take
      // Ada and Cleo in their projektA sessions — create them if
      // missing, Ada on fable, Cleo on astra"). Only slugs: main
      // always exists, exact ids and sub-* names are not project sessions.
      const isExactId = /^\d{8}-\d{6}_[A-Za-z0-9_-]+$/.test(sessionRef);
      if (isExactId || sessionRef.startsWith('sub-')) {
        return c.json(
          { error: `session '${sessionRef}' does not exist and create_session only creates named project slugs (not ids or sub-* sessions)` },
          400,
        );
      }
      let resolvedModel: ReturnType<typeof resolveAnyRef> = null;
      if (createModel) {
        resolvedModel = resolveAnyRef(config, createModel);
        if (!resolvedModel) {
          const known = listAllModels(config).map((m) => m.model.alias ?? `${m.providerName}/${m.modelId}`);
          return c.json(
            { error: `model '${createModel}' not found in config.yaml — session NOT created`, known_models: known },
            400,
          );
        }
      }
      try {
        session = await createSession(agent, sessionRef);
      } catch (err) {
        return c.json({ error: `cannot create session '${sessionRef}': ${(err as Error).message}` }, 400);
      }
      sessionCreated = true;
      if (createModel && resolvedModel) {
        await sessionMetaStore.update(agent, session, (current) => ({ ...current, modelOverride: createModel }));
        sessionModel = `${resolvedModel.providerName}/${resolvedModel.modelId}`;
      }
      logger.info({
        msg: 'a2a.session_created',
        agent,
        session,
        slug: sessionRef,
        by: fromAgent ?? null,
        model: sessionModel ?? null,
      });
      // Tell the target what just happened — this is its first message
      // in a session it did not know it had. Beside the text, not in it
      // (turn-framing.ts): the record is the question.
      creationNote =
        `[Your session '${sessionRef}' was just created by ${fromAgent ?? 'the caller'} for this conversation` +
        (sessionModel ? `; it runs on model ${sessionModel}` : '') +
        '.]';
    } else if (session && createModel) {
      sessionNote = `session '${sessionRef}' already existed — create_model '${createModel}' ignored; to switch an existing session use the session_model tool (PUT /agents/${agent}/sessions/${session}/model)`;
    }
    if (!session) {
      // Name the sessions that DO exist so an agent that guessed a slug
      // can correct it instead of retreating to main (2026-09-06 report).
      const known = (await listSessions(agent)).map((s) => s.slug);
      return c.json(
        { error: `session '${sessionRef}' not found for agent '${agent}'`, known_sessions: known },
        404,
      );
    }

    // Acquire the session lock. A from_agent caller (agent_ask, sub-spawn)
    // queues with priority='agent' and yields to any human user turn that
    // arrives in parallel. A direct user-side caller of /chat/send-sync
    // (rare — TUI uses /chat/send) gets priority='user'.
    //
    // Sub-spawn destinations are fresh sessions (sub-xxx-yyy), so the lock
    // is uncontended in that path; cost is one Map lookup + a Promise.
    // Circular-wait (deadlock) guard for blocking A2A calls (agent_ask +
    // spawn_subagent wait:true via HTTP fallback). Only callers that
    // identify their own blocked turn (waiter_*) participate — check +
    // register are synchronous back-to-back so concurrent calls can't
    // both slip past. The edge must be registered BEFORE
    // acquireSessionLock: the caller is already waiting while this
    // request queues on the target's lock. See
    // src/server/ask-wait-graph.ts for the full coverage map.
    let releaseWait: (() => void) | undefined;
    if (waiterAgent && waiterSession) {
      const waitFrom = { agent: waiterAgent, session: waiterSession };
      const waitTo = { agent, session };
      const cycle = findWaitCycle(waitFrom, waitTo);
      if (cycle) {
        logger.warn({
          msg: 'a2a.circular_wait_rejected',
          from: `${waiterAgent}/${waiterSession}`,
          to: `${agent}/${session}`,
          chain: cycle,
        });
        return c.json(
          {
            error:
              `circular A2A wait: ${agent}/${session} is already waiting on ` +
              `${waiterAgent}/${waiterSession} (wait chain: ${cycle.join(' → ')}). ` +
              `This call would deadlock both turns.`,
            circular_wait: true,
            chain: cycle,
          },
          409,
        );
      }
      releaseWait = registerWait(waitFrom, waitTo);
    }

    // agent_ask round trips are tracked by call_id so a caller whose
    // wait timed out can pick the outcome up later (agent_ask_result).
    const detach = body.detach === true && Boolean(agentAskCallId && fromAgent);
    if (agentAskCallId && fromAgent) {
      registerAskCall({
        call_id: agentAskCallId,
        from_agent: fromAgent,
        ...(fromSession ? { from_session: fromSession } : {}),
        target_agent: agent,
        target_session: session,
        text,
        ...(detach ? { detached: true } : {}),
      });
      // The asker hanging up IS the signal that it stopped waiting:
      // agent_ask aborts its fetch when its own timeout fires. Only such
      // a call needs waking when the answer finally lands — one that is
      // still on the line gets the answer as its tool result.
      const askerGone = c.req.raw.signal;
      if (askerGone && !detach) {
        if (askerGone.aborted) markAskCallPending(agentAskCallId);
        else askerGone.addEventListener('abort', () => markAskCallPending(agentAskCallId), { once: true });
      }
    }
    // Every other caller of this route (a sync sub, a direct client) gets
    // an item too, so the queue can show it.
    const workId = agentAskCallId && fromAgent ? agentAskCallId : randomUUID();
    // Who this turn is from: an agent asking (agent_ask), a spawned
    // sub working a brief (spawn_subagent wait:true over HTTP — the
    // waiter fields name its parent), or a client of this route acting
    // as the person.
    const origin: TurnOrigin = fromAgent
      ? { kind: 'agent', from: { agent: fromAgent, ...(fromSession ? { session: fromSession } : {}) }, ...(agentAskCallId ? { callId: agentAskCallId } : {}) }
      : subagentDepth > 0
        ? {
            kind: 'subagent',
            depth: subagentDepth,
            ...(waiterAgent && waiterSession ? { parent: { agent: waiterAgent, session: waiterSession } } : {}),
          }
        : { kind: 'human', via: 'chat' };
    if (!(agentAskCallId && fromAgent)) {
      openWork({
        id: workId,
        origin,
        target: { agent, session },
        ...(waiterAgent && waiterSession ? { requester: { agent: waiterAgent, session: waiterSession } } : {}),
        text,
        wake: 'never',
      });
    }
    const turnArgs = {
      agent,
      session,
      text,
      ...(creationNote ? { turnPrefix: creationNote } : {}),
      workId,
      origin,
      ...(body.attachments && body.attachments.length > 0
        ? { attachments: body.attachments }
        : {}),
      ...(modelOverride ? { modelOverride } : {}),
      ...(maxRoundsOverride
        ? { agentLoopOverride: { maxRounds: maxRoundsOverride } }
        : {}),
      // Streams to SSE subscribers too — a human watching this session
      // sees A2A inbound user_messages and the assistant's reply appear
      // live, not just on session refresh.
    };
    if (detach) {
      releaseWait?.();
      void startTurn(turnArgs).catch((err) => {
        logger.warn({ msg: 'a2a.detached_turn_failed', call_id: agentAskCallId, agent, session, err: (err as Error).message });
      });
      return c.json(
        {
          call_id: agentAskCallId,
          state: 'pending',
          session_id: session,
          ...(sessionCreated ? { session_created: true } : {}),
          ...(sessionModel ? { session_model: sessionModel } : {}),
          ...(sessionNote ? { session_note: sessionNote } : {}),
        },
        202,
      );
    }
    try {
      const result = await startTurn(turnArgs);
      if (!result) throw new Error('turn did not start');
      return c.json({
        ...result,
        session_id: session,
        ...(sessionCreated ? { session_created: true } : {}),
        ...(sessionModel ? { session_model: sessionModel } : {}),
        ...(sessionNote ? { session_note: sessionNote } : {}),
      });
    } catch (err) {
      if (err instanceof DequeuedError) {
        // Taken back by the person before it started. The asker reads a
        // failed call with the reason — not a model failure to retry.
        return c.json({ finalText: '', outcome: 'failed', error: REMOVED_BY_USER, dequeued: true, session_id: session });
      }
      if (agentAskCallId) failAskCall(agentAskCallId, (err as Error).message);
      return c.json({ error: (err as Error).message }, 500);
    } finally {
      releaseWait?.();
    }
  });
}
