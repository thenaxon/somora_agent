// `somora acp` (docs/acp.md): somora as an ACP agent. An editor (Zed,
// JetBrains) or another agent system starts `somora acp` and talks ACP
// over stdio; this side is a thin client of the running somora server,
// like the TUI and the phone: POST /chat/send, the live chat stream,
// /chat/history, /chat/abort. The agent's tools, memory, locks and dream
// switch stay what they are — the editor is one more window on the same
// session.
//
// One process speaks for one agent (`--agent`). ACP session ids are
// somora session ids.

import type {
  Agent,
  AgentSideConnection,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOptionKind,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import { SseToAcp, historyToAcp, type SseFrame } from './translate.ts';
import type { NormalizedEvent } from '../types/events.ts';

/** The HTTP the agent needs — `loopbackFetch` in the CLI (adds the key),
 *  plain fetch against a test server. */
export type HttpFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}>;

export interface SomoraAcpOptions {
  base: string;
  agent: string;
  /** `--session`: session/new opens this session instead of a new one. */
  session?: string;
  version: string;
  fetch: HttpFetch;
  /** Diagnostics (stderr in the CLI — stdout is the protocol). */
  log?: (line: string) => void;
}

interface SessionRow {
  id: string;
  slug: string;
  lastActivity: string | null;
}

/** A question's option → the ACP option kind (the server sends the kind
 *  as description for permission requests; a builder's ask_user option
 *  is a plain choice). */
function optionKind(description: string | undefined, label: string): PermissionOptionKind {
  const k = description ?? '';
  if (k === 'allow_once' || k === 'allow_always' || k === 'reject_once' || k === 'reject_always') return k;
  return /^(no|reject|deny|cancel)\b/i.test(label) ? 'reject_once' : 'allow_once';
}

/** Read the live chat stream frame by frame. */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as unknown;
          if (parsed && typeof parsed === 'object') yield { event, data: parsed as Record<string, unknown> };
        } catch {
          /* a frame that is not JSON is not for us */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class SomoraAcpAgent implements Agent {
  /** Running prompts by session: cancel aborts them. */
  private readonly running = new Map<string, { cancelled: boolean }>();

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly opts: SomoraAcpOptions,
  ) {}

  private url(path: string): string {
    return `${this.opts.base}${path}`;
  }

  private async json<T>(path: string, init?: Parameters<HttpFetch>[1]): Promise<T> {
    const res = await this.opts.fetch(this.url(path), init);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let message = body;
      try {
        message = (JSON.parse(body) as { error?: string }).error ?? body;
      } catch {
        /* not JSON */
      }
      throw new Error(message || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private agentPath(): string {
    return `/agents/${encodeURIComponent(this.opts.agent)}`;
  }

  private async sessions(): Promise<SessionRow[]> {
    return this.json<SessionRow[]>(`${this.agentPath()}/sessions`);
  }

  private async requireSession(sessionId: string): Promise<SessionRow> {
    const row = (await this.sessions()).find((s) => s.id === sessionId || s.slug === sessionId);
    if (!row) throw RequestError.resourceNotFound(sessionId);
    return row;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    // Fail early and clearly when the server or the agent is not there:
    // the editor shows this message instead of a dead connection.
    const agents = await this.json<Array<{ name: string; kind?: string }>>('/agents').catch((err: Error) => {
      throw RequestError.internalError(undefined, `somora server not reachable at ${this.opts.base}: ${err.message}`);
    });
    const me = agents.find((a) => a.name === this.opts.agent);
    if (!me) throw RequestError.invalidParams(undefined, `no agent '${this.opts.agent}' on this somora (${agents.map((a) => a.name).join(', ')})`);
    if (me.kind === 'external') throw RequestError.invalidParams(undefined, `'${this.opts.agent}' is an external agent — talk to its own system directly`);
    return {
      protocolVersion: 1,
      agentInfo: { name: 'somora', title: `somora · ${this.opts.agent}`, version: this.opts.version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      authMethods: [],
    };
  }

  async authenticate(): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    if (this.opts.session) {
      const row = await this.requireSession(this.opts.session);
      return { sessionId: row.id };
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const res = await this.opts.fetch(this.url(`${this.agentPath()}/sessions`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: `acp-${stamp}` }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    // 409 = the name exists (two sessions in one second): use it.
    if ((res.ok || res.status === 409) && body.id) return { sessionId: body.id };
    throw new Error(body.error ?? `could not create a session (HTTP ${res.status})`);
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const rows = await this.sessions();
    return {
      sessions: rows.map((s) => ({
        sessionId: s.id,
        cwd: params.cwd ?? process.cwd(),
        title: s.slug,
        updatedAt: s.lastActivity,
      })),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const row = await this.requireSession(params.sessionId);
    const { events } = await this.json<{ events: NormalizedEvent[] }>(
      `/chat/history?agent=${encodeURIComponent(this.opts.agent)}&session=${encodeURIComponent(row.id)}`,
    );
    for (const update of historyToAcp(events)) {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update });
    }
    return {};
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    await this.requireSession(params.sessionId);
    return {};
  }

  async closeSession(): Promise<Record<string, never>> {
    // somora sessions outlive the editor; nothing to close here.
    return {};
  }

  async cancel(params: CancelNotification): Promise<void> {
    const run = this.running.get(params.sessionId);
    if (!run) return;
    run.cancelled = true;
    await this.opts
      .fetch(this.url(`/chat/abort?agent=${encodeURIComponent(this.opts.agent)}&session=${encodeURIComponent(params.sessionId)}`), { method: 'POST' })
      .catch(() => undefined);
  }

  /** Images of the prompt → somora attachments (POST /attachments). */
  private async upload(prompt: PromptRequest['prompt']): Promise<Array<{ hash: string; name: string; mime: string; size: number }>> {
    const out: Array<{ hash: string; name: string; mime: string; size: number }> = [];
    let n = 0;
    for (const b of prompt) {
      if (b.type !== 'image') continue;
      const bytes = Buffer.from(b.data, 'base64');
      const ext = b.mimeType.split('/')[1] ?? 'bin';
      const r = await this.json<{ hash: string; name: string; mime: string; size: number }>('/attachments', {
        method: 'POST',
        headers: { 'Content-Type': b.mimeType, 'X-Somora-Filename': encodeURIComponent(`image-${++n}.${ext}`) },
        body: new Uint8Array(bytes),
      });
      out.push({ hash: r.hash, name: r.name, mime: r.mime, size: r.size });
    }
    return out;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const { sessionId } = params;
    if (this.running.has(sessionId)) throw RequestError.invalidRequest(undefined, 'a prompt is already running in this session');
    const text = params.prompt
      .map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'resource_link') return `[${b.name}](${b.uri})`;
        if (b.type === 'resource' && 'text' in b.resource) return `\n<file uri="${b.resource.uri}">\n${b.resource.text}\n</file>\n`;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    const attachments = await this.upload(params.prompt);
    if (!text && attachments.length === 0) return { stopReason: 'end_turn' };

    const run = { cancelled: false };
    this.running.set(sessionId, run);
    const abort = new AbortController();
    const send = (update: SessionUpdate) => this.conn.sessionUpdate({ sessionId, update });
    try {
      // Stream first, then send: the turn's first frames must not pass
      // before we listen.
      const res = await this.opts.fetch(
        this.url(`/chat/stream?agent=${encodeURIComponent(this.opts.agent)}&session=${encodeURIComponent(sessionId)}`),
        { headers: { Accept: 'text/event-stream' }, signal: abort.signal },
      );
      if (!res.ok || !res.body) throw new Error(`chat stream: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      const frames = sseFrames(res.body);
      const first = await frames.next();
      if (first.done) throw new Error('chat stream closed before it connected');

      const { turnId } = await this.json<{ turnId: string }>('/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: this.opts.agent, session: sessionId, text, ...(attachments.length ? { attachments } : {}) }),
      });

      const tr = new SseToAcp(`${turnId.slice(0, 8)}-`);
      let mine = false;
      let end: SseFrame | null = null;
      for await (const f of frames) {
        if (!mine) {
          // Frames of a turn before ours (another client's, a queued
          // one) are not this prompt's.
          if (f.event === 'user_message' && f.data.turnId === turnId) mine = true;
          else if (f.event === 'turn_dequeued' && (f.data.turnId === turnId || f.data.workId === turnId)) return { stopReason: 'cancelled' };
          else if (f.event === 'status' && typeof f.data.msg === 'string' && f.data.msg.startsWith('turn failed: ')) {
            throw new Error(f.data.msg.slice('turn failed: '.length));
          }
          continue;
        }
        if (f.event === 'agent' && f.data.phase === 'end') {
          end = f;
          break;
        }
        if (f.event === 'question_asked') {
          await this.ask(sessionId, f.data, tr);
          continue;
        }
        for (const u of tr.update(f)) await send(u);
      }
      for (const u of tr.finish(end)) await send(u);
      if (run.cancelled) return { stopReason: 'cancelled' };
      if (!end) throw new Error('the chat stream ended before the turn did');
      if (tr.errors.length > 0) await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n⚠ ${tr.errors.join('; ')}` } });
      return { stopReason: 'end_turn' };
    } catch (err) {
      if (run.cancelled) return { stopReason: 'cancelled' };
      this.opts.log?.(`prompt failed: ${(err as Error).message}`);
      throw RequestError.internalError(undefined, (err as Error).message);
    } finally {
      abort.abort();
      this.running.delete(sessionId);
    }
  }

  /** A question of the agent (a builder's ask_user, an approval) → the
   *  editor's permission dialog; the choice goes back as the answer. No
   *  choice (the editor cancelled) leaves it open for other windows, and
   *  the server's timeout takes the safest option. */
  private async ask(sessionId: string, q: Record<string, unknown>, tr: SseToAcp): Promise<void> {
    const id = typeof q.questionId === 'string' ? q.questionId : null;
    const options = Array.isArray(q.options) ? (q.options as Array<{ label: string; description?: string }>) : [];
    if (!id || options.length === 0) return;
    const question = typeof q.question === 'string' ? q.question : 'The agent asks';
    let r;
    try {
      r = await this.conn.requestPermission({
        sessionId,
        toolCall: tr.lastToolCall ? { toolCallId: tr.lastToolCall.id, title: question } : { toolCallId: `q-${id}`, title: question, status: 'pending' },
        options: options.map((o) => ({ optionId: o.label, name: o.label, kind: optionKind(o.description, o.label) })),
      });
    } catch (err) {
      this.opts.log?.(`permission request failed: ${(err as Error).message}`);
      return;
    }
    if (r.outcome.outcome !== 'selected') return;
    await this.json(`${this.agentPath()}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [r.outcome.optionId] }),
    }).catch((err: Error) => this.opts.log?.(`answer failed: ${err.message}`));
  }
}
