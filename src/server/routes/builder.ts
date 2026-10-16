// Moved unchanged from src/server/index.ts, which calls registerBuilderRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { getLspManager } from '../../lsp/index.ts';
import { LSP_SERVERS, findBinary } from '../../lsp/registry.ts';
import { type Persona, listAgents, loadPersona } from '../../persona/loader.ts';
import { resolveSessionId, sessionMetaStore } from '../../storage/sessions.ts';
import { checkWriteAllowed, expandHome } from '../../tools/file/policy.ts';
import { registerAskCall } from '../ask-calls.ts';
import { claimOfSession, describeClaim, listWorkdirClaims, workdirClaimedBy } from '../builder-busy.ts';
import { answerQuestion, askQuestion, pendingQuestion } from '../builder-questions.ts';
import { CHAT_QUESTION_TIMEOUT_MS, TURN_ATTENDED_KEY } from '../ask-attended.ts';
import { type BuilderMode, type BuilderPhase, DEFAULT_PLAN_FILE, type TodoItem, archiveNameFor, patchBuilderState, readBuilderState } from '../builder-session.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { DequeuedError } from '../session-queue.ts';
import { workdirFromMeta } from '../session-workdir.ts';
import { startTurn } from '../start-turn.ts';
import type { TurnOrigin } from '../turn-origin-kind.ts';
import { openWork } from '../work-ledger.ts';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { mkdir as mkdirFs, rename as renameFs, stat as statFs, writeFile as writeFileFs } from 'node:fs/promises';
import { dirname, isAbsolute, join as joinPath, normalize } from 'node:path';

export interface BuilderRoutesDeps {
  publish: typeof Server.publish;
}

export function registerBuilderRoutes(app: Hono, routeDeps: BuilderRoutesDeps): void {
  const { publish } = routeDeps;
  // GET /agents/:agent/sessions/:session/work — what this session is
  // doing, what waits behind it, what is about to arrive, and what it
  // started elsewhere (Phase 2, private/turn-dispatch-phase2-design.md
  // §2.1). Previews only: no prompts, no tool bodies, no secrets.
  // ── Builder sessions (docs/builder.md) ──────────────────────────────
  // Mode, phase, plan file, task list and the open question of a builder
  // session. The task panel in the web reads GET …/builder and listens to
  // `builder_state`, `todo_updated`, `question_asked` and
  // `question_answered`; the builder's tools (todo_write, ask_user,
  // plan_write) write through PUT …/todos, POST …/ask and PUT …/plan.

  async function builderSessionOf(c: Context): Promise<{ agent: string; session: string; persona: Persona } | Response> {
    const agent = c.req.param('agent') ?? '';
    const sessionRef = c.req.param('session') ?? '';
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    return { agent, session, persona };
  }

  app.get('/agents/:agent/sessions/:session/builder', async (c) => {
    const r = await builderSessionOf(c);
    if (r instanceof Response) return r;
    const meta = await sessionMetaStore.get(r.agent, r.session);
    const state = readBuilderState(meta as Record<string, unknown>);
    const q = pendingQuestion(r.agent, r.session);
    // The running turn, for the panel's "running for 4:32 · 23 tool calls"
    // line: a builder turn is long, and a chat window's streaming pill says
    // nothing about how long or how far.
    const turn = claimOfSession(r.agent, r.session);
    return c.json({
      agent: r.agent,
      session: r.session,
      kind: r.persona.kind,
      state,
      question: q
        ? { questionId: q.id, question: q.question, header: q.header, options: q.options, multiple: q.multiple, askedAt: q.askedAt, expiresAt: q.expiresAt }
        : null,
      turn: turn
        ? { turnId: turn.turnId, startedAt: turn.since, toolCalls: turn.toolCalls, ...(turn.lastTool ? { lastTool: turn.lastTool, lastToolAt: turn.lastToolAt } : {}) }
        : null,
    });
  });

  app.patch('/agents/:agent/sessions/:session/builder', async (c) => {
    const r = await builderSessionOf(c);
    if (r instanceof Response) return r;
    const body = (await c.req.json().catch(() => ({}))) as {
      mode?: string;
      phase?: string;
      planPath?: string | null;
      orderer?: { agent?: unknown; session?: unknown };
    };
    const patch: { mode?: BuilderMode; phase?: BuilderPhase; planPath?: string | null; orderer?: { agent: string; session?: string } } = {};
    if (body.orderer !== undefined) {
      if (!body.orderer || typeof body.orderer.agent !== 'string' || !body.orderer.agent) {
        return c.json({ error: 'orderer must be { agent, session? }' }, 400);
      }
      patch.orderer = {
        agent: body.orderer.agent,
        ...(typeof body.orderer.session === 'string' && body.orderer.session ? { session: body.orderer.session } : {}),
      };
    }
    if (body.mode !== undefined) {
      if (body.mode !== 'attended' && body.mode !== 'unattended') return c.json({ error: 'mode must be attended | unattended' }, 400);
      patch.mode = body.mode;
    }
    if (body.phase !== undefined) {
      if (body.phase !== 'plan' && body.phase !== 'build') return c.json({ error: 'phase must be plan | build' }, 400);
      patch.phase = body.phase;
    }
    if (body.planPath !== undefined) {
      if (body.planPath !== null && (typeof body.planPath !== 'string' || !isAbsolute(expandHome(body.planPath)))) {
        return c.json({ error: 'planPath must be an absolute path or null' }, 400);
      }
      patch.planPath = body.planPath === null ? null : normalize(expandHome(body.planPath));
    }
    const state = await patchBuilderState(sessionMetaStore, r.agent, r.session, patch);
    logger.info({ msg: 'builder.state_patched', agent: r.agent, session: r.session, ...patch });
    await publish(r.agent, r.session, { event: 'builder_state', data: { mode: state.mode, phase: state.phase, planPath: state.planPath } });
    return c.json({ agent: r.agent, session: r.session, state });
  });

  // Language servers (docs/lsp.md). The file tools call this after a
  // builder's write — in-process and from the MCP child alike — and get
  // the server's errors for the file back; nothing when no server serves
  // the file, none is installed, or the verdict does not come in time.
  app.post('/lsp/diagnostics', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { agent?: string; session?: string; path?: string; touch?: boolean } | null;
    if (!body || typeof body.agent !== 'string' || typeof body.session !== 'string' || typeof body.path !== 'string' || !isAbsolute(body.path)) {
      return c.json({ error: 'body must be { agent, session, path (absolute), touch? }' }, 400);
    }
    const persona = await loadPersona(body.agent);
    if (!persona) return c.json({ error: `agent '${body.agent}' not found` }, 404);
    if (persona.kind !== 'builder' || !config.lsp.enabled) return c.json({ diagnostics: null, reason: persona.kind !== 'builder' ? 'not a builder' : 'disabled' });
    const meta = await sessionMetaStore.get(body.agent, body.session);
    const workdir = workdirFromMeta(meta as Record<string, unknown>, persona, config).path;
    const mgr = getLspManager(() => config);
    if (body.touch) {
      mgr.touch(workdir, body.path);
      return c.json({ diagnostics: null, touched: true });
    }
    const diagnostics = await mgr.diagnosticsAfterWrite(workdir, body.path);
    return c.json({ diagnostics });
  });
  app.get('/lsp/status', async (c) => {
    const servers = await Promise.all(
      LSP_SERVERS.map(async (def) => {
        const own: { enabled?: boolean; command?: string } = config.lsp.servers[def.id] ?? {};
        const bin = await findBinary(def, own.command);
        return { id: def.id, title: def.title, extensions: def.extensions, enabled: own.enabled !== false, command: bin.command, source: bin.source };
      }),
    );
    return c.json({ enabled: config.lsp.enabled, waitMs: config.lsp.waitMs, servers, running: getLspManager(() => config).status() });
  });

  // The builders of this somora (for an orchestrator choosing one) and
  // who is working where right now (one builder per folder).
  app.get('/builders', async (c) => {
    const agents = (await listAgents()).filter((a) => a.kind === 'builder');
    const claims = listWorkdirClaims();
    return c.json({
      builders: agents.map((a) => ({
        name: a.name,
        role: a.role ?? null,
        description: a.description,
        busy: claims.filter((cl) => cl.agent === a.name).map((cl) => ({ session: cl.session, workdir: cl.workdir, since: cl.since })),
      })),
    });
  });
  app.get('/builders/busy', async (c) => {
    const workdir = c.req.query('workdir');
    if (!workdir) return c.json({ claims: listWorkdirClaims() });
    const claim = workdirClaimedBy(expandHome(workdir));
    return c.json({ workdir, busy: claim ? { ...claim, reason: describeClaim(claim) } : null });
  });

  // Go: the plan is approved — switch to build and tell the builder.
  app.post('/agents/:agent/sessions/:session/builder/go', async (c) => {
    const r = await builderSessionOf(c);
    if (r instanceof Response) return r;
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    {
      // Another builder in this folder right now: the build would edit
      // its working copy under it. Refuse with the name; the person (or
      // the orderer) presses Go again after that report.
      const meta = await sessionMetaStore.get(r.agent, r.session);
      const folder = workdirFromMeta(meta as Record<string, unknown>, r.persona, config).path;
      const claim = workdirClaimedBy(folder);
      if (claim && !(claim.agent === r.agent && claim.session === r.session)) {
        return c.json({ error: `folder busy: ${describeClaim(claim)}`, busy: claim }, 409);
      }
    }
    const state = await patchBuilderState(sessionMetaStore, r.agent, r.session, { phase: 'build' });
    await publish(r.agent, r.session, { event: 'builder_state', data: { mode: state.mode, phase: state.phase, planPath: state.planPath } });
    const text =
      `The plan${state.planPath ? ` at ${state.planPath}` : ''} is approved — GO. Execute it now: read the plan first, keep the task list with todo_write, ` +
      `verify each step, and end with the report.${body.note ? `\n\n${body.note.trim()}` : ''}`;
    const turnId = randomUUID();
    // An order that came from another agent (builder_dispatch with
    // phase: plan) has an orderer waiting for the result. The Go turn
    // then runs as that agent's detached ask — exactly what agent_ask
    // wait:false registers — so the orderer is woken with the report
    // when the build ends, instead of never hearing of it.
    const orderer = state.orderer;
    if (orderer) {
      registerAskCall({
        call_id: turnId,
        from_agent: orderer.agent,
        ...(orderer.session ? { from_session: orderer.session } : {}),
        target_agent: r.agent,
        target_session: r.session,
        text,
        detached: true,
      });
      const origin: TurnOrigin = { kind: 'agent', from: { agent: orderer.agent, ...(orderer.session ? { session: orderer.session } : {}) }, callId: turnId };
      void startTurn({ agent: r.agent, session: r.session, text, origin, turnId, workId: turnId }).catch((err: unknown) => {
        if (err instanceof DequeuedError) return;
        logger.error({ msg: 'builder.go_turn_failed', agent: r.agent, session: r.session, err: (err as Error).message });
      });
      logger.info({ msg: 'builder.go', agent: r.agent, session: r.session, turnId, wakes: orderer });
      return c.json({ agent: r.agent, session: r.session, state, turnId, callId: turnId, wakes: orderer }, 202);
    }
    const origin: TurnOrigin = { kind: 'human', via: 'chat' };
    openWork({ id: turnId, origin, target: { agent: r.agent, session: r.session }, requester: { human: true }, text, wake: 'never' });
    void startTurn({ agent: r.agent, session: r.session, text, origin, turnId, workId: turnId }).catch((err: unknown) => {
      if (err instanceof DequeuedError) return;
      logger.error({ msg: 'builder.go_turn_failed', agent: r.agent, session: r.session, err: (err as Error).message });
    });
    logger.info({ msg: 'builder.go', agent: r.agent, session: r.session, turnId });
    return c.json({ agent: r.agent, session: r.session, state, turnId }, 202);
  });

  app.put('/agents/:agent/sessions/:session/todos', async (c) => {
    const r = await builderSessionOf(c);
    if (r instanceof Response) return r;
    const body = (await c.req.json().catch(() => null)) as { todos?: unknown; by_agent?: string } | null;
    if (!body || !Array.isArray(body.todos)) return c.json({ error: 'body must be { todos: [...] }' }, 400);
    const todos: TodoItem[] = [];
    for (const t of body.todos as unknown[]) {
      if (!t || typeof t !== 'object') continue;
      const o = t as { content?: unknown; status?: unknown; priority?: unknown };
      if (typeof o.content !== 'string' || o.content.trim().length === 0) continue;
      todos.push({
        content: o.content.trim().slice(0, 500),
        status: typeof o.status === 'string' && o.status.trim() ? o.status.trim().toLowerCase() : 'pending',
        ...(typeof o.priority === 'string' && o.priority.trim() ? { priority: o.priority.trim().toLowerCase() } : {}),
      });
      if (todos.length >= 100) break;
    }
    const state = await patchBuilderState(sessionMetaStore, r.agent, r.session, { todos });
    await publish(r.agent, r.session, { event: 'todo_updated', data: { todos: state.todos, ...(body.by_agent ? { by: body.by_agent } : {}) } });
    return c.json({ agent: r.agent, session: r.session, todos: state.todos });
  });

  app.put('/agents/:agent/sessions/:session/plan', async (c) => {
    const r = await builderSessionOf(c);
    if (r instanceof Response) return r;
    const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
    if (!body || typeof body.content !== 'string') return c.json({ error: 'body must be { content: string }' }, 400);
    const meta = await sessionMetaStore.get(r.agent, r.session);
    const state = readBuilderState(meta as Record<string, unknown>);
    const planPath = state?.planPath ?? joinPath(workdirFromMeta(meta as Record<string, unknown>, r.persona, config).path, DEFAULT_PLAN_FILE);
    const policy = checkWriteAllowed(planPath, r.agent);
    if (!policy.ok) return c.json({ error: policy.reason }, 400);
    await mkdirFs(dirname(planPath), { recursive: true });
    // A plan file that is already there and was not written by this
    // session (an earlier build's plan, a person's own) is history, not a
    // draft: it moves aside as PLAN-<date>-<session>.md before the new
    // plan takes its place.
    let archived: string | null = null;
    const m = meta as Record<string, unknown>;
    // "Written by this session" is a path and a time: after the plan path
    // moved with a pin, the file at the new path is somebody else's.
    const writtenTs = typeof m.builderPlanWrittenTs === 'number' && m.builderPlanWrittenPath === planPath ? (m.builderPlanWrittenTs as number) : null;
    try {
      const st = await statFs(planPath);
      if (writtenTs === null || st.mtimeMs > writtenTs + 2000) {
        archived = await archiveNameFor(planPath, r.session);
        await renameFs(planPath, archived);
        logger.info({ msg: 'builder.plan_archived', agent: r.agent, session: r.session, from: planPath, to: archived });
      }
    } catch {
      /* no plan there yet */
    }
    const tmp = `${planPath}.somora-tmp.${process.pid}.${Date.now().toString(36)}`;
    await writeFileFs(tmp, body.content, 'utf8');
    await renameFs(tmp, planPath);
    await sessionMetaStore.update(r.agent, r.session, (current) => ({
      ...current,
      builderPlanWrittenTs: Date.now(),
      builderPlanWrittenPath: planPath,
      // A path chosen here by default may still follow a later pin.
      ...(state?.planPath ? {} : { builderPlanPath: planPath, builderPlanPathDefault: true }),
    }));
    logger.info({ msg: 'builder.plan_written', agent: r.agent, session: r.session, path: planPath, bytes: Buffer.byteLength(body.content), archived });
    await publish(r.agent, r.session, { event: 'builder_state', data: { mode: state?.mode ?? 'attended', phase: state?.phase ?? 'plan', planPath } });
    return c.json({ path: planPath, bytes: Buffer.byteLength(body.content, 'utf8'), ...(archived ? { archived, note: 'An earlier plan was there; it was moved beside the new one. Say in your plan what of it still stands.' } : {}) });
  });

  // ask_user: blocks until the person answers (POST …/answer) or the wait
  // runs out. The tool's own timeout is a little longer than `timeout_ms`.
  app.post('/agents/:agent/sessions/:session/ask', async (c) => {
    const r = await builderSessionOf(c);
    if (r instanceof Response) return r;
    const body = (await c.req.json().catch(() => null)) as {
      question?: unknown;
      header?: unknown;
      options?: unknown;
      multiple?: unknown;
      timeout_ms?: unknown;
    } | null;
    if (!body || typeof body.question !== 'string' || !Array.isArray(body.options)) {
      return c.json({ error: 'body must be { question, options: [{label, description?}], multiple?, timeout_ms? }' }, 400);
    }
    const options = (body.options as unknown[])
      .map((o) => {
        if (!o || typeof o !== 'object') return null;
        const x = o as { label?: unknown; description?: unknown };
        if (typeof x.label !== 'string' || !x.label.trim()) return null;
        return { label: x.label.trim().slice(0, 80), ...(typeof x.description === 'string' ? { description: x.description.slice(0, 300) } : {}) };
      })
      .filter((o): o is { label: string; description?: string } => o !== null)
      .slice(0, 6);
    if (options.length < 2) return c.json({ error: 'at least two options with a label' }, 400);
    // A chat agent asks only in a turn a person started (ask-attended.ts).
    // The tool is not offered otherwise; this catches a call that slips
    // through (an old tool list, a direct HTTP call) before it waits.
    if (r.persona.kind !== 'builder') {
      const meta = (await sessionMetaStore.get(r.agent, r.session)) as Record<string, unknown>;
      if (meta[TURN_ATTENDED_KEY] !== true) {
        return c.json({ answered: false, answers: [], text: 'nobody is watching this turn — decide yourself and say what you decided' });
      }
    }
    const answer = await askQuestion(
      {
        agent: r.agent,
        session: r.session,
        question: body.question.trim().slice(0, 2000),
        ...(typeof body.header === 'string' && body.header.trim() ? { header: body.header.trim().slice(0, 40) } : {}),
        options,
        multiple: body.multiple === true,
        // A builder's question may wait 30 minutes; a chat agent's turn
        // holds the conversation, so 10 unless it asks for another time.
        ...(typeof body.timeout_ms === 'number' ? { timeoutMs: body.timeout_ms } : r.persona.kind !== 'builder' ? { timeoutMs: CHAT_QUESTION_TIMEOUT_MS } : {}),
      },
      (q) => {
        void publish(r.agent, r.session, {
          event: 'question_asked',
          data: { questionId: q.id, question: q.question, ...(q.header ? { header: q.header } : {}), options: q.options, multiple: q.multiple, expiresAt: q.expiresAt },
        });
      },
    );
    return c.json(answer);
  });

  app.post('/agents/:agent/sessions/:session/answer', async (c) => {
    const r = await builderSessionOf(c);
    if (r instanceof Response) return r;
    const body = (await c.req.json().catch(() => null)) as { questionId?: unknown; answers?: unknown; text?: unknown } | null;
    if (!body || typeof body.questionId !== 'string') return c.json({ error: 'body must be { questionId, answers?: string[], text?: string }' }, 400);
    const ok = answerQuestion(r.agent, r.session, body.questionId, {
      ...(Array.isArray(body.answers) ? { answers: (body.answers as unknown[]).filter((a): a is string => typeof a === 'string') } : {}),
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
    });
    if (!ok) return c.json({ error: 'no open question with that id on this session' }, 404);
    await publish(r.agent, r.session, { event: 'question_answered', data: { questionId: body.questionId, answered: true } });
    return c.json({ ok: true });
  });
}
