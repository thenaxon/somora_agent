// Single message-row renderer. Memoized so the message list
// re-renders only the streaming-tail when chat-delta events arrive
// — older messages keep their identity, React skips them.
//
// Roles:
//   user           — bubble right, plain text
//   assistant      — bubble left, markdown content + streaming cursor
//   tool_call      — collapsible tool-call block (full width)
//   tool_result    — collapsible tool-result block (full width)
//   memory_inject  — inline `◇ memory · N hits · refs…` line (TUI-style)

import { memo, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  File as FileIcon,
  Pin,
  User,
} from 'lucide-react';
import type { AttachmentDisplay, ChatMessage } from '../types/chat';
import { AssistantMarkdown } from './AssistantMarkdown';
import { ToolCallBlock, ToolResultBlock } from './ToolBlocks';

interface Props {
  msg: ChatMessage;
  agentColor?: string;
  agentIcon?: string;
  /** True when a pin-note window for this message is currently open. */
  isPinned?: boolean;
  /** Click handler for the pin button — toggles pin on/off. Omitted
   *  when the parent isn't wired for pinning (e.g. read-only renders). */
  onPinClick?: () => void;
}

export const MessageItem = memo(function MessageItem({
  msg,
  agentColor,
  agentIcon,
  isPinned,
  onPinClick,
}: Props) {
  if (msg.role === 'tool_call') {
    return <ToolCallBlock toolCall={msg.toolCall} />;
  }
  if (msg.role === 'tool_result') {
    return <ToolResultBlock toolResult={msg.toolResult} />;
  }
  if (msg.role === 'memory_inject') {
    return <MemoryInjectLine memory={msg.memory} />;
  }
  if (msg.role === 'user') {
    return (
      <div className="chat-msg user">
        <div
          className="chat-msg-avatar"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <User size={12} />
        </div>
        <div
          className="chat-msg-bubble"
          style={{
            whiteSpace: 'pre-wrap',
            display: 'flex',
            flexDirection: 'column',
            gap: msg.attachments && msg.attachments.length > 0 ? 6 : 0,
          }}
        >
          {msg.attachments && msg.attachments.length > 0 && (
            <UserAttachmentRow attachments={msg.attachments} />
          )}
          {msg.text && <span>{msg.text}</span>}
        </div>
      </div>
    );
  }
  // assistant — bubble is the direct flex child (no wrapper div).
  // Wrapping the bubble in another div let `min-width: 0` collapse
  // it below content size, making the bubble's `max-width: 75%`
  // resolve against a tiny container and break short text like
  // "Danke" mid-word. Mirrors orbit's layout pattern.
  const showActions = !msg.streaming && !!msg.text;
  return (
    <div className="chat-msg agent">
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
        {showActions && (
          <BubbleActions
            text={msg.text ?? ''}
            isPinned={!!isPinned}
            {...(onPinClick ? { onPinClick } : {})}
          />
        )}
      </div>
    </div>
  );
});

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
