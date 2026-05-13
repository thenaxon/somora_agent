import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactElement } from 'react';
import type { ProjectInfo, ThinkingState, TurnStats } from './types.ts';
import { formatTokens } from './format.ts';

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
}: Props) {
  const tokenSegment = renderTokenSegment(stats);
  const agentTag = agentIcon ? `${agentIcon} ${agent}` : agent;
  return (
    <Box>
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
      <Box flexGrow={1} justifyContent="flex-end">
        {streaming ? (
          streamingPhase === 'pre' && stats?.thinking?.active ? (
            // Pre-content phase + reasoning model: signal the user is
            // *thinking*, not stuck. As soon as content tokens land the
            // spinner switches to "streaming".
            <Text color="cyan" bold>
              <Spinner type="dots" /> 🧠 thinking…
            </Text>
          ) : (
            <Text color="yellow" bold>
              <Spinner type="dots" /> streaming · ESC to abort
            </Text>
          )
        ) : connected ? (
          <Text color="green">● connected</Text>
        ) : (
          <Text color="red" bold>
            ● disconnected
          </Text>
        )}
      </Box>
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
      <Text color="cyan"> ({formatTokens(reasoning)} 🧠)</Text>
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
