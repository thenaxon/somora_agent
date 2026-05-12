// Pin-note window — sticky-note style snapshot of a single agent
// message that the user pinned for working-memory. Captures
// content + meta (agent / session / timestamp) at pin time and
// stays visible while the user keeps chatting elsewhere.
//
// Lives inside the standard <Window> chrome so drag/resize/focus
// behave like all other windows. Yellow titlebar tint signals at a
// glance that this is a pin, not live content.

import { AssistantMarkdown } from './AssistantMarkdown';
import type { PinNote } from '../types/window';

interface Props {
  note: PinNote;
}

export function PinNoteWindow({ note }: Props) {
  const tsLabel = formatTs(note.ts);
  const pinnedAgo = formatRelative(note.pinnedAt);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--pin-note-bg, var(--bg-1))',
      }}
    >
      {/* Header: agent + session + when */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--line-2)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          fontSize: 11,
          fontFamily: '"JetBrains Mono", monospace',
          color: 'var(--text-2)',
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            background: note.agentColor
              ? `linear-gradient(135deg, ${note.agentColor}, ${note.agentColor}88)`
              : 'var(--bg-3)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
          }}
        >
          {note.agentIcon ?? '🤖'}
        </span>
        <span style={{ color: 'var(--text-0)', fontWeight: 600 }}>{note.agentName}</span>
        <span>·</span>
        <span>{note.sessionLabel ?? note.sessionId}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }} title={tsLabel}>
          {tsLabel}
        </span>
      </div>

      {/* Body: scrollable markdown render */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 14px',
          fontSize: 13,
          lineHeight: 1.5,
          userSelect: 'text',
        }}
      >
        {note.text ? (
          <AssistantMarkdown content={note.text} />
        ) : (
          <span style={{ color: 'var(--text-3)' }}>(empty message)</span>
        )}
      </div>

      {/* Footer: when this pin itself was made */}
      <div
        style={{
          padding: '6px 12px',
          borderTop: '1px solid var(--line-2)',
          flexShrink: 0,
          fontSize: 10,
          fontFamily: '"JetBrains Mono", monospace',
          color: 'var(--text-3)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>📌 pinned {pinnedAgo}</span>
      </div>
    </div>
  );
}

function formatTs(ts: number): string {
  if (!Number.isFinite(ts)) return '?';
  const d = new Date(ts);
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (isToday) return `${hh}:${mm}`;
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${dd} ${hh}:${mm}`;
}

function formatRelative(ts: number): string {
  if (!Number.isFinite(ts)) return '?';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
