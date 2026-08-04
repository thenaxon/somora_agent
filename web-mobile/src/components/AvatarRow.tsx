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
  /** Set of agents currently mid-turn on ANY session (own active stream
   *  via useChatStream + cross-agent activity stream merged upstream). */
  streamingAgents?: Set<string>;
  /** Set of agents with unread activity (any session has
   *  unreadAt > seenAt). Drives the unread dot. */
  unreadAgents?: Set<string>;
  /** Per-agent REM + global DEEP/LUCID state. Optional — if undefined
   *  the row renders without any dream indicators. */
  dreamStates?: DreamStates;
}

export function AvatarRow({
  agents,
  activeAgent,
  onSelect,
  streamingAgents,
  unreadAgents,
  dreamStates,
}: Props) {
  if (agents.length === 0) return null;
  return (
    <div className="avatar-row" role="tablist">
      {agents.map((a) => {
        const active = a.name === activeAgent;
        const streaming = streamingAgents?.has(a.name) ?? false;
        const unread = unreadAgents?.has(a.name) ?? false;
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
              {!streaming && unread && (
                <span
                  className="avatar-unread-dot"
                  aria-label="unread activity"
                  title="New activity — tap to view"
                />
              )}
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
      {(dreamStates?.lucid.pendingFindings ?? 0) > 0 && (
        <LucidChip
          findings={dreamStates!.lucid.pendingFindings!}
          oldestPendingAt={dreamStates!.lucid.oldestPendingAt}
        />
      )}
    </div>
  );
}

// Trailing non-agent tile: lucid review backlog. Lucid is platform-
// wide wiki cleanup, so the badge can't live on any single agent —
// it gets its own tile at the end of the row, mirroring the web's
// wiki-tile badge (2026-07-29 feedback: pending lucid runs were
// invisible in every client). Display-only on mobile — reviews run
// through an agent via dream_review, so tapping selects nothing.
function LucidChip({
  findings,
  oldestPendingAt,
}: {
  findings: number;
  oldestPendingAt?: string;
}) {
  const title =
    `${findings} lucid finding${findings === 1 ? '' : 's'} awaiting review` +
    (oldestPendingAt ? ` (oldest run from ${oldestPendingAt.slice(0, 10)})` : '') +
    ' — ask any agent to run dream_review';
  return (
    <div className="avatar-tile lucid-chip" role="note" aria-label={title} title={title}>
      <span className="avatar-tile-icon lucid-chip-icon">
        {/* Inline glyph (open book) — mobile keeps the no-lucide rule. */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
          <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
        </svg>
        <span className="avatar-rem-badge lucid">{findings > 9 ? '9+' : findings}</span>
      </span>
      <span className="avatar-tile-label">wiki</span>
    </div>
  );
}
