// Live ChatWindow: SSE-streaming, history hydration, markdown,
// tool-blocks, live token counts, pinned-to-bottom scroll, send +
// abort. Slash-command popup, drag&drop attachments and the
// memory-inject banner come in subsequent steps.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  MoreHorizontal,
  Paperclip,
  Send,
  Wrench,
  X as XIcon,
} from 'lucide-react';
import { api, type AgentInfo, type AttachmentRef } from '../lib/api';
import { gradientFor, resolveAgentColor } from '../lib/colors';
import { useSessionInfo } from '../hooks/useSessionInfo';
import { useChatSessionFromContext } from './ChatProvider';
import { MessageItem } from './MessageItem';
import { SlashCommandPopup, type SlashCommand } from './SlashCommandPopup';
import { AttachmentTray, type PendingAttachment } from './AttachmentTray';
import { ScreenshotCapture } from './ScreenshotCapture';
import { MicCapture } from './MicCapture';
import { ChatMenuPopover } from './ChatMenuPopover';
import { ProjectChip } from './ProjectChip';

interface Props {
  agent: AgentInfo;
  sessionId: string;
  /** Window-manager focus state. When this flips to true (e.g. user
   *  clicked the window), the chat auto-focuses the input textarea
   *  so they can type immediately without an extra click. */
  windowFocused?: boolean;
  /** Provided by the window manager so slash-commands `/session` and
   *  `/new` can mutate this window's sessionId in place. */
  onSwitchSession?: (sessionId: string) => void;
  /** Message ids currently pinned (have an open pin-note window).
   *  Drives the bubble pin-icon's active state. */
  pinnedMsgIds?: Set<string>;
  /** Open a new pin-note for one message snapshot. */
  onPin?: (note: import('../types/window').PinNote) => void;
  /** Close the pin-note window for a given message id. */
  onUnpin?: (msgId: string) => void;
}

function formatTokens(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function ChatWindow({
  agent,
  sessionId,
  windowFocused,
  onSwitchSession,
  pinnedMsgIds,
  onPin,
  onUnpin,
}: Props) {
  const color = resolveAgentColor(agent);
  const { model, thinking, refresh: refreshSessionInfo } = useSessionInfo(agent.name, sessionId);
  const chat = useChatSessionFromContext(agent.name, sessionId);
  // Tools-toggle persists per agent::session — a reload restores
  // whatever state the user last clicked into. localStorage key is
  // scoped so each chat-window remembers its own preference.
  const showToolsKey = `somora.web.showTools.${agent.name}::${sessionId}`;
  const [showTools, setShowTools] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(showToolsKey) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(showToolsKey, showTools ? '1' : '0');
    } catch {
      /* storage unavailable — drop silently */
    }
  }, [showTools, showToolsKey]);
  // Memory-inject banner — same pattern as showTools. When on and the
  // current turn injected memory hits, a band between header and body
  // shows what was pulled in. Click chevron to expand the full
  // injected text block.
  const showMemoryKey = `somora.web.showMemory.${agent.name}::${sessionId}`;
  const [showMemory, setShowMemory] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(showMemoryKey) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(showMemoryKey, showMemory ? '1' : '0');
    } catch {
      /* storage unavailable — drop silently */
    }
  }, [showMemory, showMemoryKey]);
  const [draft, setDraft] = useState('');
  // Slash-command popup state. `slashKey` is a one-shot key-event
  // signal handed to the popup; `slashKeyNonce` keeps it monotonic so
  // the popup can ignore stale signals from React re-renders.
  const slashOpen = draft.trimStart().startsWith('/');
  const [slashKey, setSlashKey] = useState<{ key: string; nonce: number } | null>(null);
  const slashKeyNonceRef = useRef(0);
  const [systemNotice, setSystemNotice] = useState<{
    text: string;
    tone: 'info' | 'error';
  } | null>(null);
  // Phase Y.B — attachments staged for the next turn. Each entry covers
  // a single file's lifecycle: `uploading` → `ready` (hash from server)
  // or `error`. Send is gated on every staged file being either ready
  // (rolls into `attachments[]`) or error (skipped, but doesn't block).
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [dragHover, setDragHover] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  // Pinned = "stick to latest". Only flipped to false by trusted user
  // intent (wheel-up, touch-drag-up, pointer-drag-up while NOT scrolling
  // toward the bottom). Programmatic scrolls and content-height changes
  // during streaming must not flip it — that was the root of the
  // intermittent unpin bug.
  const pinnedRef = useRef(true);
  // Suspends the pinned-autoscroll RAF chain while the user is mid-drag
  // on a horizontally-scrolling element inside a bubble (a fenced code
  // block's <pre> scrollbar, a wide <table>'s scrollbar). Each streaming
  // delta otherwise re-runs scrollIntoView 3x via the RAF chain below,
  // which on touch devices contributes to the "horizontal scrollbar
  // won't stay where I dragged it" symptom (Luca 2026-05-16 report).
  // Cleared 300ms after pointerup so a single rapid drag isn't broken
  // by an intervening React commit.
  const userScrollGuardRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Three-dots ••• menu state. We snapshot the anchor button's rect on
  // open so the popover can position itself without prop-drilling refs.
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);

  // Keep the textarea height in sync with the current draft. Driving this
  // from a layout-effect — rather than from the onChange handler alone —
  // ensures the height also shrinks when the draft is cleared from outside
  // typing (e.g. setDraft('') after send, slash-popup dismiss). Previously
  // the field stayed expanded until the turn ended.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    const desired = el.scrollHeight;
    if (desired <= 120) {
      el.style.height = desired + 'px';
      el.style.overflowY = 'hidden';
    } else {
      el.style.height = '120px';
      el.style.overflowY = 'auto';
    }
  }, [draft]);

  // Pinned-to-bottom: only auto-scroll while user is at the bottom
  // of the message list. Manual scroll-up via wheel/touch/drag unpins;
  // programmatic scrolls do not. Lazy-load older messages when the user
  // nears the top of the scrollback — we capture scrollHeight before
  // the load and restore the visual anchor after older slice prepends.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Re-pin when the user scrolls back to (or near) the bottom — even
    // if they had unpinned earlier with a wheel-up. Threshold 120 is
    // intentionally looser than the unpin threshold below so heights
    // that grow by a couple of lines between scroll events don't kick
    // the user off the live tail.
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < 120) pinnedRef.current = true;
    if (el.scrollTop < 60 && chat.hasMore) {
      const beforeHeight = el.scrollHeight;
      const beforeTop = el.scrollTop;
      void chat.loadOlder().then(() => {
        // After older messages prepend, the visible content moves
        // down by the height delta. Re-anchor so the user's eye
        // stays on what they were reading.
        requestAnimationFrame(() => {
          const after = scrollRef.current;
          if (!after) return;
          const delta = after.scrollHeight - beforeHeight;
          if (delta > 0) after.scrollTop = beforeTop + delta;
        });
      });
    }
  }, [chat]);

  // Trusted user-intent unpin: wheel-up or touch-drag-up away from
  // the bottom. Programmatic scrolls don't fire these — keeps the
  // auto-pin from getting clobbered during streaming when bubble
  // heights settle a few ms after React commit.
  const userScrollUnpin = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist > 120) pinnedRef.current = false;
  }, []);

  // Pinned auto-scroll: useLayoutEffect runs before paint, so the first
  // correction is invisible to the user. Two RAFs follow to catch late
  // height changes from markdown re-layout (code blocks, images) and
  // tool-block rendering — bug class is "scrollTop set once, then bubble
  // grows another 40px after layout settles, latest line ends up below
  // viewport". RAFs are throttled in background tabs which matches the
  // user's observation that the miss is more frequent there; an extra
  // post-commit retry mitigates it for foreground sessions.
  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    // Don't fight the user. If they're mid-drag on a code-block's
    // horizontal scrollbar, the RAF chain below would clobber their
    // pointer interaction every streaming delta.
    if (userScrollGuardRef.current) return;
    const sentinel = bottomSentinelRef.current;
    if (sentinel) {
      sentinel.scrollIntoView({ block: 'end' });
    } else {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      if (userScrollGuardRef.current) return;
      const s = bottomSentinelRef.current;
      if (s) s.scrollIntoView({ block: 'end' });
      raf2 = requestAnimationFrame(() => {
        if (userScrollGuardRef.current) return;
        const s2 = bottomSentinelRef.current;
        if (s2) s2.scrollIntoView({ block: 'end' });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [chat.messages, chat.streaming, chat.thinking]);

  // Set userScrollGuardRef while the user is dragging the horizontal
  // scrollbar of a code block / table inside a bubble. Detection: a
  // pointerdown landing on a <pre> or wide <table> element, cleared 300
  // ms after pointerup so the next render commit doesn't fight a still-
  // active drag. Listener lives on the scrollRef container (not document)
  // so it doesn't fire on other windows' content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Only guard when the gesture starts inside an element that owns
      // horizontal scroll. closest('pre, table') covers both fenced
      // code blocks and markdown tables (rehype-highlight wraps the
      // pre, react-markdown emits tables in a scrollable wrapper).
      if (!target.closest('pre, table')) return;
      userScrollGuardRef.current = true;
      if (releaseTimer) clearTimeout(releaseTimer);
    };
    const onUp = () => {
      if (!userScrollGuardRef.current) return;
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        userScrollGuardRef.current = false;
      }, 300);
    };
    el.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      if (releaseTimer) clearTimeout(releaseTimer);
    };
  }, []);

  // Auto-focus the input on first focus AND on every mouse-click
  // into the chat (handler below). Effect-based focus alone wasn't
  // enough: clicking inside an already-focused window doesn't
  // transition windowFocused, so the effect never re-runs.
  useEffect(() => {
    if (!windowFocused) return;
    const sel = window.getSelection?.();
    if (sel && sel.toString().length > 0) return;
    textareaRef.current?.focus();
  }, [windowFocused]);

  // After streaming ends, refocus the textarea so the user can
  // immediately type the next message — the `disabled={streaming}`
  // attribute blurs the field while the agent answers, and the
  // browser doesn't auto-restore focus when disabled flips off.
  // Gate on windowFocused so a streaming-end in a background
  // session doesn't yank focus from whichever window the user is
  // currently looking at.
  useEffect(() => {
    if (chat.streaming) return;
    if (!windowFocused) return;
    textareaRef.current?.focus();
  }, [chat.streaming, windowFocused]);

  const focusTextareaIfPossible = useCallback((target: EventTarget | null) => {
    // Skip when the click landed on a real interactive element so
    // we don't yank focus away mid-action (button click, link,
    // text-selection drag, code-block scroll-grab, etc.).
    if (target instanceof HTMLElement) {
      if (
        target.closest('button') ||
        target.closest('a') ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('pre')
      ) {
        return;
      }
    }
    // Defer focus to next tick: a synchronous .focus() during
    // onMouseDown loses the race against the browser's own
    // default focus dispatch (the click can move focus to whatever
    // element it landed on, after our handler runs). setTimeout(0)
    // queues us after that, so our focus on the textarea wins.
    setTimeout(() => {
      const sel = window.getSelection?.();
      if (sel && sel.toString().length > 0) return;
      textareaRef.current?.focus();
    }, 0);
  }, []);

  // Filter messages by toggles. Tools-toggle hides tool_call +
  // tool_result rows; memory-toggle hides memory_inject rows. State
  // stays intact in either case — toggling on restores the rows.
  const visibleMessages = useMemo(() => {
    return chat.messages.filter((m) => {
      if (!showTools && (m.role === 'tool_call' || m.role === 'tool_result')) return false;
      if (!showMemory && m.role === 'memory_inject') return false;
      return true;
    });
  }, [chat.messages, showTools, showMemory]);

  // Run a slash command resolved by the popup. Returns nothing — the
  // result is communicated via systemNotice (transient banner above
  // the input) or a thrown error. Either way the draft gets cleared.
  const dispatchSlash = useCallback(
    async (cmd: SlashCommand) => {
      try {
        if (cmd.kind === 'model') {
          await api.setSessionModel(agent.name, sessionId, cmd.ref);
          refreshSessionInfo();
          setSystemNotice({ text: `model → ${cmd.ref}`, tone: 'info' });
        } else if (cmd.kind === 'thinking') {
          await api.setSessionThinking(agent.name, sessionId, cmd.level);
          refreshSessionInfo();
          setSystemNotice({ text: `thinking → ${cmd.level}`, tone: 'info' });
        } else if (cmd.kind === 'session') {
          onSwitchSession?.(cmd.slug);
          setSystemNotice({ text: `switched to session "${cmd.slug}"`, tone: 'info' });
        } else if (cmd.kind === 'new') {
          await api.createSession(agent.name, cmd.slug);
          onSwitchSession?.(cmd.slug);
          setSystemNotice({ text: `created + switched to "${cmd.slug}"`, tone: 'info' });
        } else if (cmd.kind === 'reset') {
          const r = await api.resetSession(agent.name, sessionId);
          // Server archived the old jsonl + touched a fresh empty
          // one. SSE stays connected on the same session id — we just
          // wipe the local buffer so the chat-body reflects the now-
          // empty session immediately. Stream/memory/usage snapshots
          // also clear (fresh session, none of them apply anymore).
          chat.clearMessages();
          setSystemNotice({
            text: r.archivedId
              ? `reset → archived as ${r.archivedId} · REM scheduled`
              : 'reset → session was empty, nothing to archive',
            tone: 'info',
          });
        } else if (cmd.kind === 'projekt') {
          await api.setSessionProject(agent.name, sessionId, cmd.slug);
          void chat.refreshProject();
          setSystemNotice({ text: `project pinned: ${cmd.slug}`, tone: 'info' });
        } else if (cmd.kind === 'projekt-unlink') {
          await api.clearSessionProject(agent.name, sessionId);
          void chat.refreshProject();
          setSystemNotice({ text: 'project unlinked', tone: 'info' });
        }
      } catch (err) {
        setSystemNotice({ text: `error: ${(err as Error).message}`, tone: 'error' });
      }
    },
    [agent.name, sessionId, onSwitchSession, refreshSessionInfo, chat],
  );

  // Auto-dismiss the notice after a few seconds so it doesn't pile up.
  useEffect(() => {
    if (!systemNotice) return;
    const t = setTimeout(() => setSystemNotice(null), 3500);
    return () => clearTimeout(t);
  }, [systemNotice]);

  // Stage one or more files: drop, paste, or file-picker all flow
  // through here. Each file gets an immediate placeholder row, then
  // the upload kicks off in the background and flips the row to ready
  // / error when the server responds.
  const stageFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const newItems: PendingAttachment[] = arr.map((f) => {
      const id = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined;
      return {
        id,
        ...(previewUrl ? { previewUrl } : {}),
        state: 'uploading',
        name: f.name || 'unnamed',
        size: f.size,
        mimeHint: f.type,
      };
    });
    setPendingAttachments((prev) => [...prev, ...newItems]);
    // Fire each upload in parallel; update the matching row when each
    // resolves. Errors stick to the row, don't bubble up to the user
    // beyond the chip's red border + tooltip.
    arr.forEach((file, i) => {
      const id = newItems[i]!.id;
      api
        .uploadAttachment(file)
        .then((ref) => {
          setPendingAttachments((prev) =>
            prev.map((it) => (it.id === id ? { ...it, state: 'ready', ref } : it)),
          );
        })
        .catch((err: Error) => {
          setPendingAttachments((prev) =>
            prev.map((it) =>
              it.id === id ? { ...it, state: 'error', error: err.message } : it,
            ),
          );
        });
    });
  }, []);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const it = prev.find((x) => x.id === id);
      if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  // Paste handler — image bytes from the clipboard arrive as File
  // entries on the ClipboardEvent.clipboardData.items. Non-file paste
  // (plain text) falls through to the textarea's default behavior.
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const files: File[] = [];
      for (const item of Array.from(dt.items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        stageFiles(files);
      }
    },
    [stageFiles],
  );

  const onSend = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const text = draft.trim();
      const readyAttachments = pendingAttachments
        .filter((p) => p.state === 'ready' && p.ref)
        .map((p) => p.ref as AttachmentRef);
      const stillUploading = pendingAttachments.some((p) => p.state === 'uploading');
      if (chat.streaming) return;
      if (stillUploading) {
        setSystemNotice({ text: 'wait — attachment still uploading', tone: 'info' });
        return;
      }
      if (!text && readyAttachments.length === 0) return;
      // Slash commands never go through chat.send — the popup
      // dispatches them directly. If the textarea still holds a
      // slash on Enter, treat it as a no-op.
      if (text.startsWith('/')) return;
      setDraft('');
      // Clear staged attachments immediately — they're now in flight
      // via chat.send. Revoke any preview URLs we created.
      pendingAttachments.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
      setPendingAttachments([]);
      chat
        .send(text, readyAttachments.length > 0 ? readyAttachments : undefined)
        .catch((err: Error) => {
          // eslint-disable-next-line no-console
          console.error('[somora-web] send failed', err.message);
          setSystemNotice({ text: `send failed: ${err.message}`, tone: 'error' });
        });
    },
    [draft, chat, pendingAttachments],
  );

  const modelLabel = model?.alias ?? model?.modelId ?? '—';
  // Three-state thinking display: active (model supports reasoning + level set),
  // dormant (level set but active model has no 'reasoning' capability — TUI
  // shows the same dormant label), or hidden (no level / off).
  const thinkingLevelSet = thinking?.effective && thinking.effective !== 'off';
  const thinkingActive = thinkingLevelSet && thinking?.modelSupportsReasoning;
  const thinkingDormant = thinkingLevelSet && !thinking?.modelSupportsReasoning;

  return (
    <div
      className="chat"
      onMouseDown={(e) => focusTextareaIfPossible(e.target)}
      onDragEnter={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDragHover(true);
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
        }
      }}
      onDragLeave={(e) => {
        // Only clear when the drag leaves the chat root entirely
        // (relatedTarget outside it). DragLeave fires on every child
        // crossing too, which would flicker the overlay.
        const related = e.relatedTarget as Node | null;
        if (!related || !(e.currentTarget as Node).contains(related)) {
          setDragHover(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragHover(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          stageFiles(e.dataTransfer.files);
        }
      }}
      style={{ position: 'relative' }}
    >
      {dragHover && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            background: `${color}22`,
            border: `2px dashed ${color}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 14,
            color,
          }}
        >
          drop to attach
        </div>
      )}
      <div className="chat-header">
        <div className="chat-avatar agent-bg" style={{ background: gradientFor(color) }}>
          <span
            style={{
              fontSize: 20,
              lineHeight: 1,
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))',
            }}
          >
            {agent.icon ?? '🤖'}
          </span>
        </div>
        <div className="chat-header-info">
          <div
            className="chat-header-name"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <span>{agent.name}</span>
            {agent.role && (
              <span
                style={{
                  fontSize: 9,
                  fontFamily: '"JetBrains Mono", monospace',
                  color,
                  background: `${color}15`,
                  border: `1px solid ${color}40`,
                  padding: '1px 6px',
                  borderRadius: 3,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                }}
              >
                {agent.role}
              </span>
            )}
            {chat.streaming && (
              <span
                style={{
                  fontSize: 9,
                  fontFamily: '"JetBrains Mono", monospace',
                  color: 'var(--accent)',
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                }}
              >
                streaming…
              </span>
            )}
          </div>
          <div
            className="chat-header-meta"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10,
            }}
          >
            <span>{sessionId}</span>
            <Sep />
            <span title={model?.modelId ?? 'no model resolved'} style={{ color: 'var(--text-1)' }}>
              {modelLabel}
            </span>
            {thinkingActive && (
              <>
                <Sep />
                <span style={{ color: 'var(--accent)' }} title={`thinking: ${thinking?.effective}`}>
                  🧠 {thinking?.effective}
                </span>
              </>
            )}
            {thinkingDormant && (
              <>
                <Sep />
                <span
                  style={{ color: 'var(--text-2)' }}
                  title="thinking level is set but the active model has no 'reasoning' capability — switch model, or run /thinking off"
                >
                  thinking={thinking?.effective}{' '}
                  <span style={{ color: 'var(--warn)' }}>(dormant)</span>
                </span>
              </>
            )}
            <Sep />
            <button
              type="button"
              onClick={() => setShowTools((v) => !v)}
              title={showTools ? 'tool-call rendering on' : 'tool-call rendering off'}
              style={{
                all: 'unset',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                padding: '0 4px',
                borderRadius: 3,
                background: showTools ? `${color}25` : 'transparent',
                border: showTools ? `1px solid ${color}55` : '1px solid var(--line)',
                color: showTools ? color : 'var(--text-2)',
              }}
            >
              <Wrench size={10} />
              <span>tools</span>
            </button>
            <button
              type="button"
              onClick={() => setShowMemory((v) => !v)}
              title={showMemory ? 'memory-inject banner on' : 'memory-inject banner off'}
              style={{
                all: 'unset',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                padding: '0 4px',
                borderRadius: 3,
                background: showMemory ? `${color}25` : 'transparent',
                border: showMemory ? `1px solid ${color}55` : '1px solid var(--line)',
                color: showMemory ? color : 'var(--text-2)',
              }}
            >
              <Brain size={10} />
              <span>memory</span>
            </button>
            <Sep />
            <span style={{ color: 'var(--text-2)' }} title="prompt tokens (cached part dimmed)">
              ↑ {formatTokens(chat.usage?.tokens_in)}
              {chat.usage?.tokens_in_cached ? (
                <span style={{ color: 'var(--text-3)' }}>
                  {' '}
                  ({formatTokens(chat.usage.tokens_in_cached)}¢)
                </span>
              ) : null}
            </span>
            <span style={{ color: 'var(--text-2)' }} title="completion tokens">
              ↓ {formatTokens(chat.usage?.tokens_out)}
              {chat.usage?.tokens_out_reasoning ? (
                <span style={{ color: 'var(--accent)' }}>
                  {' '}
                  ({formatTokens(chat.usage.tokens_out_reasoning)}🧠)
                </span>
              ) : null}
            </span>
            <Sep />
            <span
              style={{
                color: chat.connected ? 'var(--ok)' : 'var(--text-3)',
              }}
              title={chat.connected ? 'SSE stream connected' : 'SSE stream disconnected'}
            >
              ● {chat.connected ? 'connected' : 'offline'}
            </span>
          </div>
        </div>
        <div className="chat-header-actions">
          {chat.projectsEnabled && (
            <ProjectChip
              agent={agent.name}
              session={sessionId}
              project={chat.project}
              onMutated={() => void chat.refreshProject()}
            />
          )}
          <button
            ref={menuButtonRef}
            type="button"
            className="chat-icon-btn"
            title="Session actions"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => {
              if (menuOpen) {
                setMenuOpen(false);
                return;
              }
              setMenuAnchorRect(menuButtonRef.current?.getBoundingClientRect() ?? null);
              setMenuOpen(true);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>
      <ChatMenuPopover
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRect={menuAnchorRect}
        model={model}
        thinking={thinking}
        onSlash={dispatchSlash}
      />

      <div
        className="chat-body"
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={(e) => {
          if (e.deltaY < 0) userScrollUnpin();
        }}
        onTouchMove={userScrollUnpin}
      >
        {chat.hasMore && !chat.loading && (
          <div
            style={{
              textAlign: 'center',
              padding: '8px 0',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10,
            }}
          >
            <button
              type="button"
              onClick={() => {
                const el = scrollRef.current;
                if (!el) return;
                const beforeHeight = el.scrollHeight;
                const beforeTop = el.scrollTop;
                void chat.loadOlder().then(() => {
                  requestAnimationFrame(() => {
                    const after = scrollRef.current;
                    if (!after) return;
                    const delta = after.scrollHeight - beforeHeight;
                    if (delta > 0) after.scrollTop = beforeTop + delta;
                  });
                });
              }}
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '2px 8px',
                borderRadius: 3,
                border: '1px solid var(--line-2)',
                color: 'var(--text-2)',
              }}
            >
              ↑ load older
            </button>
          </div>
        )}
        {chat.loading ? (
          <div
            style={{
              color: 'var(--text-3)',
              textAlign: 'center',
              padding: '24px 0',
              fontSize: 11,
            }}
          >
            loading history…
          </div>
        ) : visibleMessages.length === 0 ? (
          <div
            style={{
              color: 'var(--text-3)',
              textAlign: 'center',
              padding: '24px 0',
              fontSize: 11,
            }}
          >
            no messages yet — say hi
          </div>
        ) : (
          visibleMessages.map((m) => {
            const isPinned = pinnedMsgIds?.has(m.id) ?? false;
            const onPinClick = onPin
              ? () => {
                  if (m.role !== 'assistant' || !m.text) return;
                  if (isPinned) {
                    onUnpin?.(m.id);
                    return;
                  }
                  onPin({
                    msgId: m.id,
                    text: m.text,
                    agentName: agent.name,
                    ...(agent.icon ? { agentIcon: agent.icon } : {}),
                    ...(color ? { agentColor: color } : {}),
                    sessionId,
                    sessionLabel: sessionId === 'main' ? 'main' : sessionId,
                    ts: m.ts,
                    pinnedAt: Date.now(),
                  });
                }
              : undefined;
            return (
              <MessageItem
                key={m.id}
                msg={m}
                agentColor={color}
                agentIcon={agent.icon}
                isPinned={isPinned}
                {...(onPinClick ? { onPinClick } : {})}
              />
            );
          })
        )}
        {chat.thinking && !chat.streaming && (
          <div className="chat-msg agent">
            <div
              className="chat-msg-avatar"
              style={{ background: gradientFor(color), fontSize: 14 }}
            >
              {agent.icon ?? '🤖'}
            </div>
            <div>
              <div className="chat-msg-bubble" style={{ color: 'var(--text-2)' }}>
                <span style={{ animation: 'somora-cursor-blink 1.2s infinite' }}>
                  {agent.name} denkt nach…
                </span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomSentinelRef} aria-hidden="true" />
      </div>

      <AttachmentTray items={pendingAttachments} onRemove={removePendingAttachment} />

      <form
        className="chat-input"
        onSubmit={onSend}
        style={{ position: 'relative' }}
      >
        {systemNotice && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 8,
              right: 8,
              marginBottom: 4,
              padding: '4px 10px',
              borderRadius: 4,
              background: systemNotice.tone === 'error' ? 'var(--danger)' : 'var(--bg-3)',
              color: systemNotice.tone === 'error' ? '#fff' : 'var(--text-1)',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              border: `1px solid ${systemNotice.tone === 'error' ? 'var(--danger)' : 'var(--line-2)'}`,
              zIndex: 9,
            }}
          >
            {systemNotice.text}
          </div>
        )}
        {slashOpen && !chat.streaming && (
          <SlashCommandPopup
            agent={agent.name}
            draft={draft}
            keyEvent={slashKey}
            onAccept={({ commit, resolved }) => {
              if (resolved) {
                setDraft('');
                void dispatchSlash(resolved);
                textareaRef.current?.focus();
              } else {
                setDraft(commit);
                textareaRef.current?.focus();
              }
            }}
            onDismiss={() => setDraft('')}
          />
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) stageFiles(e.target.files);
            // Reset so the same file can be picked again next round.
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="chat-icon-btn"
          title="Attach files (or drag & drop / paste)"
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={14} />
        </button>
        <ScreenshotCapture onCaptured={(file) => stageFiles([file])} />
        <textarea
          ref={textareaRef}
          className="chat-textarea"
          rows={1}
          placeholder={`Message ${agent.name}…  (try /)`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // Slash-popup intercepts navigation keys when active.
            // Forward by bumping a nonced one-shot signal so the
            // popup picks up the keystroke without us tracking it
            // explicitly here. Enter+Shift always inserts a newline
            // (default textarea behavior); Enter without shift either
            // accepts the popup row or sends the message.
            if (slashOpen) {
              if (
                e.key === 'ArrowDown' ||
                e.key === 'ArrowUp' ||
                e.key === 'Escape' ||
                e.key === 'Tab' ||
                (e.key === 'Enter' && !e.shiftKey)
              ) {
                e.preventDefault();
                slashKeyNonceRef.current += 1;
                setSlashKey({ key: e.key, nonce: slashKeyNonceRef.current });
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={chat.streaming}
          style={{ overflowY: 'hidden' }}
        />
        <MicCapture
          onTranscript={(text) => {
            // Append to existing draft (with a separating space) so a
            // user can type a stem and dictate the rest, or vice versa.
            // Empty draft → just set the transcript.
            setDraft((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${text}` : text));
            textareaRef.current?.focus();
          }}
        />
        {chat.streaming ? (
          <button
            type="button"
            className="chat-send"
            title="Abort streaming"
            onClick={() => chat.abort()}
            style={{ background: 'var(--danger)' }}
          >
            <XIcon size={14} />
          </button>
        ) : (
          <button
            type="submit"
            className="chat-send"
            title="Send"
            disabled={!draft.trim()}
          >
            <Send size={14} />
          </button>
        )}
      </form>
    </div>
  );
}

function Sep() {
  return <span style={{ color: 'var(--line-2)' }}>·</span>;
}
