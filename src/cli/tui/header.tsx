import { Box, Text, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useState, type ReactElement } from 'react';
import type { ProjectInfo, ThinkingState, TurnStats } from './types.ts';
import { formatTokens } from './format.ts';

/**
 * Live terminal-column count. Default-export the hook so callers stay
 * thin. We track resize via stdout.on('resize') so the constrained
 * Header box always matches reality after the user drags the window.
 */
function useTerminalCols(): number {
  const { stdout } = useStdout();
  const [cols, setCols] = useState<number>(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return undefined;
    const onResize = (): void => setCols(stdout.columns ?? 80);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return cols;
}

interface Props {
  agent: string;
  agentIcon: string;
  session: string;
  stats: TurnStats | null;
  streaming: boolean;
  // 'pre' = streaming started but no content tokens have landed yet (the
  // model is likely thinking when reasoning is active). 'content' =
  // tokens are flowing. Drives the "🧠 thinking…" badge.
  streamingPhase: 'pre' | 'content';
  connected: boolean;
  showMemory: boolean;
  showTools: boolean;
  reviewLoop?: { agent: string; dreamId: string } | null;
  /** Currently-pinned project for this (agent, session), or null. */
  project?: ProjectInfo | null;
  /** Names of agents other than the current one that have unread
   *  activity. Renders as `📬 N` chip in the header so the user
   *  knows to /agent over to check. */
  unreadOtherAgents?: Set<string>;
}

// Status line. Sits right above the input, NOT at the top of the terminal —
// keeps the bottom-panel (status / input / hints) anchored while older
// turns scroll up and out via Ink's <Static>.
//
// Color choice: explicit `gray` instead of dimColor wherever the text needs
// to be readable. dimColor halves intensity, which on dark terminals turns
// near-black; gray is a real color that survives both backgrounds.
export function Header({
  agent,
  agentIcon,
  session,
  stats,
  streaming,
  streamingPhase,
  connected,
  showMemory,
  showTools,
  reviewLoop,
  project,
  unreadOtherAgents,
}: Props) {
  const tokenSegment = renderTokenSegment(stats);
  const agentTag = agentIcon ? `${agentIcon} ${agent}` : agent;
  // Constrain to one terminal row. Background: Ink's internal
  // string-width measurement disagrees with terminal renderers for
  // ZWJ-composed emojis (🕵️‍♀️, 👨‍💻 etc — multi-codepoint glyphs joined
  // with U+200D + variation selectors). Ink may under-count cells,
  // computes more flex-filler than the terminal can fit, the line
  // overflows by 1 column and wraps. The terminal then has a 2-row
  // status panel while Ink still thinks it's 1 row — cursor-up math
  // becomes off-by-one each render and content visibly scrolls
  // upward per keystroke as the dynamic frame leaks one row of
  // residue per cycle. width + overflowX="hidden" forces Ink to
  // measure the row as exactly cols wide, 1 tall, regardless of
  // content. Worst case: rightmost item gets truncated, but the
  // panel stays stable.
  const cols = useTerminalCols();
  return (
    <Box width={cols} overflowX="hidden">
      <Text color="yellow" bold>
        🐨 somora{' '}
      </Text>
      <Text color="gray">· </Text>
      <Text color="cyan" bold>
        {agentTag}:{session}
      </Text>
      {stats?.model ? (
        <>
          <Text color="gray"> · </Text>
          <Text color="magentaBright">{stats.model}</Text>
        </>
      ) : null}
      {tokenSegment ? (
        <>
          <Text>{'   '}</Text>
          {tokenSegment}
        </>
      ) : null}
      {stats?.thinking ? (
        <>
          <Text color="gray">{'   '}</Text>
          <ThinkingBadge state={stats.thinking} />
        </>
      ) : null}
      <Text color="gray">{'   '}</Text>
      <ShowFlag label="mem" on={showMemory} />
      <Text color="gray">{' '}</Text>
      <ShowFlag label="tools" on={showTools} />
      {reviewLoop ? (
        <>
          <Text color="gray">{'   '}</Text>
          <Text color="magenta" bold>
            📝 wiki-review:{reviewLoop.agent}
          </Text>
        </>
      ) : null}
      {project ? (
        <>
          <Text color="gray">{'   '}</Text>
          <ProjectChip project={project} />
        </>
      ) : null}
      {unreadOtherAgents && unreadOtherAgents.size > 0 ? (
        <>
          <Text color="gray">{'   '}</Text>
          <Text color="yellowBright" bold>
            📬 {unreadOtherAgents.size}
          </Text>
        </>
      ) : null}
      {/* Connection / streaming indicator. Kept short on purpose:
       *  previously this was `● connected` / `● disconnected` inside a
       *  flexGrow=1 / justifyContent=flex-end Box. That right-alignment
       *  pushed the row to terminal-width every render, and any
       *  cell-width disagreement between Ink (string-width) and the
       *  terminal-renderer for ZWJ-composed emojis (🕵️‍♀️, 👨‍💻 — multi-
       *  codepoint glyphs joined with U+200D + VS16) made the row
       *  overflow by one column and wrap. Ink kept measuring it as
       *  1 row while the terminal showed 2, the cursor-up-by-N math
       *  was off-by-one each render, and content visibly drifted
       *  upward per keystroke. Two changes together kill the
       *  failure mode: drop the right-alignment (no full-width row
       *  computation) and drop the trailing word (no wrap pressure
       *  at any reasonable terminal width). */}
      <Text color="gray">{'   '}</Text>
      {streaming ? (
        streamingPhase === 'pre' && stats?.thinking?.active ? (
          <Text color="cyan" bold>
            <Spinner type="dots" /> thinking
          </Text>
        ) : (
          <Text color="yellow" bold>
            <Spinner type="dots" /> streaming
          </Text>
        )
      ) : connected ? (
        <Text color="green">●</Text>
      ) : (
        <Text color="red" bold>
          ●
        </Text>
      )}
    </Box>
  );
}

// Compact project indicator in the header. Folder glyph + name. We
// don't render `color` as an actual color because Ink's color support
// is limited to named ANSI colors / hex with broad terminal support,
// and per-user hex colors would be unpredictable. The presence of the
// chip itself is the affordance; the web UI does the full color tint.
function ProjectChip({ project }: { project: ProjectInfo }) {
  return (
    <Text color="blueBright" bold>
      📁 {project.name}
      {project.archived ? <Text color="yellow"> ⚠</Text> : null}
    </Text>
  );
}

// Compact on/off badge for display toggles. Off-state is rendered red
// so a glance at the header makes it obvious why memory/tool lines
// aren't appearing in the scrollback.
function ShowFlag({ label, on }: { label: string; on: boolean }) {
  return (
    <Text color={on ? 'gray' : 'red'} bold={!on}>
      {label}
      {on ? ' ✓' : ' ✗'}
    </Text>
  );
}

// Thinking-level indicator. `active=false` means the user picked a level
// but the active model has no 'reasoning' capability — surface the
// dormant state honestly instead of pretending the setting works.
function ThinkingBadge({ state }: { state: ThinkingState }) {
  if (!state.active) {
    return (
      <Text color="gray">
        thinking={state.level}{' '}
        <Text color="yellow">(dormant)</Text>
      </Text>
    );
  }
  return (
    <Text color="cyan">
      🧠 {state.level}
      {state.wire ? <Text color="gray">→{state.wire}</Text> : null}
    </Text>
  );
}

function renderTokenSegment(stats: TurnStats | null): ReactElement | null {
  if (!stats) return null;
  const cached = stats.tokensInCached;
  const total = stats.tokensIn;
  const window = stats.contextWindow;

  let inSegment: ReactElement;
  if (cached !== null && cached > 0 && total >= cached) {
    const uncached = total - cached;
    inSegment = (
      <Text>
        <Text color="white">↑ {formatTokens(uncached)}</Text>
        <Text color="green">+{formatTokens(cached)}¢</Text>
      </Text>
    );
  } else {
    inSegment = <Text color="white">↑ {formatTokens(total)}</Text>;
  }
  const reasoning = stats.tokensOutReasoning;
  const reasoningSegment =
    reasoning !== null && reasoning > 0 ? (
      <Text color="cyan"> ({stats.tokensOutReasoningEstimated ? '~' : ''}{formatTokens(reasoning)} 🧠)</Text>
    ) : null;
  return (
    <Text>
      {inSegment}
      {window ? <Text color="gray"> / {formatTokens(window)}</Text> : null}
      <Text color="white">   ↓ {formatTokens(stats.tokensOut)}</Text>
      {reasoningSegment}
    </Text>
  );
}
