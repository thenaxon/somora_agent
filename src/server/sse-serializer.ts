// Per-turn SSE serializer. Holds a callId→tool map so tool_result events
// (which only carry callId in the wire format) can be correlated back to
// the originating tool name and pre-formatted accordingly. Clients
// receive renderable strings, not raw payloads — keeps TUI / Orbit / web
// consumers thin.

import { formatArgs, formatDetails, formatResult, shortToolName } from './tool-format.ts';
import {
  resolveEngineMetaLabel,
  summariseEngineMeta,
} from '../engine/engine-meta-labels.ts';
import type { NormalizedEvent, SseEvent } from '../types/events.ts';

export function createTurnSerializer() {
  const callIdToTool = new Map<string, string>();
  return function serialize(ev: NormalizedEvent): SseEvent | null {
    switch (ev.kind) {
      case 'assistant_delta':
        return { event: 'chat', data: { state: 'delta', text: ev.text } };
      case 'assistant_message':
        return { event: 'chat', data: { state: 'final', text: ev.text } };
      case 'thinking_delta':
        return { event: 'thinking', data: { state: 'delta', text: ev.text } };
      case 'thinking_message':
        return {
          event: 'thinking',
          data: { state: 'final', text: ev.text, ...(ev.truncated ? { truncated: true } : {}) },
        };
      case 'tool_call': {
        const tool = shortToolName(ev.tool);
        callIdToTool.set(ev.callId, tool);
        return {
          event: 'tool',
          data: {
            phase: 'call',
            tool,
            summary: formatArgs(ev.tool, ev.input),
            details: formatDetails(ev.input),
          },
        };
      }
      case 'tool_result': {
        const tool = callIdToTool.get(ev.callId) ?? '?';
        if (ev.error) {
          return {
            event: 'tool',
            data: { phase: 'error', tool, error: ev.error },
          };
        }
        const summary = formatResult(tool, ev.output);
        // Trivial successes (e.g. {ok:true} after memory_write) are
        // suppressed — the call line already conveys the action.
        if (summary === null) return null;
        return {
          event: 'tool',
          data: {
            phase: 'result',
            tool,
            summary,
            details: formatDetails(ev.output),
          },
        };
      }
      case 'error':
        return { event: 'status', data: { msg: `error: ${ev.message}` } };
      case 'assistant_audio':
        return {
          event: 'assistant_audio',
          data: {
            turnId: ev.turnId,
            url: ev.audio.url,
            mime: ev.audio.mime,
            ...(ev.audio.durationMs !== undefined ? { durationMs: ev.audio.durationMs } : {}),
            cacheKey: ev.audio.cacheKey,
          },
        };
      case 'assistant_media':
        return {
          event: 'assistant_media',
          data: { turnId: ev.turnId, media: ev.media },
        };
      case 'engine_meta': {
        const label = resolveEngineMetaLabel(ev.engine, ev.itemType);
        const summary = summariseEngineMeta(ev.engine, ev.itemType, ev.payload);
        return {
          event: 'engine_meta',
          data: {
            engine: ev.engine,
            itemType: ev.itemType,
            label,
            ...(summary ? { summary } : {}),
            payload: ev.payload,
          },
        };
      }
      case 'model_fallback':
        return {
          event: 'model_fallback',
          data: {
            requested: ev.requested,
            actual: ev.actual,
            reason: ev.reason,
            ...(ev.hops ? { hops: ev.hops } : {}),
          },
        };
      default:
        return null;
    }
  };
}

/**
 * Serialize ONE event that was written into a session outside any turn.
 *
 * The realtime voice path appends straight into a session's history: the
 * caller's spoken line, the line the voice self said back, and the note
 * that a call changed hands. Those must reach every subscriber of that
 * session in the same shape a turn produces, otherwise a client sees a
 * frame it cannot read.
 *
 * Before this existed, the voice path handed `publish()` a raw
 * NormalizedEvent through a cast. The SSE writer then stringified an
 * undefined payload, threw, and `publish()` treated the throw as a dead
 * subscriber and tore that stream down — so every spoken line kicked the
 * chat window, the TUI and the phone off the session (85 evictions in one
 * evening, 2026-09-12). The cast is gone; this function replaces it.
 *
 * `tool_call` / `tool_result` never travel this path: their correlation
 * lives in a per-turn serializer, and a standalone one has no turn to
 * correlate within. They return null rather than a half-correct frame.
 */
export function serializeSessionEvent(ev: NormalizedEvent): SseEvent | null {
  if (ev.kind === 'tool_call' || ev.kind === 'tool_result') return null;
  if (ev.kind === 'user_message') {
    return {
      event: 'user_message',
      data: {
        text: ev.text,
        ts: ev.ts,
        ...(ev.from_agent ? { from_agent: ev.from_agent } : {}),
        ...(ev.from_agent && ev.from_session ? { from_session: ev.from_session } : {}),
        ...(ev.from_system ? { from_system: ev.from_system } : {}),
        // How it was said. Without this the live bubble and the one
        // after a reload render differently: history carries `input`,
        // the stream did not. Projected field by field — the stored
        // shape also holds free-form STT provider tags that no client
        // needs to see.
        ...(ev.input
          ? {
              input: {
                ...(ev.input.modality ? { modality: ev.input.modality } : {}),
                ...(ev.input.source ? { source: ev.input.source } : {}),
              },
            }
          : {}),
      },
    };
  }
  return createTurnSerializer()(ev);
}
