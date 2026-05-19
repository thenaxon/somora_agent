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
      default:
        return null;
    }
  };
}
