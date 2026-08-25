// A single non-agent tile in the sidebar dock (tmux, terminal,
// sessions, sentinel, tools, wiki). Same tile shape as an agent tile
// for visual consistency, but the icon is a lucide glyph in a flat
// tinted square instead of a gradient avatar.
//
// Which tiles exist and in what order is decided in Desktop.tsx; the
// dock's ordering and drag handling live in Dock.tsx.

import type { ReactNode } from 'react';

interface Props {
  label: string;
  icon: ReactNode;
  /** The app's window is open — drives the `.active` highlight. */
  active: boolean;
  onClick: () => void;
  /** Optional count badge in the glyph corner (same slot as the
   *  agent-tile REM badge). */
  badge?: ReactNode;
}

export function AppTile({ label, icon, active, onClick, badge }: Props) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={active ? 'agent-icon active' : 'agent-icon'}
      style={{ width: 88 }}
    >
      <div
        className="agent-icon-glyph"
        style={{
          background: active
            ? 'linear-gradient(180deg, var(--bg-3), var(--bg-2))'
            : 'linear-gradient(180deg, var(--bg-2), var(--bg-1))',
          color: active ? 'var(--accent)' : 'var(--text-2)',
        }}
      >
        {icon}
        {badge}
      </div>
      <div
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 11,
          color: active ? 'var(--text-1)' : 'var(--text-2)',
        }}
      >
        {label}
      </div>
    </div>
  );
}
