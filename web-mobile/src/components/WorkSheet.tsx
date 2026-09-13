// The session's work queue on the phone: a badge in the header, and
// the bottom sheet it opens (design: private/turn-dispatch-phase2-
// design.md §5). Same four sections as the desktop popover — Running,
// Waiting, Arriving, From here — one line per entry, × on every
// waiting entry. Glyphs and labels come from the shared presentation
// table (web/src/lib/origin.ts); no lucide on mobile, emoji as-is.
//
// Thin client: the sheet draws the /work snapshot and calls the two
// routes it is given (abort, dequeue). No queue logic of its own.

import { useEffect, useState } from 'react';
import type { SessionWorkResponse, WorkItemDto } from '../hooks/useSessionWork';
import {
  formatElapsed,
  originGlyphLabel,
  workArrivingLabel,
  workBadgeText,
  workRequesterLabel,
} from '../../../web/src/lib/origin';

function counts(work: SessionWorkResponse | null) {
  if (!work) return { waiting: 0, running: false, arriving: 0, subagents: 0, asks: 0 };
  return {
    waiting: work.queued.length,
    running: work.active !== null || work.busy,
    arriving: work.pendingWakes.length,
    subagents: work.children.filter((c) => c.kind === 'subagent').length,
    asks: work.children.filter((c) => c.kind !== 'subagent').length,
  };
}

export function WorkBadge({
  work,
  open,
  onToggle,
}: {
  work: SessionWorkResponse | null;
  open: boolean;
  onToggle: () => void;
}) {
  const text = workBadgeText(counts(work));
  if (!text) return null;
  return (
    <button
      type="button"
      className={`work-badge ${open ? 'open' : ''}`}
      onClick={onToggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Work queue: ${text}`}
    >
      <span aria-hidden="true">⌛</span>
      <span>{text}</span>
    </button>
  );
}

interface SheetProps {
  open: boolean;
  onClose: () => void;
  work: SessionWorkResponse | null;
  /** The existing abort — Stop for the running turn. */
  onStop: () => void;
  /** Remove a waiting entry; resolves with an inline note or null. */
  onRemove: (item: WorkItemDto) => Promise<string | null>;
  /** Jump to a child's session. The phone only shows `main` per
   *  agent, so the caller decides which targets are reachable. */
  onOpenSession?: (agent: string, session: string) => boolean;
}

export function WorkSheet({ open, onClose, work, onStop, onRemove, onOpenSession }: SheetProps) {
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

  if (!open) return null;

  const asOf = work?.asOf ?? Date.now();
  const running = work?.active ?? null;
  const busyWithoutItem = Boolean(work && work.busy && !work.active);
  const waiting = work?.queued ?? [];
  const arriving = work?.pendingWakes ?? [];
  const children = work?.children ?? [];
  const empty = !running && !busyWithoutItem && waiting.length === 0 && arriving.length === 0 && children.length === 0;

  async function handleRemove(item: WorkItemDto) {
    if (!item.id) return;
    setRemoving(item.id);
    try {
      setNote(await onRemove(item));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="work-sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="work-sheet"
        role="dialog"
        aria-label="Session work queue"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="work-sheet-grip" aria-hidden="true" />
        {note && <div className="work-sheet-note" role="status">{note}</div>}
        {empty && <div className="work-sheet-empty">nothing waiting, nothing running</div>}

        {(running || busyWithoutItem) && (
          <section className="work-section">
            <h3>Running</h3>
            {running ? (
              <Line
                item={running}
                meta={`since ${formatElapsed(asOf - (running.startedAt ?? running.enqueuedAt))}`}
                trailing={<StopButton onClick={onStop} />}
              />
            ) : (
              <div className="work-line">
                <span className="work-line-label">a turn</span>
                <span className="work-line-preview">started before the queue view existed</span>
                <StopButton onClick={onStop} />
              </div>
            )}
          </section>
        )}

        {waiting.length > 0 && (
          <section className="work-section">
            <h3>Waiting</h3>
            {waiting.map((item, i) => (
              <Line
                key={item.id ?? `w-${i}`}
                item={item}
                position={item.position ?? i + 1}
                requester={workRequesterLabel(item.requester)}
                meta={formatElapsed(asOf - item.enqueuedAt)}
                trailing={
                  item.id ? (
                    <button
                      type="button"
                      className="work-x"
                      onClick={() => void handleRemove(item)}
                      disabled={removing === item.id}
                      aria-label="Remove from the queue"
                    >
                      ×
                    </button>
                  ) : null
                }
              />
            ))}
          </section>
        )}

        {arriving.length > 0 && (
          <section className="work-section">
            <h3>Arriving</h3>
            {arriving.map((item, i) => {
              const gl = originGlyphLabel('wake', item.about);
              return (
                <div key={item.id ?? `a-${i}`} className="work-line">
                  <span className="work-line-glyph" aria-hidden="true">{gl.glyph}</span>
                  <span className="work-line-preview strong">{workArrivingLabel(item.about, item.target)}</span>
                  {item.state === 'failed' && <span className="work-line-meta danger">failed</span>}
                </div>
              );
            })}
          </section>
        )}

        {children.length > 0 && (
          <section className="work-section">
            <h3>From here</h3>
            {children.map((item, i) => {
              const gl = originGlyphLabel(item.kind, item.about);
              const target = item.target;
              const canOpen = Boolean(onOpenSession && target && target.session === 'main');
              const body = (
                <>
                  <span className="work-line-glyph" aria-hidden="true">{gl.glyph}</span>
                  <span className="work-line-label">{gl.label}</span>
                  <span className="work-line-preview">{target ? `${target.agent} · ${target.session}` : item.preview}</span>
                  <span className={`work-line-meta ${item.state === 'running' ? 'accent' : ''}`}>{item.state}</span>
                </>
              );
              return canOpen ? (
                <button
                  key={item.id ?? `c-${i}`}
                  type="button"
                  className="work-line tappable"
                  onClick={() => {
                    if (onOpenSession!(target!.agent, target!.session)) onClose();
                  }}
                >
                  {body}
                </button>
              ) : (
                <div key={item.id ?? `c-${i}`} className="work-line">{body}</div>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}

function Line({
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
  return (
    <div className="work-line">
      {position !== undefined && <span className="work-line-pos">{position}</span>}
      <span className="work-line-glyph" aria-hidden="true">{gl.glyph}</span>
      <span className="work-line-label">{gl.label}</span>
      <span className="work-line-preview">{item.preview || '(no text)'}</span>
      {requester && <span className="work-line-meta">{requester}</span>}
      <span className="work-line-meta">{meta}</span>
      {trailing}
    </div>
  );
}

function StopButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="work-stop" onClick={onClick} aria-label="Stop the running turn">
      ■
    </button>
  );
}
