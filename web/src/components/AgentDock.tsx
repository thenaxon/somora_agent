// Left-side agent dock. Replicates the click-dummy's `.agent-dock`
// behaviour — vertical column of 88-px wide tiles, each with a
// glyph (emoji), label, and a status-dot.
//
// Status-dot semantics:
//   online       — server reachable, agent listed, no special state
//   busy         — agent currently streaming an answer (Phase 1c+)
//   loop-holder  — agent currently holds the wiki review loop
//   offline      — server unreachable (whole dock state shows error)

import type { AgentInfo, DreamStates } from '../lib/api';
import { gradientFor, resolveAgentColor } from '../lib/colors';

export type AgentStatus = 'online' | 'busy' | 'loop-holder' | 'offline';
type DreamPulse = 'rem' | 'deep' | 'lucid' | null;

interface Props {
  agents: AgentInfo[];
  loading: boolean;
  error: string | null;
  onAgentClick: (agent: AgentInfo) => void;
  /** Names of agents whose chat is currently streaming. Empty in
   *  Phase 1; Phase 1c populates from the per-session streaming
   *  registry once ChatWindow is in. */
  streamingAgents?: Set<string>;
  /** Name of the agent currently holding the wiki review loop, if
   *  any. Comes from /dream/loop-state. */
  loopHolder?: string | null;
  /** Names of agents whose chat windows are currently open. Drives
   *  the `.active` background tint. */
  activeAgentIds?: Set<string>;
  /** Per-agent REM + server-global DEEP/LUCID state. Drives the
   *  per-icon pulse-glow and the REM pending-review counter badge. */
  dreamStates?: DreamStates;
}

function computeStatus(
  agentName: string,
  hasError: boolean,
  loopHolder: string | null | undefined,
  isStreaming: boolean,
): AgentStatus {
  if (hasError) return 'offline';
  if (loopHolder === agentName) return 'loop-holder';
  if (isStreaming) return 'busy';
  return 'online';
}

/** Determine which dream phase (if any) should pulse on this agent's
 *  icon. Priority: LUCID > DEEP > REM — most specific wins. LUCID only
 *  pulses on the loopHolder agent; DEEP pulses on every agent (system-
 *  wide consolidation); REM pulses only on the agent whose worker is
 *  currently extracting. */
function computeDreamPulse(
  agentName: string,
  dreamStates: DreamStates | undefined,
): DreamPulse {
  if (!dreamStates) return null;
  if (dreamStates.lucid.active && dreamStates.lucid.loopHolder === agentName) {
    return 'lucid';
  }
  if (dreamStates.deep.active) return 'deep';
  if (dreamStates.rem[agentName]?.active) return 'rem';
  return null;
}

export function AgentDock({
  agents,
  loading,
  error,
  onAgentClick,
  streamingAgents,
  loopHolder,
  activeAgentIds,
  dreamStates,
}: Props) {
  return (
    <>
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
          const status = computeStatus(
            agent.name,
            !!error,
            loopHolder,
            !!streamingAgents?.has(agent.name),
          );
          const pulse = computeDreamPulse(agent.name, dreamStates);
          const pendingCount = dreamStates?.rem[agent.name]?.pendingCount ?? 0;
          const glyphClass =
            'agent-icon-glyph' + (pulse ? ` dream-active dream-${pulse}` : '');
          // role+tabIndex+onKeyDown gives keyboard a11y without
          // dropping the click-dummy's <div> markup that the CSS
          // expects (button-element resets would fight .agent-icon).
          return (
            <div
              key={agent.name}
              role="button"
              tabIndex={0}
              className={`agent-icon ${isActive ? 'active' : ''}`}
              onClick={() => onAgentClick(agent)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onAgentClick(agent);
                }
              }}
              title={agent.description}
            >
              <div
                className={glyphClass}
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
                <span className={`status-dot ${status}`} />
                {pendingCount > 0 && (
                  <span
                    className="rem-badge"
                    title={`${pendingCount} REM dream${pendingCount === 1 ? '' : 's'} ready for review`}
                  >
                    {pendingCount > 9 ? '9+' : pendingCount}
                  </span>
                )}
              </div>
              <div className="agent-icon-label">{agent.name}</div>
              <div className="agent-icon-sub">
                {(agent.role ?? 'agent').toLowerCase()}
              </div>
            </div>
          );
        })}
    </>
  );
}
