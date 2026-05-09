// Phase-1 ChatWindow skeleton: header + empty body placeholder +
// disabled input. Step 3 = chrome only; streaming, markdown, tool
// blocks, drag&drop, slash-commands all land in Step 4 when the
// /chat/stream SSE wiring goes in.
//
// Layout matches the click-dummy chat.jsx: avatar + name + role
// badge + session-id, three action icons (pin / branch / more),
// scrollable body, input with paperclip + textarea + send.

import { Pin, GitBranch, MoreHorizontal, Paperclip, Send } from 'lucide-react';
import type { AgentInfo } from '../lib/api';
import { gradientFor, resolveAgentColor } from '../lib/colors';

interface Props {
  agent: AgentInfo;
  sessionId: string;
}

export function ChatWindow({ agent, sessionId }: Props) {
  const color = resolveAgentColor(agent);

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
          </div>
          <div className="chat-header-meta">session: {sessionId}</div>
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

      <div className="chat-body">
        <div
          style={{
            color: 'var(--text-3)',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            textAlign: 'center',
            padding: '24px 0',
            letterSpacing: '0.04em',
          }}
        >
          chat-stream wires up in step 4
        </div>
      </div>

      <div className="chat-input">
        <button type="button" className="chat-icon-btn" title="Attach (TODO)" disabled>
          <Paperclip size={14} />
        </button>
        <textarea
          className="chat-textarea"
          rows={1}
          placeholder={`Message ${agent.name}…`}
          disabled
        />
        <button type="button" className="chat-send" title="Send (TODO)" disabled>
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
