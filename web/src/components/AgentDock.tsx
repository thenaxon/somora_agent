// Left-side agent dock. Replicates the click-dummy's `.agent-dock`
// behaviour — vertical column of 88-px wide tiles, each with a
// glyph (emoji), label, and (eventually) a status-dot. Per-agent
// color is applied to the glyph background gradient + status-dot
// glow.
//
// Phase 1: static list from /agents. No right-click context menu
// yet (Phase 2: open existing sessions / new session). No tools
// section below (Phase 1.5+).

import type { AgentInfo } from '../lib/api';
import { gradientFor, resolveAgentColor } from '../lib/colors';

interface Props {
  agents: AgentInfo[];
  loading: boolean;
  error: string | null;
  onAgentClick: (agent: AgentInfo) => void;
  activeAgentIds?: Set<string>;
}

export function AgentDock({ agents, loading, error, onAgentClick, activeAgentIds }: Props) {
  return (
    <div className="agent-dock">
      {loading && (
        <div className="agent-icon-sub" style={{ padding: 8, fontSize: 10 }}>
          loading…
        </div>
      )}
      {error && (
        <div
          className="agent-icon-sub"
          style={{ padding: 8, fontSize: 10, color: 'var(--danger)' }}
          title={error}
        >
          server unreachable
        </div>
      )}
      {!loading &&
        !error &&
        agents.map((agent) => {
          const color = resolveAgentColor(agent);
          const isActive = activeAgentIds?.has(agent.name);
          return (
            <button
              key={agent.name}
              type="button"
              className={`agent-icon ${isActive ? 'active' : ''}`}
              onClick={() => onAgentClick(agent)}
              title={agent.description}
              style={{ all: 'unset', cursor: 'pointer' }}
            >
              <div
                className="agent-icon-glyph"
                style={{
                  background: gradientFor(color),
                  borderColor: `${color}40`,
                  boxShadow: `0 6px 18px rgba(0,0,0,0.4), 0 0 0 1px ${color}20, inset 0 1px 0 rgba(255,255,255,0.08)`,
                }}
              >
                <span
                  style={{
                    fontSize: 30,
                    lineHeight: 1,
                    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))',
                  }}
                >
                  {agent.icon ?? '🤖'}
                </span>
                <span className="status-dot online" />
              </div>
              <div className="agent-icon-label">{agent.name}</div>
              <div className="agent-icon-sub">agent</div>
            </button>
          );
        })}
    </div>
  );
}
