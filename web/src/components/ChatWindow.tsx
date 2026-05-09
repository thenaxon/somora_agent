// Live ChatWindow: SSE-streaming, history hydration, markdown,
// tool-blocks, live token counts, pinned-to-bottom scroll, send +
// abort. Slash-command popup, drag&drop attachments and the
// memory-inject banner come in subsequent steps.

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  Pin,
  GitBranch,
  MoreHorizontal,
  Paperclip,
  Send,
  Wrench,
  X as XIcon,
} from 'lucide-react';
import type { AgentInfo } from '../lib/api';
import { gradientFor, resolveAgentColor } from '../lib/colors';
import { useSessionInfo } from '../hooks/useSessionInfo';
import { useChatSessionFromContext } from './ChatProvider';
import { MessageItem } from './MessageItem';

interface Props {
  agent: AgentInfo;
  sessionId: string;
  /** Window-manager focus state. When this flips to true (e.g. user
   *  clicked the window), the chat auto-focuses the input textarea
   *  so they can type immediately without an extra click. */
  windowFocused?: boolean;
}

function formatTokens(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function ChatWindow({ agent, sessionId, windowFocused }: Props) {
  const color = resolveAgentColor(agent);
  const { model, thinking } = useSessionInfo(agent.name, sessionId);
  const chat = useChatSessionFromContext(agent.name, sessionId);
  const [showTools, setShowTools] = useState(false);
  const [draft, setDraft] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Pinned-to-bottom: only auto-scroll while user is at the bottom
  // of the message list. Manual scroll-up unpins.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = dist < 80;
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.streaming, chat.thinking]);

  // Auto-focus the input whenever the window becomes focused (user
  // clicks anywhere in it, taskbar selects it, etc.) — saves an
  // extra click before typing. Skip if the user is currently
  // selecting text in the body.
  useEffect(() => {
    if (!windowFocused) return;
    const sel = window.getSelection?.();
    if (sel && sel.toString().length > 0) return;
    textareaRef.current?.focus();
  }, [windowFocused]);

  // Filter messages by tools-toggle. When off, hide tool_call +
  // tool_result rows from the view (they remain in the underlying
  // state so toggling on doesn't lose them).
  const visibleMessages = useMemo(() => {
    if (showTools) return chat.messages;
    return chat.messages.filter((m) => m.role !== 'tool_call' && m.role !== 'tool_result');
  }, [chat.messages, showTools]);

  const onSend = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const text = draft.trim();
      if (!text || chat.streaming) return;
      setDraft('');
      chat.send(text).catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.error('[somora-web] send failed', err.message);
      });
    },
    [draft, chat],
  );

  const modelLabel = model?.alias ?? model?.modelId ?? '—';
  const thinkingActive =
    thinking?.modelSupportsReasoning && thinking.effective && thinking.effective !== 'off';

  return (
    <div className="chat">
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
          <button type="button" className="chat-icon-btn" title="Pin (TODO)">
            <Pin size={14} />
          </button>
          <button type="button" className="chat-icon-btn" title="Branch session (TODO)">
            <GitBranch size={14} />
          </button>
          <button type="button" className="chat-icon-btn" title="More (TODO)">
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      <div className="chat-body" ref={scrollRef} onScroll={handleScroll}>
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
          visibleMessages.map((m) => (
            <MessageItem key={m.id} msg={m} agentColor={color} agentIcon={agent.icon} />
          ))
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
      </div>

      <form className="chat-input" onSubmit={onSend}>
        <button type="button" className="chat-icon-btn" title="Attach (TODO)" disabled>
          <Paperclip size={14} />
        </button>
        <textarea
          ref={textareaRef}
          className="chat-textarea"
          rows={1}
          placeholder={`Message ${agent.name}…`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            // Auto-grow up to 120px. Reset to 0 so scrollHeight
            // reflects the new content exactly; otherwise the
            // browser keeps the prior height as the floor and we
            // can't shrink. Setting overflowY explicitly avoids
            // the always-on mini scrollbar that the default `auto`
            // shows even when the content fits.
            const el = e.target;
            el.style.height = '0px';
            const desired = el.scrollHeight;
            if (desired <= 120) {
              el.style.height = desired + 'px';
              el.style.overflowY = 'hidden';
            } else {
              el.style.height = '120px';
              el.style.overflowY = 'auto';
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={chat.streaming}
          style={{ overflowY: 'hidden' }}
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
