import { Box, Text } from 'ink';
import type { CommandMeta } from './commands.ts';

// Big enough to fit every slash command we ship (currently 13). If the
// command list grows past this the popup will scroll-window via the
// selectedIndex below — but until then, just show everything so the user
// doesn't have to Tab blindly through hidden entries.
const MAX_VISIBLE = 20;

// Slash-autocomplete popup. Sits between the status line and the input;
// shows matching commands while the user is still typing the command name.
export function SlashAutocomplete({
  matches,
  selectedIndex,
}: {
  matches: CommandMeta[];
  selectedIndex: number;
}) {
  if (matches.length === 0) return null;
  // Slide the visible window so the highlighted entry is always in view —
  // matters only when matches.length > MAX_VISIBLE.
  let start = 0;
  if (matches.length > MAX_VISIBLE) {
    if (selectedIndex >= MAX_VISIBLE) {
      start = Math.min(selectedIndex - MAX_VISIBLE + 1, matches.length - MAX_VISIBLE);
    }
  }
  const visible = matches.slice(start, start + MAX_VISIBLE);
  const hiddenAfter = matches.length - (start + visible.length);
  const hiddenBefore = start;
  return (
    <Box flexDirection="column">
      {hiddenBefore > 0 ? (
        <Text color="gray">{`  ↑ ${hiddenBefore} more above`}</Text>
      ) : null}
      {visible.map((cmd, i) => {
        const realIndex = start + i;
        const isSelected = realIndex === selectedIndex;
        return (
          <Text
            key={cmd.name}
            color={isSelected ? 'cyan' : 'gray'}
            bold={isSelected}
          >
            {isSelected ? '▸ ' : '  '}
            {cmd.usage}
          </Text>
        );
      })}
      {hiddenAfter > 0 ? (
        <Text color="gray">{`  ↓ ${hiddenAfter} more below`}</Text>
      ) : null}
    </Box>
  );
}
