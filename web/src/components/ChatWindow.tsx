// Phase-1 ChatWindow skeleton: header (with rich live meta line) +
// empty body placeholder + disabled input. Step 4 wires the chat
// stream itself — until then the header still shows live data
// (model, thinking, soon tokens + streaming-state).
//
// Layout matches the click-dummy chat.jsx: avatar + name + role
// badge on top, meta line beneath with session · model · thinking
// · (tokens, step 4) · tools-toggle. Three action icons (pin /
// branch / more) on the right.

import { useState } from 'react';
import { Pin, GitBranch, MoreHorizontal, Paperclip, Send, Wrench } from 'lucide-react';
import type { AgentInfo } from '../lib/api';
import { gradientFor, resolveAgentColor } from '../lib/colors';
import { useSessionInfo } from '../hooks/useSessionInfo';

interface Props {
  agent: AgentInfo;
  sessionId: string;
}

export function ChatWindow({ agent, sessionId }: Props) {
  const color = resolveAgentColor(agent);
  const { model, thinking } = useSessionInfo(agent.name, sessionId);
  const [showTools, setShowTools] = useState(false);

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
            <span style={{ color: 'var(--text-3)' }} title="streaming token counts arrive in step 4">
              ↑— ↓—
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

function Sep() {
  return <span style={{ color: 'var(--line-2)' }}>·</span>;
}
