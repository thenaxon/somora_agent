// Start menu behind the koala in the taskbar (2026-11-16, the operator's
// ask: with many windows open the desktop tiles are covered, and every
// agent and app should stay one click away). It sits above every window.
//
// Agents: a click opens the main chat, like the tile; the › button or a
// right-click opens the same menu as a right-click on the tile, which also
// holds "On the desktop". Apps: a click opens the app, the pin puts its
// tile on the desktop or takes it off. A search field on top (focused on
// open) narrows both lists; Enter opens the first hit, arrow keys move.
// Settings and Sign out at the bottom.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, LogOut, Pin, PinOff, Search, Settings } from 'lucide-react';
import type { AgentInfo } from '../lib/api';
import { searchEntries } from '../lib/start-menu';

export interface StartAgent {
  agent: AgentInfo;
  /** A turn is running right now. */
  working: boolean;
  /** Unread replies. */
  unread: boolean;
}

export interface StartApp {
  /** Tile id, `app:<name>`. */
  id: string;
  label: string;
  glyph: ReactNode;
  /** Its window is open. */
  active: boolean;
  open: () => void;
  /** Count shown next to the name (the wiki's pending lucid findings). */
  badge?: number;
}

interface Props {
  agents: StartAgent[];
  apps: StartApp[];
  /** Tile ids taken off the desktop. */
  hidden: ReadonlySet<string>;
  onToggleDesktop: (id: string) => void;
  onOpenAgent: (agent: AgentInfo) => void;
  /** Open the agent's menu at this point (viewport coordinates). */
  onAgentMenu: (agent: AgentInfo, x: number, y: number) => void;
  onOpenSettings?: (() => void) | undefined;
  onSignOut: () => void;
  onClose: () => void;
  /** The koala button: a press on it toggles, it is not "outside". */
  anchor: HTMLElement | null;
}

type Hit = { kind: 'agent'; id: string; name: string; extra?: string; item: StartAgent } | { kind: 'app'; id: string; name: string; item: StartApp };

export function StartMenu({ agents, apps, hidden, onToggleDesktop, onOpenAgent, onAgentMenu, onOpenSettings, onSignOut, onClose, anchor }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(-1);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on a press outside: not the koala (it toggles), not the agent
  // menu opened from here (a portal of its own).
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Element | null;
      if (!t) return;
      if (ref.current?.contains(t) || anchor?.contains(t) || t.closest?.('.agent-context-menu')) return;
      onClose();
    }
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  const hits = useMemo(() => {
    const a: Hit[] = searchEntries(
      agents.map((item) => ({ kind: 'agent' as const, id: `agent:${item.agent.name}`, name: item.agent.name, ...(item.agent.role ? { extra: item.agent.role } : {}), item })),
      query,
    );
    const p: Hit[] = searchEntries(
      apps.map((item) => ({ kind: 'app' as const, id: item.id, name: item.label, item })),
      query,
    );
    return { agents: a, apps: p, all: [...a, ...p] };
  }, [agents, apps, query]);

  function activate(h: Hit) {
    if (h.kind === 'agent') onOpenAgent(h.item.agent);
    else h.item.open();
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.target !== inputRef.current) {
      // Arrows and Enter belong to the search field; on a focused
      // button (a pin, Settings) they keep their own meaning.
      return;
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = hits.all.length;
      if (n === 0) return;
      setSel((s) => (e.key === 'ArrowDown' ? (s + 1) % n : (s - 1 + n) % n));
    } else if (e.key === 'Enter') {
      const h = hits.all[sel >= 0 ? sel : 0];
      if (h && (sel >= 0 || query.trim())) {
        e.preventDefault();
        activate(h);
      }
    }
  }

  const selectedId = sel >= 0 ? hits.all[sel]?.id : undefined;

  // The columns scroll on their own; keep the selected row in sight.
  useEffect(() => {
    if (!selectedId) return;
    ref.current?.querySelector('.start-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const node = (
    <div ref={ref} className="start-menu" role="dialog" aria-label="Start menu" data-testid="start-menu" onKeyDown={onKeyDown}>
      <label className="start-search">
        <Search size={14} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Search agents and apps"
          spellCheck={false}
          autoComplete="off"
          data-testid="start-search"
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(e.target.value.trim() ? 0 : -1);
          }}
        />
      </label>

      <div className="start-columns">
        <section className="start-column" aria-label="Agents">
          <div className="start-title">Agents</div>
          {hits.agents.length === 0 && <div className="start-empty">{query ? 'No agent matches.' : 'No agents.'}</div>}
          {hits.agents.map((h) => {
            if (h.kind !== 'agent') return null;
            const { agent, working, unread } = h.item;
            const openMenu = (x: number, y: number) => onAgentMenu(agent, x, y);
            return (
              <div
                key={h.id}
                className={`start-row${selectedId === h.id ? ' selected' : ''}`}
                data-testid={`start-agent-${agent.name}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openMenu(e.clientX, e.clientY);
                }}
              >
                <button type="button" className="start-row-main" onClick={() => activate(h)} title={`Open ${agent.name} · main`}>
                  <span className="start-row-icon">{agent.icon ?? '🤖'}</span>
                  <span className="start-row-name">{agent.name}</span>
                  {agent.role && <span className="start-row-extra">{agent.role.toLowerCase()}</span>}
                  {working && <span className="start-dot working" title="Working" />}
                  {unread && <span className="start-dot unread" title="Unread replies" />}
                  {hidden.has(h.id) && <span className="start-row-off" title="Not on the desktop"><PinOff size={11} /></span>}
                </button>
                <button
                  type="button"
                  className="start-row-side"
                  aria-label={`${agent.name} menu`}
                  title="Sessions, configure, on the desktop"
                  data-testid={`start-agent-menu-${agent.name}`}
                  onClick={(e) => {
                    // Beside the start menu, level with the row — not over the apps.
                    const row = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const menu = ref.current?.getBoundingClientRect();
                    openMenu((menu?.right ?? row.right) + 6, row.top);
                  }}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            );
          })}
        </section>

        <section className="start-column" aria-label="Apps">
          <div className="start-title">Apps</div>
          {hits.apps.length === 0 && <div className="start-empty">No app matches.</div>}
          {hits.apps.map((h) => {
            if (h.kind !== 'app') return null;
            const app = h.item;
            const on = !hidden.has(app.id);
            return (
              <div key={h.id} className={`start-row${selectedId === h.id ? ' selected' : ''}`} data-testid={`start-${app.id.replace(':', '-')}`}>
                <button type="button" className="start-row-main" onClick={() => activate(h)} title={`Open ${app.label}`}>
                  <span className="start-row-icon">{app.glyph}</span>
                  <span className="start-row-name">{app.label}</span>
                  {app.badge ? <span className="start-badge">{app.badge > 9 ? '9+' : app.badge}</span> : null}
                  {app.active && <span className="start-dot open" title="Open" />}
                </button>
                <button
                  type="button"
                  className={`start-row-side start-pin${on ? ' on' : ''}`}
                  aria-pressed={on}
                  aria-label={`${app.label} on the desktop`}
                  title={on ? 'On the desktop — click to take it off' : 'Not on the desktop — click to put it there'}
                  data-testid={`start-pin-${app.id.replace(':', '-')}`}
                  onClick={() => onToggleDesktop(app.id)}
                >
                  {on ? <Pin size={13} /> : <PinOff size={13} />}
                </button>
              </div>
            );
          })}
        </section>
      </div>

      <div className="start-footer">
        {onOpenSettings && (
          <button
            type="button"
            className="start-footer-item"
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
          >
            <Settings size={13} /> Settings…
          </button>
        )}
        <button type="button" className="start-footer-item" onClick={onSignOut}>
          <LogOut size={13} /> Sign out
        </button>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}
