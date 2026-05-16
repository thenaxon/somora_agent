// Scrollable message list for the active agent. Auto-pins to the
// bottom unless the user has scrolled up to read (then we leave them
// alone). All chat-stream state is passed in from MobileApp — no
// SSE-owning hook here, to keep the subscription single per active agent.

import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage } from '../hooks/useChatStream';

interface Props {
  agent: string;
  messages: ChatMessage[];
  streaming: boolean;
  connectionError: string | null;
}

export function ChatArea({ agent, messages, streaming, connectionError }: Props) {
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

  return (
    <>
      {connectionError && <div className="banner info">{connectionError}</div>}
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !streaming && (
          <div className="chat-empty">
            Sag etwas zu <strong>{agent}</strong>.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg-row ${m.role}`}>
            <div className={`msg-bubble ${m.role}`}>
              {m.role === 'agent' ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        draggable={false}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {m.text}
                </ReactMarkdown>
              ) : (
                m.text
              )}
              {m.streaming && <span className="msg-streaming-cursor" />}
            </div>
          </div>
        ))}
        {/* Typing-indicator: shown when the server is working but the
            agent hasn't started emitting text yet (model thinking,
            ToolSearch, tool_call still running). Disappears as soon
            as the first chat.delta lands and the streaming bubble
            takes over. Three-dot animation lives in styles.css. */}
        {streaming && !messages.some((m) => m.role === 'agent' && m.streaming) && (
          <div className="msg-row agent" aria-live="polite">
            <div className="msg-bubble agent typing-indicator">
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
