// Horizontal scrollable strip of agent avatars. Tapping switches the
// active agent. Active tile gets an accent border + tinted background.
//
// Mobile UX target: 44px min touch target (we use 44 + 4px padding =
// ~52 per tile), thumb-reachable height at the top of the screen.
//
// Status indicators on each tile (mirrors the desktop AgentDock):
//   - streaming-dot: bottom-right accent pulse when this agent is the
//     one currently replying (single-session mobile means at most one)
//   - dream-pulse: glow around the avatar when this agent's REM /
//     server-wide DEEP / loop-holder LUCID phase is active
//   - rem-badge: top-right pending-review counter from REM extraction

import type { AgentInfo } from '../hooks/useAgents';
import { computeDreamPulse, type DreamStates } from '../hooks/useDreamStates';

interface Props {
  agents: AgentInfo[];
  activeAgent: string | null;
  onSelect: (name: string) => void;
  /** Name of the agent currently producing a reply, or null. Mobile is
   *  single-session-at-a-time, so at most one agent streams. */
  streamingAgent?: string | null;
  /** Per-agent REM + global DEEP/LUCID state. Optional — if undefined
   *  the row renders without any dream indicators. */
  dreamStates?: DreamStates;
}

export function AvatarRow({
  agents,
  activeAgent,
  onSelect,
  streamingAgent,
  dreamStates,
}: Props) {
  if (agents.length === 0) return null;
  return (
    <div className="avatar-row" role="tablist">
      {agents.map((a) => {
        const active = a.name === activeAgent;
        const streaming = a.name === streamingAgent;
        const pulse = computeDreamPulse(a.name, dreamStates);
        const pendingCount = dreamStates?.rem[a.name]?.pendingCount ?? 0;
        const iconClass =
          'avatar-tile-icon' + (pulse ? ` dream-active dream-${pulse}` : '');
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
              className={iconClass}
              style={a.color ? { background: `linear-gradient(135deg, ${a.color}, ${a.color}88)` } : undefined}
            >
              {a.icon ?? '🤖'}
              {streaming && <span className="avatar-streaming-dot" aria-hidden="true" />}
              {pendingCount > 0 && (
                <span
                  className="avatar-rem-badge"
                  title={`${pendingCount} REM dream${pendingCount === 1 ? '' : 's'} ready for review`}
                >
                  {pendingCount > 9 ? '9+' : pendingCount}
                </span>
              )}
            </span>
            <span className="avatar-tile-label">{a.name}</span>
          </button>
        );
      })}
    </div>
  );
}
