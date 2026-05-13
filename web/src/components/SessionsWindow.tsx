// Sessions tool — cross-agent session browser with archive support.
//
// Sits in the AppDock next to tmux/terminal. Lists every (agent, session)
// pair the server knows, with composite status icons (live / archived /
// REM-state), bulk archive, click-to-chat, manual reload, and a 60s
// auto-refresh while the window is open.
//
// Archive is meta-flag based (no file movement). Backend: GET /sessions,
// POST /agents/<a>/sessions/<s>/archive, POST .../unarchive. See
// private/sessions-tool-design.md for the full architecture.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Archive, ArchiveRestore, MessageSquare } from 'lucide-react';
import { api, type GlobalSessionRow, type ProjectInfo } from '../lib/api';
import { DreamPhaseIcon } from './DreamPhaseIcon';
import { useChatContext } from './ChatProvider';

type TabKey = 'active' | 'archived' | 'all';
type SortKey = 'lastActivity' | 'messageCount' | 'byteSize' | 'agent';

interface Props {
  onOpenChat: (args: { agent: string; sessionId: string; agentLabel: string }) => void;
}

export function SessionsWindow({ onOpenChat }: Props) {
  const [rows, setRows] = useState<GlobalSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('active');
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState<Set<string>>(new Set());
  const [engineFilter, setEngineFilter] = useState<Set<string>>(new Set());
  const [dreamFilter, setDreamFilter] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('lastActivity');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);
  // Project lookup — single GET /projects (including archived) at mount,
  // then session rows resolve their slug → name + color from this map.
  // Cheap because the list is small and rarely changes during a Sessions-
  // window lifetime. Only fetched when the feature is enabled — saves a
  // round-trip otherwise.
  const { projectsEnabled } = useChatContext();
  const [projectsBySlug, setProjectsBySlug] = useState<Record<string, ProjectInfo>>({});
  useEffect(() => {
    if (!projectsEnabled) return;
    api
      .projects(true)
      .then((list) => {
        const map: Record<string, ProjectInfo> = {};
        for (const p of list) map[p.slug] = p;
        setProjectsBySlug(map);
      })
      .catch(() => {
        /* projects feature off — leave map empty, rows just show slug */
      });
  }, [projectsEnabled]);

  // Fetch covers both active + archived in one round-trip (the backend
  // returns archived only when explicitly requested). The tab decides
  // which subset to render.
  const fetchSessions = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const data = await api.globalSessions({
        includeArchived: true,
        ...(signal ? { signal } : {}),
      });
      setRows(data);
      setLoading(false);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void fetchSessions(ac.signal);
    return () => ac.abort();
  }, [fetchSessions]);

  // 60s auto-refresh while window is mounted + user has the toggle on.
  // Restarts on toggle change so we don't have a stale interval running.
  useEffect(() => {
    if (!autoRefresh) return;
    const handle = setInterval(() => void fetchSessions(), 60_000);
    return () => clearInterval(handle);
  }, [autoRefresh, fetchSessions]);

  // Derived: available agents + engines for the filter chips. Sorted by
  // first occurrence so the filter UI stays stable across refreshes.
  const agentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.agent);
    return [...set].sort();
  }, [rows]);

  const engineOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.engine) set.add(r.engine);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (tab === 'active') out = out.filter((r) => !r.isArchived);
    else if (tab === 'archived') out = out.filter((r) => r.isArchived);
    // tab === 'all' → no filter on archive state
    if (agentFilter.size > 0) out = out.filter((r) => agentFilter.has(r.agent));
    if (engineFilter.size > 0) out = out.filter((r) => r.engine && engineFilter.has(r.engine));
    if (dreamFilter.size > 0) out = out.filter((r) => dreamFilter.has(r.dream.status));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(
        (r) =>
          r.slug.toLowerCase().includes(q) ||
          r.agent.toLowerCase().includes(q) ||
          r.sessionId.toLowerCase().includes(q),
      );
    }
    const sorted = [...out].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      switch (sortKey) {
        case 'lastActivity':
          return dir * ((a.lastActivity ?? '').localeCompare(b.lastActivity ?? ''));
        case 'messageCount':
          return dir * (a.messageCount - b.messageCount);
        case 'byteSize':
          return dir * (a.byteSize - b.byteSize);
        case 'agent':
          return dir * a.agent.localeCompare(b.agent);
      }
    });
    return sorted;
  }, [rows, tab, agentFilter, engineFilter, dreamFilter, search, sortKey, sortDir]);

  const kpi = useMemo(() => {
    const all = rows.length;
    const live = rows.filter((r) => r.liveSubscribers > 0).length;
    const archived = rows.filter((r) => r.isArchived).length;
    const dreamed = rows.filter((r) => r.dream.status === 'dreamed').length;
    const partial = rows.filter((r) => r.dream.status === 'partial').length;
    return { all, live, archived, dreamed, partial };
  }, [rows]);

  const toggleSet = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const handleArchiveOne = useCallback(
    async (row: GlobalSessionRow) => {
      try {
        if (row.isArchived) {
          await api.unarchiveSession(row.agent, row.sessionId);
        } else {
          if (row.isMain) {
            // Server enforces this — surface ahead of time so the user
            // doesn't get a confusing error.
            // eslint-disable-next-line no-alert
            alert("Can't archive a 'main' session directly. Use /reset to spawn an archived copy.");
            return;
          }
          await api.archiveSession(row.agent, row.sessionId);
        }
        await fetchSessions();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[somora-web] (un)archive failed', err);
        setError((err as Error).message);
      }
    },
    [fetchSessions],
  );

  const handleBulkArchive = useCallback(async () => {
    const targets = filtered.filter((r) => selected.has(rowKey(r)) && !r.isMain);
    for (const r of targets) {
      try {
        if (r.isArchived) await api.unarchiveSession(r.agent, r.sessionId);
        else await api.archiveSession(r.agent, r.sessionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[somora-web] bulk archive skipped', r.agent, r.sessionId, err);
      }
    }
    setSelected(new Set());
    await fetchSessions();
  }, [filtered, selected, fetchSessions]);

  const allInTabSelected = filtered.length > 0 && filtered.every((r) => selected.has(rowKey(r)));

  return (
    <div style={{ padding: 12, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, color: 'var(--text-1)', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header / KPI / controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Sessions</div>
        <div style={{ color: 'var(--text-2)' }}>
          {kpi.all} total · {kpi.live} live · {kpi.archived} archived · {kpi.dreamed} dreamed · {kpi.partial} partial
        </div>
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-2)' }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          auto 60s
        </label>
        <button
          type="button"
          className="chat-icon-btn"
          title="Reload"
          onClick={() => void fetchSessions()}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {(['active', 'archived', 'all'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: '4px 10px',
              border: '1px solid var(--bg-3)',
              background: tab === t ? 'var(--bg-3)' : 'transparent',
              color: tab === t ? 'var(--text-1)' : 'var(--text-2)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 11,
            }}
          >
            {t === 'active' ? `Active (${rows.filter((r) => !r.isArchived).length})` : t === 'archived' ? `Archived (${kpi.archived})` : `All (${rows.length})`}
          </button>
        ))}
      </div>

      {/* Filter row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="search slug / agent / id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: '4px 8px',
            background: 'var(--bg-2)',
            border: '1px solid var(--bg-3)',
            color: 'var(--text-1)',
            fontFamily: 'inherit',
            fontSize: 11,
            minWidth: 200,
          }}
        />
        <ChipGroup
          label="agent"
          options={agentOptions}
          selected={agentFilter}
          onToggle={(k) => setAgentFilter((s) => toggleSet(s, k))}
        />
        {engineOptions.length > 0 && (
          <ChipGroup
            label="engine"
            options={engineOptions}
            selected={engineFilter}
            onToggle={(k) => setEngineFilter((s) => toggleSet(s, k))}
          />
        )}
        <ChipGroup
          label="REM"
          options={['dreamed', 'partial', 'never']}
          selected={dreamFilter}
          onToggle={(k) => setDreamFilter((s) => toggleSet(s, k))}
        />
      </div>

      {/* Bulk action bar — only visible when something is selected */}
      {selected.size > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            background: 'var(--bg-2)',
            border: '1px solid var(--accent)',
            marginBottom: 8,
          }}
        >
          <span>{selected.size} selected</span>
          <button
            type="button"
            onClick={() => void handleBulkArchive()}
            style={{
              padding: '4px 10px',
              background: 'var(--accent)',
              color: 'var(--bg-1)',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 11,
            }}
          >
            {tab === 'archived' ? 'Unarchive selected' : 'Archive selected'}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            style={{
              padding: '4px 10px',
              background: 'transparent',
              color: 'var(--text-2)',
              border: '1px solid var(--bg-3)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 11,
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      {error && (
        <div style={{ color: 'var(--warn)', padding: 8, marginBottom: 8 }}>
          Error: {error}
        </div>
      )}
      {loading ? (
        <div style={{ color: 'var(--text-2)', padding: 8 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: 'var(--text-2)', padding: 8 }}>No sessions match.</div>
      ) : (
        <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: 'var(--text-2)', textAlign: 'left' }}>
                <th style={cellHead}>
                  <input
                    type="checkbox"
                    checked={allInTabSelected}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelected(new Set(filtered.filter((r) => !r.isMain).map(rowKey)));
                      } else {
                        setSelected(new Set());
                      }
                    }}
                  />
                </th>
                <SortHead label="Agent" onClick={() => toggleSort(setSortKey, setSortDir, sortKey, sortDir, 'agent')} active={sortKey === 'agent'} dir={sortDir} />
                <th style={cellHead}>Slug</th>
                {projectsEnabled && <th style={cellHead}>Project</th>}
                <th style={cellHead}>Engine</th>
                <th style={cellHead}>Status</th>
                <SortHead label="Last activity" onClick={() => toggleSort(setSortKey, setSortDir, sortKey, sortDir, 'lastActivity')} active={sortKey === 'lastActivity'} dir={sortDir} />
                <SortHead label="Msgs" onClick={() => toggleSort(setSortKey, setSortDir, sortKey, sortDir, 'messageCount')} active={sortKey === 'messageCount'} dir={sortDir} />
                <SortHead label="Size" onClick={() => toggleSort(setSortKey, setSortDir, sortKey, sortDir, 'byteSize')} active={sortKey === 'byteSize'} dir={sortDir} />
                <th style={cellHead}>REM</th>
                <th style={cellHead}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const key = rowKey(r);
                const isSelected = selected.has(key);
                return (
                  <tr
                    key={key}
                    style={{
                      borderTop: '1px solid var(--bg-3)',
                      background: isSelected ? 'var(--bg-2)' : 'transparent',
                      cursor: 'pointer',
                    }}
                    onClick={(e) => {
                      // Click outside the checkbox / action button opens chat.
                      const target = e.target as HTMLElement;
                      if (target.closest('input,button')) return;
                      onOpenChat({
                        agent: r.agent,
                        sessionId: r.sessionId,
                        agentLabel: `${r.agent} · ${r.slug}`,
                      });
                    }}
                  >
                    <td style={cellBody} onClick={(e) => e.stopPropagation()}>
                      {!r.isMain && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => setSelected((s) => toggleSet(s, key))}
                        />
                      )}
                    </td>
                    <td style={{ ...cellBody, color: r.agentColor ?? 'var(--text-1)' }}>
                      {r.agentIcon ? `${r.agentIcon} ` : ''}{r.agent}
                    </td>
                    <td style={cellBody}>{r.slug}{r.isMain ? ' ★' : ''}</td>
                    {projectsEnabled && (
                      <td style={cellBody}>
                        <ProjectCell
                          slug={r.projectSlug}
                          project={r.projectSlug ? projectsBySlug[r.projectSlug] : undefined}
                        />
                      </td>
                    )}
                    <td style={{ ...cellBody, color: 'var(--text-2)' }}>{r.engine ?? '—'}</td>
                    <td style={cellBody}>
                      <StatusCell row={r} />
                    </td>
                    <td style={{ ...cellBody, color: 'var(--text-2)' }}>{fmtRelTime(r.lastActivity)}</td>
                    <td style={{ ...cellBody, textAlign: 'right' }}>{r.messageCount}</td>
                    <td style={{ ...cellBody, textAlign: 'right', color: 'var(--text-2)' }}>{fmtBytes(r.byteSize)}</td>
                    <td style={cellBody}>
                      <DreamCell row={r} />
                    </td>
                    <td style={cellBody} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          type="button"
                          className="chat-icon-btn"
                          title="Open chat"
                          onClick={() =>
                            onOpenChat({
                              agent: r.agent,
                              sessionId: r.sessionId,
                              agentLabel: `${r.agent} · ${r.slug}`,
                            })
                          }
                        >
                          <MessageSquare size={12} />
                        </button>
                        {!r.isMain && (
                          <button
                            type="button"
                            className="chat-icon-btn"
                            title={r.isArchived ? 'Unarchive' : 'Archive'}
                            onClick={() => void handleArchiveOne(r)}
                          >
                            {r.isArchived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function rowKey(r: GlobalSessionRow): string {
  return `${r.agent}:${r.sessionId}`;
}

function toggleSort(
  setKey: (k: SortKey) => void,
  setDir: (d: 'asc' | 'desc') => void,
  curKey: SortKey,
  curDir: 'asc' | 'desc',
  next: SortKey,
) {
  if (curKey === next) {
    setDir(curDir === 'asc' ? 'desc' : 'asc');
  } else {
    setKey(next);
    setDir('desc');
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtRelTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  if (diff < 0) return iso.slice(0, 16);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 60) return `${Math.floor(day / 7)}w ago`;
  return iso.slice(0, 10);
}

function StatusCell({ row }: { row: GlobalSessionRow }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      {row.liveSubscribers > 0 && (
        <span title={`${row.liveSubscribers} live subscriber(s)`} style={{ color: '#4ade80' }}>●</span>
      )}
      {row.isArchived && <span title="archived">📦</span>}
      {row.isMain && <span title="main session" style={{ color: 'var(--accent)' }}>★</span>}
    </span>
  );
}

function DreamCell({ row }: { row: GlobalSessionRow }) {
  const { status, lagEvents } = row.dream;
  if (status === 'dreamed') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <DreamPhaseIcon phase="rem" size={11} title="fully dreamed" /> ✓
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--warn)' }}>
        <DreamPhaseIcon phase="rem" size={11} title={`${lagEvents} new events since last REM`} /> ⚠{lagEvents}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--text-2)' }}>
      <DreamPhaseIcon phase="rem" size={11} title="never dreamed" /> ○
    </span>
  );
}

function ChipGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
      <span style={{ color: 'var(--text-2)', marginRight: 4 }}>{label}:</span>
      {options.map((o) => {
        const active = selected.has(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => onToggle(o)}
            style={{
              padding: '2px 6px',
              border: '1px solid var(--bg-3)',
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? 'var(--bg-1)' : 'var(--text-2)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 10,
            }}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

const cellHead: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 10,
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

const cellBody: React.CSSProperties = {
  padding: '6px 8px',
  whiteSpace: 'nowrap',
};

function SortHead({
  label,
  onClick,
  active,
  dir,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
  dir: 'asc' | 'desc';
}) {
  return (
    <th
      style={{ ...cellHead, cursor: 'pointer' }}
      onClick={onClick}
    >
      {label}{active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

/** Renders a small color-coded chip in the Sessions table when a row
 *  has a pinned project. Falls back to slug-as-text when the project
 *  lookup map hasn't loaded yet, or has been deleted on disk after
 *  the session got its pin (`project` undefined but slug present). */
function ProjectCell({ slug, project }: { slug?: string; project?: ProjectInfo }) {
  if (!slug) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  if (!project) {
    return (
      <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }} title="project not loaded">
        {slug}
      </span>
    );
  }
  const color = project.color ?? 'var(--text-2)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 6px',
        background: `${typeof color === 'string' && color.startsWith('#') ? `${color}22` : 'transparent'}`,
        border: `1px solid ${typeof color === 'string' && color.startsWith('#') ? `${color}55` : 'var(--line)'}`,
        borderRadius: 3,
        color,
        fontSize: 10,
      }}
      title={`entity: ${project.entity}${project.archived ? ' (archived)' : ''}`}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 1,
          background: color,
        }}
      />
      {project.name}
      {project.archived ? ' ⚠' : ''}
    </span>
  );
}
