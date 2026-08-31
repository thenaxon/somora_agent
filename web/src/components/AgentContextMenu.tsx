// Right-click menu on an agent's desktop icon (2026-08-31, Rene's ask:
// start a new session with an agent without first being in its main
// chat). The agent is the object here; its sessions are properties of
// it — which is also where later agent-wide actions (default model,
// reset, abilities) belong, instead of growing the per-chat ••• menu.
//
// Today: Open main · Recent sessions (last three, most recent first) ·
// New session… (inline name field, validated as you type) · All
// sessions… (the Sessions tool). Rendered into a portal on <body> so it
// sits above windows and the taskbar; fixed at the pointer, nudged
// back inside the viewport when it would spill. Visual language
// mirrors ChatMenuPopover / SlashCommandPopup.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Clock, List, MessageSquare, Plus } from 'lucide-react';
import { api, type AgentInfo, type SessionSummary } from '../lib/api';
import { suggestSlug, validateSessionSlug } from '../lib/session-slug';

const MENU_WIDTH = 260;
const RECENT_LIMIT = 3;

interface Props {
  agent: AgentInfo;
  /** Pointer position of the right-click, viewport coordinates. */
  x: number;
  y: number;
  onClose: () => void;
  /** Open (or focus) a chat window on this agent + session. `label`
   *  is what the window title shows after the agent name. */
  onOpenSession: (agent: AgentInfo, sessionId: string, label: string) => void;
  /** Open the cross-agent Sessions tool. */
  onOpenSessionsTool: () => void;
}

export function AgentContextMenu({ agent, x, y, onClose, onOpenSession, onOpenSessionsTool }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [recent, setRecent] = useState<SessionSummary[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Recent sessions — everything but main, newest activity first.
  useEffect(() => {
    let cancelled = false;
    api
      .sessions(agent.name)
      .then((list) => {
        if (cancelled) return;
        const others = list
          .filter((s) => !s.isMain)
          .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
          .slice(0, RECENT_LIMIT);
        setRecent(others);
      })
      .catch((err) => {
        if (!cancelled) setRecentError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.name]);

  // Keep the menu inside the viewport: measure after paint, nudge left
  // / up when it would spill (a right-click near the bottom-right
  // corner is the common case for a tile column on the left… and the
  // most annoying place for a menu to vanish).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, naming, recent, submitError]);

  // Close on outside press, Esc, another context menu, resize.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    function onCtx(e: MouseEvent) {
      if (ref.current && ref.current.contains(e.target as Node)) {
        e.preventDefault();
        return;
      }
      onClose();
    }
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('contextmenu', onCtx, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('contextmenu', onCtx, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);

  const check = validateSessionSlug(name);

  async function create(): Promise<void> {
    if (!check.ok || creating) return;
    setCreating(true);
    setSubmitError(null);
    try {
      const created = await api.createSession(agent.name, check.slug);
      onOpenSession(agent, created.id, created.slug);
      onClose();
    } catch (err) {
      setSubmitError((err as Error).message.replace(/^create session \d+:?\s*/i, '') || 'Could not create the session.');
      setCreating(false);
    }
  }

  const node = (
    <div
      ref={ref}
      role="menu"
      aria-label={`${agent.name} menu`}
      data-testid="agent-context-menu"
      className="agent-context-menu"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 10000,
        width: MENU_WIDTH,
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 12,
        color: 'var(--text-1)',
        padding: 4,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={headerStyle}>
        <span style={{ fontSize: 14 }}>{agent.icon ?? '🤖'}</span>
        <span style={{ fontWeight: 600, color: 'var(--text-0)' }}>{agent.name}</span>
        {agent.role && <span style={{ color: 'var(--text-3)' }}>· {agent.role.toLowerCase()}</span>}
      </div>

      <MenuItem
        icon={<MessageSquare size={13} />}
        label="Open main"
        testId="agent-menu-open-main"
        onClick={() => {
          onOpenSession(agent, 'main', 'main');
          onClose();
        }}
      />

      <div style={sectionTitle}>
        <Clock size={11} style={{ verticalAlign: -1 }} /> recent sessions
      </div>
      {recent === null && !recentError && <div style={muted}>Loading…</div>}
      {recentError && (
        <div style={{ ...muted, color: 'var(--danger, #e5534b)' }}>
          <AlertTriangle size={11} style={{ verticalAlign: -1 }} /> {recentError}
        </div>
      )}
      {recent && recent.length === 0 && <div style={muted}>Only main so far.</div>}
      {recent?.map((s) => (
        <MenuItem
          key={s.id}
          icon={<span style={{ width: 13, display: 'inline-block' }} />}
          label={s.slug}
          hint={relativeTime(s.lastActivity)}
          testId={`agent-menu-recent-${s.slug}`}
          onClick={() => {
            onOpenSession(agent, s.id, s.slug);
            onClose();
          }}
        />
      ))}

      <div style={divider} />

      {!naming ? (
        <MenuItem
          icon={<Plus size={13} />}
          label="New session…"
          testId="agent-menu-new-session"
          onClick={() => setNaming(true)}
        />
      ) : (
        <div style={{ padding: '4px 6px 6px' }}>
          <div style={{ color: 'var(--text-3)', fontSize: 11, marginBottom: 4 }}>
            Name the new session
          </div>
          <input
            ref={inputRef}
            data-testid="agent-menu-session-name"
            value={name}
            placeholder="e.g. research-notes"
            spellCheck={false}
            autoComplete="off"
            disabled={creating}
            onChange={(e) => {
              setName(e.target.value);
              setSubmitError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setNaming(false);
                setName('');
                setSubmitError(null);
              }
            }}
            style={inputStyle}
          />
          <div
            data-testid="agent-menu-session-hint"
            style={{
              marginTop: 4,
              fontSize: 11,
              color: submitError || (name && !check.ok) ? 'var(--danger, #e5534b)' : 'var(--text-3)',
              minHeight: 14,
            }}
          >
            {submitError
              ? submitError
              : name.length === 0
                ? 'Enter to create · Esc to cancel'
                : check.ok
                  ? `Enter → opens "${check.slug}" in a new window`
                  : check.reason}
          </div>
          {name.length > 0 && suggestSlug(name) !== name && suggestSlug(name).length > 0 && !check.ok && (
            <button
              type="button"
              data-testid="agent-menu-session-suggest"
              onClick={() => {
                setName(suggestSlug(name));
                inputRef.current?.focus();
              }}
              style={suggestButton}
            >
              use "{suggestSlug(name)}"
            </button>
          )}
        </div>
      )}

      <MenuItem
        icon={<List size={13} />}
        label="All sessions…"
        testId="agent-menu-all-sessions"
        onClick={() => {
          onOpenSessionsTool();
          onClose();
        }}
      />
    </div>
  );
  return createPortal(node, document.body);
}

function MenuItem({
  icon,
  label,
  hint,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <div
      role="menuitem"
      tabIndex={0}
      data-testid={testId}
      className="agent-context-menu-item"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={itemStyle}
    >
      <span style={{ color: 'var(--text-2)', display: 'inline-flex' }}>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {hint && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{hint}</span>}
    </div>
  );
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px 8px',
  borderBottom: '1px solid var(--line)',
  marginBottom: 4,
};
const sectionTitle: React.CSSProperties = {
  padding: '6px 8px 2px',
  fontSize: 10,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: 'var(--text-3)',
};
const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderRadius: 4,
  cursor: 'pointer',
};
const divider: React.CSSProperties = {
  height: 1,
  background: 'var(--line)',
  margin: '4px 6px',
};
const muted: React.CSSProperties = {
  padding: '4px 8px',
  color: 'var(--text-3)',
  fontSize: 11,
};
const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 6px',
  background: 'var(--bg-1)',
  border: '1px solid var(--line-2)',
  borderRadius: 3,
  color: 'var(--text-0)',
  fontSize: 12,
  fontFamily: '"JetBrains Mono", monospace',
  outline: 'none',
};
const suggestButton: React.CSSProperties = {
  marginTop: 4,
  padding: '2px 6px',
  background: 'transparent',
  border: '1px solid var(--line-2)',
  borderRadius: 3,
  color: 'var(--text-2)',
  fontSize: 11,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
