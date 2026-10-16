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
    const text = this.text.trimEnd() || (note ?? '');
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

/**
 * somora events of one turn → ACP updates. The deltas somora streams are
 * cumulative; ACP wants pieces, so each delta becomes the new suffix.
 */
export class SomoraToAcp {
  private sentText = 0;
  private sentThinking = 0;
  private readonly openTools = new Set<string>();

  update(ev: Ev): SessionUpdate[] {
    switch (ev.kind) {
      case 'assistant_delta':
      case 'assistant_message': {
        const piece = ev.text.length >= this.sentText ? ev.text.slice(this.sentText) : '';
        this.sentText = Math.max(this.sentText, ev.text.length);
        return piece ? [{ sessionUpdate: 'agent_message_chunk', content: textBlock(piece) }] : [];
      }
      case 'thinking_delta':
      case 'thinking_message': {
        const piece = ev.text.length >= this.sentThinking ? ev.text.slice(this.sentThinking) : '';
        this.sentThinking = Math.max(this.sentThinking, ev.text.length);
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
