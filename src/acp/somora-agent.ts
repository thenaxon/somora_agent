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

/** A non-waiting question as reply text: each question with its
 *  options, for the person to answer with the next prompt. */
export function asyncQuestionText(q: { question?: unknown; options?: unknown; parts?: unknown }): string {
  type Part = { question: string; options: Array<{ label: string }> };
  const parts: Part[] = Array.isArray(q.parts) && q.parts.length > 0
    ? (q.parts as Part[])
    : [{ question: typeof q.question === 'string' ? q.question : '', options: Array.isArray(q.options) ? (q.options as Array<{ label: string }>) : [] }];
  const blocks = parts
    .filter((p) => p && typeof p.question === 'string' && p.question)
    .map((p) => [`❓ ${p.question}`, ...(p.options ?? []).map((o) => `- ${o.label}`)].join('\n'));
  return `\n\n${blocks.join('\n\n')}`;
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

/** One prompt of the editor, from its arrival to its end. */
interface PromptRun {
  cancelled: boolean;
  /** The somora session it goes to, once known. */
  target?: string;
  /** The turn /chat/send started — set once the server answered. */
  turnId?: string;
  /** Our turn's own frames have begun: it runs on the server. */
  mine: boolean;
  /** Ends the live stream (the turn was taken out of the queue). */
  stream: AbortController;
}

export class SomoraAcpAgent implements Agent {
  /** Running prompts by session: cancel stops them. */
  private readonly running = new Map<string, PromptRun>();
  /** New sessions are only noted until their first prompt: a client
   *  that opens a session and never writes (OpenClaw's health check, an
   *  editor opening a panel) leaves no empty somora session behind.
   *  Client id → the slug to create. */
  private readonly unborn = new Set<string>();
  /** Client id → somora session id, once created. */
  private readonly born = new Map<string, string>();

  /** The somora session behind a client's session id, created now when it
   *  was only noted so far. */
  private async materialize(sessionId: string): Promise<string> {
    const known = this.born.get(sessionId);
    if (known) return known;
    if (!this.unborn.has(sessionId)) return sessionId;
    const res = await this.opts.fetch(this.url(`${this.agentPath()}/sessions`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: sessionId }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!((res.ok || res.status === 409) && body.id)) throw new Error(body.error ?? `could not create a session (HTTP ${res.status})`);
    this.unborn.delete(sessionId);
    this.born.set(sessionId, body.id);
    return body.id;
  }

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
    // Noted, not created: the session appears in somora with the first
    // prompt (materialize). The slug carries a random tail so two
    // sessions opened in the same second stay apart.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const slug = `acp-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    this.unborn.add(slug);
    return { sessionId: slug };
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
    // A session that never got a prompt has no history to replay.
    if (this.unborn.has(params.sessionId)) return {};
    const row = await this.requireSession(this.born.get(params.sessionId) ?? params.sessionId);
    const { events } = await this.json<{ events: NormalizedEvent[] }>(
      `/chat/history?agent=${encodeURIComponent(this.opts.agent)}&session=${encodeURIComponent(row.id)}`,
    );
    for (const update of historyToAcp(events)) {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update });
    }
    return {};
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!this.unborn.has(params.sessionId)) await this.requireSession(this.born.get(params.sessionId) ?? params.sessionId);
    return {};
  }

  async closeSession(): Promise<Record<string, never>> {
    // somora sessions outlive the editor; nothing to close here.
    return {};
  }

  /** Stop this prompt and nothing else. Before /chat/send answered,
   *  the flag alone does it (prompt() checks it before sending and right
   *  after). A turn still waiting behind another client's turn is taken
   *  out of the queue; only a turn of ours that runs is stopped. */
  async cancel(params: CancelNotification): Promise<void> {
    const run = this.running.get(params.sessionId);
    if (!run) return;
    run.cancelled = true;
    if (run.turnId) await this.stopTurn(params.sessionId, run);
  }

  private async stopTurn(sessionId: string, run: PromptRun): Promise<void> {
    const turnId = run.turnId!;
    if (!run.mine) {
      const res = await this.opts.fetch(this.url(`/chat/queue/${encodeURIComponent(turnId)}`), { method: 'DELETE' }).catch(() => null);
      if (res?.ok) {
        run.stream.abort();
        return;
      }
    }
    // Running (or about to: the lock went to it a moment ago and its
    // stop is not registered yet — try again briefly). `turnId` makes
    // sure another client's turn is never the one stopped.
    const target = run.target ?? sessionId;
    for (let i = 0; i < 10 && this.running.get(sessionId) === run; i++) {
      const res = await this.opts
        .fetch(this.url(`/chat/abort?agent=${encodeURIComponent(this.opts.agent)}&session=${encodeURIComponent(target)}&turnId=${encodeURIComponent(turnId)}`), { method: 'POST' })
        .catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => ({}))) as { aborted?: boolean }) : {};
      if (body.aborted !== false) return;
      await new Promise((r) => setTimeout(r, 200));
    }
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
    // Registered at once: a cancel during the uploads or the session's
    // creation counts too.
    const run: PromptRun = { cancelled: false, mine: false, stream: new AbortController() };
    this.running.set(sessionId, run);
    try {
      return await this.runPrompt(params, run);
    } finally {
      run.stream.abort();
      this.running.delete(sessionId);
    }
  }

  private async runPrompt(params: PromptRequest, run: PromptRun): Promise<PromptResponse> {
    const { sessionId } = params;
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
    if (run.cancelled) return { stopReason: 'cancelled' };

    const send = (update: SessionUpdate) => this.conn.sessionUpdate({ sessionId, update });
    try {
      // The somora session behind the client's id (created now if new).
      const target = await this.materialize(sessionId);
      run.target = target;
      // Stream first, then send: the turn's first frames must not pass
      // before we listen.
      const res = await this.opts.fetch(
        this.url(`/chat/stream?agent=${encodeURIComponent(this.opts.agent)}&session=${encodeURIComponent(target)}`),
        { headers: { Accept: 'text/event-stream' }, signal: run.stream.signal },
      );
      if (!res.ok || !res.body) throw new Error(`chat stream: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      const frames = sseFrames(res.body);
      const first = await frames.next();
      if (first.done) throw new Error('chat stream closed before it connected');
      if (run.cancelled) return { stopReason: 'cancelled' };

      const { turnId } = await this.json<{ turnId: string }>('/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: this.opts.agent, session: target, text, ...(attachments.length ? { attachments } : {}) }),
      });
      run.turnId = turnId;
      // Cancelled while the server took the message: stop it now.
      if (run.cancelled) void this.stopTurn(sessionId, run);

      const tr = new SseToAcp(`${turnId.slice(0, 8)}-`);
      let end: SseFrame | null = null;
      for await (const f of frames) {
        if (!run.mine) {
          // Frames of a turn before ours (another client's, a queued
          // one) are not this prompt's.
          if (f.event === 'user_message' && f.data.turnId === turnId) run.mine = true;
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
          // A question that does not wait has no dialog: it goes into the
          // reply as text (Codex's own is there already), and the editor
          // answers with the next prompt.
          if (f.data.async !== true) await this.ask(sessionId, target, f.data, tr);
          else if (f.data.source !== 'codex') await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: asyncQuestionText(f.data) } });
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
    }
  }

  /** A question of the agent (a builder's ask_user, an approval) → the
   *  editor's permission dialog; the choice goes back as the answer. No
   *  choice (the editor cancelled) leaves it open for other windows, and
   *  the server's timeout takes the safest option. */
  private async ask(sessionId: string, target: string, q: Record<string, unknown>, tr: SseToAcp): Promise<void> {
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
    await this.json(`${this.agentPath()}/sessions/${encodeURIComponent(target)}/questions/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [r.outcome.optionId] }),
    }).catch((err: Error) => this.opts.log?.(`answer failed: ${err.message}`));
  }
}
