// ACP (Agent Client Protocol) ⇄ somora events, both directions, in one
// place (private/external-agents/KONZEPT.md):
//
//   AcpTurnTranslator — an external agent's `session/update`s during one
//     prompt → somora NormalizedEvents (what the chat renders and the
//     session file keeps).
//   SomoraToAcp       — somora events of a turn → ACP `session/update`s,
//     for `somora acp` (somora as an ACP agent).
//   historyToAcp      — a stored somora session → the updates
//     `session/load` replays.
//   SseToAcp          — the live chat stream a client sees (`chat`,
//     `thinking`, `tool`, `todo_updated`, `agent`) → ACP updates, for
//     `somora acp` as a thin client.
//
// Pure: no I/O, no process. The engine adapter and `somora acp` feed it.

import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { NormalizedEvent } from '../types/events.ts';

/** Engine name on every event an external agent produces. */
export const ACP_ENGINE = 'acp';

type Ev = NormalizedEvent;

/** Text of an ACP content block; non-text blocks are named, not dropped. */
export function blockText(block: ContentBlock | undefined): string {
  if (!block) return '';
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    case 'resource_link':
      return `[${block.name || block.uri}]`;
    case 'resource': {
      const r = block.resource as { text?: string; uri?: string };
      return typeof r.text === 'string' ? r.text : `[${r.uri ?? 'resource'}]`;
    }
    default:
      return '';
  }
}

/** Text of a tool call's content (output, diffs, terminals). */
export function toolContentText(content: ToolCallContent[] | null | undefined): string {
  if (!content || content.length === 0) return '';
  return content
    .map((c) => {
      if (c.type === 'content') return blockText(c.content);
      if (c.type === 'diff') return `${c.path}\n--- before\n${c.oldText ?? ''}\n+++ after\n${c.newText}`;
      if (c.type === 'terminal') return `[terminal ${c.terminalId}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** A short tool name for the chat row: the ACP `name`, else what the
 *  title starts with before a colon (both OpenClaw and Hermes write
 *  `exec: …` / `terminal: …`), else the kind. */
export function toolName(title: string | undefined, name: string | null | undefined, kind: ToolKind | undefined): string {
  if (name && name.trim()) return name.trim();
  const head = (title ?? '').split(':')[0]!.trim();
  if (head && head.length <= 40 && !/\s{2,}/.test(head)) return head;
  return kind ?? 'tool';
}

interface ToolState {
  emitted: boolean;
  done: boolean;
  lastText: string;
  lastRaw: unknown;
}

export interface TurnUsage {
  /** Context occupancy and window from `usage_update`. */
  used?: number;
  size?: number;
  /** From the prompt response's `usage`, when the agent reports one. */
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
}

/**
 * One prompt's updates → somora events. Feed every `session/update` to
 * `update()`, then call `finish()` with the prompt's stop reason. Updates
 * after finish (Hermes sent a text chunk after `cancel`) are dropped.
 */
export class AcpTurnTranslator {
  private text = '';
  private thinking = '';
  private readonly tools = new Map<string, ToolState>();
  private finished = false;
  readonly usage: TurnUsage = {};
  /** Set from `session_info_update`. */
  title: string | undefined;
  /** Updates seen after finish — counted for the log. */
  lateUpdates = 0;

  constructor(
    private readonly turnId: string,
    private readonly engine = ACP_ENGINE,
    private readonly now: () => number = Date.now,
  ) {}

  update(u: SessionUpdate): Ev[] {
    if (this.finished) {
      this.lateUpdates += 1;
      return [];
    }
    const ts = this.now();
    const engine = this.engine;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const piece = blockText(u.content);
        // Leading blank lines of the first piece are formatting, not text
        // (Hermes starts its answers with "\n\n\n\n").
        this.text = this.text ? this.text + piece : piece.replace(/^\s+/, '');
        return this.text ? [{ kind: 'assistant_delta', ts, engine, text: this.text }] : [];
      }
      case 'agent_thought_chunk': {
        this.thinking += blockText(u.content);
        return [{ kind: 'thinking_delta', ts, engine, text: this.thinking }];
      }
      case 'tool_call': {
        const out: Ev[] = [];
        const st: ToolState = { emitted: true, done: false, lastText: toolContentText(u.content), lastRaw: u.rawOutput };
        this.tools.set(u.toolCallId, st);
        out.push({
          kind: 'tool_call',
          ts,
          engine,
          callId: u.toolCallId,
          tool: toolName(u.title, u.name, u.kind),
          input: toolInput(u.rawInput, u.title),
        });
        if (u.status === 'completed' || u.status === 'failed') out.push(...this.closeTool(u.toolCallId, u.status, u.rawOutput, ts));
        return out;
      }
      case 'tool_call_update': {
        const out: Ev[] = [];
        let st = this.tools.get(u.toolCallId);
        if (!st) {
          // An update for a call we never saw start: show it anyway.
          st = { emitted: true, done: false, lastText: '', lastRaw: undefined };
          this.tools.set(u.toolCallId, st);
          out.push({
            kind: 'tool_call',
            ts,
            engine,
            callId: u.toolCallId,
            tool: toolName(u.title ?? undefined, u.name, u.kind ?? undefined),
            input: toolInput(u.rawInput, u.title ?? undefined),
          });
        }
        const text = toolContentText(u.content);
        if (text) st.lastText = text;
        if (u.rawOutput !== undefined) st.lastRaw = u.rawOutput;
        if (u.status === 'completed' || u.status === 'failed') out.push(...this.closeTool(u.toolCallId, u.status, u.rawOutput, ts));
        return out;
      }
      case 'plan':
        return [{ kind: 'engine_meta', ts, engine, itemType: 'plan', payload: { entries: u.entries } }];
      case 'usage_update':
        this.usage.used = u.used;
        this.usage.size = u.size;
        return [];
      case 'session_info_update':
        if (typeof u.title === 'string' && u.title.trim()) this.title = u.title.trim();
        return [];
      default:
        // user_message_chunk (only on load), available_commands_update,
        // current_mode_update, config_option_update: nothing to render.
        return [];
    }
  }

  private closeTool(id: string, status: ToolCallStatus, rawOutput: unknown, ts: number): Ev[] {
    const st = this.tools.get(id)!;
    if (st.done) return [];
    st.done = true;
    const output = st.lastText || (rawOutput !== undefined ? rawOutput : st.lastRaw) || '';
    return [
      {
        kind: 'tool_result',
        ts,
        engine: this.engine,
        callId: id,
        output,
        ...(status === 'failed' ? { error: typeof output === 'string' && output ? output.slice(0, 500) : 'the tool failed' } : {}),
      },
    ];
  }

  /** The prompt returned. Closes open tool calls and the turn. */
  finish(stopReason: StopReason | 'error', usage?: TurnUsage, errorMessage?: string): Ev[] {
    if (this.finished) return [];
    this.finished = true;
    const ts = this.now();
    const engine = this.engine;
    if (usage) Object.assign(this.usage, usage);
    const out: Ev[] = [];
    // A call still open when the turn ends did not finish.
    for (const [id, st] of this.tools) {
      if (st.done) continue;
      st.done = true;
      out.push({ kind: 'tool_result', ts, engine, callId: id, output: st.lastText || '', error: stopReason === 'cancelled' ? 'stopped' : 'the turn ended before the tool finished' });
    }
    if (this.thinking) out.push({ kind: 'thinking_message', ts, engine, text: this.thinking });
    const note = stopNote(stopReason);
    // A stopped turn ends like on every other engine: what came so far,
    // then the marker (clients and history rebuilds know it).
    const text =
      stopReason === 'cancelled'
        ? this.text.trimEnd()
          ? `${this.text.trimEnd()}\n\n[somora] aborted by user`
          : '[somora] aborted by user'
        : this.text.trimEnd() || (note ?? '');
    if (stopReason === 'error') {
      out.push({ kind: 'error', ts, engine, message: errorMessage ?? 'the external agent failed', providerError: true });
    }
    if (text) out.push({ kind: 'assistant_message', ts, engine, text });
    const u = this.usage;
    const hasUsage = u.inputTokens !== undefined || u.outputTokens !== undefined || u.used !== undefined;
    out.push({
      kind: 'turn_end',
      ts,
      engine,
      turnId: this.turnId,
      ...(hasUsage
        ? {
            usage: {
              tokens_in: u.inputTokens ?? 0,
              tokens_out: u.outputTokens ?? 0,
              ...(u.cachedReadTokens ? { tokens_in_cached: u.cachedReadTokens } : {}),
              ...(u.thoughtTokens ? { tokens_out_reasoning: u.thoughtTokens } : {}),
              ...(u.used !== undefined ? { context_tokens: u.used } : {}),
              ...(u.size !== undefined ? { context_window: u.size } : {}),
            },
          }
        : {}),
      ...(stopReason !== 'end_turn' && stopReason !== 'cancelled' && stopReason !== 'error' ? { degraded: { reason: stopReason } } : {}),
    });
    return out;
  }
}

function toolInput(rawInput: unknown, title: string | undefined): unknown {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) return rawInput;
  if (rawInput !== undefined && rawInput !== null) return { input: rawInput };
  return title ? { title } : {};
}

/** A line for the chat when the agent stopped for a reason other than
 *  finishing, and wrote nothing. */
function stopNote(r: StopReason | 'error'): string | null {
  switch (r) {
    case 'max_tokens':
      return '[the external agent stopped: output limit reached]';
    case 'max_turn_requests':
      return '[the external agent stopped: step limit reached]';
    case 'refusal':
      return '[the external agent refused]';
    default:
      return null;
  }
}

// ── somora → ACP (`somora acp`) ─────────────────────────────────────

/** ACP tool kind for a somora tool name. */
export function acpToolKind(tool: string): ToolKind {
  if (/^(file_read|memory_get|memory_list|wiki_get|skill_read)/.test(tool)) return 'read';
  if (/^(file_write|file_patch|memory_write|memory_edit|wiki_(create|edit|move))/.test(tool)) return 'edit';
  if (/delete/.test(tool)) return 'delete';
  if (/^(file_search|memory_search|web_search|file_list|session_list)/.test(tool)) return 'search';
  if (/^(exec|tmux_|bash|shell)/.test(tool)) return 'execute';
  if (/^(web_fetch|browser)/.test(tool)) return 'fetch';
  if (/think|plan/.test(tool)) return 'think';
  return 'other';
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'path', 'query', 'url', 'slug', 'agent', 'task']) {
    if (typeof o[k] === 'string' && o[k]) return String(o[k]).slice(0, 80);
  }
  return '';
}

function resultText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

/** What to send for a cumulative text, given what was sent. Usually the
 *  new suffix. A text that no longer extends the sent one (a stopped turn
 *  ends as "…partial [somora] aborted by user") sends what differs after
 *  the common start, on a new line — ACP cannot take sent text back.
 *  Leading whitespace is never sent. */
function nextPiece(sent: string, raw: string): [piece: string, sent: string] {
  // Leading blank lines carry nothing, and a model's final text often
  // drops the ones its stream started with.
  const text = raw.trimStart();
  if (text.startsWith(sent)) return [text.slice(sent.length), text];
  if (sent.startsWith(text)) return ['', sent];
  let i = 0;
  while (i < sent.length && i < text.length && sent[i] === text[i]) i++;
  const rest = text.slice(i).trim();
  return rest ? [`\n${rest}`, sent + `\n${rest}`] : ['', sent];
}

/**
 * somora events of one turn → ACP updates. The deltas somora streams are
 * cumulative; ACP wants pieces, so each delta becomes the new suffix.
 */
export class SomoraToAcp {
  // Sent so far / the last cumulative text received, per stream.
  private sentText = '';
  private sentThinking = '';
  private lastText = '';
  private lastThinking = '';
  private readonly openTools = new Set<string>();

  update(ev: Ev): SessionUpdate[] {
    switch (ev.kind) {
      case 'assistant_delta':
      case 'assistant_message': {
        if (ev.text === this.lastText) return [];
        this.lastText = ev.text;
        const [piece, sent] = nextPiece(this.sentText, ev.text);
        this.sentText = sent;
        return piece ? [{ sessionUpdate: 'agent_message_chunk', content: textBlock(piece) }] : [];
      }
      case 'thinking_delta':
      case 'thinking_message': {
        if (ev.text === this.lastThinking) return [];
        this.lastThinking = ev.text;
        const [piece, sent] = nextPiece(this.sentThinking, ev.text);
        this.sentThinking = sent;
        return piece ? [{ sessionUpdate: 'agent_thought_chunk', content: textBlock(piece) }] : [];
      }
      case 'tool_call': {
        this.openTools.add(ev.callId);
        const detail = summarizeInput(ev.input);
        return [
          {
            sessionUpdate: 'tool_call',
            toolCallId: ev.callId,
            title: detail ? `${ev.tool}: ${detail}` : ev.tool,
            name: ev.tool,
            kind: acpToolKind(ev.tool),
            status: 'in_progress',
            rawInput: ev.input,
          },
        ];
      }
      case 'tool_result': {
        this.openTools.delete(ev.callId);
        const text = ev.error ? `${ev.error}${ev.output ? `\n${resultText(ev.output)}` : ''}` : resultText(ev.output);
        return [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: ev.callId,
            status: ev.error ? 'failed' : 'completed',
            content: [{ type: 'content', content: textBlock(text.slice(0, 20_000)) }],
            rawOutput: ev.output,
          },
        ];
      }
      case 'turn_end': {
        const u = ev.usage;
        if (u?.context_tokens !== undefined && u.context_window) {
          return [{ sessionUpdate: 'usage_update', used: u.context_tokens, size: u.context_window }];
        }
        return [];
      }
      default:
        return [];
    }
  }
}

/** A stored somora session → the updates `session/load` replays. */
export function historyToAcp(events: readonly Ev[]): SessionUpdate[] {
  const out: SessionUpdate[] = [];
  let turn = new SomoraToAcp();
  for (const ev of events) {
    if (ev.kind === 'user_message') {
      turn = new SomoraToAcp();
      if (ev.text) out.push({ sessionUpdate: 'user_message_chunk', content: textBlock(ev.text) });
      continue;
    }
    if (ev.kind === 'assistant_delta' || ev.kind === 'thinking_delta') continue;
    out.push(...turn.update(ev));
  }
  return out;
}

/** One frame of the live chat stream (GET /chat/stream). */
export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/**
 * The live chat stream of one turn → ACP updates. The stream is what
 * every client reads: text and thinking cumulative, tools pre-formatted
 * and without a call id — a result belongs to the oldest open call of
 * the same tool (calls of one tool finish in order), a trivial success
 * sends no result at all, so whatever is still open at the end closes as
 * done.
 */
export class SseToAcp {
  private readonly text = new SomoraToAcp();
  private readonly open: Array<{ id: string; tool: string }> = [];
  private seq = 0;
  /** The last tool call — a question asked during a turn names it. */
  lastToolCall: { id: string; title: string } | null = null;
  /** `error: …` status lines of the turn, for the stop note. */
  readonly errors: string[] = [];

  constructor(private readonly idPrefix = 't') {}

  update(f: SseFrame): SessionUpdate[] {
    const d = f.data;
    const str = (k: string): string | undefined => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
    switch (f.event) {
      case 'chat': {
        const t = str('text');
        return t === undefined ? [] : this.text.update({ kind: 'assistant_delta', ts: 0, engine: 'somora', text: t } as Ev);
      }
      case 'thinking': {
        const t = str('text');
        return t === undefined ? [] : this.text.update({ kind: 'thinking_delta', ts: 0, engine: 'somora', text: t } as Ev);
      }
      case 'tool': {
        const tool = str('tool') ?? 'tool';
        const phase = str('phase');
        if (phase === 'call') {
          const id = `${this.idPrefix}${++this.seq}`;
          this.open.push({ id, tool });
          const summary = str('summary');
          const title = summary && summary !== '{}' ? `${tool}: ${summary}` : tool;
          this.lastToolCall = { id, title };
          return [
            {
              sessionUpdate: 'tool_call',
              toolCallId: id,
              title,
              kind: acpToolKind(tool),
              status: 'in_progress',
              ...(str('details') ? { rawInput: str('details') } : {}),
            },
          ];
        }
        if (phase === 'result' || phase === 'error') {
          const at = this.open.findIndex((o) => o.tool === tool);
          const hit = at >= 0 ? this.open.splice(at, 1)[0]! : this.open.shift();
          if (!hit) return [];
          const text = phase === 'error' ? (str('error') ?? 'failed') : [str('summary'), str('details')].filter(Boolean).join('\n');
          return [
            {
              sessionUpdate: 'tool_call_update',
              toolCallId: hit.id,
              status: phase === 'error' ? 'failed' : 'completed',
              ...(text ? { content: [{ type: 'content' as const, content: textBlock(text.slice(0, 20_000)) }] } : {}),
            },
          ];
        }
        return [];
      }
      case 'todo_updated': {
        const todos = Array.isArray(d.todos) ? (d.todos as Array<{ content?: unknown; status?: unknown; priority?: unknown }>) : [];
        return [
          {
            sessionUpdate: 'plan',
            entries: todos
              .filter((t) => typeof t.content === 'string')
              .map((t) => ({
                content: t.content as string,
                status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
                priority: t.priority === 'high' || t.priority === 'low' ? t.priority : 'medium',
              })),
          },
        ];
      }
      case 'status': {
        const msg = str('msg');
        if (msg?.startsWith('error: ') || msg?.startsWith('turn failed: ')) this.errors.push(msg.replace(/^(error|turn failed): /, ''));
        return [];
      }
      default:
        return [];
    }
  }

  /** The turn ended (`agent` phase end): close what is open, report the
   *  context fill. */
  finish(end: SseFrame | null): SessionUpdate[] {
    const out: SessionUpdate[] = this.open.splice(0).map((o) => ({ sessionUpdate: 'tool_call_update' as const, toolCallId: o.id, status: 'completed' as const }));
    const usage = end?.data.usage as { context_tokens?: number } | undefined;
    const size = end?.data.contextWindow;
    if (typeof usage?.context_tokens === 'number' && typeof size === 'number' && size > 0) {
      out.push({ sessionUpdate: 'usage_update', used: usage.context_tokens, size });
    }
    return out;
  }
}
