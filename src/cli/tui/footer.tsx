import { Box, Text } from 'ink';

const COMMAND_HINTS = '/agent  /session  /model  /reset  /help';
const KEY_HINTS = '⏎ send · ⌃C exit';

export function Footer() {
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(80)}</Text>
      <Box>
        <Text dimColor>{COMMAND_HINTS}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>{KEY_HINTS}</Text>
        </Box>
      </Box>
    </Box>
  );
}
