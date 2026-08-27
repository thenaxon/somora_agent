// Single message-row renderer. Memoized so the message list
// re-renders only the streaming-tail when chat-delta events arrive
// — older messages keep their identity, React skips them.
//
// Variants (after the A2A/sentinel pass):
//   user            — neutral bubble right, plain text
//   peer-agent      — A2A inbound: bubble right, sender's color+icon
//                     (looked up via `peerAgents` prop)
//   sentinel        — system-trigger inbound: centered divider
//   assistant       — bubble left, markdown content + streaming cursor
//   tool_call/...   — block forms, no bubble

import { memo, useRef, useState } from 'react';
import {
  Bell,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  File as FileIcon,
  Hourglass,
  Pause,
  Pin,
  Play,
  Square,
  SquareTerminal,
  User,
} from 'lucide-react';
import type { AssistantImage, AttachmentDisplay, ChatMessage } from '../types/chat';
import { AssistantMarkdown } from './AssistantMarkdown';
import { ToolCallBlock, ToolResultBlock } from './ToolBlocks';
import { EngineMetaBlock } from './EngineMetaBlock';

interface PeerAgentInfo {
  color: string;
  icon?: string;
}

interface Props {
  msg: ChatMessage;
  agentColor?: string;
  agentIcon?: string;
  /** Lookup for A2A inbound: when msg.fromAgent is set, this resolves
   *  the sender's color+icon so the bubble carries the SENDER's
   *  identity instead of the session-owner's. Provided by the
   *  containing ChatWindow via the useAgents registry. */
  peerAgents?: ReadonlyMap<string, PeerAgentInfo>;
  /** True when a pin-note window for this message is currently open. */
  isPinned?: boolean;
  /** Click handler for the pin button — toggles pin on/off. Omitted
   *  when the parent isn't wired for pinning (e.g. read-only renders). */
  onPinClick?: () => void;
  /** Aborts the in-flight turn for this session. Wired by ChatWindow
   *  from ChatContext.abort. When set, a streaming assistant-bubble
   *  shows a Stop button in place of pin/copy — in ADDITION to the
   *  composer Stop (both affordances stay, user preference). */
  onAbort?: () => void;
}

/** `provider/modelId` → the id only, for compact chips. */
function shortModelRef(ref: string): string {
  const slash = ref.indexOf('/');
  return slash < 0 ? ref : ref.slice(slash + 1);
}

export const MessageItem = memo(function MessageItem({
  msg,
  agentColor,
  agentIcon,
  peerAgents,
  isPinned,
  onPinClick,
  onAbort,
}: Props) {
  if (msg.role === 'tool_call') {
    return <ToolCallBlock toolCall={msg.toolCall} />;
  }
  if (msg.role === 'tool_result') {
    return <ToolResultBlock toolResult={msg.toolResult} />;
  }
  if (msg.role === 'engine_meta') {
    return <EngineMetaBlock meta={msg.meta} />;
  }
  if (msg.role === 'memory_inject') {
    return <MemoryInjectLine memory={msg.memory} />;
  }
  // System-triggered inbound (sentinel fire, tmux attention wake):
  // centered divider, not a bubble. Sentinel keeps the `<Bell />` the
  // AppDock uses; tmux wakes get a terminal glyph + session name.
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
  const peer = isPeer && msg.fromAgent ? peerAgents?.get(msg.fromAgent) : undefined;

  if (msg.role === 'user') {
    // User OR peer-agent inbound — both right-aligned. Distinction
    // is purely visual: peer gets sender-color+icon and an
    // assistant-style bubble background; plain user keeps the
    // neutral look from before.
    const peerColor = peer?.color;
    const peerIcon = peer?.icon;
    return (
      <div className={`chat-msg-row ${isPeer ? 'peer-agent' : 'user'}`}>
        <div className="chat-msg">
          <div
            className="chat-msg-avatar"
            style={
              isPeer && peerColor
                ? {
                    background: `linear-gradient(135deg, ${peerColor}, ${peerColor}88)`,
                    fontSize: 14,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }
                : {
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }
            }
          >
            {isPeer ? (peerIcon ?? '🤖') : <User size={12} />}
          </div>
          <div className="chat-msg-meta-col">
            {msg.text && (
              <BubbleActions text={msg.text} isPinned={false} />
            )}
            <div
              className={`chat-msg-bubble ${isPeer ? 'peer-bubble' : ''}`}
              style={
                isPeer && peerColor
                  ? {
                      whiteSpace: 'pre-wrap',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: msg.attachments && msg.attachments.length > 0 ? 6 : 0,
                      background: `${peerColor}1f`,
                      borderColor: `${peerColor}30`,
                    }
                  : {
                      whiteSpace: 'pre-wrap',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: msg.attachments && msg.attachments.length > 0 ? 6 : 0,
                    }
              }
            >
              {msg.attachments && msg.attachments.length > 0 && (
                <UserAttachmentRow attachments={msg.attachments} />
              )}
              {msg.text && <span>{msg.text}</span>}
            </div>
            <BubbleTimestamp ts={msg.ts} queued={msg.queued} />
          </div>
        </div>
      </div>
    );
  }
  // assistant — left-aligned bubble.
  const showActions = !msg.streaming && !!msg.text;
  // Streaming bubble keeps a permanent Stop button in the action slot
  // — replaces pin/copy while the turn is in flight. The composer
  // additionally shows Stop next to Send; both trigger the same abort.
  const showStop = msg.streaming === true && !!onAbort;
  return (
    <div className="chat-msg-row agent">
      <div className="chat-msg">
        <div
          className="chat-msg-avatar"
          style={{
            background: agentColor
              ? `linear-gradient(135deg, ${agentColor}, ${agentColor}88)`
              : 'var(--bg-3)',
            fontSize: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {agentIcon ?? '🤖'}
        </div>
        <div className="chat-msg-meta-col">
          {showStop && onAbort && <StopAction onAbort={onAbort} />}
          {showActions && (
            <BubbleActions
              text={msg.text ?? ''}
              isPinned={!!isPinned}
              {...(onPinClick ? { onPinClick } : {})}
            />
          )}
          <div className="chat-msg-bubble agent-bubble" style={{ position: 'relative' }}>
            {msg.text ? (
              <AssistantMarkdown content={msg.text} />
            ) : (
              <span style={{ color: 'var(--text-3)' }}>…</span>
            )}
            {msg.streaming && (
              <span
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 12,
                  marginLeft: 2,
                  verticalAlign: 'middle',
                  background: 'var(--text-2)',
                  animation: 'somora-cursor-blink 1s steps(1) infinite',
                }}
              />
            )}
            {msg.role === 'assistant' && msg.images && msg.images.length > 0 && (
              <GeneratedImageRow images={msg.images} />
            )}
            {msg.role === 'assistant' && msg.audio && <PlayAudioButton url={msg.audio.url} />}
            {msg.role === 'assistant' && msg.fallback && (
              <span
                className="fallback-chip"
                title={
                  `Answered by the fallback model ${msg.fallback.actual} — the primary ` +
                  `${msg.fallback.requested} failed before producing anything: ${msg.fallback.reason}`
                }
              >
                ⇄ fallback · {shortModelRef(msg.fallback.actual)}
              </span>
            )}
          </div>
          <BubbleTimestamp ts={msg.ts} />
        </div>
      </div>
    </div>
  );
});

// Centered system-divider for sentinel-trigger inbounds. The
// `text` is the synthesized trigger prompt (`[Sentinel trigger
// fired]\ntrigger_id: …\nname: …`) — we surface the first non-
// empty line after the leading marker as a one-liner; the rest
// stays in JSONL for forensic recall but doesn't clutter the chat.
function SentinelDivider({ text, ts }: { text: string; ts: number }) {
  const summary = summarizeSentinelTriggerText(text);
  const time = formatBubbleTime(ts);
  return (
    <div className="sentinel-divider" aria-label="Sentinel trigger">
      <span className="sentinel-divider-rule" />
      <span className="sentinel-divider-body">
        <Bell size={12} />
        <span className="sentinel-divider-label">Sentinel</span>
        {summary && (
          <>
            <span className="sentinel-divider-sep">·</span>
            <span className="sentinel-divider-name">{summary}</span>
          </>
        )}
        <span className="sentinel-divider-sep">·</span>
        <span className="sentinel-divider-time">{time}</span>
      </span>
      <span className="sentinel-divider-rule" />
    </div>
  );
}

// tmux attention wake — same divider chrome as Sentinel (shared CSS
// classes), terminal glyph instead of the bell. `text` is the wake
// prompt; we surface the quoted session name from its first line.
function TmuxDivider({ text, ts }: { text: string; ts: number }) {
  const summary = summarizeTmuxWakeText(text);
  const time = formatBubbleTime(ts);
  return (
    <div className="sentinel-divider" aria-label="tmux attention wake">
      <span className="sentinel-divider-rule" />
      <span className="sentinel-divider-body">
        <SquareTerminal size={12} />
        <span className="sentinel-divider-label">tmux</span>
        {summary && (
          <>
            <span className="sentinel-divider-sep">·</span>
            <span className="sentinel-divider-name">{summary}</span>
          </>
        )}
        <span className="sentinel-divider-sep">·</span>
        <span className="sentinel-divider-time">{time}</span>
      </span>
      <span className="sentinel-divider-rule" />
    </div>
  );
}

// Subagent attention wake — same centered-divider language as
// sentinel/tmux. Shows the finished task_id so the user can correlate
// with subagent_list output at a glance.
function SubagentDivider({ text, ts }: { text: string; ts: number }) {
  const taskId = summarizeSubagentWakeText(text);
  const time = formatBubbleTime(ts);
  return (
    <div className="sentinel-divider" aria-label="subagent attention wake">
      <span className="sentinel-divider-rule" />
      <span className="sentinel-divider-body">
        <Bot size={12} />
        <span className="sentinel-divider-label">subagent</span>
        {taskId && (
          <>
            <span className="sentinel-divider-sep">·</span>
            <span className="sentinel-divider-name">{taskId}</span>
          </>
        )}
        <span className="sentinel-divider-sep">·</span>
        <span className="sentinel-divider-time">{time}</span>
      </span>
      <span className="sentinel-divider-rule" />
    </div>
  );
}

/** Pull the task id out of the `[subagent attention] Task 'task_x'…`
 *  wake prompt; empty string when the shape ever changes. */
function summarizeSubagentWakeText(text: string): string {
  const m = text.match(/Task '([^']+)'/);
  return m?.[1] ?? '';
}

function summarizeTmuxWakeText(text: string): string {
  // Wake prompts start with: [tmux attention] Session '<name>' (…
  const match = text.match(/Session '([^']+)'/);
  if (match && match[1]) return match[1];
  return '';
}

function summarizeSentinelTriggerText(text: string): string {
  // The dispatcher's buildFirePrompt emits a header block:
  //   [Sentinel trigger fired]
  //   trigger_id: <id>
  //   name: <name>
  //   …
  // We surface just the name as the divider label.
  const match = text.match(/^name:\s*(.+)$/im);
  if (match && match[1]) return match[1].trim();
  return '';
}

function BubbleTimestamp({
  ts,
  queued,
}: {
  ts: number;
  queued?: { ahead: number };
}) {
  if (!ts && !queued) return null;
  // queued marker sits to the LEFT of the time, same row, dimmed.
  // We surface "queued" alone when ahead<=1 (just the currently-
  // running turn to wait for), and "queued · N ahead" when there
  // are other waiters in front.
  return (
    <span className="chat-msg-time">
      {queued && (
        <span className="chat-msg-queued" title="Waiting for the previous turn to finish">
          <Hourglass size={10} />
          <span>queued</span>
          {queued.ahead > 1 && <span>· {queued.ahead - 1} ahead</span>}
          <span className="chat-msg-queued-sep">·</span>
        </span>
      )}
      {ts ? formatBubbleTime(ts) : ''}
    </span>
  );
}

function formatBubbleTime(ts: number): string {
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

// Per-bubble Play-button for assistant turns that have a pre-generated
// TTS artifact. Rendered only when an `assistant_audio` event arrived
// for this turn — never re-generates on click, just plays what's
// already cached server-side.
function PlayAudioButton({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  function onClick() {
    if (audioRef.current) {
      if (playing) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        setPlaying(false);
        return;
      }
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
        border: '1px solid var(--border-2)',
        borderRadius: 4,
        color: 'var(--text-2)',
        cursor: 'pointer',
        fontSize: 12,
        padding: '3px 8px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {playing ? <Pause size={12} /> : <Play size={12} />}
      <span>{playing ? 'Stop' : 'Play'}</span>
    </button>
  );
}

// Always-visible Stop button shown in place of pin/copy while a
// turn is streaming. Unlike BubbleActions this is NOT hover-gated —
// the `bubble-actions bubble-stop` class drops the opacity-on-hover
// rule from desktop.css so the button stays in the visual hierarchy
// the entire time the agent is talking. Click → abort the in-flight
// turn for this (agent, session); the response from /chat/abort is
// asynchronous, the actual close-out arrives as a chat:final + agent:end.
function StopAction({ onAbort }: { onAbort: () => void }) {
  return (
    <div className="bubble-actions bubble-stop" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="bubble-action-btn bubble-stop-btn"
        title="Stop generating"
        onClick={onAbort}
        aria-label="Stop generating"
      >
        <Square size={11} fill="currentColor" />
      </button>
    </div>
  );
}

// Hover-revealed copy + pin buttons in the top-right corner of an
// assistant bubble. When `isPinned` is true the pin icon is always
// visible (yellow, filled) so the user can spot pinned messages in
// the scroll without having to hover each one.
function BubbleActions({
  text,
  isPinned,
  onPinClick,
}: {
  text: string;
  isPinned: boolean;
  onPinClick?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts. Silent — user
      // will see no feedback and can retry with a manual selection.
    }
  }

  return (
    <div
      className={`bubble-actions ${isPinned ? 'has-pinned' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="bubble-action-btn"
        title={copied ? 'Copied' : 'Copy message'}
        onClick={handleCopy}
        aria-label="Copy message"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {onPinClick && (
        <button
          type="button"
          className={`bubble-action-btn pin-btn ${isPinned ? 'active' : ''}`}
          title={isPinned ? 'Unpin' : 'Pin this message'}
          onClick={onPinClick}
          aria-label={isPinned ? 'Unpin message' : 'Pin message'}
          aria-pressed={isPinned}
        >
          <Pin
            size={12}
            fill={isPinned ? 'currentColor' : 'none'}
          />
        </button>
      )}
    </div>
  );
}

// Images generated during an assistant turn, shown under the reply.
//
// Rendered large rather than as the small chips used for user
// attachments: the user asked for a picture, and a 24px thumbnail of it
// would be a worse answer than the file path. Clicking opens the full
// image in a new tab — the window has no lightbox, and a broken
// half-measure would be worse than the browser's own viewer.
function GeneratedImageRow({ images }: { images: AssistantImage[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {images.map((img) => (
        <a
          key={img.id}
          href={img.url}
          target="_blank"
          rel="noreferrer"
          title={img.prompt}
          style={{ display: 'block', lineHeight: 0 }}
        >
          <img
            src={img.url}
            alt={img.prompt}
            loading="lazy"
            style={{
              maxWidth: images.length > 1 ? 168 : 320,
              maxHeight: 320,
              borderRadius: 6,
              border: '1px solid var(--line)',
              display: 'block',
            }}
            onError={(e) => {
              // The file was moved or deleted outside somora. Drop the
              // broken-image icon rather than leaving a grey box.
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        </a>
      ))}
    </div>
  );
}

// Attachment row inside a user-bubble. Image attachments render as
// thumbnails sourced from `/attachments/<hash>` (a tiny helper route
// would be cleaner, but reusing the staged previewUrl-or-nothing
// pattern here just shows the icon — the agent has the bytes
// server-side, the user already saw the file when picking it).
function UserAttachmentRow({ attachments }: { attachments: AttachmentDisplay[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {attachments.map((a) => (
        <div
          key={a.hash + a.name}
          title={`${a.name} (${formatBytes(a.size)})`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.18)',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            maxWidth: 220,
          }}
        >
          {a.kind === 'image' ? (
            <img
              src={`/attachments/${a.hash}`}
              alt={a.name}
              style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 2 }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : a.kind === 'pdf' ? (
            <FileText size={12} />
          ) : (
            <FileIcon size={12} />
          )}
          <span
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {a.name}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function MemoryInjectLine({ memory }: { memory: import('../types/chat').MemoryHitsSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  // Cap visible refs at 3 like the TUI; surface the rest as `+N more`
  // so a recall with 8 hits doesn't smear the whole line with slugs.
  const MAX_VISIBLE = 3;
  const visible = memory.refs.slice(0, MAX_VISIBLE);
  const overflow = memory.refs.length - visible.length;
  const sourceTint = (ref: string): string => {
    if (ref.startsWith('wiki/')) return 'var(--accent)';
    if (ref.startsWith('memory/')) return 'var(--text-1)';
    if (ref.startsWith('vault/')) return 'var(--text-2)';
    return 'var(--text-2)';
  };
  return (
    <div
      style={{
        margin: '4px 12px 4px 28px',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
        color: 'var(--text-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Brain size={11} style={{ color: 'var(--accent-2, #c084fc)' }} />
        <span style={{ color: 'var(--accent-2, #c084fc)', fontWeight: 600 }}>
          memory · {memory.count} hit{memory.count === 1 ? '' : 's'}
        </span>
        {typeof memory.topScore === 'number' && (
          <span style={{ color: 'var(--text-3)' }} title="top hybrid score">
            top {memory.topScore.toFixed(2)}
          </span>
        )}
        {visible.length > 0 && (
          <>
            <span style={{ color: 'var(--line-2)' }}>·</span>
            {visible.map((ref) => (
              <span key={ref} title={ref} style={{ color: sourceTint(ref), whiteSpace: 'nowrap' }}>
                {ref}
              </span>
            ))}
            {overflow > 0 && (
              <span style={{ color: 'var(--text-3)' }}>+{overflow} more</span>
            )}
          </>
        )}
        {memory.fullText && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'collapse full inject text' : 'expand full inject text'}
            style={{
              all: 'unset',
              cursor: 'pointer',
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              color: 'var(--text-3)',
            }}
          >
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
      </div>
      {expanded && memory.fullText && (
        <pre
          style={{
            margin: 0,
            maxHeight: 220,
            overflow: 'auto',
            background: 'var(--surface-1)',
            border: '1px solid var(--line-2)',
            borderRadius: 4,
            padding: 6,
            fontSize: 10,
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            color: 'var(--text-1)',
          }}
        >
          {memory.fullText}
        </pre>
      )}
    </div>
  );
}
