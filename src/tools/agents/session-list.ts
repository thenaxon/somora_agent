// session_list — which chat sessions exist, and is anything running?
//
// Agents had no way to see somora's chat sessions — their own or a
// colleague's. Asked on a call "which sessions do you have open?", one
// answered with its tmux sessions, then fell back to raw curl against
// the internal API (report 2026-09-16). It is also what makes
// agent_ask({session}) and sentinel dispatch usable: you can only name
// a session you can find.
//
// Read-only on purpose. Archiving or opening sessions for someone else
// is a different decision (who confirms it, who sees it) and not part
// of this tool.
//
// Goes through HTTP because "is a turn running" lives in the main
// server process; claude-cli/codex-cli run tools in an MCP child that
// cannot see it.

import { z } from 'zod';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ToolDefinition } from '../types.ts';

const Input = z
  .object({
    agent: z.string().min(1).optional().describe('Whose sessions. Default: your own. "*" = every agent.'),
    include_archived: z.boolean().optional().describe('Include archived sessions. Default false.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max rows, most recently active first. Default 30.'),
  })
  .strict();

interface SessionRow {
  agent: string;
  session: string;
  id: string;
  is_main: boolean;
  is_current?: true;
  archived?: true;
  last_activity: string | null;
  messages: number;
  running: boolean;
  queued: number;
  project?: string;
  engine?: string;
}

interface SessionListResult {
  count: number;
  total: number;
  sessions: SessionRow[];
  hint?: string;
}

export const sessionList: ToolDefinition<z.infer<typeof Input>, SessionListResult> = {
  name: 'session_list',
  toolset: 'agents',
  description:
    'List somora CHAT sessions — yours by default, another agent\'s with `agent`, everyone\'s with ' +
    'agent:"*". "Session" here is a somora conversation (what the web Sessions window shows), not a ' +
    'tmux session. Each row: session name (use it as `session` in agent_ask or sentinel dispatch), ' +
    'last activity, message count, the pinned project, and whether a turn is running there right now ' +
    '(`running`) with how many wait behind it (`queued`). Your current session is marked ' +
    '`is_current`. Read-only. Use it for "which sessions do you have?", "is anything still running ' +
    'at <agent>?", and before addressing a session by name.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Whose sessions. Default: your own. "*" = every agent.' },
      include_archived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max rows, most recently active first. Default 30.' },
    },
    additionalProperties: false,
  },
  defaultTimeoutMs: 15_000,
  async handler(input, ctx): Promise<SessionListResult> {
    const host = process.env.SOMORA_HOST || '127.0.0.1';
    const port = process.env.SOMORA_PORT || '18737';
    const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
    const url = `${scheme}://${host}:${port}/sessions${input.include_archived ? '?include_archived=true' : ''}`;
    let res;
    try {
      res = await loopbackFetch(url, { method: 'GET' });
    } catch (err) {
      const c = classifyFetchError(err);
      throw new Error(`session_list [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}`);
    }
    if (!res.ok) throw new Error(`session_list: server returned HTTP ${res.status}`);
    const body = (await res.json()) as { sessions?: Array<Record<string, unknown>> };
    return shapeSessionList(body.sessions ?? [], { ...input, self: ctx.agent, currentSession: ctx.session });
  },
};

/** Filter, order and trim the server rows. Exported for tests. */
export function shapeSessionList(
  rows: Array<Record<string, unknown>>,
  opts: { agent?: string; limit?: number; self: string; currentSession?: string },
): SessionListResult {
  const who = opts.agent ?? opts.self;
  const mine = rows.filter((r) => who === '*' || r.agent === who);
  const known = new Set(rows.map((r) => String(r.agent)));
  if (who !== '*' && mine.length === 0 && !known.has(who)) {
    return {
      count: 0,
      total: 0,
      sessions: [],
      hint: `No sessions found for '${who}'. Agents with sessions: ${[...known].sort().join(', ') || '(none)'}.`,
    };
  }
  const ts = (r: Record<string, unknown>): number => (typeof r.lastActivity === 'string' ? Date.parse(r.lastActivity) || 0 : 0);
  // Running first — that is usually the question — then most recent.
  mine.sort((a, b) => Number(Boolean(b.busy)) - Number(Boolean(a.busy)) || ts(b) - ts(a));
  const limit = opts.limit ?? 30;
  const sessions = mine.slice(0, limit).map((r): SessionRow => {
    const id = String(r.sessionId);
    const slug = typeof r.slug === 'string' && r.slug.length > 0 ? r.slug : id;
    return {
      agent: String(r.agent),
      session: slug,
      id,
      is_main: r.isMain === true,
      ...(r.agent === opts.self && opts.currentSession !== undefined && id === opts.currentSession ? { is_current: true as const } : {}),
      ...(r.isArchived === true ? { archived: true as const } : {}),
      last_activity: typeof r.lastActivity === 'string' ? r.lastActivity : null,
      messages: typeof r.messageCount === 'number' ? r.messageCount : 0,
      running: r.busy === true,
      queued: typeof r.queueLength === 'number' ? r.queueLength : 0,
      ...(typeof r.projectSlug === 'string' ? { project: r.projectSlug } : {}),
      ...(typeof r.engine === 'string' ? { engine: r.engine } : {}),
    };
  });
  return {
    count: sessions.length,
    total: mine.length,
    sessions,
    ...(mine.length > sessions.length ? { hint: `${mine.length - sessions.length} more not shown — raise limit.` } : {}),
  };
}
