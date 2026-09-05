// Scrollable message list for the active agent. Auto-pins to the
// bottom unless the user has scrolled up to read (then we leave them
// alone). All chat-stream state is passed in from MobileApp — no
// SSE-owning hook here, to keep the subscription single per active agent.

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

// Agents reference local files by bare absolute path (FileView convention
// on the desktop client). The phone has no FileView window, so both links
// and inline images to such paths go through /files/raw, which applies
// the file_read policy. Module-level so ReactMarkdown keeps component
// identity across renders.
const FILESYSTEM_PATH_RE = /^(~|\/(home|Users|var|opt|tmp|etc|mnt|root))(\/|$)/;
const rawUrl = (p: string | undefined): string | undefined =>
  p && FILESYSTEM_PATH_RE.test(p) ? `/files/raw?path=${encodeURIComponent(p)}` : p;
const MARKDOWN_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={rawUrl(href)} target="_blank" rel="noopener noreferrer" draggable={false}>
      {children}
    </a>
  ),
  img: ({ src, alt }: { src?: string; alt?: string }) => {
    const url = rawUrl(typeof src === 'string' ? src : undefined);
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img src={url} alt={alt ?? ''} style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 6 }} />
      </a>
    );
  },
};
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage, ThinkingContent } from '../hooks/useChatStream';
import type { AgentInfo } from '../hooks/useAgents';
import { resolveAgentColor } from '../hooks/agentColors';

interface Props {
  agent: string;
  messages: ChatMessage[];
  streaming: boolean;
  connectionError: string | null;
  /** Transient status (abort outcome). Shown as info banner. */
  statusNotice?: string | null;
  /** Full agent registry — used to resolve sender color+icon for
   *  A2A inbound (msg.fromAgent) AND the active agent's own color+
   *  icon for outgoing/agent bubbles. Mobile mirrors web's per-
   *  agent coloring instead of the older uniform `--bg-2`. */
  agents: AgentInfo[];
  /** Aborts the in-flight turn. Wired to useChatStream.abort. The
   *  streaming agent-bubble keeps its always-on Stop (no hover
   *  affordance on touch) IN ADDITION to the composer Stop — both
   *  trigger the same abort. */
  onAbort: () => void;
  /** Take a queued (not yet started) message back into the composer.
   *  Wired to useChatStream.recall by MobileApp; the "↩ edit" button
   *  on a queued bubble calls it with the bubble's id. */
  onRecall?: (messageId: string) => void;
}

export function ChatArea({
  agent,
  messages,
  streaming,
  connectionError,
  statusNotice,
  agents,
  onAbort,
  onRecall,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUpRef.current = distance > 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (userScrolledUpRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
  }, [messages]);

  // Lookup table: agent name → resolved color + icon. Used for
  // both the active agent's own bubbles AND A2A peer inbounds.
  const agentLookup = useMemo(() => {
    const m = new Map<string, { color: string; icon?: string }>();
    for (const a of agents) {
      m.set(a.name, {
        color: resolveAgentColor(a),
        ...(a.icon ? { icon: a.icon } : {}),
      });
    }
    return m;
  }, [agents]);

  const activeAgentInfo = agentLookup.get(agent);

  return (
    <>
      {connectionError && <div className="banner info">{connectionError}</div>}
      {statusNotice && <div className="banner info">{statusNotice}</div>}
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !streaming && (
          <div className="chat-empty">
            Sag etwas zu <strong>{agent}</strong>.
          </div>
        )}
        {messages.map((m) => (
          <MobileMessage
            key={m.id}
            msg={m}
            activeAgentColor={activeAgentInfo?.color}
            {...(activeAgentInfo?.icon ? { activeAgentIcon: activeAgentInfo.icon } : {})}
            agentLookup={agentLookup}
            onAbort={onAbort}
            {...(onRecall ? { onRecall } : {})}
          />
        ))}
        {/* Typing-indicator: shown when the server is working but the
            agent hasn't started emitting text yet (model thinking,
            ToolSearch, tool_call still running). Disappears as soon
            as the first chat.delta lands and the streaming bubble
            takes over. Three-dot animation lives in styles.css. */}
        {streaming && !messages.some((m) => m.role === 'agent' && m.streaming) && (
          <div className="msg-row agent" aria-live="polite">
            <div
              className="msg-bubble agent typing-indicator"
              style={
                activeAgentInfo?.color
                  ? {
                      background: `${activeAgentInfo.color}1f`,
                      borderColor: `${activeAgentInfo.color}30`,
                    }
                  : undefined
              }
            >
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

interface MobileMessageProps {
  msg: ChatMessage;
  activeAgentColor?: string;
  activeAgentIcon?: string;
  agentLookup: ReadonlyMap<string, { color: string; icon?: string }>;
  onAbort: () => void;
  onRecall?: (messageId: string) => void;
}

// One row in the chat scroll. Handles five visual variants:
//   - sentinel divider (centered, system styling, Bell icon)
//   - peer-agent inbound (right side, sender's color+icon)
//   - user (right side, neutral — same look as before)
//   - assistant (left side, active agent's color+icon)
//   - error (left side, compact danger block — the turn failed;
//     rendered IN the turn so later turns don't shift, 2026-08-28)
// A streaming agent-bubble additionally carries an always-on Stop
// (composer shows a second Stop next to Send — both abort).
function MobileMessage({
  msg,
  activeAgentColor,
  activeAgentIcon,
  agentLookup,
  onAbort,
  onRecall,
}: MobileMessageProps) {
  if (msg.role === 'error') {
    return (
      <div className="msg-row error" role="alert">
        <div className="msg-col">
          <div className="msg-bubble error">
            <span className="msg-error-glyph" aria-hidden="true">⚠</span> {msg.text}
            {msg.mediaNote && (
              <MediaNote images={msg.mediaNote.images} videos={msg.mediaNote.videos} />
            )}
          </div>
          <span className="msg-time">{formatMobileTime(msg.ts)}</span>
        </div>
      </div>
    );
  }
  if (msg.role === 'user' && msg.fromSystem === 'sentinel') {
    return <SentinelDivider text={msg.text} ts={msg.ts} />;
  }
  if (msg.role === 'user' && msg.fromSystem === 'tmux') {
    return <TmuxDivider text={msg.text} ts={msg.ts} />;
  }
  if (msg.role === 'user' && msg.fromSystem === 'subagent') {
    return <SubagentDivider text={msg.text} ts={msg.ts} />;
  }
  const isPeer = msg.role === 'user' && !!msg.fromAgent;
  const peer = isPeer && msg.fromAgent ? agentLookup.get(msg.fromAgent) : undefined;
  const isAgent = msg.role === 'agent';

  const variant: string = isPeer ? 'peer-agent' : msg.role;
  const bubbleStyle: React.CSSProperties = {};
  if (isPeer && peer) {
    bubbleStyle.background = `${peer.color}1f`;
    bubbleStyle.borderColor = `${peer.color}30`;
  } else if (isAgent && activeAgentColor) {
    bubbleStyle.background = `${activeAgentColor}1f`;
    bubbleStyle.borderColor = `${activeAgentColor}30`;
  }

  const avatarColor = isPeer ? peer?.color : activeAgentColor;
  const avatarIcon = isPeer ? peer?.icon : activeAgentIcon;

  return (
    <div className={`msg-row ${variant}`}>
      {(isPeer || isAgent) && (
        <span
          className="msg-avatar"
          style={
            avatarColor
              ? { background: `linear-gradient(135deg, ${avatarColor}, ${avatarColor}88)` }
              : undefined
          }
        >
          {avatarIcon ?? '🤖'}
        </span>
      )}
      <div className="msg-col">
        <div className={`msg-bubble ${variant}`} style={bubbleStyle}>
          {isAgent && msg.thinking && <ThinkingLine thinking={msg.thinking} hasText={!!msg.text} />}
          {isAgent && !msg.text && msg.mediaNote ? null : isAgent ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={MARKDOWN_COMPONENTS}
            >
              {msg.text}
            </ReactMarkdown>
          ) : (
            msg.text
          )}
          {isAgent && msg.streaming && <span className="msg-streaming-cursor" />}
          {isAgent && msg.streaming && (
            <button
              type="button"
              className="msg-stop-btn"
              onClick={onAbort}
              aria-label="Stop generating"
              title="Stop generating"
            >
              <StopIcon />
            </button>
          )}
          {isAgent && msg.audio && <PlayAudioButton url={msg.audio.url} />}
          {isAgent && msg.mediaNote && (
            <MediaNote images={msg.mediaNote.images} videos={msg.mediaNote.videos} />
          )}
        </div>
        <span className="msg-time">
          {msg.role === 'user' && msg.queued && (
            <span className="msg-queued" title="Waiting for the previous turn to finish">
              <HourglassIcon />
              <span>queued</span>
              {msg.queued.ahead > 1 && <span>· {msg.queued.ahead - 1} ahead</span>}
              <span className="msg-queued-sep">·</span>
            </span>
          )}
          {/* Recall: while the server still holds the message in line it
           *  can be taken back into the composer, edited and re-sent —
           *  Stop only interrupts the RUNNING turn (2026-08-26 ask). */}
          {msg.role === 'user' && msg.queued && !msg.fromAgent && !msg.fromSystem && onRecall && (
            <button
              type="button"
              className="msg-recall-btn"
              onClick={() => onRecall(msg.id)}
              aria-label="Edit queued message"
              title="Take back and edit"
            >
              ↩ edit
            </button>
          )}
          {formatMobileTime(msg.ts)}
        </span>
      </div>
    </div>
  );
}

// Compact reasoning line at the top of an agent bubble — the phone
// version of the web's ThinkingBlock. One row, never a big open box:
//   thinking, no reply text yet — the row plus the LAST line of the
//     reasoning underneath it, muted and ellipsised, so the user sees
//     the model working without the bubble growing on a small screen;
//   thinking, reply text arrived — just the row, pulsing until the
//     thinking final lands;
//   final — just the row. Tap to expand: full text, plain (half-formed
//     markdown mid-stream renders badly), pre-wrap, capped at ~50vh and
//     scrollable, with the server's truncation note when flagged.
// A manual tap wins for the life of the row: `userOpen` starts as null
// ("no opinion") and is never reset by prop updates, so a late final
// does not snap a block the user opened shut.
function ThinkingLine({ thinking, hasText }: { thinking: ThinkingContent; hasText: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const streaming = thinking.streaming === true;
  const open = userOpen ?? false;
  const peek = streaming && !hasText && !open ? lastNonEmptyLine(thinking.text) : '';
  // Keep an opened box pinned to the newest line while deltas arrive.
  useEffect(() => {
    if (!open || !streaming) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, streaming, thinking.text]);
  return (
    <div
      className={`thinking-line ${open ? 'open' : ''} ${streaming ? 'streaming' : ''} ${hasText ? 'with-text' : ''}`}
    >
      <button
        type="button"
        className="thinking-head"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        aria-label={open ? 'Hide thinking' : 'Show thinking'}
      >
        <span className="thinking-head-row">
          <span className="thinking-label">🧠 thinking</span>
          {streaming && (
            <span className="thinking-pulse" aria-label="thinking in progress">…</span>
          )}
          <span className="thinking-chevron" aria-hidden="true">
            <ChevronIcon up={open} />
          </span>
        </span>
        {peek && <span className="thinking-peek">{peek}</span>}
      </button>
      {open && (
        <div className="thinking-body" ref={bodyRef}>
          {thinking.text}
          {!streaming && thinking.truncated && (
            <span className="thinking-truncated"> (truncated by the server)</span>
          )}
        </div>
      )}
    </div>
  );
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? '';
    if (line) return line;
  }
  return '';
}

// Inline line-art chevron (lucide path) — mobile bundle keeps the
// "no lucide-react" rule, see MicButton.tsx.
function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {up ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}
    </svg>
  );
}

// The PWA deliberately shows no images or video: it is a phone client
// for reading and replying, and the desktop app is where media gets
// looked at. But saying NOTHING would make a turn that produced a
// picture read as "the agent answered without delivering" — so the
// bubble carries one line naming what exists and where to see it.
function MediaNote({ images, videos }: { images: number; videos: number }) {
  const parts: string[] = [];
  if (images > 0) parts.push(images === 1 ? '1 image' : `${images} images`);
  if (videos > 0) parts.push(videos === 1 ? '1 video' : `${videos} videos`);
  if (parts.length === 0) return null;
  return <div className="msg-media-note">{parts.join(' · ')} · open in the web app</div>;
}

// Inline line-art Hourglass — path copied from lucide-react so the
// mobile bundle keeps the "no lucide-react" rule (see MicButton.tsx).
// Same visual language as the Sentinel Bell on web; gray stroke,
// no fill. 12×12 at the timestamp baseline.
function HourglassIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
  );
}

// Inline line-art Stop (filled square). Used by the always-on Stop
// button on a streaming agent bubble. Filled because "stop" needs a
// solid visual hit-target on touch; outline would read as decorative.
function StopIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

// Centered system-trigger divider. Same visual language as the web's
// SentinelDivider — a thin rule with the Bell glyph + trigger name +
// time. No bubble, since this wasn't sent by a person or an agent.
function SentinelDivider({ text, ts }: { text: string; ts: number }) {
  const name = summarizeSentinelTriggerText(text);
  const time = formatMobileTime(ts);
  return (
    <div className="sentinel-divider" aria-label="Sentinel trigger">
      <span className="sentinel-rule" />
      <span className="sentinel-body">
        <span className="sentinel-icon" aria-hidden="true">🔔</span>
        <span className="sentinel-label">Sentinel</span>
        {name && (
          <>
            <span className="sentinel-sep">·</span>
            <span className="sentinel-name">{name}</span>
          </>
        )}
        <span className="sentinel-sep">·</span>
        <span className="sentinel-time">{time}</span>
      </span>
      <span className="sentinel-rule" />
    </div>
  );
}

// tmux attention wake — same divider chrome as Sentinel (shared CSS
// classes), terminal glyph instead of the bell.
function TmuxDivider({ text, ts }: { text: string; ts: number }) {
  const name = summarizeTmuxWakeText(text);
  const time = formatMobileTime(ts);
  return (
    <div className="sentinel-divider" aria-label="tmux attention wake">
      <span className="sentinel-rule" />
      <span className="sentinel-body">
        <span className="sentinel-icon" aria-hidden="true">🖥️</span>
        <span className="sentinel-label">tmux</span>
        {name && (
          <>
            <span className="sentinel-sep">·</span>
            <span className="sentinel-name">{name}</span>
          </>
        )}
        <span className="sentinel-sep">·</span>
        <span className="sentinel-time">{time}</span>
      </span>
      <span className="sentinel-rule" />
    </div>
  );
}

// Subagent attention wake — same centered-divider language as
// sentinel/tmux. Shows the finished task_id for correlation.
function SubagentDivider({ text, ts }: { text: string; ts: number }) {
  const taskId = text.match(/Task '([^']+)'/)?.[1] ?? '';
  const time = formatMobileTime(ts);
  return (
    <div className="sentinel-divider" aria-label="subagent attention wake">
      <span className="sentinel-rule" />
      <span className="sentinel-body">
        <span className="sentinel-icon" aria-hidden="true">🤖</span>
        <span className="sentinel-label">subagent</span>
        {taskId && (
          <>
            <span className="sentinel-sep">·</span>
            <span className="sentinel-name">{taskId}</span>
          </>
        )}
        <span className="sentinel-sep">·</span>
        <span className="sentinel-time">{time}</span>
      </span>
      <span className="sentinel-rule" />
    </div>
  );
}

function summarizeTmuxWakeText(text: string): string {
  const match = text.match(/Session '([^']+)'/);
  if (match && match[1]) return match[1];
  return '';
}

function summarizeSentinelTriggerText(text: string): string {
  const match = text.match(/^name:\s*(.+)$/im);
  if (match && match[1]) return match[1].trim();
  return '';
}

function formatMobileTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mo}. ${hh}:${mm}`;
}

// Per-bubble Play-button for agent turns that have a server-generated
// TTS audio artifact attached. Tappable to replay; tap again to stop.
function PlayAudioButton({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  function onClick() {
    if (playing && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlaying(false);
      return;
    }
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => {
      setPlaying(false);
      audioRef.current = null;
    };
    audio.onerror = () => {
      setPlaying(false);
      audioRef.current = null;
    };
    audio.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={playing ? 'Stop' : 'Play voice reply'}
      style={{
        marginTop: 6,
        background: 'transparent',
        border: '1px solid var(--border-2, #444)',
        borderRadius: 4,
        color: 'var(--text-2, #888)',
        cursor: 'pointer',
        fontSize: 12,
        padding: '4px 10px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span aria-hidden="true">{playing ? '⏸' : '▶'}</span>
      <span>{playing ? 'Stop' : 'Play'}</span>
    </button>
  );
}
