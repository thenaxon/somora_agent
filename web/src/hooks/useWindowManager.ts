// Window manager: open / close / focus / move / resize / persist.
// Mirrors the click-dummy desktop.jsx state model in TS-strict form,
// with a few quality-of-life additions (auto-arrange, save/restore).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PersistedLayout, PinNote, WindowState } from '../types/window';
import {
  ARRANGE_PAD,
  arrangeSlots,
  currentViewport,
  fitAllToDesktop,
  type Rect,
  TASKBAR_HEIGHT,
} from '../lib/window-geometry';

const STORAGE_KEY = 'somora-web-layout';
const STORAGE_KEY_SAVED = 'somora-web-layout-saved';
/** Viewport-resize events arrive in bursts while a window is being
 *  dragged between displays; one fit per pause is plenty. */
const VIEWPORT_FIT_DEBOUNCE_MS = 120;

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

  // A window never leaves the desktop. The drag and corner-resize
  // handlers clamp as the user moves them; this covers the case they
  // can't — the VIEWPORT changing under a layout that was fine a
  // moment ago (browser dragged from a 27" display to the MacBook
  // screen, or a layout restored from localStorage on a smaller
  // screen). Every window is shifted back inside and shrunk only if
  // it no longer fits at all; the taskbar's Arrange button stays
  // reachable no matter what. Runs once after hydration and on every
  // (debounced) resize. Nothing moves when everything already fits —
  // fitAllToDesktop returns the same array, so no re-render and no
  // localStorage write (2026-08-31, Rene's report).
  useEffect(() => {
    if (!hydrated) return;
    const fit = () => setWindows((ws) => fitAllToDesktop(ws, currentViewport()));
    fit();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fit, VIEWPORT_FIT_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (timer) clearTimeout(timer);
    };
  }, [hydrated]);

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

  /** Open or focus the Sentinel trigger inspector. Singleton. */
  const openSentinelList = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'sentinel');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(820, 520, zCounter + 1);
    const id = `sentinel-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'sentinel',
      title: 'Sentinel',
      icon: '🔔',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  /** Open or focus the Wiki Explorer. Singleton — the three-column
   *  layout wants width, and two of them would just fight for it. */
  const openWiki = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'wiki');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(1180, 700, zCounter + 1);
    const id = `wiki-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'wiki',
      title: 'Wiki',
      icon: '📚',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  /** Open or focus the Tools matrix (per-agent tool visibility +
   *  external MCP server status). Singleton. */
  const openTools = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'tools');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(940, 640, zCounter + 1);
    const id = `tools-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'tools',
      title: 'Abilities',
      icon: '🧰',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  /** Open or focus the Media window (gallery + generation form for
   *  images and video). Singleton — the gallery is one archive, and two
   *  windows onto it would just compete for the same scroll position.
   *
   *  The window KIND stays `images`: it is persisted in the saved
   *  desktop layout, and renaming it would drop everyone's window
   *  position on the next release for a label nobody sees. */
  /** Open or focus the Agent window (persona files + prompt budget)
   *  for one agent. One per agent. */
  const openAgentConfig = useCallback(
    (agentName: string) => {
      const existing = windows.find((w) => w.kind === 'agent-config' && w.agentName === agentName);
      if (existing) {
        focus(existing.id);
        return;
      }
      const pos = randomPos(900, 640, zCounter + 1);
      const id = `agent-config-${agentName}-${Date.now()}`;
      const next: WindowState = {
        id,
        kind: 'agent-config',
        title: agentName,
        meta: 'configure',
        icon: '⚙️',
        agentName,
        ...pos,
        minimized: false,
      };
      setWindows((ws) => [...ws, next]);
      setZCounter((z) => z + 1);
      setFocusedId(id);
    },
    [windows, zCounter, focus],
  );

  /** Open or focus the Team window (org chart editor). Singleton. */
  const openTeam = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'team');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(980, 660, zCounter + 1);
    const id = `team-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'team',
      title: 'Team',
      icon: '👥',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  const openImages = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'images');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(1000, 680, zCounter + 1);
    const id = `images-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'images',
      title: 'Media',
      icon: '🖼',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  /** Remember which page a wiki window is on so a reload restores it. */
  const setWikiSlug = useCallback((id: string, slug: string) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, wikiSlug: slug } : w)));
  }, []);

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

  /** Open or focus the voice window (singleton): one call at a time,
   *  because a second standing audio connection is a second bill and a
   *  second microphone nobody asked for. */
  const openVoice = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'voice');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(520, 620, zCounter + 1);
    const id = `voice-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'voice',
      title: 'voice',
      icon: '🎙',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  /** Open or focus the server log window (singleton). Reading the log
   *  used to mean an ssh session and `tail` — which is not available at
   *  the moment something looks wrong (Rene 2026-09-10). */
  const openLogs = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'logs');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(900, 560, zCounter + 1);
    const id = `logs-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'logs',
      title: 'server log',
      icon: '📜',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  /** Open or focus the browser list (singleton), stage 2 of the shared
   *  browser (docs/browser.md). */
  const openBrowserList = useCallback(() => {
    const existing = windows.find((w) => w.kind === 'browser-list');
    if (existing) {
      focus(existing.id);
      return;
    }
    const pos = randomPos(560, 420, zCounter + 1);
    const id = `browser-list-${Date.now()}`;
    const next: WindowState = {
      id,
      kind: 'browser-list',
      title: 'browser sessions',
      icon: '🌐',
      ...pos,
      minimized: false,
    };
    setWindows((ws) => [...ws, next]);
    setZCounter((z) => z + 1);
    setFocusedId(id);
  }, [windows, zCounter, focus]);

  /** Open or focus the live view of one browser window. Deduped per VIEW
   *  id — one window per agent, its own tabs inside it. */
  const openBrowser = useCallback(
    (viewId: string, title: string) => {
      const existing = windows.find((w) => w.kind === 'browser' && w.browserViewId === viewId);
      if (existing) {
        focus(existing.id);
        return;
      }
      const pos = randomPos(1100, 760, zCounter + 1);
      const id = `browser-${viewId}-${Date.now()}`;
      const next: WindowState = {
        id,
        kind: 'browser',
        title,
        meta: 'browser',
        browserViewId: viewId,
        ...pos,
        minimized: false,
      };
      setWindows((ws) => [...ws, next]);
      setZCounter((z) => z + 1);
      setFocusedId(id);
    },
    [windows, zCounter, focus],
  );

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

  /** Drop restored chat windows whose agent no longer exists.
   *
   *  A saved layout outlives the agents in it: rename or delete an agent
   *  and its window comes back from localStorage pointing at a name the
   *  server no longer serves. Desktop.tsx renders nothing for it, so it
   *  sits there invisible and unclosable — but still counted, which made
   *  Arrange leave a hole for a window nobody could see (Luca's report).
   *
   *  Only ever called with an agent list the server actually answered
   *  with; while it is loading or unreachable the windows stay put,
   *  because "no agents" and "cannot ask" must not look the same here. */
  const dropOrphanChats = useCallback((known: ReadonlySet<string>) => {
    setWindows((ws) => {
      const next = ws.filter((w) => w.kind !== 'chat' || !w.agentName || known.has(w.agentName));
      return next.length === ws.length ? ws : next;
    });
  }, []);

  /** Arrange uses the whole desktop, right up to the left edge.
   *
   *  It used to keep a fixed 140 px free there, from the days when the
   *  agent dock WAS a fixed column on the left. Since icons can be
   *  dragged anywhere that reservation only guessed — it held a strip
   *  free whether or not an icon still stood in it, and never matched a
   *  second icon column (Luca's report). Icons sit below the windows by
   *  design, so a window covering one is exactly what a desktop does;
   *  minimize or close it and the icon is back. */
  const autoArrange = useCallback(() => {
    setWindows((ws) => {
      const visible = ws.filter((w) => !w.minimized);
      const n = visible.length;
      if (n === 0) return ws;
      const area = {
        x: ARRANGE_PAD,
        y: ARRANGE_PAD,
        w: window.innerWidth - ARRANGE_PAD * 2,
        h: window.innerHeight - TASKBAR_HEIGHT - ARRANGE_PAD * 2,
      };
      // Slots go to windows left-to-right, top-to-bottom by where they
      // already are, so Arrange rearranges what the user sees instead of
      // reshuffling by open order — and the leftmost window is the one
      // that becomes the full-height master. Arranging twice is a no-op.
      const order = [...visible].sort((a, b) => a.x - b.x || a.y - b.y);
      const slots = arrangeSlots(n, area);
      const byId = new Map(order.map((w, i) => [w.id, slots[i] as Rect]));
      return ws.map((w) => {
        const slot = byId.get(w.id);
        return slot ? { ...w, ...slot } : w;
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
    dropOrphanChats,
    saveLayout,
    restoreLayout,
    setWindowSession,
    openTmuxList,
    openTmuxTerm,
    openBrowserList,
    openLogs,
    openVoice,
    openBrowser,
    openShellTerm,
    openSessionsList,
    openSentinelList,
    openWiki,
    openTools,
    openTeam,
    openAgentConfig,
    openImages,
    setWikiSlug,
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
