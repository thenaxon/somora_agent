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

// Status line. Sits right above the input, NOT at the top of the terminal —
// keeps the bottom-panel (status / input / hints) anchored while older
// turns scroll up and out via Ink's <Static>.
//
// Color choice: explicit `gray` instead of dimColor wherever the text needs
// to be readable. dimColor halves intensity, which on dark terminals turns
// near-black; gray is a real color that survives both backgrounds.
export function Header({ agent, session, stats, streaming, connected }: Props) {
  const tokenSegment = renderTokenSegment(stats);
  return (
    <Box>
      <Text color="yellow" bold>
        🐨 somora{' '}
      </Text>
      <Text color="gray">· </Text>
      <Text color="cyan" bold>
        {agent}:{session}
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
      <Box flexGrow={1} justifyContent="flex-end">
        {streaming ? (
          <Text color="yellow" bold>
            <Spinner type="dots" /> streaming
          </Text>
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
  return (
    <Text>
      {inSegment}
      {window ? <Text color="gray"> / {formatTokens(window)}</Text> : null}
      <Text color="white">   ↓ {formatTokens(stats.tokensOut)}</Text>
    </Text>
  );
}
