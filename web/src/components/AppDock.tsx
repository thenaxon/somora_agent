// Apps dock — sits below the agent dock and hosts non-agent surfaces
// (tmux today; files-browser, logs, etc. when they land). Same tile
// shape as the agent dock for visual consistency, but the icons are
// lucide glyphs in a flat tinted square instead of gradient avatars.

import type { ReactNode } from 'react';
import { Bell, MessagesSquare, Square, Terminal } from 'lucide-react';

interface Props {
  /** Names of apps whose window is currently open — drives the
   *  `.active` highlight on the dock tile. Today: 'tmux',
   *  'sessions', 'sentinel'. Future apps register here. */
  activeApps?: Set<string>;
  onTmuxClick: () => void;
  /** Spawns a fresh shell terminal in the somora workspace.
   *  Non-singleton: every click adds another independent terminal
   *  window, so the tile never shows an active state. */
  onTerminalClick: () => void;
  /** Open or focus the cross-agent Sessions browser. Singleton. */
  onSessionsClick: () => void;
  /** Open or focus the Sentinel trigger inspector. Singleton. */
  onSentinelClick: () => void;
}

export function AppDock({
  activeApps,
  onTmuxClick,
  onTerminalClick,
  onSessionsClick,
  onSentinelClick,
}: Props) {
  const isTmuxActive = activeApps?.has('tmux') ?? false;
  const isSessionsActive = activeApps?.has('sessions') ?? false;
  const isSentinelActive = activeApps?.has('sentinel') ?? false;
  return (
    <>
      <AppTile
        label="tmux"
        icon={<Terminal size={28} />}
        active={isTmuxActive}
        onClick={onTmuxClick}
      />
      <AppTile
        label="terminal"
        icon={<Square size={26} strokeWidth={1.5} />}
        active={false}
        onClick={onTerminalClick}
      />
      <AppTile
        label="sessions"
        icon={<MessagesSquare size={26} />}
        active={isSessionsActive}
        onClick={onSessionsClick}
      />
      <AppTile
        label="sentinel"
        icon={<Bell size={26} />}
        active={isSentinelActive}
        onClick={onSentinelClick}
      />
    </>
  );
}

function AppTile({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
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
