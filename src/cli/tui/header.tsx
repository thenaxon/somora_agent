import { Box, Text, useWindowSize } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactElement } from 'react';
import type { ProjectInfo, ThinkingState, TurnStats } from './types.ts';
import { formatTokens } from './format.ts';
import { fitSegments, sessionLabel, type Segment } from './layout.ts';

/**
 * Live terminal-column count: ink's own hook re-renders on resize, so
 * the constrained Header box always matches the window after a drag.
 */
function useTerminalCols(): number {
  return useWindowSize().columns || 80;
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
  /** Session work counters (`⌛3 ▶1 🤖2`), empty when idle. Text is
   *  pre-formatted by work-queue.ts; /queue shows the list. */
  workCounters?: string;
  /** The model the session's next turn uses (alias or id), read from
   *  the server and refreshed on every switch. */
  nextModel?: { label: string; modelId: string } | null;
  /** An external agent: shown in place of the model
   *  ("external · OpenClaw 2026.10.3"), which its own system sets. */
  externalLabel?: string | null;
  /** During a turn: what Enter does with a new message — hand it into
   *  the running turn or queue it behind (Ctrl+T switches). */
  sendMode?: 'steer' | 'queue' | null;
}

// Status line. Sits right above the input, NOT at the top of the terminal —
// keeps the bottom-panel (status / input / hints) anchored while older
// turns scroll up and out via Ink's <Static>.
//
// Always exactly one row (2026-11-22). The parts used to be separate
// flex children of a width-limited box: when the line was too long Yoga
// shrank them, each wrapped on its own, and the status grew to two or
// three rows mid-turn with words cut in half ("qwen38nex", "high→xhig").
// Now every part is a segment with a priority; when the line does not
// fit, the least important part is left out whole (fitSegments), and the
// rest is one Text that can only be cut at its end. The width leaves one
// column spare: a terminal that draws an emoji wider than string-width
// counts must not wrap the row (the 2026-05-22 ZWJ drift).
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
  workCounters,
  nextModel,
  externalLabel,
  sendMode,
}: Props) {
  const cols = useTerminalCols();
  const agentTag = agentIcon ? `${agentIcon} ${agent}` : agent;
  const where = `${agentTag}:${sessionLabel(session)}`;
  const segments: HeaderSegment[] = [];
  segments.push({ key: 'brand', priority: 5, plain: '🐨 somora', node: <Text color="yellow" bold>🐨 somora</Text> });
  segments.push({ key: 'where', priority: 100, plain: where, node: <Text color="cyan" bold>{where}</Text> });
  if (externalLabel) {
    segments.push({ key: 'model', priority: 60, plain: externalLabel, node: <Text color="magentaBright">{externalLabel}</Text> });
  } else if (stats?.model) {
    const switched = nextModel && !sameModel(stats.model, nextModel.modelId) ? ` → ${nextModel.label} (next turn)` : '';
    segments.push({
      key: 'model',
      priority: 60,
      plain: stats.model + switched,
      node: (
        <Text>
          <Text color="magentaBright">{stats.model}</Text>
          {switched ? <Text color="gray">{switched}</Text> : null}
        </Text>
      ),
    });
  } else if (nextModel) {
    segments.push({ key: 'model', priority: 60, plain: nextModel.label, node: <Text color="magentaBright">{nextModel.label}</Text> });
  }
  const tokens = renderTokenSegment(stats);
  if (tokens) segments.push({ key: 'tokens', priority: 30, plain: tokens.plain, node: tokens.node });
  if (stats?.thinking) {
    const t = stats.thinking;
    segments.push({
      key: 'thinking',
      priority: 20,
      plain: t.active ? `🧠 ${t.level}${t.wire ? `→${t.wire}` : ''}` : `thinking=${t.level} (dormant)`,
      node: <ThinkingBadge state={t} />,
    });
  }
  segments.push({
    key: 'flags',
    priority: 15,
    plain: `mem ${showMemory ? '✓' : '✗'} tools ${showTools ? '✓' : '✗'}`,
    node: (
      <Text>
        <ShowFlag label="mem" on={showMemory} />
        <Text color="gray"> </Text>
        <ShowFlag label="tools" on={showTools} />
      </Text>
    ),
  });
  if (reviewLoop) {
    const text = `📝 wiki-review:${reviewLoop.agent}`;
    segments.push({ key: 'review', priority: 10, plain: text, node: <Text color="magenta" bold>{text}</Text> });
  }
  if (project) {
    segments.push({ key: 'project', priority: 25, plain: `📁 ${project.name}${project.archived ? ' ⚠' : ''}`, node: <ProjectChip project={project} /> });
  }
  if (unreadOtherAgents && unreadOtherAgents.size > 0) {
    const text = `📬 ${unreadOtherAgents.size}`;
    segments.push({ key: 'unread', priority: 70, plain: text, node: <Text color="yellowBright" bold>{text}</Text> });
  }
  if (workCounters) {
    segments.push({ key: 'work', priority: 80, plain: workCounters, node: <Text color="yellow">{workCounters}</Text> });
  }
  if (sendMode) {
    // Beside the spinner and kept long, so it is there while typing.
    const text = sendMode === 'steer' ? '↪ steer' : '⏸ queue';
    segments.push({ key: 'send', priority: 85, plain: text, node: <Text color={sendMode === 'steer' ? 'magenta' : 'yellow'} bold>{text}</Text> });
  }
  // Connection / streaming indicator: short on purpose, never
  // right-aligned (a full-width row is what made the 2026-05-22 drift).
  const thinkingPhase = streaming && streamingPhase === 'pre' && stats?.thinking?.active;
  segments.push({
    key: 'state',
    priority: 90,
    plain: streaming ? (thinkingPhase ? '⠋ thinking' : '⠋ streaming') : '●',
    node: streaming ? (
      thinkingPhase ? (
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
    ),
  });
  const width = Math.max(10, cols - 1);
  const kept = fitSegments(segments, width);
  return (
    <Box width={width} height={1} overflow="hidden">
      <Text wrap="truncate-end">
        {kept.map((seg, i) => (
          <Text key={seg.key}>
            {i > 0 ? <Text color="gray">{seg.key === 'where' || seg.key === 'model' ? ' · ' : '   '}</Text> : null}
            {seg.node}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

interface HeaderSegment extends Segment {
  node: ReactElement;
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

function renderTokenSegment(stats: TurnStats | null): { node: ReactElement; plain: string } | null {
  if (!stats) return null;
  const cached = stats.tokensInCached;
  const total = stats.tokensIn;
  const window = stats.contextWindow;

  // Σ marks a SUM: every request the turn made. A turn with 21 tool
  // rounds sends its context 21 times, so this runs far past the window
  // and must not be read as the fill level next to it.
  let inSegment: ReactElement;
  let plain: string;
  if (cached !== null && cached > 0 && total >= cached) {
    const uncached = total - cached;
    plain = `Σ↑ ${formatTokens(uncached)}+${formatTokens(cached)}¢`;
    inSegment = (
      <Text>
        <Text color="white">Σ↑ {formatTokens(uncached)}</Text>
        <Text color="green">+{formatTokens(cached)}¢</Text>
      </Text>
    );
  } else {
    plain = `Σ↑ ${formatTokens(total)}`;
    inSegment = <Text color="white">Σ↑ {formatTokens(total)}</Text>;
  }
  const reasoning = stats.tokensOutReasoning;
  const reasoningSegment =
    reasoning !== null && reasoning > 0 ? (
      <Text color="cyan"> ({stats.tokensOutReasoningEstimated ? '~' : ''}{formatTokens(reasoning)} 🧠)</Text>
    ) : null;
  // Occupancy is its own number. `↑` is what the turn spent, summed over
  // every request it made — printing that over the window read as "the
  // context is 4x full" on tool-using turns and hid a real overflow
  // until the backend refused it (2026-09-10).
  const filled = stats.contextTokens;
  const ratio = filled !== null && window ? filled / window : null;
  // Past the window the ratio stops being a scale: the TUI prints both
  // numbers anyway, so an over-full context reads as "425k/272k" and
  // says on its own that the configured window is too small.
  const contextSegment =
    filled !== null && window ? (
      <Text color={ratio! > 1 ? 'magenta' : ratio! > 0.9 ? 'red' : ratio! > 0.75 ? 'yellow' : 'gray'}>
        {' '}▣ {formatTokens(filled)}/{formatTokens(window)}
      </Text>
    ) : null;
  if (contextSegment) plain += ` ▣ ${formatTokens(filled!)}/${formatTokens(window!)}`;
  plain += `   ↓ ${formatTokens(stats.tokensOut)}`;
  if (reasoningSegment) plain += ` (${stats.tokensOutReasoningEstimated ? '~' : ''}${formatTokens(reasoning!)} 🧠)`;
  return {
    plain,
    node: (
      <Text>
        {inSegment}
        {contextSegment}
        <Text color="white">   ↓ {formatTokens(stats.tokensOut)}</Text>
        {reasoningSegment}
      </Text>
    ),
  };
}

/** The last turn's model (an id, or `provider/id` after a fallback)
 *  against the session's next model id. */
function sameModel(turnModel: string, nextModelId: string): boolean {
  return turnModel === nextModelId || turnModel.endsWith(`/${nextModelId}`);
}
