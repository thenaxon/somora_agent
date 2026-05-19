// Renders an engine_meta event in the chat — codex's internal
// plan/checklist (todo_list) and any other engine side-channel items
// somora persists in JSONL. Mirrors ToolBlocks visually but with a
// distinct color/icon so the user can tell at a glance "this came
// from the engine, not from somora's tool-layer".
//
// Visibility is gated by the same `show.tools` toggle as tool calls
// (see ChatWindow's visibleMessages filter).

import { useState, useMemo, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import type { EngineMetaPayload } from '../types/chat';
import { extractTodoListItems } from '../lib/engine-meta-labels';

const cardStyle: CSSProperties = {
  background: 'var(--bg-3)',
  border: '1px solid var(--line)',
  borderRadius: 5,
  margin: '3px 0',
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 11,
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
  opacity: 0.78,
};

const headerStyle: CSSProperties = {
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

const detailsStyle: CSSProperties = {
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

const statusGlyph: Record<string, string> = {
  completed: '✓',
  in_progress: '→',
  pending: '○',
  cancelled: '⊘',
};

const statusColor: Record<string, string> = {
  completed: 'var(--ok, #4caf50)',
  in_progress: 'var(--accent)',
  pending: 'var(--text-2)',
  cancelled: 'var(--text-2)',
};

export function EngineMetaBlock({ meta }: { meta: EngineMetaPayload }) {
  const [open, setOpen] = useState(false);

  const todoItems = useMemo(() => {
    if (meta.engine === 'codex-cli' && meta.itemType === 'todo_list') {
      return extractTodoListItems(meta.payload);
    }
    return null;
  }, [meta.engine, meta.itemType, meta.payload]);

  const fallbackJson = useMemo(() => {
    try {
      return JSON.stringify(meta.payload, null, 2);
    } catch {
      return String(meta.payload);
    }
  }, [meta.payload]);

  return (
    <div style={cardStyle} title={`${meta.engine} · ${meta.itemType}`}>
      <button type="button" style={headerStyle} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <ListChecks size={12} style={{ color: 'var(--text-2)' }} />
        <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>
          {meta.engine.replace('-cli', '')} · {meta.label}
        </span>
        {meta.summary && (
          <span
            style={{
              color: 'var(--text-2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
              fontStyle: 'italic',
            }}
          >
            {meta.summary}
          </span>
        )}
      </button>
      {open && (
        <div style={detailsStyle}>
          {todoItems ? (
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
              {todoItems.map((it, idx) => (
                <li key={idx} style={{ display: 'flex', gap: 6, padding: '1px 0' }}>
                  <span
                    style={{
                      color: statusColor[it.status] ?? 'var(--text-2)',
                      width: 12,
                      flexShrink: 0,
                    }}
                  >
                    {statusGlyph[it.status] ?? '○'}
                  </span>
                  <span
                    style={{
                      color: it.status === 'completed' ? 'var(--text-2)' : 'var(--text-1)',
                      textDecoration: it.status === 'cancelled' ? 'line-through' : 'none',
                    }}
                  >
                    {it.content}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <pre style={{ margin: 0 }}>{fallbackJson}</pre>
          )}
        </div>
      )}
    </div>
  );
}
