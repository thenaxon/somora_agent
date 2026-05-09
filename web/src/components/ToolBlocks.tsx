// Collapsible tool-call + tool-result blocks. Adapted from orbit's
// ToolCallBlock / ToolResultBlock. Single line shows tool-name +
// short summary + chevron; click expands to pretty-printed JSON.
//
// Per-tool summary rules favour somora's actual tool surface
// (memory_*, dream_*, wiki_*, file_*, exec, web_*, …) so the line
// reads informatively at a glance without expanding.

import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, CornerDownRight } from 'lucide-react';
import type { ToolCallPayload, ToolResultPayload } from '../types/chat';

function summariseToolCall(tc: ToolCallPayload): string {
  const i = tc.input as Record<string, unknown>;
  const get = (k: string): string | undefined =>
    typeof i[k] === 'string' ? (i[k] as string) : undefined;

  switch (tc.tool) {
    case 'memory_search':
    case 'memory_get':
      return get('query') ?? get('reference') ?? '';
    case 'memory_write':
    case 'memory_edit':
    case 'memory_delete':
      return get('slug') ?? '';
    case 'wiki_edit':
    case 'wiki_create':
    case 'wiki_delete':
      return get('wikiPath') ?? '';
    case 'dream_run':
      return `phase=${get('phase') ?? '?'}`;
    case 'dream_apply':
    case 'dream_dismiss':
    case 'dream_get':
    case 'dream_review':
      return get('dream_id') ?? '';
    case 'file_read':
    case 'file_write':
    case 'file_patch':
    case 'file_list':
      return get('path') ?? '';
    case 'file_search':
      return get('pattern') ?? '';
    case 'exec':
      return get('command') ?? '';
    case 'web_search':
      return get('query') ?? '';
    case 'web_fetch':
      return get('url') ?? '';
    case 'somora_docs_read':
      return get('topic') ?? '';
    case 'time_now':
      return '';
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
      return first ?? '';
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function ToolCallBlock({ toolCall }: { toolCall: ToolCallPayload }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => truncate(summariseToolCall(toolCall), 80), [toolCall]);

  return (
    <div
      style={{
        background: 'var(--bg-3)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        margin: '4px 0',
        fontSize: 12,
        fontFamily: '"JetBrains Mono", monospace',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          all: 'unset',
          cursor: 'pointer',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          color: 'var(--text-1)',
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{toolCall.tool}</span>
        {summary && (
          <span
            style={{
              color: 'var(--text-2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {summary}
          </span>
        )}
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: '8px 10px',
            borderTop: '1px solid var(--line)',
            background: 'var(--bg-1)',
            color: 'var(--text-1)',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
          }}
        >
          {JSON.stringify(toolCall.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function ToolResultBlock({ toolResult }: { toolResult: ToolResultPayload }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => stringifyOutput(toolResult.output), [toolResult]);
  const summary = useMemo(() => truncate(text.replace(/\s+/g, ' '), 100), [text]);

  return (
    <div
      style={{
        background: 'var(--bg-3)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        margin: '4px 0',
        fontSize: 12,
        fontFamily: '"JetBrains Mono", monospace',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          all: 'unset',
          cursor: 'pointer',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          color: 'var(--text-1)',
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <CornerDownRight size={12} style={{ color: 'var(--ok)' }} />
        <span
          style={{
            color: 'var(--text-2)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {summary}
        </span>
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: '8px 10px',
            borderTop: '1px solid var(--line)',
            background: 'var(--bg-1)',
            color: 'var(--text-1)',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
          }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

function stringifyOutput(output: unknown): string {
  if (output === undefined || output === null) return '(no output)';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}
