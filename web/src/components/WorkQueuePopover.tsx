// The session's work queue: a badge in the chat header and the popover
// it opens (design: private/turn-dispatch-phase2-design.md §5).
//
// Four sections, each only when non-empty:
//   Running   — the turn holding the lock, since when, and Stop
//               (the existing /chat/abort — no second control).
//   Waiting   — the queue in lock order; × removes any entry
//               (DELETE /chat/queue/:id, whoever queued it).
//   Arriving  — results on their way back into this session (wakes).
//   From here — sub-agents and agent_ask calls this session started
//               elsewhere; clicking opens that session.
//
// Thin client: everything drawn here comes from GET …/work, refreshed
// by useSessionWork. Glyph + label per kind come from the shared
// presentation table in lib/origin.ts (mobile draws the same rows).
//
// Rendered into a portal at document.body, positioned from the badge's
// rect, same as ChatMenuPopover — and in its visual language (JetBrains
// Mono, bg-2, var(--line) borders).

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  Bot,
  Clapperboard,
  CornerDownLeft,
  Globe,
  Hourglass,
  PhoneCall,
  Send,
  Square,
  SquareTerminal,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { SessionWorkResponse, WorkItemDto } from '../lib/api';
import {
  formatElapsed,
  originGlyphLabel,
  workArrivingLabel,
  workBadgeText,
  workRequesterLabel,
  type WorkIconKey,
} from '../lib/origin';

// One icon per row kind — the same set the transcript dividers use
// (MessageItem.ORIGIN_ICONS) plus the two bubble kinds a queue can
// hold: a person's message and an agent's ask.
const WORK_ICONS: Record<WorkIconKey, LucideIcon> = {
  human: User,
  agent: Send,
  sentinel: Bell,
  tmux: SquareTerminal,
  browser: Globe,
  subagent: Bot,
  a2a: CornerDownLeft,
  job: Clapperboard,
  voice: PhoneCall,
};

export interface WorkCounts {
  waiting: number;
  running: boolean;
  arriving: number;
  subagents: number;
  asks: number;
}

/** The numbers the badge shows, straight off the snapshot. */
export function workCounts(work: SessionWorkResponse | null): WorkCounts {
  if (!work) return { waiting: 0, running: false, arriving: 0, subagents: 0, asks: 0 };
  return {
    waiting: work.queued.length,
    running: work.active !== null || work.busy,
    arriving: work.pendingWakes.length,
    subagents: work.children.filter((c) => c.kind === 'subagent').length,
    asks: work.children.filter((c) => c.kind !== 'subagent').length,
  };
}

// ── badge ─────────────────────────────────────────────────────────────

interface BadgeProps {
  work: SessionWorkResponse | null;
  open: boolean;
  onToggle: (anchor: DOMRect | null) => void;
  color: string;
}

/** `waiting 3 · running` in the header. Renders nothing when nothing
 *  waits, runs, arrives or was started from here. */
export function WorkBadge({ work, open, onToggle, color }: BadgeProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const text = workBadgeText(workCounts(work));
  if (!text) return null;
  return (
    <button
      ref={ref}
      type="button"
      className="work-badge"
      title="What this session is doing and what waits behind it"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => onToggle(ref.current?.getBoundingClientRect() ?? null)}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 9,
        fontFamily: '"JetBrains Mono", monospace',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        padding: '1px 6px',
        borderRadius: 3,
        color: open ? color : 'var(--text-2)',
        background: open ? `${color}25` : 'var(--bg-2)',
        border: open ? `1px solid ${color}55` : '1px solid var(--line-2)',
        whiteSpace: 'nowrap',
      }}
    >
      <Hourglass size={9} />
      <span>{text}</span>
    </button>
  );
}

// ── popover ───────────────────────────────────────────────────────────

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRect: DOMRect | null;
  work: SessionWorkResponse | null;
  /** Stop the running turn — the existing abort. */
  onStop: () => void;
  /** Remove a waiting entry. Resolves with a short note to show inline
   *  (409 / 404 / transport), or null when it went through. */
  onRemove: (item: WorkItemDto) => Promise<string | null>;
  /** Stop a running entry under "From here": a sub-agent task (with
   *  everything it started) or an agent_ask running on its target.
   *  Resolves with a note or null. */
  onStopChild?: (item: WorkItemDto) => Promise<string | null>;
  /** Open the target session of a child the way the sessions list does. */
  onOpenSession?: ((agent: string, session: string) => void) | undefined;
}

export function WorkQueuePopover({ open, onClose, anchorRect, work, onStop, onRemove, onStopChild, onOpenSession }: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setNote(null);
      setRemoving(null);
    }
  }, [open]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      // Skip the click on the badge itself — the parent toggles there.
      if (anchorRect) {
        const { clientX: x, clientY: y } = e;
        if (x >= anchorRect.left && x <= anchorRect.right && y >= anchorRect.top && y <= anchorRect.bottom) {
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

  const sections = useMemo(() => {
    if (!work) return null;
    return {
      running: work.active,
      busyWithoutItem: work.busy && !work.active,
      waiting: work.queued,
      arriving: work.pendingWakes,
      children: work.children,
    };
  }, [work]);

  if (!open || !anchorRect) return null;

  // Below the badge, left-aligned to it; clamp so a badge near the
  // right edge does not push the popover off-screen.
  const width = 340;
  const top = Math.round(anchorRect.bottom + 6);
  const left = Math.round(Math.min(anchorRect.left, Math.max(8, window.innerWidth - width - 8)));
  const asOf = work?.asOf ?? Date.now();

  async function handleRemove(item: WorkItemDto) {
    if (!item.id) return;
    setRemoving(item.id);
    try {
      const err = await onRemove(item);
      setNote(err);
    } finally {
      setRemoving(null);
    }
  }

  // Stop on a "From here" row: the sub-agent's task with its children,
  // or the turn an agent_ask runs as on the target (Rene, 2026-09-13:
  // "click and stop from here, not by opening the sub's session").
  async function handleStopChild(item: WorkItemDto) {
    if (!item.id || !onStopChild) return;
    setRemoving(item.id);
    try {
      setNote(await onStopChild(item));
    } finally {
      setRemoving(null);
    }
  }

  // Jumping to a child's session is a navigation — the popover closes
  // so the new window is not covered by it.
  function openTarget(agent: string, session: string) {
    onOpenSession?.(agent, session);
    onClose();
  }

  const empty =
    !sections ||
    (!sections.running &&
      !sections.busyWithoutItem &&
      sections.waiting.length === 0 &&
      sections.arriving.length === 0 &&
      sections.children.length === 0);

  const node = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Session work queue"
      className="work-queue-popover"
      style={{
        position: 'fixed',
        top,
        left,
        zIndex: 1000,
        width,
        maxHeight: 'min(70vh, 520px)',
        overflowY: 'auto',
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
        color: 'var(--text-1)',
      }}
    >
      {note && (
        <div
          role="status"
          style={{
            padding: '6px 10px',
            fontSize: 10,
            color: 'var(--warn)',
            borderBottom: '1px solid var(--line-2)',
            background: 'rgba(210, 153, 34, 0.08)',
          }}
        >
          {note}
        </div>
      )}

      {empty && <div style={{ padding: '10px', color: 'var(--text-3)', fontSize: 10 }}>nothing waiting, nothing running</div>}

      {sections?.running && (
        <Section title="RUNNING">
          <Row
            item={sections.running}
            meta={`since ${formatElapsed(asOf - (sections.running.startedAt ?? sections.running.enqueuedAt))}`}
            trailing={<StopButton onClick={onStop} />}
          />
        </Section>
      )}
      {sections?.busyWithoutItem && (
        <Section title="RUNNING">
          <div style={rowStyle}>
            <span style={{ ...labelStyle, color: 'var(--text-2)' }}>a turn</span>
            <span style={previewStyle}>started before the queue view existed</span>
            <StopButton onClick={onStop} />
          </div>
        </Section>
      )}

      {sections && sections.waiting.length > 0 && (
        <>
          {sections.running && <Divider />}
          <Section title="WAITING">
            {sections.waiting.map((item, i) => (
              <Row
                key={item.id ?? `w-${i}`}
                item={item}
                position={item.position ?? i + 1}
                requester={workRequesterLabel(item.requester)}
                meta={`waited ${formatElapsed(asOf - item.enqueuedAt)}`}
                trailing={
                  item.id ? (
                    <button
                      type="button"
                      onClick={() => void handleRemove(item)}
                      disabled={removing === item.id}
                      title={
                        item.kind === 'human'
                          ? 'Take this message back into the composer'
                          : 'Remove from the queue — the requester sees it as failed'
                      }
                      aria-label="Remove from the queue"
                      style={{ ...iconButton, opacity: removing === item.id ? 0.4 : 1 }}
                    >
                      <X size={12} />
                    </button>
                  ) : null
                }
              />
            ))}
          </Section>
        </>
      )}

      {sections && sections.arriving.length > 0 && (
        <>
          <Divider />
          <Section title="ARRIVING">
            {sections.arriving.map((item, i) => {
              const gl = originGlyphLabel('wake', item.about);
              const Icon = WORK_ICONS[gl.icon];
              return (
                <div key={item.id ?? `a-${i}`} style={rowStyle}>
                  <Icon size={12} style={{ color: 'var(--text-2)', flexShrink: 0 }} />
                  <span style={{ ...previewStyle, color: 'var(--text-1)' }}>
                    {workArrivingLabel(item.about, item.target)}
                  </span>
                  {item.state === 'failed' && <span style={{ color: 'var(--danger)', fontSize: 10 }}>failed</span>}
                </div>
              );
            })}
          </Section>
        </>
      )}

      {sections && sections.children.length > 0 && (
        <>
          <Divider />
          <Section title="FROM HERE">
            {sections.children.map((item, i) => {
              const gl = originGlyphLabel(item.kind, item.about);
              const Icon = WORK_ICONS[gl.icon];
              const target = item.target;
              const clickable = Boolean(onOpenSession && target);
              return (
                <div
                  key={item.id ?? `c-${i}`}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  title={clickable ? `Open ${target!.agent} · ${target!.session}` : undefined}
                  onClick={clickable ? () => openTarget(target!.agent, target!.session) : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openTarget(target!.agent, target!.session);
                          }
                        }
                      : undefined
                  }
                  style={{ ...rowStyle, cursor: clickable ? 'pointer' : 'default' }}
                  onMouseEnter={(e) => {
                    if (clickable) e.currentTarget.style.background = 'var(--bg-3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <Icon size={12} style={{ color: 'var(--text-2)', flexShrink: 0 }} />
                  <span style={labelStyle}>{gl.label}</span>
                  <span style={previewStyle}>
                    {target ? `${target.agent} · ${target.session}` : item.preview}
                  </span>
                  <span style={{ color: item.state === 'running' ? 'var(--accent)' : 'var(--text-3)', fontSize: 10, flexShrink: 0 }}>
                    {item.state}
                  </span>
                  {item.id && item.state === 'queued' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemove(item);
                      }}
                      disabled={removing === item.id}
                      title="Remove it before it starts — this session is told it will not run"
                      aria-label="Remove from the target's queue"
                      style={{ ...iconButton, opacity: removing === item.id ? 0.4 : 1 }}
                    >
                      <X size={12} />
                    </button>
                  )}
                  {item.id && item.state === 'running' && onStopChild && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleStopChild(item);
                      }}
                      disabled={removing === item.id}
                      title={item.kind === 'subagent' ? 'Stop this sub-agent and everything it started' : 'Stop the turn this question is running as'}
                      aria-label="Stop"
                      style={{ ...iconButton, color: 'var(--danger)', opacity: removing === item.id ? 0.4 : 1 }}
                    >
                      <Square size={11} fill="currentColor" />
                    </button>
                  )}
                </div>
              );
            })}
          </Section>
        </>
      )}
    </div>
  );

  return createPortal(node, document.body);
}

// ── rows ──────────────────────────────────────────────────────────────

function Row({
  item,
  position,
  requester,
  meta,
  trailing,
}: {
  item: WorkItemDto;
  position?: number;
  requester?: string;
  meta: string;
  trailing?: React.ReactNode;
}) {
  const gl = originGlyphLabel(item.kind, item.about);
  const Icon = WORK_ICONS[gl.icon];
  return (
    <div style={rowStyle} title={item.preview || undefined}>
      {position !== undefined && (
        <span style={{ color: 'var(--text-3)', fontSize: 10, width: 14, textAlign: 'right', flexShrink: 0 }}>{position}</span>
      )}
      <Icon size={12} style={{ color: 'var(--text-2)', flexShrink: 0 }} />
      <span style={labelStyle}>{gl.label}</span>
      <span style={previewStyle}>{item.preview || <span style={{ color: 'var(--text-3)' }}>(no text)</span>}</span>
      {requester && <span style={{ color: 'var(--text-3)', fontSize: 10, flexShrink: 0 }}>{requester}</span>}
      <span style={{ color: 'var(--text-3)', fontSize: 10, flexShrink: 0 }}>{meta}</span>
      {trailing}
    </div>
  );
}

function StopButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Stop the running turn"
      aria-label="Stop the running turn"
      style={{ ...iconButton, color: 'var(--danger)' }}
    >
      <Square size={11} fill="currentColor" />
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '8px 10px' }}>
      <div style={{ fontSize: 9, letterSpacing: 1.4, color: 'var(--text-3)', marginBottom: 4, fontWeight: 700 }}>{title}</div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '1px solid var(--line-2)' }} />;
}

// ── styles ────────────────────────────────────────────────────────────

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 4px',
  borderRadius: 3,
  minWidth: 0,
  transition: 'background 0.12s',
};

const labelStyle: React.CSSProperties = {
  color: 'var(--text-0)',
  fontSize: 10,
  flexShrink: 0,
};

const previewStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-2)',
  fontSize: 10,
};

const iconButton: React.CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  borderRadius: 3,
  color: 'var(--text-2)',
  flexShrink: 0,
};
