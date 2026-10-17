// A2A client (docs/a2a.md): reads an agent's card, sends it a task and
// follows the task to its end — over the stream when the card offers
// one, by asking for the task's state otherwise. Plain fetch and JSON;
// the peers we meet (OpenClaw, Hermes, the official SDKs) all speak the
// JSON-RPC binding.

import { randomUUID } from 'node:crypto';
import {
  type A2AMessage,
  type A2APart,
  type A2ATask,
  type AgentCard,
  ERR_METHOD_NOT_FOUND,
  type JsonRpcError,
  METHODS,
  type ProtocolVersion,
  PAUSED_STATES,
  TERMINAL_STATES,
  type TaskState,
  cardEndpoint,
  normalizeState,
  partsText,
  statusText,
  taskAnswer,
} from './protocol.ts';
import { filePartAs03 } from './files.ts';

export class A2AError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'auth' | 'rpc' | 'protocol' | 'aborted',
    readonly rpc?: JsonRpcError,
  ) {
    super(message);
  }
}

export interface ResolvedCard {
  card: AgentCard;
  endpoint: string;
  version: ProtocolVersion;
  streaming: boolean;
  fetchedAt: number;
}

const cards = new Map<string, ResolvedCard>();

/** Forget cached cards (tests, config changes). */
export function clearCardCache(): void {
  cards.clear();
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The card of the agent at `baseUrl`, cached for `maxAgeMs`. */
export async function getCard(baseUrl: string, opts: { token?: string; maxAgeMs: number; signal?: AbortSignal }): Promise<ResolvedCard> {
  const key = baseUrl.replace(/\/+$/, '');
  const hit = cards.get(key);
  if (hit && Date.now() - hit.fetchedAt < opts.maxAgeMs) return hit;
  const url = `${key}/.well-known/agent-card.json`;
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', ...authHeaders(opts.token) }, signal: withTimeout(opts.signal, 15_000) });
  } catch (err) {
    if (opts.signal?.aborted) throw new A2AError('stopped', 'aborted');
    throw new A2AError(`agent card at ${url} not reachable: ${errText(err)}`, 'unreachable');
  }
  if (!res.ok) throw new A2AError(`agent card at ${url}: HTTP ${res.status}`, res.status === 401 || res.status === 403 ? 'auth' : 'unreachable');
  let card: AgentCard;
  try {
    card = (await res.json()) as AgentCard;
  } catch {
    throw new A2AError(`agent card at ${url} is not JSON`, 'protocol');
  }
  const ep = cardEndpoint(card);
  if (!ep) throw new A2AError(`agent card at ${url} names no JSON-RPC endpoint`, 'protocol');
  const resolved: ResolvedCard = { card, endpoint: ep.url, version: ep.version, streaming: card.capabilities?.streaming === true, fetchedAt: Date.now() };
  cards.set(key, resolved);
  return resolved;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function errText(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string; code?: string } };
  const cause = e.cause?.code ?? e.cause?.message;
  return cause ? `${e.message ?? String(err)} (${cause})` : (e.message ?? String(err));
}

let rpcSeq = 0;

/** One JSON-RPC call. */
export async function rpc<T>(endpoint: string, method: string, params: unknown, opts: { token?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(opts.token) },
      body: JSON.stringify({ jsonrpc: '2.0', id: `somora-${++rpcSeq}`, method, params }),
      signal: withTimeout(opts.signal, opts.timeoutMs ?? 60_000),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new A2AError('stopped', 'aborted');
    throw new A2AError(`${method} to ${endpoint} failed: ${errText(err)}`, 'unreachable');
  }
  if (res.status === 401 || res.status === 403) throw new A2AError(`the other side refused somora's token (HTTP ${res.status})`, 'auth');
  let body: { result?: T; error?: JsonRpcError };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new A2AError(`${method}: HTTP ${res.status}, answer is not JSON`, 'protocol');
  }
  if (body.error) throw new A2AError(`${method}: ${body.error.message} (${body.error.code})`, 'rpc', body.error);
  if (!res.ok) throw new A2AError(`${method}: HTTP ${res.status}`, 'protocol');
  return body.result as T;
}

/** A message in the version the peer speaks. */
export function buildMessage(version: ProtocolVersion, text: string, ids: { messageId: string; contextId?: string; taskId?: string }, extraParts: A2APart[] = []): A2AMessage & Record<string, unknown> {
  if (version === '0.3') {
    return { kind: 'message', messageId: ids.messageId, role: 'user', parts: [{ kind: 'text', text }, ...extraParts], ...(ids.contextId ? { contextId: ids.contextId } : {}), ...(ids.taskId ? { taskId: ids.taskId } : {}) };
  }
  return { messageId: ids.messageId, role: 'ROLE_USER', parts: [{ text }, ...extraParts], ...(ids.contextId ? { contextId: ids.contextId } : {}), ...(ids.taskId ? { taskId: ids.taskId } : {}) };
}

/** The task inside a SendMessage / GetTask result (v1.0 wraps it in
 *  `task`, 0.3 returns it bare; a bare message is an immediate reply). */
function unwrap(result: unknown): { task?: A2ATask; message?: A2AMessage } {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r.task && typeof r.task === 'object') return { task: r.task as A2ATask };
  if (r.message && typeof r.message === 'object') return { message: r.message as A2AMessage };
  if (r.kind === 'message' || (Array.isArray(r.parts) && !r.status)) return { message: r as A2AMessage };
  if (r.status || r.id) return { task: r as A2ATask };
  return {};
}

export interface TaskOutcome {
  state: TaskState;
  /** The answer (completed), the question (input_required) or the reason. */
  text: string;
  taskId?: string;
  contextId?: string;
  /** For a stopped task: whether the other side confirmed the cancel. */
  cancelConfirmed?: boolean;
}

export interface RunTaskInput {
  card: ResolvedCard;
  token?: string;
  text: string;
  /** File parts to send along (built for the card's version). */
  parts?: A2APart[];
  contextId?: string;
  signal?: AbortSignal;
  /** Give up after this long (the task may go on over there). */
  maxMs: number;
  pollMaxMs: number;
  /** Streamed answer text so far (the whole text, not a piece). */
  onText?: (text: string) => void;
  /** State changes and status messages, for the log and the chat. */
  onStatus?: (state: TaskState, message: string, taskId?: string) => void;
}

/** Send a task and follow it to its end. Never throws for a task that
 *  failed over there — that is an outcome; throws A2AError when the peer
 *  cannot be reached or refuses the request itself. */
export async function runTask(input: RunTaskInput): Promise<TaskOutcome> {
  const { card, token } = input;
  const messageId = `somora-${randomUUID()}`;
  const deadline = Date.now() + input.maxMs;
  let version = card.version;
  const methods = () => METHODS[version];
  const message = () => buildMessage(version, input.text, { messageId, ...(input.contextId ? { contextId: input.contextId } : {}) }, input.parts ?? []);
  let taskId: string | undefined;
  let contextId = input.contextId;
  let lastState: TaskState | undefined;
  const note = (state: TaskState, msg: string) => {
    if (state === lastState && !msg) return;
    lastState = state;
    input.onStatus?.(state, msg, taskId);
  };
  const finishFrom = (task: A2ATask): TaskOutcome | null => {
    taskId = task.id ?? taskId;
    contextId = task.contextId ?? contextId;
    const state = normalizeState(task.status?.state);
    if (TERMINAL_STATES.has(state)) {
      const text = state === 'completed' ? taskAnswer(task) : statusText(task) || taskAnswer(task);
      return { state, text, ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) };
    }
    if (PAUSED_STATES.has(state)) return { state, text: statusText(task) || taskAnswer(task), ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) };
    note(state, statusText(task));
    return null;
  };
  const cancel = async (): Promise<boolean> => {
    if (!taskId) return false;
    try {
      await rpc(card.endpoint, methods().cancel, { id: taskId }, { token, timeoutMs: 10_000 });
      return true;
    } catch {
      return false;
    }
  };
  const stopped = async (why: 'aborted' | 'timeout'): Promise<TaskOutcome> => {
    const confirmed = await cancel();
    return {
      state: 'canceled',
      text: why === 'timeout' ? `gave up after ${Math.round(input.maxMs / 60_000)} min` : 'stopped',
      cancelConfirmed: confirmed,
      ...(taskId ? { taskId } : {}),
      ...(contextId ? { contextId } : {}),
    };
  };

  // 1. Hand the task over: stream when offered, else return at once.
  if (card.streaming) {
    try {
      const streamed = await streamTask(input, card, token, methods().stream, { message: message() }, deadline, (t) => {
        taskId = t ?? taskId;
      });
      if (streamed.outcome) return streamed.outcome;
      taskId = streamed.taskId ?? taskId;
      contextId = streamed.contextId ?? contextId;
      if (!taskId) throw new A2AError('the stream ended without a task id', 'protocol');
    } catch (err) {
      if (err instanceof A2AError && err.kind === 'aborted') return stopped('aborted');
      if (err instanceof A2AError && err.kind === 'rpc' && err.rpc?.code === ERR_METHOD_NOT_FOUND && version === '1.0') {
        return runTask(as03(input));
      }
      throw err;
    }
  } else {
    let result: unknown;
    try {
      result = await rpc(card.endpoint, methods().send, { message: message(), configuration: { returnImmediately: true, blocking: false } }, { token, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (err) {
      if (err instanceof A2AError && err.kind === 'aborted') return stopped('aborted');
      if (err instanceof A2AError && err.kind === 'rpc' && err.rpc?.code === ERR_METHOD_NOT_FOUND && version === '1.0') {
        return runTask(as03(input));
      }
      throw err;
    }
    const got = unwrap(result);
    if (got.message) return { state: 'completed', text: partsText(got.message.parts), ...(got.message.contextId ? { contextId: got.message.contextId } : {}) };
    if (!got.task) throw new A2AError('the answer to the task is neither a task nor a message', 'protocol');
    const done = finishFrom(got.task);
    if (done) return done;
  }

  // 2. Follow the task by asking for its state.
  let wait = Math.min(2_000, input.pollMaxMs);
  for (;;) {
    if (input.signal?.aborted) return stopped('aborted');
    if (Date.now() > deadline) return stopped('timeout');
    await sleep(Math.min(wait, Math.max(0, deadline - Date.now())), input.signal);
    wait = Math.min(Math.round(wait * 1.5), input.pollMaxMs);
    if (input.signal?.aborted) return stopped('aborted');
    let result: unknown;
    try {
      result = await rpc(card.endpoint, methods().get, { id: taskId }, { token, timeoutMs: 30_000, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (err) {
      if (err instanceof A2AError && err.kind === 'aborted') return stopped('aborted');
      if (err instanceof A2AError && (err.kind === 'unreachable' || err.kind === 'protocol')) {
        // A blip on the way: try again at the next tick.
        note(lastState ?? 'working', `status check failed: ${err.message}`);
        continue;
      }
      throw err;
    }
    const got = unwrap(result);
    if (got.task) {
      const done = finishFrom(got.task);
      if (done) return done;
    }
  }
}

/** The same task for a peer that turned out to speak 0.3: its file
 *  parts rebuilt in the 0.3 shape. */
function as03(input: RunTaskInput): RunTaskInput {
  return { ...input, card: { ...input.card, version: '0.3' }, ...(input.parts ? { parts: input.parts.map(filePartAs03) } : {}) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** SendStreamingMessage: reads the SSE answer. Returns the outcome when
 *  the stream reached one, else the task id to follow by polling (a
 *  stream may close early). */
async function streamTask(
  input: RunTaskInput,
  card: ResolvedCard,
  token: string | undefined,
  method: string,
  params: unknown,
  deadline: number,
  onTaskId: (id: string | undefined) => void,
): Promise<{ outcome?: TaskOutcome; taskId?: string; contextId?: string }> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  input.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
  let taskId: string | undefined;
  let contextId = input.contextId;
  let text = '';
  const artifacts = new Map<string, string>();
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    try {
      res = await fetch(card.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(token) },
        body: JSON.stringify({ jsonrpc: '2.0', id: `somora-${++rpcSeq}`, method, params }),
        signal: ctl.signal,
      });
    } catch (err) {
      if (input.signal?.aborted) throw new A2AError('stopped', 'aborted');
      throw new A2AError(`${method} to ${card.endpoint} failed: ${errText(err)}`, 'unreachable');
    }
    if (res.status === 401 || res.status === 403) throw new A2AError(`the other side refused somora's token (HTTP ${res.status})`, 'auth');
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream')) {
      // Some peers answer a stream request with one JSON-RPC response.
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: JsonRpcError } | null;
      if (body?.error) throw new A2AError(`${method}: ${body.error.message} (${body.error.code})`, 'rpc', body.error);
      const got = unwrap(body?.result);
      if (got.message) return { outcome: { state: 'completed', text: partsText(got.message.parts) } };
      if (got.task) return handleTask(got.task);
      throw new A2AError(`${method}: HTTP ${res.status}, no event stream`, 'protocol');
    }
    if (!res.body) throw new A2AError(`${method}: empty stream`, 'protocol');
    const decoder = new TextDecoder();
    let buf = '';
    const reader = res.body.getReader();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (input.signal?.aborted) throw new A2AError('stopped', 'aborted');
        break; // closed early or timed out: follow by polling
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let cut: number;
      while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        let frame: { result?: Record<string, unknown>; error?: JsonRpcError };
        try {
          frame = JSON.parse(data) as typeof frame;
        } catch {
          continue;
        }
        if (frame.error) throw new A2AError(`${method}: ${frame.error.message} (${frame.error.code})`, 'rpc', frame.error);
        const r = frame.result ?? {};
        const out = handleFrame(r);
        if (out) return { outcome: out };
      }
    }
    return { ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', stop);
    ctl.abort();
  }

  function handleTask(task: A2ATask): { outcome?: TaskOutcome; taskId?: string; contextId?: string } {
    taskId = task.id ?? taskId;
    onTaskId(taskId);
    contextId = task.contextId ?? contextId;
    const state = normalizeState(task.status?.state);
    if (TERMINAL_STATES.has(state) || PAUSED_STATES.has(state)) {
      const answer = state === 'completed' ? taskAnswer(task) || text : statusText(task) || taskAnswer(task);
      return { outcome: { state, text: answer, ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) } };
    }
    input.onStatus?.(state, statusText(task), taskId);
    return { ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) };
  }

  function handleFrame(r: Record<string, unknown>): TaskOutcome | null {
    // v1.0 wraps each event in a member; 0.3 tags it with `kind`.
    const task = (r.task ?? (r.kind === 'task' ? r : undefined)) as A2ATask | undefined;
    const status = (r.statusUpdate ?? (r.kind === 'status-update' ? r : undefined)) as { taskId?: string; contextId?: string; status?: A2ATask['status'] } | undefined;
    const artifact = (r.artifactUpdate ?? (r.kind === 'artifact-update' ? r : undefined)) as
      | { taskId?: string; artifact?: { artifactId?: string; parts?: A2APart[] }; append?: boolean }
      | undefined;
    const msg = (r.message ?? (r.kind === 'message' ? r : undefined)) as A2AMessage | undefined;
    if (task) {
      const out = handleTask(task);
      return out.outcome ?? null;
    }
    if (artifact?.artifact) {
      taskId = artifact.taskId ?? taskId;
      onTaskId(taskId);
      const id = artifact.artifact.artifactId ?? '_';
      const piece = partsText(artifact.artifact.parts);
      artifacts.set(id, artifact.append ? (artifacts.get(id) ?? '') + piece : piece);
      text = [...artifacts.values()].filter((t) => t.trim()).join('\n\n');
      input.onText?.(text);
      return null;
    }
    if (status?.status) {
      taskId = status.taskId ?? taskId;
      onTaskId(taskId);
      contextId = status.contextId ?? contextId;
      const state = normalizeState(status.status.state);
      const said = partsText(status.status.message?.parts);
      if (TERMINAL_STATES.has(state) || PAUSED_STATES.has(state)) {
        const answer = (state === 'completed' ? text || said : said || text).trim();
        return { state, text: answer, ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) };
      }
      input.onStatus?.(state, said, taskId);
      return null;
    }
    if (msg) return { state: 'completed', text: partsText(msg.parts), ...(taskId ? { taskId } : {}), ...(msg.contextId ? { contextId: msg.contextId } : {}) };
    return null;
  }
}
