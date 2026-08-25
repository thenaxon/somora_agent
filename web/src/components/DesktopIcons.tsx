// Desktop icon layer — agent + app tiles arranged freely on the
// desktop surface, Windows-style: any grid cell, anywhere on screen,
// not just a fixed column on the left.
//
// Sits below the windows (z-index 5 vs. the window manager's 10+), so
// an open window covers icons exactly like a real desktop.
//
// Placement, persistence and the resize behaviour live in
// hooks/useDesktopIcons.ts; this file owns the drag gesture and what it
// looks like:
//   - the grabbed tile follows the cursor, lifted and slightly enlarged
//   - the cell underneath is outlined as the drop target
//   - dropping on an occupied cell swaps the two icons
//
// Drag is hand-rolled on pointer events rather than pulling in a
// library: the codebase already drags windows this way (Window.tsx),
// pointer events cover mouse and touch in one path, and a
// dependency-free diff is easier to review.

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  CELL_H,
  CELL_W,
  GRID_PAD,
  useDesktopIcons,
  useGridSize,
  type Cell,
} from '../hooks/useDesktopIcons';

/** Pointer travel before a press counts as a drag. Without it every
 *  click registers as a zero-length drag and swallows the tile's own
 *  onClick, which is what opens the window. */
const DRAG_THRESHOLD_PX = 5;

export interface DesktopIcon {
  /** Stable, namespaced id — `agent:<name>` / `app:<key>`. The prefix
   *  matters: without it an agent literally named "tools" would collide
   *  with the tools app tile in the stored layout. */
  id: string;
  node: ReactNode;
}

interface Props {
  icons: DesktopIcon[];
  /** Agent list still loading — placeholder above the app tiles, which
   *  are available immediately. */
  loading?: boolean;
  /** Agent fetch failed; the message is surfaced as a tooltip. */
  error?: string | null;
}

interface DragState {
  id: string;
  /** Pointer offset inside the tile, so the icon does not jump to its
   *  corner the instant you grab it. */
  grabX: number;
  grabY: number;
  /** Live pointer position, viewport coords. */
  x: number;
  y: number;
  /** Cell the icon would land in right now. */
  target: Cell;
  /** Icon currently drawn on `target`, if any — the swap partner. */
  swapWith: string | null;
}

const cellLeft = (col: number) => GRID_PAD + col * CELL_W;
const cellTop = (row: number) => GRID_PAD + row * CELL_H;

export function DesktopIcons({ icons, loading, error }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const { cols, rows } = useGridSize(layerRef, icons.length);
  const ids = icons.map((i) => i.id);
  const { layout, place } = useDesktopIcons(ids, cols, rows);

  const [drag, setDrag] = useState<DragState | null>(null);
  // Cell after the last laid-out icon (column-major, matching the
  // default fill order) — where the loading / error status goes.
  const statusCell: Cell =
    rows > 0 ? { col: Math.floor(icons.length / rows), row: icons.length % rows } : { col: 0, row: 0 };
  /** Set when a press turned into a drag, so the click browsers fire
   *  afterwards can be swallowed instead of opening a window. */
  const didDragRef = useRef(false);

  const startDrag = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (e.button !== 0) return;
      const layer = layerRef.current;
      if (!layer) return;
      didDragRef.current = false;

      const tileRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const layerRect = layer.getBoundingClientRect();
      const grabX = e.clientX - tileRect.left;
      const grabY = e.clientY - tileRect.top;
      const startX = e.clientX;
      const startY = e.clientY;

      let dragging = false;
      let target: Cell = layout.get(id) ?? { col: 0, row: 0 };

      /** Cell under the tile's own top-left corner — snapping on the
       *  tile rather than the cursor is what makes a drop land where
       *  the icon *looks* like it will land. */
      const cellUnderTile = (px: number, py: number): Cell => {
        const left = px - grabX - layerRect.left + layer.scrollLeft;
        const top = py - grabY - layerRect.top + layer.scrollTop;
        return {
          col: Math.min(Math.max(Math.round((left - GRID_PAD) / CELL_W), 0), cols - 1),
          row: Math.min(Math.max(Math.round((top - GRID_PAD) / CELL_H), 0), rows - 1),
        };
      };

      const occupantOf = (cell: Cell): string | null => {
        for (const [other, c] of layout) {
          if (other !== id && c.col === cell.col && c.row === cell.row) return other;
        }
        return null;
      };

      const onMove = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
          dragging = true;
          didDragRef.current = true;
        }
        target = cellUnderTile(ev.clientX, ev.clientY);
        setDrag({
          id,
          grabX,
          grabY,
          x: ev.clientX,
          y: ev.clientY,
          target,
          swapWith: occupantOf(target),
        });
        // Stops a touch drag from scrolling the desktop underneath.
        ev.preventDefault();
      };

      const onEnd = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        if (dragging) place(id, target);
        setDrag(null);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [cols, rows, layout, place],
  );

  /** Alt+Arrow nudges the focused icon one cell — the desktop is
   *  reachable by keyboard, so rearranging has to be too. Plain arrows
   *  stay free for normal focus traversal. */
  const onIconKeyDown = useCallback(
    (e: React.KeyboardEvent, id: string) => {
      if (!e.altKey) return;
      const at = layout.get(id);
      if (!at) return;
      const delta: Record<string, Cell> = {
        ArrowLeft: { col: -1, row: 0 },
        ArrowRight: { col: 1, row: 0 },
        ArrowUp: { col: 0, row: -1 },
        ArrowDown: { col: 0, row: 1 },
      };
      const d = delta[e.key];
      if (!d) return;
      const target = {
        col: Math.min(Math.max(at.col + d.col, 0), cols - 1),
        row: Math.min(Math.max(at.row + d.row, 0), rows - 1),
      };
      if (target.col === at.col && target.row === at.row) return;
      e.preventDefault();
      // Keep the tile's own Enter/Space open-window handler out of it.
      e.stopPropagation();
      place(id, target);
    },
    [layout, cols, rows, place],
  );

  /** A drag ends with a click on the tile — swallow it so rearranging
   *  never also opens a window. */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!didDragRef.current) return;
    didDragRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <div
      ref={layerRef}
      className={drag ? 'desktop-icons dragging' : 'desktop-icons'}
      onClickCapture={onClickCapture}
    >
      {/* Status text takes the first free cell in column-major order —
        * i.e. the slot right after the last icon, the way the old dock
        * stacked it above the app tiles in flow. Pinning it to the grid
        * origin would put it on top of whatever icon sits in cell 0
        * (the tmux tile while agents load or the server is down). */}
      {(loading || error) && (
        <div
          className={error ? 'desktop-icons-status error' : 'desktop-icons-status'}
          style={{ left: cellLeft(statusCell.col), top: cellTop(statusCell.row) }}
          {...(error ? { title: error } : {})}
        >
          {error ? 'server unreachable' : 'loading…'}
        </div>
      )}

      {/* Drop target outline, drawn under the icons. */}
      {drag && (
        <div
          className={drag.swapWith ? 'desktop-drop-target swap' : 'desktop-drop-target'}
          style={{
            left: cellLeft(drag.target.col),
            top: cellTop(drag.target.row),
            width: CELL_W,
            height: CELL_H,
          }}
        />
      )}

      {icons.map((icon) => {
        const cell = layout.get(icon.id);
        if (!cell) return null;
        const isDragged = drag?.id === icon.id;
        const isSwapPartner = drag?.swapWith === icon.id;
        // The grabbed tile leaves the grid and rides the cursor in
        // viewport coords. It is portaled to <body>: this layer sits at
        // z-index 5 UNDER the windows (10+), and a z-index inside it
        // can't escape that stacking context — without the portal the
        // icon in hand vanishes the moment it crosses an open window.
        // The cell it came from stays empty meanwhile.
        if (isDragged) {
          return createPortal(
            <div
              key={icon.id}
              className="desktop-icon in-hand"
              data-icon-id={icon.id}
              style={{
                position: 'fixed',
                left: drag.x - drag.grabX,
                top: drag.y - drag.grabY,
                width: CELL_W,
                height: CELL_H,
              }}
            >
              {icon.node}
            </div>,
            document.body,
            icon.id,
          );
        }
        return (
          <div
            key={icon.id}
            className={'desktop-icon' + (isSwapPartner ? ' swap-partner' : '')}
            data-icon-id={icon.id}
            style={{ left: cellLeft(cell.col), top: cellTop(cell.row), width: CELL_W, height: CELL_H }}
            onPointerDown={(e) => startDrag(e, icon.id)}
            onKeyDown={(e) => onIconKeyDown(e, icon.id)}
          >
            {icon.node}
          </div>
        );
      })}
    </div>
  );
}
