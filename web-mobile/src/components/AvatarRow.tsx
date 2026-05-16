// Horizontal scrollable strip of agent avatars. Tapping switches the
// active agent. Active tile gets an accent border + tinted background.
//
// Mobile UX target: 44px min touch target (we use 44 + 4px padding =
// ~52 per tile), thumb-reachable height at the top of the screen.

import type { AgentInfo } from '../hooks/useAgents';

interface Props {
  agents: AgentInfo[];
  activeAgent: string | null;
  onSelect: (name: string) => void;
}

export function AvatarRow({ agents, activeAgent, onSelect }: Props) {
  if (agents.length === 0) return null;
  return (
    <div className="avatar-row" role="tablist">
      {agents.map((a) => {
        const active = a.name === activeAgent;
        return (
          <button
            key={a.name}
            type="button"
            role="tab"
            aria-selected={active}
            className={`avatar-tile ${active ? 'active' : ''}`}
            onClick={() => onSelect(a.name)}
          >
            <span
              className="avatar-tile-icon"
              style={a.color ? { background: `linear-gradient(135deg, ${a.color}, ${a.color}88)` } : undefined}
            >
              {a.icon ?? '🤖'}
            </span>
            <span className="avatar-tile-label">{a.name}</span>
          </button>
        );
      })}
    </div>
  );
}
