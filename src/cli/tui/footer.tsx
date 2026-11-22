import { Box, Text, useWindowSize } from 'ink';
import { cellWidth } from './layout.ts';

const COMMAND_HINTS = '/agent  /session  /model  /reset  /help';
const KEY_HINTS = '↹ complete · ↑↓ history · ⌃C clear/exit';

// One row, never more (2026-11-22). The key hints sit on the right with
// padding computed here instead of a flex filler, one column short of the
// full width; when both do not fit, the key hints are left out. A footer
// that wrapped to two rows at 60 columns shifted the whole panel.
export function Footer() {
  const cols = useWindowSize().columns || 80;
  const width = Math.max(10, cols - 1);
  const room = width - cellWidth(COMMAND_HINTS) - cellWidth(KEY_HINTS);
  const line = room >= 2 ? COMMAND_HINTS + ' '.repeat(room) + KEY_HINTS : COMMAND_HINTS;
  return (
    <Box width={width} height={1} overflow="hidden">
      <Text color="gray" wrap="truncate-end">
        {line}
      </Text>
    </Box>
  );
}
