// Apps dock — sits below the agent dock and hosts non-agent surfaces
// (tmux today; files-browser, logs, etc. when they land). Same tile
// shape as the agent dock for visual consistency, but the icons are
// lucide glyphs in a flat tinted square instead of gradient avatars.

import type { ReactNode } from 'react';
import { Terminal } from 'lucide-react';

interface Props {
  /** Names of apps whose window is currently open — drives the
   *  `.active` highlight on the dock tile. Tmux is the only one for
   *  now; future apps register here. */
  activeApps?: Set<string>;
  onTmuxClick: () => void;
}

export function AppDock({ activeApps, onTmuxClick }: Props) {
  const isTmuxActive = activeApps?.has('tmux') ?? false;
  // No own positioned wrapper — slots into the unified `.agent-dock`
  // flex-wrap container alongside agent tiles. Apps follow agents in
  // the same column; overflow wraps right.
  return (
    <AppTile
      label="tmux"
      icon={<Terminal size={28} />}
      active={isTmuxActive}
      onClick={onTmuxClick}
    />
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
