// One component per Turn-kind. Kept dumb — no state, no fetches, just
// rendering.
//
// Color palette (chosen for readability on dark AND light terminals):
//   user role tag:    green
//   agent role tag:   cyan bold
//   tool ▸:           blue + bold
//   tool result ↳:    gray (a real color, NOT dimColor — dimColor is
//                     near-invisible on dark backgrounds)
//   tool error:       red bold
//   memory ◇:         magenta bold (no dim)
//   system info:      gray
//   system warn:      yellow
//   system error:     red bold

import { Box, Text } from 'ink';
import type { Turn } from './types.ts';
import { renderInline } from './markdown.tsx';

export interface VerboseFlags {
  tools: boolean;
  memory: boolean;
}

export function TurnView({
  turn,
  agentName,
  agentIcon,
  verbose,
}: {
  turn: Turn;
  agentName: string;
  agentIcon: string;
  verbose: VerboseFlags;
}) {
  switch (turn.kind) {
    case 'user':
      return (
        <UserTurn
          text={turn.text}
          {...(turn.fromAgent ? { fromAgent: turn.fromAgent } : {})}
          {...(turn.fromSystem ? { fromSystem: turn.fromSystem } : {})}
        />
      );
    case 'agent':
      return <AgentTurn text={turn.text} agentName={agentName} agentIcon={agentIcon} />;
    case 'tool':
      return <ToolEvent {...turn} verbose={verbose.tools} />;
    case 'engine_meta':
      return (
        <EngineMetaEvent
          engine={turn.engine}
          label={turn.label}
          {...(turn.summary ? { summary: turn.summary } : {})}
          {...(turn.details ? { details: turn.details } : {})}
          verbose={verbose.tools}
        />
      );
    case 'memory':
      return (
        <MemoryEvent
          count={turn.count}
          topScore={turn.topScore}
          refs={turn.refs}
          fullText={turn.fullText}
          verbose={verbose.memory}
        />
      );
    case 'media':
      return <MediaNotice items={turn.items} />;
    case 'system':
      return <SystemNotice text={turn.text} tone={turn.tone} />;
  }
}

function UserTurn({
  text,
  fromAgent,
  fromSystem,
}: {
  text: string;
  fromAgent?: string;
  fromSystem?: 'sentinel' | 'tmux' | 'subagent';
}) {
  // System inbound (sentinel trigger / tmux attention wake):
  // synthesized, not a real user message. Render as a one-line system
  // notice with a glyph + context so it's clearly distinguishable from
  // human and peer-agent turns in scrollback.
  if (fromSystem === 'sentinel' || fromSystem === 'tmux' || fromSystem === 'subagent') {
    const name =
      fromSystem === 'sentinel'
        ? summarizeSentinelTriggerText(text)
        : fromSystem === 'subagent'
          ? (text.match(/Task '([^']+)'/)?.[1] ?? '')
          : summarizeTmuxWakeText(text);
    const label =
      fromSystem === 'sentinel' ? '🔔 sentinel' : fromSystem === 'subagent' ? '🤖 subagent' : '🖥  tmux';
    return (
      <Box marginTop={1}>
        <Text color="gray" bold>
          {label}
        </Text>
        {name ? (
          <>
            <Text color="gray"> · </Text>
            <Text color="gray">{name}</Text>
          </>
        ) : null}
      </Box>
    );
  }
  // A2A inbound (fromAgent set) renders with the sender's name as a
  // cyan tag and a "↬" arrow so it's visually distinct from a turn the
  // local human just typed. Same line height, similar weight — keeps
  // scrollback rhythm intact.
  if (fromAgent) {
    const tag = `↬ ${fromAgent}`.padEnd(6, ' ');
    return (
      <Box marginTop={1}>
        <Text color="cyan" bold>
          {tag}
        </Text>
        <Text>{' '}</Text>
        <Text>{text}</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text color="green" bold>
        {'user  '}
      </Text>
      <Text>{text}</Text>
    </Box>
  );
}

// Pulls the trigger name out of the dispatcher's `buildFirePrompt`
// header block so the TUI can show one-line context next to the
// 🔔 marker instead of dumping the whole [Sentinel trigger fired]…
// block into scrollback.
function summarizeSentinelTriggerText(text: string): string {
  const match = text.match(/^name:\s*(.+)$/im);
  if (match && match[1]) return match[1].trim();
  return '';
}

// Pulls the tmux session name out of the attention-wake prompt
// (`[tmux attention] Session '<name>' (…`).
function summarizeTmuxWakeText(text: string): string {
  const match = text.match(/Session '([^']+)'/);
  if (match && match[1]) return match[1];
  return '';
}

function AgentTurn({
  text,
  agentName,
  agentIcon,
}: {
  text: string;
  agentName: string;
  agentIcon: string;
}) {
  const tag = agentIcon ? `${agentIcon} ${agentName}` : agentName;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="cyan" bold>
        {tag}
      </Text>
      <AgentBody text={text} />
    </Box>
  );
}

// Tag on its own row, body indented 2 spaces uniformly. Each line is its
// own Text element so paragraph breaks (empty lines) remain visible and
// inline markdown gets per-line rendering.
export function AgentBody({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <Box paddingLeft={2} flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line.length > 0 ? renderInline(line) : ' '}</Text>
      ))}
    </Box>
  );
}

function ToolEvent({
  tool,
  phase,
  summary,
  error,
  details,
  verbose,
}: {
  tool: string;
  phase: 'call' | 'result' | 'error';
  summary?: string;
  error?: string;
  details?: string;
  verbose: boolean;
}) {
  if (phase === 'call') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color="blue" bold>
            ▸{' '}
          </Text>
          <Text color="blue" bold>
            {tool}
          </Text>
          {summary ? <Text color="gray"> · {summary}</Text> : null}
        </Box>
        {verbose && details ? <DetailsBlock text={details} /> : null}
      </Box>
    );
  }
  if (phase === 'error') {
    return (
      <Box>
        <Text color="red" bold>
          {'  ↳ error · '}
        </Text>
        <Text color="red">{error ?? '(unknown error)'}</Text>
      </Box>
    );
  }
  // result — server only emits this when there's something worth showing
  // (it suppresses trivial successes like {ok:true} server-side).
  if (!summary && !(verbose && details)) return null;
  return (
    <Box flexDirection="column">
      {summary ? (
        <Box>
          <Text color="gray">{'  ↳ '}</Text>
          <Text color="gray">{summary}</Text>
        </Box>
      ) : null}
      {verbose && details ? <DetailsBlock text={details} /> : null}
    </Box>
  );
}

// Engine-meta event — codex's internal todo_list and future side-
// channel items. Visually dimmer + different prefix than ToolEvent so
// the user reads "engine emitted this" not "we invoked a tool".
function EngineMetaEvent({
  engine,
  label,
  summary,
  details,
  verbose,
}: {
  engine: string;
  label: string;
  summary?: string;
  details?: string;
  verbose: boolean;
}) {
  const short = engine.replace('-cli', '');
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="gray" bold>
          ◌{' '}
        </Text>
        <Text color="gray" bold>
          {short} · {label}
        </Text>
        {summary ? <Text color="gray"> · {summary}</Text> : null}
      </Box>
      {verbose && details ? <DetailsBlock text={details} /> : null}
    </Box>
  );
}

// Indented multi-line block for /verbose payloads. Kept dim so the
// short summary above remains the primary visual anchor.
function DetailsBlock({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <Box flexDirection="column" paddingLeft={4}>
      {lines.map((line, i) => (
        <Text key={i} color="gray">
          {line.length > 0 ? line : ' '}
        </Text>
      ))}
    </Box>
  );
}

function MemoryEvent({
  count,
  topScore,
  refs,
  fullText,
  verbose,
}: {
  count: number;
  topScore: number | null;
  refs: string[];
  fullText?: string;
  verbose: boolean;
}) {
  const score = topScore !== null ? ` · top=${topScore.toFixed(2)}` : '';
  // Cap the visible ref list at 3 so a recall with 8 hits doesn't smear
  // the whole line with slugs. Surface that there's more behind via "+N".
  const MAX_VISIBLE = 3;
  const visible = refs.slice(0, MAX_VISIBLE);
  const overflow = refs.length - visible.length;
  const refList = visible.length
    ? ` · ${visible.join(', ')}${overflow > 0 ? ` +${overflow} more` : ''}`
    : '';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="magenta" bold>
        ◇ memory · {count} hits
        {score}
        {refList}
      </Text>
      {verbose && fullText ? <DetailsBlock text={fullText} /> : null}
    </Box>
  );
}

function SystemNotice({
  text,
  tone,
}: {
  text: string;
  tone: 'info' | 'warn' | 'error';
}) {
  const color = tone === 'error' ? 'red' : tone === 'warn' ? 'yellow' : 'gray';
  const bold = tone === 'error';
  const prefix = tone === 'error' ? '✗' : tone === 'warn' ? '!' : 'i';
  return (
    <Box marginTop={1} flexDirection="column">
      {text.split('\n').map((line, i) => (
        <Text key={i} color={color} bold={bold}>
          {i === 0 ? `${prefix} ` : '  '}
          {line}
        </Text>
      ))}
    </Box>
  );
}

/**
 * What an agent produced, as a line you can act on.
 *
 * A terminal cannot show the picture, so it gets the filename — the
 * half that is actually useful here, since it can be copied and opened.
 * No emoji: composed ones measure differently in Ink than in the
 * terminal, and the resulting off-by-one shifts the whole scrollback
 * upward on every keystroke (2026-05 ZWJ finding).
 */
function MediaNotice({
  items,
}: {
  items: Array<{ type: 'image' | 'video'; filename: string; durationSec?: number }>;
}) {
  return (
    <Box flexDirection="column">
      {items.map((m, i) => (
        <Text key={`${m.filename}-${i}`} color="gray">
          {`  [${m.type}] ${m.filename}`}
          {m.durationSec !== undefined ? ` (${m.durationSec.toFixed(1)}s)` : ''}
        </Text>
      ))}
    </Box>
  );
}
