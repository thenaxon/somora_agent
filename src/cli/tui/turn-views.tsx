// One component per Turn-kind. Kept dumb — no state, no fetches, just
// rendering. Layout-conventions:
//   - 2-space role tag + content, single line tag where possible
//   - dim secondary text (tool args, memory refs, system notices)
//   - color-code role tags (user=cyan dim, agent=cyan bright, tool=blue,
//     memory=magenta dim, system=yellow/red by tone)

import { Box, Text } from 'ink';
import type { Turn } from './types.ts';
import { shortToolName, summarize } from './format.ts';

export function TurnView({ turn, agentName }: { turn: Turn; agentName: string }) {
  switch (turn.kind) {
    case 'user':
      return <UserTurn text={turn.text} />;
    case 'agent':
      return <AgentTurn text={turn.text} agentName={agentName} />;
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
      <Text color="cyan" dimColor>
        {'user  '}
      </Text>
      <Text>{text}</Text>
    </Box>
  );
}

function AgentTurn({ text, agentName }: { text: string; agentName: string }) {
  return (
    <Box marginTop={1} flexDirection="row">
      <Text color="cyan" bold>
        {agentName.padEnd(6)}
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
        <Text color="blue">▸ </Text>
        <Text color="blue">{name}</Text>
        {args ? (
          <Text dimColor> · {args}</Text>
        ) : null}
      </Box>
    );
  }
  if (phase === 'error') {
    return (
      <Box>
        <Text color="red">  ↳ error · </Text>
        <Text color="red" dimColor>
          {summarize(error, 200)}
        </Text>
      </Box>
    );
  }
  // result
  const out = summarize(output, 100);
  return (
    <Box>
      <Text dimColor>  ↳ </Text>
      <Text dimColor>{out || '(ok)'}</Text>
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
      <Text color="magenta" dimColor>
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
  const prefix = tone === 'error' ? '✗' : tone === 'warn' ? '!' : 'i';
  return (
    <Box marginTop={1} flexDirection="column">
      {text.split('\n').map((line, i) => (
        <Text key={i} color={color}>
          {i === 0 ? `${prefix} ` : '  '}
          {line}
        </Text>
      ))}
    </Box>
  );
}
