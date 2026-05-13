// Project chip + switcher popover for the chat-window header (Phase
// Projects v1). Sits in the chat-header-actions cluster (Position B —
// right side near the ••• button) so it's discoverable without
// stealing focus from the agent's primary identity.
//
// States:
//   - linked: filled pill with project.color + name, click → switcher
//             popover with the project's full details + Unlink button
//   - unlinked: subtle "+" / folder-icon ghost button; click → switcher
//               popover showing the project list to pick one
//
// The switcher mirrors ChatMenuPopover's portal+fixed-coords pattern
// so it escapes the chat window's overflow:hidden frame.
//
// Behavior:
//   - Click chip → open switcher
//   - Click project in switcher → POST /…/project {slug}; chip
//     updates via SSE 'project' broadcast (plus a refreshProject
//     call as snappiness fallback)
//   - Unlink button → DELETE
//   - Outside-click / Escape → close switcher

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, FolderX } from 'lucide-react';
import { api, type ProjectInfo } from '../lib/api';

interface Props {
  agent: string;
  session: string;
  /** Currently-pinned project (null = unpinned). Comes from ChatProvider
   *  stream state, kept live via SSE + refreshProject. */
  project: ProjectInfo | null;
  /** Called after a successful set/clear to nudge the provider into
   *  refetching state — covers the gap until SSE arrives. */
  onMutated: () => void;
}

export function ProjectChip({ agent, session, project, onMutated }: Props) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setAnchorRect(buttonRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  };

  if (project) {
    const color = project.color ?? '#8b8b8b';
    return (
      <>
        <button
          ref={buttonRef}
          type="button"
          title={`Project: ${project.name}\nentity: ${project.entity}\n${project.paths.length} pointer${
            project.paths.length === 1 ? '' : 's'
          }`}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={toggle}
          // Custom pill — explicitly NOT using .chat-icon-btn here.
          // That class forces width:28px height:28px display:grid which
          // would clip the name to a single character. The ghost-button
          // (no-project state below) keeps the class because it's a
          // 28x28 square by design.
          style={{
            all: 'unset',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            background: `${color}22`,
            border: `1px solid ${color}66`,
            color,
            borderRadius: 4,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            maxWidth: 200,
            height: 20,
            boxSizing: 'border-box',
            lineHeight: 1,
          }}
        >
          {project.archived ? <FolderX size={11} /> : <FolderOpen size={11} />}
          <span
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            {project.name}
          </span>
        </button>
        <ProjectSwitcher
          open={open}
          onClose={() => setOpen(false)}
          anchorRect={anchorRect}
          agent={agent}
          session={session}
          current={project}
          onMutated={onMutated}
        />
      </>
    );
  }

  // No project pinned — show a quieter "link a project" affordance.
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="chat-icon-btn"
        title="Link a project to this session"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggle}
      >
        <Folder size={14} />
      </button>
      <ProjectSwitcher
        open={open}
        onClose={() => setOpen(false)}
        anchorRect={anchorRect}
        agent={agent}
        session={session}
        current={null}
        onMutated={onMutated}
      />
    </>
  );
}

interface SwitcherProps {
  open: boolean;
  onClose: () => void;
  anchorRect: DOMRect | null;
  agent: string;
  session: string;
  current: ProjectInfo | null;
  onMutated: () => void;
}

function ProjectSwitcher({
  open,
  onClose,
  anchorRect,
  agent,
  session,
  current,
  onMutated,
}: SwitcherProps) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape close. setTimeout 0 so the click that
  // opened us doesn't immediately close us in the same tick.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      if (anchorRect) {
        const { clientX: x, clientY: y } = e;
        if (
          x >= anchorRect.left && x <= anchorRect.right &&
          y >= anchorRect.top && y <= anchorRect.bottom
        ) {
          return;
        }
      }
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRect]);

  // Fetch project list when opened (not on every mount). Cached for
  // popover lifetime; re-opens trigger a fresh fetch which is fine
  // because the list is small.
  useEffect(() => {
    if (!open) {
      setProjects(null);
      setSearch('');
      setErr(null);
      return;
    }
    api
      .projects()
      .then((p) => setProjects(p))
      .catch((e: Error) => setErr(e.message));
  }, [open]);

  // Filter + entity-grouping for the rendered list. Current project
  // is always shown at the top (above its entity group) so it's
  // immediately findable + unlinkable.
  const groups = useMemo(() => {
    if (!projects) return [];
    const filt = search.trim().toLowerCase();
    const filtered = projects.filter((p) => {
      if (current && p.slug === current.slug) return false; // current shown separately
      if (!filt) return true;
      return (
        p.slug.includes(filt) ||
        p.name.toLowerCase().includes(filt) ||
        p.entity.toLowerCase().includes(filt) ||
        p.tags.some((t) => t.toLowerCase().includes(filt))
      );
    });
    const byEntity = new Map<string, ProjectInfo[]>();
    for (const p of filtered) {
      if (!byEntity.has(p.entity)) byEntity.set(p.entity, []);
      byEntity.get(p.entity)!.push(p);
    }
    return Array.from(byEntity.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects, search, current]);

  async function pin(slug: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.setSessionProject(agent, session, slug);
      onMutated();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.clearSessionProject(agent, session);
      onMutated();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open || !anchorRect) return null;

  // Position the popover under the anchor button, right-aligned to
  // its right edge so it doesn't overflow the window. Width caps so
  // long project names don't blow up the layout.
  const POP_WIDTH = 260;
  const left = Math.max(8, anchorRect.right - POP_WIDTH);
  const top = anchorRect.bottom + 4;

  const content = (
    <div
      ref={ref}
      className="slash-popup"
      role="menu"
      style={{
        position: 'fixed',
        top,
        left,
        width: POP_WIDTH,
        maxHeight: '60vh',
        overflow: 'auto',
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        zIndex: 9999,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
      }}
    >
      {current && (
        <div
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid var(--line-2)',
            background: 'var(--bg-3)',
          }}
        >
          <div style={{ color: 'var(--text-3)', fontSize: 9, marginBottom: 2 }}>
            CURRENTLY PINNED
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: current.color ?? 'var(--text-2)',
                flexShrink: 0,
              }}
            />
            <span style={{ color: 'var(--text-1)', flex: 1 }}>{current.name}</span>
            <span style={{ color: 'var(--text-3)', fontSize: 9 }}>{current.entity}</span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={unlink}
            style={{
              all: 'unset',
              cursor: busy ? 'wait' : 'pointer',
              marginTop: 6,
              padding: '2px 8px',
              fontSize: 10,
              color: 'var(--warn)',
              border: '1px solid var(--warn)',
              borderRadius: 3,
              opacity: busy ? 0.5 : 1,
            }}
          >
            Unlink project
          </button>
        </div>
      )}

      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--line-2)' }}>
        <input
          type="text"
          autoFocus
          placeholder="search projects…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--bg-1)',
            border: '1px solid var(--line)',
            borderRadius: 3,
            padding: '3px 6px',
            color: 'var(--text-1)',
            fontFamily: 'inherit',
            fontSize: 11,
            outline: 'none',
          }}
        />
      </div>

      {err && (
        <div style={{ padding: '6px 10px', color: 'var(--error)', fontSize: 10 }}>{err}</div>
      )}

      {projects === null && !err && (
        <div style={{ padding: '8px 10px', color: 'var(--text-3)' }}>loading…</div>
      )}

      {projects !== null && projects.length === 0 && (
        <div style={{ padding: '8px 10px', color: 'var(--text-3)', fontSize: 10 }}>
          no projects configured.
          <br />
          tell your agent to <code>project_create</code> one, or add to <code>~/.somora/projects/</code>.
        </div>
      )}

      {groups.map(([entity, items]) => (
        <div key={entity}>
          <div
            style={{
              padding: '4px 10px',
              fontSize: 9,
              color: 'var(--text-3)',
              background: 'var(--bg-2)',
              borderTop: '1px solid var(--line-2)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            {entity}
          </div>
          {items.map((p) => (
            <button
              key={p.slug}
              type="button"
              disabled={busy}
              onClick={() => pin(p.slug)}
              style={{
                all: 'unset',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                boxSizing: 'border-box',
                padding: '6px 10px',
                cursor: busy ? 'wait' : 'pointer',
                opacity: busy ? 0.5 : 1,
                borderBottom: '1px solid var(--line-2)',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-3)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: p.color ?? 'var(--text-2)',
                  flexShrink: 0,
                }}
              />
              <span style={{ color: 'var(--text-1)', flex: 1 }}>{p.name}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 9 }}>
                {p.paths.length} {p.paths.length === 1 ? 'path' : 'paths'}
              </span>
            </button>
          ))}
        </div>
      ))}

      {projects !== null && projects.length > 0 && groups.length === 0 && (
        <div style={{ padding: '6px 10px', color: 'var(--text-3)', fontSize: 10 }}>
          no projects match "{search}"
        </div>
      )}
    </div>
  );

  return createPortal(content, document.body);
}
