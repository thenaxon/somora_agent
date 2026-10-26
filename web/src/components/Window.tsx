// Draggable + resizable window. Ported from the click-dummy
// window.jsx with TypeScript + a few small fixes (ref types,
// strict null checks, agent-tint via CSS variables on the root
// div). All visual styling — including the .agent-tinted variant
// — lives in desktop.css from the click-dummy port.

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { WindowState } from '../types/window';
import { clampDragPosition, clampResizeSize, currentViewport } from '../lib/window-geometry';
import { inkOnLight } from '../lib/colors';

interface Props {
  win: WindowState;
  focused: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onMinimize: (id: string) => void;
  onToggleMaximize: (id: string) => void;
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
      /** Title bar grabbed on a maximized window. Nothing happens until
       *  the mouse really moves (a double-click must not restore and
       *  re-maximize); then the window restores under the cursor at the
       *  same relative spot and the gesture carries on as a drag, the
       *  way macOS and Windows do it. */
      type: 'unmaximize';
      startX: number;
      startY: number;
      fracX: number;
      offsetY: number;
    }
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

/** Pixels the mouse must travel on a maximized window's title bar
 *  before the window restores and follows it. */
const UNMAXIMIZE_THRESHOLD = 4;

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
  onToggleMaximize,
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
        // Text in the agent's colour on the light theme (colors.ts).
        '--agent-ink-light': inkOnLight(agentColor),
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
      dragStateRef.current = win.maximized
        ? {
            type: 'unmaximize',
            startX: e.clientX,
            startY: e.clientY,
            fracX: rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5,
            offsetY: e.clientY - rect.top,
          }
        : {
            type: 'drag',
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
          };
      e.preventDefault();
    },
    [onFocus, win.id, win.maximized],
  );

  // Double-click on the title bar toggles maximize, as on every
  // desktop — but not on the traffic-light buttons themselves.
  const onTitleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('.window-btn')) return;
      dragStateRef.current = null;
      onToggleMaximize(win.id);
    },
    [onToggleMaximize, win.id],
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
      if (ds.type === 'unmaximize') {
        if (Math.abs(e.clientX - ds.startX) + Math.abs(e.clientY - ds.startY) < UNMAXIMIZE_THRESHOLD) return;
        const offsetX = Math.round(ds.fracX * win.w);
        const { x, y } = clampDragPosition(e.clientX - offsetX, e.clientY - ds.offsetY, win.h, currentViewport());
        onMove(win.id, x, y);
        onToggleMaximize(win.id);
        dragStateRef.current = { type: 'drag', offsetX, offsetY: ds.offsetY };
      } else if (ds.type === 'drag') {
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
  }, [onMove, onResize, onToggleMaximize, win.id, win.w, win.h]);

  return (
    <div
      ref={ref}
      className={[
        'window',
        focused ? 'focused' : '',
        win.minimized ? 'minimized' : '',
        win.maximized ? 'maximized' : '',
        agentColor ? 'agent-tinted' : '',
        win.kind === 'pin-note' ? 'pin-tinted' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        // Maximized fills .desktop-area (which already ends above the
        // taskbar) in CSS terms, so a browser resize keeps it filling
        // without touching the stored geometry it restores to.
        ...(win.maximized
          ? { left: 0, top: 0, width: '100%', height: '100%' }
          : { left: win.x, top: win.y, width: win.w, height: win.h }),
        zIndex: win.z,
        ...tintStyle,
      }}
      onMouseDown={() => onFocus(win.id)}
    >
      <div className="window-titlebar" onMouseDown={onTitleMouseDown} onDoubleClick={onTitleDoubleClick}>
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
            title={win.maximized ? 'Restore' : 'Maximize'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMaximize(win.id);
            }}
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
        {!win.maximized && <div className="window-resize" onMouseDown={onResizeMouseDown} />}
      </div>
    </div>
  );
}
