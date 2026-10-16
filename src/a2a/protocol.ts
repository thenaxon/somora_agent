// A2A wire format (docs/a2a.md): the parts of the Agent2Agent protocol
// somora speaks, as plain JSON — v1.0 (`SendMessage`, `TASK_STATE_*`,
// `ROLE_*`, member-presence parts) and the 0.3 shape older peers still
// send (`message/send`, `kind`, lower-case states). Read leniently,
// written as v1.0.

export const A2A_ENGINE = 'a2a';

/** Task states, folded to one spelling for both versions. */
export type TaskState = 'submitted' | 'working' | 'input_required' | 'auth_required' | 'completed' | 'failed' | 'canceled' | 'rejected' | 'unknown';

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'canceled', 'rejected']);
/** States where the task stops and waits for the asker. */
export const PAUSED_STATES: ReadonlySet<TaskState> = new Set(['input_required', 'auth_required']);

export function normalizeState(raw: unknown): TaskState {
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.toLowerCase().replace(/^task_state_/, '').replace(/-/g, '_');
  switch (s) {
    case 'submitted':
    case 'working':
    case 'input_required':
    case 'auth_required':
    case 'completed':
    case 'failed':
    case 'rejected':
      return s;
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return 'unknown';
  }
}

export interface A2APart {
  text?: string;
  url?: string;
  raw?: string;
  data?: unknown;
  filename?: string;
  mediaType?: string;
  /** 0.3 */
  kind?: string;
  file?: { uri?: string; bytes?: string; name?: string; mimeType?: string };
}

export interface A2AMessage {
  messageId?: string;
  role?: string;
  contextId?: string;
  taskId?: string;
  parts?: A2APart[];
}

export interface A2ATaskStatus {
  state?: string;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2AArtifact {
  artifactId?: string;
  name?: string;
  parts?: A2APart[];
}

export interface A2ATask {
  id?: string;
  contextId?: string;
  status?: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  kind?: string;
}

/** Text of a list of parts. Non-text parts are named, not dropped, so
 *  the reader knows something came along. */
export function partsText(parts: A2APart[] | undefined): string {
  const out: string[] = [];
  for (const p of parts ?? []) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string') out.push(p.text);
    else if (p.data !== undefined) out.push('```json\n' + safeJson(p.data) + '\n```');
    else if (typeof p.url === 'string' || p.file?.uri) out.push(`[file: ${p.filename ?? p.file?.name ?? ''} ${p.url ?? p.file?.uri}]`.replace('  ', ' '));
    else if (typeof p.raw === 'string' || p.file?.bytes) out.push(`[file: ${p.filename ?? p.file?.name ?? 'attachment'} (${p.mediaType ?? p.file?.mimeType ?? 'unknown type'}) — not shown]`);
  }
  return out.join('\n');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** The answer a finished task carries: its artifacts, else the last
 *  agent message (status message or history). */
export function taskAnswer(task: A2ATask): string {
  const fromArtifacts = (task.artifacts ?? []).map((a) => partsText(a.parts)).filter((t) => t.trim()).join('\n\n');
  if (fromArtifacts.trim()) return fromArtifacts;
  const status = partsText(task.status?.message?.parts);
  if (status.trim()) return status;
  const lastAgent = [...(task.history ?? [])].reverse().find((m) => /agent/i.test(m.role ?? ''));
  return partsText(lastAgent?.parts);
}

/** The status message's text — what the agent says while working, or the
 *  question it asks in input_required, or why it failed. */
export function statusText(task: A2ATask): string {
  return partsText(task.status?.message?.parts);
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Method names per version. */
export const METHODS = {
  '1.0': { send: 'SendMessage', stream: 'SendStreamingMessage', get: 'GetTask', cancel: 'CancelTask' },
  '0.3': { send: 'message/send', stream: 'message/stream', get: 'tasks/get', cancel: 'tasks/cancel' },
} as const;
export type ProtocolVersion = keyof typeof METHODS;

export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_TASK_NOT_FOUND = -32001;
export const ERR_TASK_NOT_CANCELABLE = -32002;
export const ERR_UNSUPPORTED = -32004;

export interface AgentCard {
  name?: string;
  description?: string;
  version?: string;
  url?: string;
  protocolVersion?: string;
  supportedInterfaces?: Array<{ url?: string; protocolBinding?: string; protocolVersion?: string }>;
  capabilities?: { streaming?: boolean; pushNotifications?: boolean };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: Array<{ id?: string; name?: string; description?: string }>;
}

/** Where to send JSON-RPC, and in which version, from a card. */
export function cardEndpoint(card: AgentCard): { url: string; version: ProtocolVersion } | null {
  const rpc = (card.supportedInterfaces ?? []).find((i) => typeof i.url === 'string' && /jsonrpc/i.test(i.protocolBinding ?? 'JSONRPC'));
  if (rpc?.url) return { url: rpc.url, version: (rpc.protocolVersion ?? '1.0').startsWith('0.') ? '0.3' : '1.0' };
  if (typeof card.url === 'string') return { url: card.url, version: (card.protocolVersion ?? '0.3').startsWith('0.') ? '0.3' : '1.0' };
  return null;
}
