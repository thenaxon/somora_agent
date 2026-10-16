// Moved unchanged from src/server/index.ts, which calls registerSpawnRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import { getExternalAgent } from '../../external/registry.ts';
import { loadPersona } from '../../persona/loader.ts';
import { createSession, resolveSessionId } from '../../storage/sessions.ts';
import { releaseSpawnSlot, reserveSpawnSlot } from '../../tools/agents/spawn.ts';
import { findWaitCycle, registerWait } from '../ask-wait-graph.ts';
import { cancelTaskCascade, completeTask, failTask, getTask, listTasksForAgent, markResultFetched, newTaskId, registerTask, waitForTaskCompletion } from '../async-tasks.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { startTurn } from '../start-turn.ts';
import type { TurnOrigin } from '../turn-origin-kind.ts';

export function registerSpawnRoutes(app: Hono): void {
  // /spawn-async — fire-and-forget version of /chat/send-sync, used by
  // spawn_subagent with wait:false. Returns a task_id immediately; the
  // turn runs in the background. Status/result via /spawn-status and
  // /spawn-result.
  app.post('/spawn-async', async (c) => {
    const body = (await c.req.json()) as {
      agent?: string;
      session?: string;
      text?: string;
      from_agent?: string;
      parent_agent?: string;
      parent_session?: string;
      subagent_depth?: number;
      model?: string;
      max_rounds?: number;
      attention?: boolean;
      /** Refs from POST /attachments — a spawn brief may carry pictures
       *  the sub has to look at (2026-09-11). */
      attachments?: Array<{ hash: string; name: string; mime: string; size: number }>;
    };
    const agent = body.agent;
    const sessionRef = body.session;
    const text = body.text ?? '';
    if (!agent || !sessionRef) {
      return c.json({ error: 'agent + session required' }, 400);
    }
    if (!(await loadPersona(agent)) && !getExternalAgent(agent)?.agent.a2a) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }

    // Resolve the session ref through the same path the rest of the
    // server uses. Pre-fix (2026-05-16 audit), this endpoint took the
    // session string verbatim and wrote a JSONL with that as the
    // filename — bypassing createSession's <YYYYMMDD-HHMMSS>_<slug>
    // format. Result: sessions visible in `GET /agents/<a>/sessions`
    // (filesystem scan) but invisible to resolveSessionId, so archive/
    // delete/edit through the UI silently 404'd.
    //
    // Fix policy:
    //   - existing session → use as-is
    //   - exact-id shape (timestamped) but not existing → 404 (caller
    //     asked for a SPECIFIC archived session that's gone — auto-
    //     creating a new one with that name would be confusing)
    //   - slug shape, not existing → auto-create via createSession()
    //     so the JSONL gets the standard timestamped filename. This
    //     covers the common case: a caller (sentinel, test scripts,
    //     external integrations) supplies a logical name like
    //     "morning-routine" and expects somora to manage the file id.
    //   - invalid name → 400 with createSession's error message
    let session = await resolveSessionId(agent, sessionRef);
    if (!session) {
      const isExactId = /^\d{8}-\d{6}_[A-Za-z0-9_-]+$/.test(sessionRef);
      if (isExactId) {
        return c.json({ error: `session '${sessionRef}' not found` }, 404);
      }
      if (sessionRef === 'main') {
        // "main" should always have resolved above; defensive fallback.
        session = 'main';
      } else {
        try {
          session = await createSession(agent, sessionRef);
          logger.info({
            msg: 'spawn_async.session_autocreated',
            agent,
            ref: sessionRef,
            session,
          });
        } catch (err) {
          return c.json(
            {
              error: `session '${sessionRef}' not resolvable and not a valid slug: ${(err as Error).message}`,
            },
            400,
          );
        }
      }
    }

    const fromAgent =
      typeof body.from_agent === 'string' && body.from_agent.length > 0 ? body.from_agent : undefined;
    const subagentDepth =
      typeof body.subagent_depth === 'number' && body.subagent_depth > 0 ? body.subagent_depth : 0;
    const modelOverride =
      typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined;
    const maxRoundsOverride =
      typeof body.max_rounds === 'number' && body.max_rounds > 0 ? body.max_rounds : undefined;
    const parent_agent = body.parent_agent ?? fromAgent ?? agent;
    const parent_session = body.parent_session ?? '?';

    // Concurrency cap — same per-agent / global limits as the in-process
    // spawn tool. Pre-audit 2026-05-16 this endpoint accepted unlimited
    // parallel POSTs, letting an agent fan out way past 4 per-target.
    const slotErr = reserveSpawnSlot(agent, subagentDepth > 0 ? subagentDepth - 1 : 0);
    if (slotErr) {
      return c.json({ error: slotErr }, 429);
    }

    const task_id = newTaskId();
    const parentDepth = subagentDepth > 0 ? subagentDepth - 1 : 0;
    registerTask({
      task_id,
      parent_agent,
      parent_session,
      parent_depth: parentDepth,
      target_agent: agent,
      target_session: session,
      started_at: Date.now(),
      text,
      ...(typeof body.attention === 'boolean' ? { attention: body.attention } : {}),
    });

    // Fire-and-forget. Errors land in the task entry, not the HTTP
    // response — the caller already got their task_id back. startTurn
    // takes the per-session lock (two parallel /spawn-async POSTs on the
    // same session serialize) and registers the abort controller under
    // the sub's (agent, session), so subagent_cancel and the Stop button
    // cut the in-flight LLM call.
    //
    // A from_agent on this route labels the brief as A2A mail — the
    // documented, if unusual, shape for an external caller. The spawn
    // tool never sends one: a brief is neutral.
    const origin: TurnOrigin = fromAgent
      ? { kind: 'agent', from: { agent: fromAgent } }
      : {
          kind: 'subagent',
          depth: subagentDepth,
          taskId: task_id,
          ...(parent_session !== '?' ? { parent: { agent: parent_agent, session: parent_session } } : {}),
        };
    void (async () => {
      try {
        const result = await startTurn({
          agent,
          session,
          text,
          turnId: task_id,
          workId: task_id,
          origin,
          ...(body.attachments && body.attachments.length > 0
            ? { attachments: body.attachments }
            : {}),
          ...(modelOverride ? { modelOverride } : {}),
          ...(maxRoundsOverride
            ? { agentLoopOverride: { maxRounds: maxRoundsOverride } }
            : {}),
        });
        if (result) completeTask(task_id, result);
        else failTask(task_id, 'turn did not start');
      } catch (err) {
        failTask(task_id, (err as Error).message);
      } finally {
        releaseSpawnSlot(agent);
      }
    })();

    return c.json({ task_id }, 202);
  });

  app.get('/spawn-status', (c) => {
    const task_id = c.req.query('task_id');
    if (!task_id) return c.json({ error: 'task_id query required' }, 400);
    const entry = getTask(task_id);
    if (!entry) return c.json({ error: `task '${task_id}' not found` }, 404);
    return c.json({
      task_id: entry.task_id,
      state: entry.state,
      parent_agent: entry.parent_agent,
      parent_session: entry.parent_session,
      target_agent: entry.target_agent,
      target_session: entry.target_session,
      started_at: entry.started_at,
      ...(entry.finished_at !== undefined ? { finished_at: entry.finished_at } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    });
  });

  app.get('/spawn-result', async (c) => {
    const task_id = c.req.query('task_id');
    if (!task_id) return c.json({ error: 'task_id query required' }, 400);
    // Optional wait_until_done=1 + timeout_ms — server-side blocking
    // poll. Lets the caller request "give me the answer or wait up to
    // N ms for it" without burning agent-loop tool-call rounds on the
    // caller side.
    const waitFlag = c.req.query('wait_until_done');
    const wantWait = waitFlag === '1' || waitFlag === 'true';
    // Defaults sourced from agentLoop.{longTaskDefaultTimeoutMs,
    // longTaskMaxTimeoutMs} so the HTTP path matches the in-process tool
    // (status.ts) — both honor the same caller-friendly politik for slow
    // local models.
    const timeoutMs = (() => {
      const def = config.agentLoop.longTaskDefaultTimeoutMs;
      const max = config.agentLoop.longTaskMaxTimeoutMs;
      const raw = c.req.query('timeout_ms');
      if (!raw) return def;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
    })();
    let entry = getTask(task_id);
    if (!entry) return c.json({ error: `task '${task_id}' not found` }, 404);
    if (wantWait && entry.state === 'running') {
      // Circular-wait guard for the blocking wait (MCP-child callers of
      // subagent_result wait_until_done land here; the in-process tool
      // path has the identical guard in src/tools/agents/status.ts).
      // waiter_* identify the caller's blocked turn. On a cycle we do NOT
      // block — the sub is itself waiting on the caller, so blocking
      // guarantees a dual-timeout hang; 409 + circular_wait lets the tool
      // translate into a teaching pending-hint. Otherwise the wait is
      // registered as an edge so OTHER calls see it.
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
            via: 'spawn-result',
            from: `${waiter.agent}/${waiter.session}`,
            to: `${target.agent}/${target.session}`,
            chain: cycle,
          });
          return c.json(
            {
              task_id,
              error: `task '${task_id}' still running and waiting on the caller`,
              state: 'running',
              circular_wait: true,
              chain: cycle,
            },
            409,
          );
        }
      }
      const releaseWait = waiter ? registerWait(waiter, target) : undefined;
      try {
        entry = (await waitForTaskCompletion(task_id, timeoutMs)) ?? entry;
      } finally {
        releaseWait?.();
      }
    }
    if (entry.state === 'running') {
      return c.json({ task_id, error: `task '${task_id}' still running`, state: 'running' }, 409);
    }
    // Terminal state delivered to the parent (MCP-child subagent_result
    // path) → suppress the pending attention wake.
    markResultFetched(entry.task_id);
    return c.json({
      task_id: entry.task_id,
      state: entry.state,
      target_agent: entry.target_agent,
      target_session: entry.target_session,
      ...(entry.result ? { result: entry.result } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    });
  });

  app.get('/spawn-list', (c) => {
    const parent = c.req.query('parent_agent');
    if (!parent) return c.json({ error: 'parent_agent query required' }, 400);
    return c.json({ tasks: listTasksForAgent(parent) });
  });

  // /spawn-cancel — abort a running spawn tree (task + cascaded child
  // tasks). HTTP twin of the in-process subagent_cancel path so the MCP
  // child (claude-cli/codex-cli tool host) can cancel too. Only the
  // spawning agent may cancel its task — same guard as the tool.
  app.post('/spawn-cancel', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      task_id?: string;
      requesting_agent?: string;
      reason?: string;
    };
    if (!body.task_id) return c.json({ error: 'task_id required' }, 400);
    const entry = getTask(body.task_id);
    if (!entry) return c.json({ error: `task '${body.task_id}' not found` }, 404);
    if (body.requesting_agent && entry.parent_agent !== body.requesting_agent) {
      return c.json(
        {
          error:
            `task '${body.task_id}' was spawned by '${entry.parent_agent}', ` +
            `not by '${body.requesting_agent}' — only the spawning agent can cancel it`,
        },
        403,
      );
    }
    // No requesting_agent = a person (the queue popover, /queue in the
    // TUI): the parent reads "stopped by the user", like the Stop button.
    const who = body.requesting_agent ? `cancelled by ${body.requesting_agent}` : 'stopped by the user';
    const reason = body.reason?.trim() ? `${who}: ${body.reason.trim()}` : who;
    const outcome = cancelTaskCascade(body.task_id, reason, body.requesting_agent ? 'agent' : 'human');
    if (!outcome) return c.json({ error: `task '${body.task_id}' not found` }, 404);
    return c.json(outcome);
  });
}
