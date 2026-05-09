// Collapsible tool-call + tool-result blocks. Live SSE events
// arrive pre-formatted from the server (`summary` + `details`
// strings); JSONL history events arrive raw (`input` /  `output`
// objects). Both render the same — render `summary || derived
// from input` on the always-visible row, expand to show
// `details || pretty-printed input/output`.

import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, CornerDownRight, AlertTriangle } from 'lucide-react';
import type { ToolCallPayload, ToolResultPayload } from '../types/chat';

function deriveCallSummary(tc: ToolCallPayload): string {
  if (tc.summary) return tc.summary;
  if (!tc.input) return '';
  const i = tc.input;
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

function deriveCallDetails(tc: ToolCallPayload): string {
  if (tc.details) return tc.details;
  if (tc.input) {
    try {
      return JSON.stringify(tc.input, null, 2);
    } catch {
      return String(tc.input);
    }
  }
  return '(no input)';
}

function deriveResultSummary(tr: ToolResultPayload): string {
  if (tr.error) return tr.error;
  if (tr.summary) return tr.summary;
  if (tr.output === undefined || tr.output === null) return '(no output)';
  if (typeof tr.output === 'string') return tr.output;
  try {
    return JSON.stringify(tr.output);
  } catch {
    return String(tr.output);
  }
}

function deriveResultDetails(tr: ToolResultPayload): string {
  if (tr.details) return tr.details;
  if (tr.error) return tr.error;
  if (tr.output === undefined || tr.output === null) return '(no output)';
  if (typeof tr.output === 'string') return tr.output;
  try {
    return JSON.stringify(tr.output, null, 2);
  } catch {
    return String(tr.output);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-3)',
  border: '1px solid var(--line)',
  borderRadius: 5,
  margin: '3px 0',
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 11,
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
};

const headerStyle: React.CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  color: 'var(--text-1)',
  boxSizing: 'border-box',
};

const detailsStyle: React.CSSProperties = {
  margin: 0,
  padding: '6px 8px',
  borderTop: '1px solid var(--line)',
  background: 'var(--bg-1)',
  color: 'var(--text-1)',
  fontSize: 10.5,
  whiteSpace: 'pre-wrap',
  overflowX: 'auto',
  overflowY: 'auto',
  maxHeight: 240,
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
};

export function ToolCallBlock({ toolCall }: { toolCall: ToolCallPayload }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => truncate(deriveCallSummary(toolCall), 100), [toolCall]);
  const details = useMemo(() => deriveCallDetails(toolCall), [toolCall]);

  return (
    <div style={cardStyle}>
      <button type="button" style={headerStyle} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{toolCall.tool}</span>
        {summary && (
          <span
            style={{
              color: 'var(--text-2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}
          >
            {summary}
          </span>
        )}
      </button>
      {open && <pre style={detailsStyle}>{details}</pre>}
    </div>
  );
}

export function ToolResultBlock({ toolResult }: { toolResult: ToolResultPayload }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => truncate(deriveResultSummary(toolResult), 120), [toolResult]);
  const details = useMemo(() => deriveResultDetails(toolResult), [toolResult]);
  const isError = !!toolResult.error;

  return (
    <div
      style={{
        ...cardStyle,
        borderColor: isError ? 'var(--danger)' : 'var(--line)',
      }}
    >
      <button type="button" style={headerStyle} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {isError ? (
          <AlertTriangle size={11} style={{ color: 'var(--danger)' }} />
        ) : (
          <CornerDownRight size={11} style={{ color: 'var(--ok)' }} />
        )}
        <span
          style={{
            color: isError ? 'var(--danger)' : 'var(--text-2)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {summary}
        </span>
      </button>
      {open && <pre style={detailsStyle}>{details}</pre>}
    </div>
  );
}
