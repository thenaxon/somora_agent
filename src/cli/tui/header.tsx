import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactElement } from 'react';
import type { TurnStats } from './types.ts';
import { formatTokens } from './format.ts';

interface Props {
  agent: string;
  session: string;
  stats: TurnStats | null;
  streaming: boolean;
  connected: boolean;
}

export function Header({ agent, session, stats, streaming, connected }: Props) {
  const tokenSegment = renderTokenSegment(stats);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow">🐨 somora </Text>
        <Text dimColor>· </Text>
        <Text color="cyan">
          {agent}:{session}
        </Text>
        {stats?.model ? (
          <>
            <Text dimColor> · </Text>
            <Text color="magenta">{stats.model}</Text>
          </>
        ) : null}
        {tokenSegment ? (
          <>
            <Text dimColor>   </Text>
            {tokenSegment}
          </>
        ) : null}
        <Box flexGrow={1} justifyContent="flex-end">
          {streaming ? (
            <Text color="yellow">
              <Spinner type="dots" /> streaming
            </Text>
          ) : connected ? (
            <Text dimColor>● connected</Text>
          ) : (
            <Text color="red">● disconnected</Text>
          )}
        </Box>
      </Box>
      <Text dimColor>{'─'.repeat(80)}</Text>
    </Box>
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
        ↑ {formatTokens(uncached)}
        <Text color="green">+{formatTokens(cached)}¢</Text>
      </Text>
    );
  } else {
    inSegment = <Text>↑ {formatTokens(total)}</Text>;
  }
  return (
    <Text>
      {inSegment}
      {window ? <Text dimColor> / {formatTokens(window)}</Text> : null}
      <Text>   ↓ {formatTokens(stats.tokensOut)}</Text>
    </Text>
  );
}
