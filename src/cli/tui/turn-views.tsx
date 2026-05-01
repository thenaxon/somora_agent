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
import { shortToolName } from './format.ts';
import { formatArgs, formatResult } from './tool-format.ts';
import { renderInline } from './markdown.tsx';

export function TurnView({
  turn,
  agentName,
  agentIcon,
}: {
  turn: Turn;
  agentName: string;
  agentIcon: string;
}) {
  switch (turn.kind) {
    case 'user':
      return <UserTurn text={turn.text} />;
    case 'agent':
      return <AgentTurn text={turn.text} agentName={agentName} agentIcon={agentIcon} />;
    case 'tool':
      return <ToolEvent {...turn} />;
    case 'memory':
      return <MemoryEvent count={turn.count} topScore={turn.topScore} refs={turn.refs} />;
    case 'system':
      return <SystemNotice text={turn.text} tone={turn.tone} />;
  }
}

function UserTurn({ text }: { text: string }) {
  return (
    <Box marginTop={1}>
      <Text color="green" bold>
        {'user  '}
      </Text>
      <Text>{text}</Text>
    </Box>
  );
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
  input,
  output,
  error,
}: {
  tool: string;
  phase: 'call' | 'result' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
}) {
  const name = shortToolName(tool);
  if (phase === 'call') {
    const args = formatArgs(tool, input);
    return (
      <Box marginTop={1}>
        <Text color="blue" bold>
          ▸{' '}
        </Text>
        <Text color="blue" bold>
          {name}
        </Text>
        {args ? <Text color="gray"> · {args}</Text> : null}
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
  // result — suppress entirely if the per-tool formatter says it's trivial
  // (e.g. {ok:true} after a memory_write).
  const summary = formatResult(tool, output);
  if (!summary) return null;
  return (
    <Box>
      <Text color="gray">{'  ↳ '}</Text>
      <Text color="gray">{summary}</Text>
    </Box>
  );
}

function MemoryEvent({
  count,
  topScore,
  refs,
}: {
  count: number;
  topScore: number | null;
  refs: string[];
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
    <Box marginTop={1}>
      <Text color="magenta" bold>
        ◇ memory · {count} hits
        {score}
        {refList}
      </Text>
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
