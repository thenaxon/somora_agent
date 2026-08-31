// Draggable + resizable window. Ported from the click-dummy
// window.jsx with TypeScript + a few small fixes (ref types,
// strict null checks, agent-tint via CSS variables on the root
// div). All visual styling — including the .agent-tinted variant
// — lives in desktop.css from the click-dummy port.

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { WindowState } from '../types/window';
import { clampDragPosition, clampResizeSize, currentViewport } from '../lib/window-geometry';

interface Props {
  win: WindowState;
  focused: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onMinimize: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, w: number, h: number) => void;
  /** Per-agent hex color for chat windows. Drives the tinted-border
   *  CSS variable set; undefined = neutral chrome. */
  agentColor?: string;
  children?: ReactNode;
}

type DragState =
  | { type: 'drag'; offsetX: number; offsetY: number }
  | {
      type: 'resize';
      startX: number;
      startY: number;
      startW: number;
      startH: number;
      /** Window's top-left at resize-start. Captured here so the
       *  mouse-move handler can clamp the bottom edge against the
       *  taskbar without having to read fresh win.x/y props (which
       *  would either be stale in the closure or force the effect
       *  to re-attach on every position change). */
      startWinX: number;
      startWinY: number;
    }
  | null;

// Clamp numbers (taskbar height, minimum size) live in
// lib/window-geometry.ts — the same rule the window manager applies on
// a browser-viewport resize, so the three ways a window can move never
// disagree about where the desktop ends.

export function Window({
  win,
  focused,
  onFocus,
  onClose,
  onMinimize,
  onMove,
  onResize,
  agentColor,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState>(null);

  const tintStyle = agentColor
    ? ({
        '--agent-color': agentColor,
        '--agent-tint': `${agentColor}10`,
        '--agent-tint-strong': `${agentColor}1f`,
        '--agent-line': `${agentColor}30`,
        '--agent-glow': `${agentColor}55`,
        '--agent-accent': `linear-gradient(135deg, ${agentColor}, ${agentColor}88)`,
      } as React.CSSProperties)
    : undefined;

  const onTitleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest('.window-btn')) return;
      onFocus(win.id);
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      dragStateRef.current = {
        type: 'drag',
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      };
      e.preventDefault();
    },
    [onFocus, win.id],
  );

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      onFocus(win.id);
      dragStateRef.current = {
        type: 'resize',
        startX: e.clientX,
        startY: e.clientY,
        startW: win.w,
        startH: win.h,
        startWinX: win.x,
        startWinY: win.y,
      };
      e.preventDefault();
      e.stopPropagation();
    },
    [onFocus, win.id, win.w, win.h, win.x, win.y],
  );

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const ds = dragStateRef.current;
      if (!ds) return;
      if (ds.type === 'drag') {
        // The WHOLE window stays above the taskbar — title bar AND
        // body — and never leaves the desktop on the top/left; up to
        // all but 100px may hang off the right edge on purpose.
        const { x, y } = clampDragPosition(
          e.clientX - ds.offsetX,
          e.clientY - ds.offsetY,
          win.h,
          currentViewport(),
        );
        onMove(win.id, x, y);
      } else if (ds.type === 'resize') {
        // The bottom-right corner never pushes past the taskbar —
        // once the handle goes under it the user can't grab it back.
        const { w, h } = clampResizeSize(
          ds.startWinX,
          ds.startWinY,
          ds.startW + (e.clientX - ds.startX),
          ds.startH + (e.clientY - ds.startY),
          currentViewport(),
        );
        onResize(win.id, w, h);
      }
    }
    function onMouseUp() {
      dragStateRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMove, onResize, win.id, win.h]);

  return (
    <div
      ref={ref}
      className={[
        'window',
        focused ? 'focused' : '',
        win.minimized ? 'minimized' : '',
        agentColor ? 'agent-tinted' : '',
        win.kind === 'pin-note' ? 'pin-tinted' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: win.x,
        top: win.y,
        width: win.w,
        height: win.h,
        zIndex: win.z,
        ...tintStyle,
      }}
      onMouseDown={() => onFocus(win.id)}
    >
      <div className="window-titlebar" onMouseDown={onTitleMouseDown}>
        <div className="window-controls">
          <button
            type="button"
            className="window-btn close"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(win.id);
            }}
          />
          <button
            type="button"
            className="window-btn min"
            title="Minimize"
            onClick={(e) => {
              e.stopPropagation();
              onMinimize(win.id);
            }}
          />
          <button
            type="button"
            className="window-btn max"
            title="Maximize (TODO)"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
        <div className="window-title">
          {win.icon && <span className="window-title-icon">{win.icon}</span>}
          <span>{win.title}</span>
          {win.meta && <span className="window-title-meta">· {win.meta}</span>}
        </div>
        <div className="window-spacer" />
      </div>
      <div className="window-body">
        {children}
        <div className="window-resize" onMouseDown={onResizeMouseDown} />
      </div>
    </div>
  );
}
