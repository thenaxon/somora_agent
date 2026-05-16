// Window manager: open / close / focus / move / resize / persist.
// Mirrors the click-dummy desktop.jsx state model in TS-strict form,
// with a few quality-of-life additions (auto-arrange, save/restore).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PersistedLayout, PinNote, WindowState } from '../types/window';

const STORAGE_KEY = 'somora-web-layout';
const STORAGE_KEY_SAVED = 'somora-web-layout-saved';
const TASKBAR_HEIGHT = 56;

export interface OpenChatArgs {
  agentName: string;
  sessionId: string;
  agentLabel: string;
  agentMeta?: string;
  agentIcon?: string;
}

export function useWindowManager() {
  const [windows, setWindows] = useState<WindowState[]>([]);
  const [zCounter, setZCounter] = useState(10);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Restore persisted layout on first mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedLayout;
        if (Array.isArray(parsed.windows)) {
          setWindows(parsed.windows);
          setZCounter(parsed.zCounter || 10);
          setFocusedId(parsed.focusedId ?? null);
        }
      }
    } catch {
      // Corrupt storage — ignore, start with empty layout.
    }
    setHydrated(true);
  }, []);

  // Persist on every change, but only after initial hydration so we
  // don't immediately wipe the saved layout with the empty-default.
  useEffect(() => {
    if (!hydrated) return;
    const snap: PersistedLayout = { windows, zCounter, focusedId };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      // Quota exceeded — silently drop, layout will live for the
      // session at least.
    }
  }, [windows, zCounter, focusedId, hydrated]);

  const focus = useCallback((id: string) => {
    setZCounter((z) => z + 1);
    setFocusedId(id);
    setWindows((ws) =>
      ws.map((w) => (w.id === id ? { ...w, z: zCounter + 1, minimized: false } : w)),
    );
  }, [zCounter]);

  const close = useCallback((id: string) => {
    setWindows((ws) => ws.filter((w) => w.id !== id));
    setFocusedId((cur) => (cur === id ? null : cur));
  }, []);

  const minimize = useCallback((id: string) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, minimized: true } : w)));
  }, []);

  const move = useCallback((id: string, x: number, y: number) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, x, y } : w)));
  }, []);

  const resize = useCallback((id: string, w: number, h: number) => {
    setWindows((ws) => ws.map((win) => (win.id === id ? { ...win, w, h } : win)));
  }, []);

  /** Mutate the sessionId of an open chat window in place. Used by
   *  the slash-command popup's `/session` and `/new` handlers — the
   *  ChatWindow then re-subscribes to the new session's SSE via
   *  ChatProvider, no remount required. */
  const setWindowSession = useCallback((id: string, sessionId: string) => {
    setWindows((ws) =>
      ws.map((w) =>
        w.id === id && w.kind === 'chat' ? { ...w, sessionId } : w,
      ),
    );
  }, []);

  /** Open or focus the cross-agent Sessions list window. Singleton —
   *  only one Sessions tool exists at a time. */
  const openSessionsList = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'sessions-list');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(880, 600, zCounter + 1);
    const id = `sessions-list-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'sessions-list',
      title: 'Sessions',
      icon: '🗂',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  /** Open or focus the tmux-app list window. Singleton — only one
   *  list view exists at a time. Phase 1.5. */
  const openTmuxList = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'tmux-list');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(520, 460, zCounter + 1);
    const id = `tmux-list-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'tmux-list',
      title: 'tmux sessions',
      icon: '⌨',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  /** Open a fresh shell-terminal window rooted in the somora
   *  workspace. NOT deduped — every click spawns another independent
   *  shell. Phase 1.5. */
  const openShellTerm = useCallback(() => {
    const pos = randomPos(720, 520, zCounter + 1);
    const id = `shell-term-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'shell-term',
      title: 'terminal',
      meta: 'shell',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [zCounter]);

  /** Open or focus an xterm.js window attached to a specific tmux
   *  session. Per-(tmux-name) deduped — clicking the same session
   *  twice in the list focuses the existing terminal instead of
   *  spawning a second attach. Phase 1.5. */
  const openTmuxTerm = useCallback(
    (tmuxName: string) => {
      const existing = windows.find(
        (w) => w.kind === 'tmux-term' && w.tmuxName === tmuxName,
      );
      if (existing) {
        focus(existing.id);
        return;
      }
      const pos = randomPos(720, 520, zCounter + 1);
      const id = `tmux-term-${tmuxName}-${Date.now()}`;
      const next: WindowState = {
        id,
        kind: 'tmux-term',
        title: tmuxName,
        meta: 'tmux',
        tmuxName,
        ...pos,
        minimized: false,
      };
      setWindows((ws) => [...ws, next]);
      setZCounter((z) => z + 1);
      setFocusedId(id);
    },
    [windows, zCounter, focus],
  );

  /** Open or focus a chat window for (agent, session). If a window
   *  for the same agent+session already exists, focus it instead of
   *  opening a duplicate. */
  const openChat = useCallback(
    (args: OpenChatArgs) => {
      const existing = windows.find(
        (w) => w.kind === 'chat' && w.agentName === args.agentName && w.sessionId === args.sessionId,
      );
      if (existing) {
        focus(existing.id);
        return;
      }
      const pos = randomPos(520, 460, zCounter + 1);
      const id = `chat-${args.agentName}-${args.sessionId}-${Date.now()}`;
      const next: WindowState = {
        id,
        kind: 'chat',
        agentName: args.agentName,
        sessionId: args.sessionId,
        title: args.agentLabel,
        ...(args.agentMeta ? { meta: args.agentMeta } : {}),
        ...(args.agentIcon ? { icon: args.agentIcon } : {}),
        ...pos,
        minimized: false,
      };
      setWindows((ws) => [...ws, next]);
      setZCounter((z) => z + 1);
      setFocusedId(id);
    },
    [windows, zCounter, focus],
  );

  /** Open or focus a pin-note window snapshotting one chat message.
   *  De-dups by `msgId` — re-pinning the same message focuses the
   *  existing note instead of opening a duplicate. */
  const openPinNote = useCallback(
    (note: PinNote) => {
      const existing = windows.find(
        (w) => w.kind === 'pin-note' && w.pinNote?.msgId === note.msgId,
      );
      if (existing) {
        focus(existing.id);
        return;
      }
      const pos = randomPos(360, 320, zCounter + 1);
      const id = `pin-note-${note.msgId}-${Date.now()}`;
      const next: WindowState = {
        id,
        kind: 'pin-note',
        title: `${note.agentName} note`,
        icon: '📌',
        pinNote: note,
        ...pos,
        minimized: false,
      };
      setWindows((ws) => [...ws, next]);
      setZCounter((z) => z + 1);
      setFocusedId(id);
    },
    [windows, zCounter, focus],
  );

  /** Open or focus a FileView window for the given absolute filesystem
   *  path. De-dups by path — re-clicking the same link focuses the
   *  existing window instead of opening a duplicate. The content is
   *  fetched inside the FileViewWindow component, so opening is cheap. */
  const openFileView = useCallback(
    (path: string) => {
      const existing = windows.find(
        (w) => w.kind === 'file-view' && w.filePath === path,
      );
      if (existing) {
        focus(existing.id);
        return;
      }
      const pos = randomPos(560, 520, zCounter + 1);
      const id = `file-view-${Date.now()}`;
      const baseName = path.split('/').filter(Boolean).pop() ?? path;
      const next: WindowState = {
        id,
        kind: 'file-view',
        title: baseName,
        meta: path,
        icon: '📄',
        filePath: path,
        ...pos,
        minimized: false,
      };
      setWindows((ws) => [...ws, next]);
      setZCounter((z) => z + 1);
      setFocusedId(id);
    },
    [windows, zCounter, focus],
  );

  /** Set of message ids currently pinned. Drives the pin-button
   *  active state on chat bubbles — when a pin-note window closes,
   *  the set updates automatically and the bubble's pin icon flips
   *  back to its inactive style. */
  const pinnedMsgIds = useMemo(
    () =>
      new Set(
        windows
          .filter((w) => w.kind === 'pin-note' && w.pinNote)
          .map((w) => w.pinNote!.msgId),
      ),
    [windows],
  );

  /** Close the pin-note window that captures a given message id, if
   *  any. Used by the bubble's pin-button when it's clicked while
   *  active — the user toggles the pin off from the source side. */
  const unpinMessage = useCallback(
    (msgId: string) => {
      const target = windows.find(
        (w) => w.kind === 'pin-note' && w.pinNote?.msgId === msgId,
      );
      if (!target) return;
      setWindows((ws) => ws.filter((w) => w.id !== target.id));
      setFocusedId((cur) => (cur === target.id ? null : cur));
    },
    [windows],
  );

  const autoArrange = useCallback(() => {
    setWindows((ws) => {
      const visible = ws.filter((w) => !w.minimized);
      const n = visible.length;
      if (n === 0) return ws;
      const dockX = 140;
      const padX = 24;
      const padY = 24;
      const gap = 16;
      const areaW = window.innerWidth - dockX - padX;
      const areaH = window.innerHeight - TASKBAR_HEIGHT - padY * 2;
      const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
      const rows = Math.ceil(n / cols);
      const cellW = Math.floor((areaW - gap * (cols - 1)) / cols);
      const cellH = Math.floor((areaH - gap * (rows - 1)) / rows);
      return ws.map((w) => {
        if (w.minimized) return w;
        const idx = visible.indexOf(w);
        if (idx === -1) return w;
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        return {
          ...w,
          x: dockX + c * (cellW + gap),
          y: padY + r * (cellH + gap),
          w: cellW,
          h: cellH,
        };
      });
    });
  }, []);

  const saveLayout = useCallback(() => {
    const snap: PersistedLayout = { windows, zCounter, focusedId };
    try {
      localStorage.setItem(STORAGE_KEY_SAVED, JSON.stringify(snap));
    } catch {
      // Quota — non-fatal.
    }
  }, [windows, zCounter, focusedId]);

  const restoreLayout = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SAVED);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as PersistedLayout;
      if (Array.isArray(parsed.windows)) {
        setWindows(parsed.windows);
        setZCounter(parsed.zCounter || 10);
        setFocusedId(parsed.focusedId ?? null);
        return true;
      }
    } catch {
      /* corrupt save — ignore */
    }
    return false;
  }, []);

  return {
    windows,
    focusedId,
    openChat,
    focus,
    close,
    minimize,
    move,
    resize,
    autoArrange,
    saveLayout,
    restoreLayout,
    setWindowSession,
    openTmuxList,
    openTmuxTerm,
    openShellTerm,
    openSessionsList,
    openPinNote,
    unpinMessage,
    pinnedMsgIds,
    openFileView,
  };
}

function randomPos(
  width: number,
  height: number,
  z: number,
): { x: number; y: number; w: number; h: number; z: number } {
  const dockOffset = 140;
  const maxX = window.innerWidth - width - 40;
  const maxY = window.innerHeight - height - TASKBAR_HEIGHT - 40;
  const x = dockOffset + Math.floor(Math.random() * Math.max(1, maxX - dockOffset));
  const y = 60 + Math.floor(Math.random() * Math.max(1, maxY - 60));
  return { x, y, w: width, h: height, z };
}
