import { Box, Text } from 'ink';

const COMMAND_HINTS = '/agent  /session  /model  /reset  /help';
const KEY_HINTS = '↹ complete · ↑↓ history · ⌃C clear/exit';

export function Footer() {
  return (
    <Box>
      <Text color="gray">{COMMAND_HINTS}</Text>
      <Box flexGrow={1} justifyContent="flex-end">
        <Text color="gray">{KEY_HINTS}</Text>
      </Box>
    </Box>
  );
}
