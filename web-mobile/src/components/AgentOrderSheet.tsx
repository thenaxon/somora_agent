// The order of the agent tiles, edited on the phone: a long press on a
// tile (or "Agent order" in the session sheet) opens this bottom sheet.
// Each agent is a row with a drag handle and ↑ ↓; top of the list =
// first tile on the left. "Done" saves it for every device.
//
// A sheet, not dragging in the tile row: there a drag fights the row's
// sideways scroll, and on a narrow phone the tiles are small targets.

import { useRef, useState } from 'react';
import type { AgentInfo } from '../hooks/useAgents';
import { moveItem } from '../hooks/agent-order';

interface Props {
  agents: AgentInfo[];
  onClose: () => void;
  /** Resolves with an error text or null. */
  onSave: (order: string[]) => Promise<string | null>;
}

const ROW_HEIGHT = 48;

export function AgentOrderSheet({ agents, onClose, onSave }: Props) {
  const [list, setList] = useState(() => agents.map((a) => a.name));
  const [drag, setDrag] = useState<{ index: number; dy: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const start = useRef<{ y: number; index: number } | null>(null);
  // The sheet opens under a finger still on the tile: the click of that
  // finger's lift lands on the backdrop. Only a touch that began on the
  // backdrop closes it.
  const downOnBackdrop = useRef(false);
  const byName = new Map(agents.map((a) => [a.name, a]));

  const target = (index: number, dy: number) => Math.max(0, Math.min(list.length - 1, index + Math.round(dy / ROW_HEIGHT)));

  const save = async () => {
    setSaving(true);
    const err = await onSave(list);
    setSaving(false);
    if (err) setNote(err);
    else onClose();
  };

  return (
    <div
      className="work-sheet-backdrop"
      role="presentation"
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) onClose();
      }}
    >
      <div className="work-sheet order-sheet" role="dialog" aria-label="Agent order" onClick={(e) => e.stopPropagation()}>
        <div className="work-sheet-grip" aria-hidden="true" />
        {note && <div className="work-sheet-note" role="status">{note}</div>}
        <section className="work-section">
          <div className="session-sheet-head">
            <h3>Agent order</h3>
            <button type="button" className="session-new" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Done'}
            </button>
          </div>
          <div className="order-hint">Top of the list is the first tile on the left. The same on every device.</div>
          <ol className="order-list">
            {list.map((name, i) => {
              const a = byName.get(name);
              const dragging = drag?.index === i;
              return (
                <li
                  key={name}
                  className={`order-row ${dragging ? 'dragging' : ''}`}
                  style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
                >
                  <span
                    className="order-handle"
                    aria-label={`Drag ${name}`}
                    onPointerDown={(e) => {
                      (e.target as HTMLElement).setPointerCapture(e.pointerId);
                      start.current = { y: e.clientY, index: i };
                      setDrag({ index: i, dy: 0 });
                    }}
                    onPointerMove={(e) => {
                      if (!start.current) return;
                      setDrag({ index: start.current.index, dy: e.clientY - start.current.y });
                    }}
                    onPointerUp={(e) => {
                      if (!start.current) return;
                      const { index, y } = start.current;
                      start.current = null;
                      setDrag(null);
                      setList((l) => moveItem(l, index, target(index, e.clientY - y)));
                    }}
                    onPointerCancel={() => {
                      start.current = null;
                      setDrag(null);
                    }}
                  >
                    ☰
                  </span>
                  <span
                    className="order-icon"
                    style={a?.color ? { background: `linear-gradient(135deg, ${a.color}, ${a.color}88)` } : undefined}
                  >
                    {a?.icon ?? '🤖'}
                  </span>
                  <span className="order-name">{name}</span>
                  <button type="button" className="order-move" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => setList((l) => moveItem(l, i, i - 1))}>
                    ↑
                  </button>
                  <button type="button" className="order-move" aria-label={`Move ${name} down`} disabled={i === list.length - 1} onClick={() => setList((l) => moveItem(l, i, i + 1))}>
                    ↓
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}
