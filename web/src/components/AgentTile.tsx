// A single agent tile on the desktop. Replicates the click-dummy's
// `.agent-icon` — 88-px wide tile with a glyph (emoji), label, and a
// status-dot.
//
// Placement, drag handling and the loading/error states live in
// DesktopIcons.tsx (+ hooks/useDesktopIcons.ts); this file is purely one
// tile's presentation.
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
  agent: AgentInfo;
  onClick: (agent: AgentInfo) => void;
  /** True when the server is unreachable — forces the offline dot. */
  offline?: boolean;
  /** This agent's chat is currently streaming. */
  streaming?: boolean;
  /** This agent has unread activity in some session. Drives the
   *  unread-dot. */
  unread?: boolean;
  /** Name of the agent currently holding the wiki review loop, if
   *  any. Comes from /dream/loop-state. */
  loopHolder?: string | null;
  /** This agent's chat window is open. Drives the `.active` tint. */
  active?: boolean;
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

export function AgentTile({
  agent,
  onClick,
  offline,
  streaming,
  unread,
  loopHolder,
  active,
  dreamStates,
}: Props) {
  const color = resolveAgentColor(agent);
  const status = computeStatus(agent.name, !!offline, loopHolder, !!streaming);
  const pulse = computeDreamPulse(agent.name, dreamStates);
  const pendingCount = dreamStates?.rem[agent.name]?.pendingCount ?? 0;
  const glyphClass =
    'agent-icon-glyph' + (pulse ? ` dream-active dream-${pulse}` : '');
  // role+tabIndex+onKeyDown gives keyboard a11y without dropping the
  // click-dummy's <div> markup that the CSS expects (button-element
  // resets would fight .agent-icon).
  return (
    <div
      role="button"
      tabIndex={0}
      className={`agent-icon ${active ? 'active' : ''}`}
      onClick={() => onClick(agent)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(agent);
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
        {status !== 'busy' && unread && (
          <span
            className="agent-unread-dot"
            aria-label="unread activity"
            title="New activity in a session — open the chat to read"
          />
        )}
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
}
