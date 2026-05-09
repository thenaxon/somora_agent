// Single message-row renderer. Memoized so the message list
// re-renders only the streaming-tail when chat-delta events arrive
// — older messages keep their identity, React skips them.
//
// Roles:
//   user        — bubble right, plain text
//   assistant   — bubble left, markdown content + streaming cursor
//   tool_call   — collapsible tool-call block (full width)
//   tool_result — collapsible tool-result block (full width)

import { memo } from 'react';
import { User } from 'lucide-react';
import type { ChatMessage } from '../types/chat';
import { AssistantMarkdown } from './AssistantMarkdown';
import { ToolCallBlock, ToolResultBlock } from './ToolBlocks';

interface Props {
  msg: ChatMessage;
  agentColor?: string;
  agentIcon?: string;
}

export const MessageItem = memo(function MessageItem({ msg, agentColor, agentIcon }: Props) {
  if (msg.role === 'tool_call') {
    return <ToolCallBlock toolCall={msg.toolCall} />;
  }
  if (msg.role === 'tool_result') {
    return <ToolResultBlock toolResult={msg.toolResult} />;
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
        <div className="chat-msg-bubble" style={{ whiteSpace: 'pre-wrap' }}>
          {msg.text}
        </div>
      </div>
    );
  }
  // assistant — bubble is the direct flex child (no wrapper div).
  // Wrapping the bubble in another div let `min-width: 0` collapse
  // it below content size, making the bubble's `max-width: 75%`
  // resolve against a tiny container and break short text like
  // "Danke" mid-word. Mirrors orbit's layout pattern.
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
      <div className="chat-msg-bubble">
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
      </div>
    </div>
  );
});
