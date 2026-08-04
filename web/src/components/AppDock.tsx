// Apps dock — sits below the agent dock and hosts non-agent surfaces
// (tmux today; files-browser, logs, etc. when they land). Same tile
// shape as the agent dock for visual consistency, but the icons are
// lucide glyphs in a flat tinted square instead of gradient avatars.

import { useEffect, useState, type ReactNode } from 'react';
import { Bell, BookOpen, MessagesSquare, Square, Terminal } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  /** Names of apps whose window is currently open — drives the
   *  `.active` highlight on the dock tile. Today: 'tmux',
   *  'sessions', 'sentinel', 'wiki'. Future apps register here. */
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
  /** Open or focus the read-only Wiki Explorer. Singleton. */
  onWikiClick: () => void;
  /** Pending lucid findings awaiting review (server-global) — badge
   *  on the wiki tile. Lucid is platform-wide wiki cleanup, so the
   *  badge lives HERE and not on any single agent (2026-07-29
   *  feedback: pending lucid runs were invisible in the UI). */
  lucidPendingFindings?: number;
  /** created_at of the oldest pending run — tooltip staleness hint. */
  lucidOldestPendingAt?: string;
}

export function AppDock({
  activeApps,
  onTmuxClick,
  onTerminalClick,
  onSessionsClick,
  onSentinelClick,
  onWikiClick,
  lucidPendingFindings = 0,
  lucidOldestPendingAt,
}: Props) {
  const isTmuxActive = activeApps?.has('tmux') ?? false;
  const isSessionsActive = activeApps?.has('sessions') ?? false;
  const isSentinelActive = activeApps?.has('sentinel') ?? false;
  const isWikiActive = activeApps?.has('wiki') ?? false;
  // The wiki is opt-in (wiki.enabled + obsidian.vault). A tile that
  // opens a window which can only say "not configured" is worse than no
  // tile — so the UI gate matches the server's 503 gate.
  const [wikiEnabled, setWikiEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api
      .wikiStatus()
      .then((s) => {
        if (!cancelled) setWikiEnabled(s.enabled);
      })
      .catch(() => {
        // Older server without the route — leave the tile hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);
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
      {wikiEnabled && (
        <AppTile
          label="wiki"
          icon={<BookOpen size={26} />}
          active={isWikiActive}
          onClick={onWikiClick}
          badge={
            lucidPendingFindings > 0 ? (
              <span
                className="rem-badge lucid"
                title={
                  `${lucidPendingFindings} lucid finding${lucidPendingFindings === 1 ? '' : 's'} ` +
                  `awaiting review${
                    lucidOldestPendingAt
                      ? ` (oldest run from ${lucidOldestPendingAt.slice(0, 10)})`
                      : ''
                  } — review with any agent via dream_review`
                }
              >
                {lucidPendingFindings > 9 ? '9+' : lucidPendingFindings}
              </span>
            ) : undefined
          }
        />
      )}
    </>
  );
}

function AppTile({
  label,
  icon,
  active,
  onClick,
  badge,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  /** Optional count badge in the glyph corner (same slot as the
   *  agent-dock REM badge). */
  badge?: ReactNode;
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
