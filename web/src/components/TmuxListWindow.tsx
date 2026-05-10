// Tmux session list — the body of the "tmux app" window. Polls
// /tmux/sessions every 5s so newly-created (or killed) sessions
// surface without a manual refresh. Click a row → opens an xterm
// window attached to that session via the window manager.
//
// Origin metadata: when somora's `tmux create` produced the session,
// the row shows "↳ from <agent> · <session>". When tmux knows about
// a session that somora's origin store doesn't (a user fired
// `tmux new` from a host shell), the row labels it "orphan".

import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, Terminal as TerminalIcon } from 'lucide-react';
import { api, type TmuxSessionInfo } from '../lib/api';

interface Props {
  onAttach: (tmuxName: string) => void;
}

export function TmuxListWindow({ onAttach }: Props) {
  const [sessions, setSessions] = useState<TmuxSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.tmuxSessions();
      setSessions(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: '"JetBrains Mono", monospace',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--line)',
          fontSize: 11,
          color: 'var(--text-2)',
        }}
      >
        <span>
          {sessions === null
            ? 'loading…'
            : sessions.length === 0
              ? 'no tmux sessions'
              : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          title="refresh"
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: 'var(--text-3)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <RefreshCw size={11} />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 11, padding: 8 }}>{error}</div>
        )}
        {sessions === null && !error ? (
          <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 24, fontSize: 11 }}>
            loading…
          </div>
        ) : sessions && sessions.length === 0 ? (
          <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 24, fontSize: 11 }}>
            <div>no tmux sessions running on this host</div>
            <div style={{ marginTop: 8, color: 'var(--text-3)' }}>
              ask an agent to create one — `tmux({'{'}action:'create',name:'…'{'}'})`
            </div>
          </div>
        ) : (
          (sessions ?? []).map((s) => (
            <SessionRow key={s.name} session={s} onAttach={() => onAttach(s.name)} />
          ))
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  onAttach,
}: {
  session: TmuxSessionInfo;
  onAttach: () => void;
}) {
  const lastSeen = formatRelative(session.lastActivityEpoch);
  return (
    <div
      onClick={onAttach}
      title={`attach to ${session.name}`}
      style={{
        cursor: 'pointer',
        padding: '8px 10px',
        borderRadius: 4,
        marginBottom: 4,
        background: 'var(--bg-3)',
        border: '1px solid var(--line-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-2)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-3)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <TerminalIcon size={12} style={{ color: 'var(--accent)' }} />
        <span style={{ color: 'var(--text-1)', fontSize: 12, fontWeight: 600 }}>
          {session.name}
        </span>
        <span style={{ color: 'var(--text-3)', fontSize: 10 }}>
          · {session.windows} window{session.windows === 1 ? '' : 's'}
        </span>
        {session.activeCommand && (
          <span style={{ color: 'var(--text-2)', fontSize: 10 }}>
            <Activity size={10} style={{ display: 'inline', marginRight: 2 }} />
            {session.activeCommand}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 10 }}>
          {lastSeen}
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
        {session.origin
          ? `↳ from ${session.origin.agent}${session.origin.session ? ' · ' + session.origin.session : ''}`
          : '↳ orphan (created outside somora)'}
      </div>
    </div>
  );
}

function formatRelative(epoch: number | null): string {
  if (!epoch) return 'never attached';
  const ms = Date.now() - epoch * 1000;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
