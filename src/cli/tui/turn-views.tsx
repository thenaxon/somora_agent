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
import { shortToolName, summarize } from './format.ts';

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
    <Box marginTop={1} flexDirection="row">
      <Text color="cyan" bold>
        {tag}
        {'  '}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text>{text}</Text>
      </Box>
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
  input?: string;
  output?: string;
  error?: string;
}) {
  const name = shortToolName(tool);
  if (phase === 'call') {
    const args = summarize(input, 100);
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
        <Text color="red">{summarize(error, 200)}</Text>
      </Box>
    );
  }
  // result
  const out = summarize(output, 100);
  return (
    <Box>
      <Text color="gray">{'  ↳ '}</Text>
      <Text color="gray">{out || '(ok)'}</Text>
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
  const refList = refs.length ? ` · ${refs.join(', ')}` : '';
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
