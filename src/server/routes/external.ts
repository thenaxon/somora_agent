// External agents (docs/external-agents.md): their entries for the agent
// list, the status of each system, the badge image, and the answer route
// for questions — the general "open question" a turn may ask the person
// (an external agent's permission request; the builder keeps its own
// route until it moves over).

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { IMAGE_TYPES, badgeIsImage, externalBadge } from '../../external/badge.ts';
import { connectionSnapshot, knownInfo } from '../../external/connection.ts';
import { externalNameClashes, getExternalAgent, listExternalAgents, type ExternalAgent } from '../../external/registry.ts';
import { resolveSessionId } from '../../storage/sessions.ts';
import { answerWithoutWaiting, openAsyncQuestion, sendAsPerson } from '../async-questions.ts';
import { answerQuestion, pendingQuestion } from '../builder-questions.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';

export { badgeIsImage, externalBadge };

const BADGE_MAX_BYTES = 256 * 1024;

function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** The entries the agent list gets for external agents. */
export function externalAgentEntries(): Array<Record<string, unknown>> {
  return listExternalAgents(config).map((ext) => {
    const b = externalBadge(ext);
    return {
      name: ext.name,
      description: ext.agent.description ?? `${b.label} agent on ${ext.system}`,
      icon: ext.agent.icon ?? b.badge,
      role: 'external',
      steering: false,
      kind: 'external',
      external: { system: ext.system, label: b.label, badge: b.badge, badgeImage: b.badgeImage, version: b.version, a2a: Boolean(ext.agent.a2a) },
    };
  });
}

export interface ExternalRoutesDeps {
  publish: typeof Server.publish;
}

export function registerExternalRoutes(app: Hono, routeDeps: ExternalRoutesDeps): void {
  const { publish } = routeDeps;
  // GET /external — systems, their agents, what each said about itself,
  // open connections, and names ignored because a somora agent has them.
  app.get('/external', (c) => {
    const open = connectionSnapshot();
    const systems = Object.entries(config.external.systems).map(([name, sys]) => ({
      name,
      protocol: sys.protocol,
      transport: sys.transport,
      agents: Object.keys(sys.agents).map((agent) => {
        const ext = getExternalAgent(agent);
        const info = knownInfo(agent);
        return {
          name: agent,
          ...(ext ? { badge: externalBadge(ext) } : {}),
          agentInfo: info?.agentInfo ?? null,
          profile: info?.profile.name ?? sys.profile ?? null,
          capabilities: info?.capabilities ?? null,
          connections: open.filter((o) => o.agent === agent).map((o) => ({ sessionId: o.sessionId, where: o.where, idleMs: o.idleMs })),
        };
      }),
    }));
    return c.json({ idleMinutes: config.external.idleMinutes, questionTimeoutMinutes: config.external.questionTimeoutMinutes, systems, ignored: externalNameClashes(config) });
  });

  // GET /external/:system/badge — the badge image set in config.yaml.
  app.get('/external/:system/badge', async (c) => {
    const sys = config.external.systems[c.req.param('system')];
    const file = sys?.badge;
    if (!file || !badgeIsImage(file)) return c.json({ error: 'no badge image for this system' }, 404);
    const path = expandHome(file);
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size > BADGE_MAX_BYTES) return c.json({ error: 'badge must be a file up to 256 KB' }, 422);
      const type = IMAGE_TYPES[extname(path).toLowerCase()]!;
      return new Response(new Uint8Array(await readFile(path)), {
        headers: {
          'Content-Type': type,
          'X-Content-Type-Options': 'nosniff',
          // An SVG served as an image does not run scripts, but keep it inert if opened directly.
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'Cache-Control': 'private, max-age=300',
        },
      });
    } catch {
      return c.json({ error: 'badge file not found' }, 404);
    }
  });

  // The open question of a session, for a window opened while it waits.
  app.get('/agents/:agent/sessions/:session/question', async (c) => {
    const agent = c.req.param('agent');
    const session = await resolveSessionId(agent, c.req.param('session'));
    if (!session) return c.json({ error: 'session not found' }, 404);
    const q = pendingQuestion(agent, session) ?? (await openAsyncQuestion(agent, session));
    return c.json({ question: q });
  });

  // Answer the open question of a session (any agent kind). A waiting
  // question resolves its tool call; one that does not wait is sent as
  // the person's next message (async-questions.ts).
  app.post('/agents/:agent/sessions/:session/questions/:id/answer', async (c) => {
    const agent = c.req.param('agent');
    const session = await resolveSessionId(agent, c.req.param('session'));
    if (!session) return c.json({ error: 'session not found' }, 404);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as { answers?: unknown; text?: unknown; parts?: unknown } | null;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter((a): a is string => typeof a === 'string') : []);
    const answers = strings(body?.answers);
    const text = typeof body?.text === 'string' ? body.text : undefined;
    if (answerQuestion(agent, session, id, { answers, ...(text !== undefined ? { text } : {}) })) {
      logger.info({ msg: 'question.answered', agent, session, questionId: id, answers });
      await publish(agent, session, { event: 'question_answered', data: { questionId: id, answered: true, choice: answers[0] ?? null } });
      return c.json({ ok: true });
    }
    // A question that does not wait: the answer becomes the person's
    // next message, sent the way a typed one is.
    const parts = Array.isArray(body?.parts)
      ? (body!.parts as unknown[]).map((p) => {
          const x = (p && typeof p === 'object' ? p : {}) as { answers?: unknown; text?: unknown };
          return { answers: strings(x.answers), ...(typeof x.text === 'string' ? { text: x.text } : {}) };
        })
      : undefined;
    const r = await answerWithoutWaiting(agent, session, id, { answers, ...(text !== undefined ? { text } : {}), ...(parts ? { parts } : {}) });
    if ('error' in r) {
      return r.error === 'empty'
        ? c.json({ error: 'empty answer — choose an option or type a text' }, 400)
        : c.json({ error: 'no open question with that id on this session' }, 404);
    }
    await publish(agent, session, { event: 'question_answered', data: { questionId: id, answered: true, choice: r.choice } });
    const turnId = sendAsPerson(agent, session, r.text);
    return c.json({ ok: true, sent: true, turnId, text: r.text });
  });
}
