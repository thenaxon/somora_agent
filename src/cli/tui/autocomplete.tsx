import { Box, Text } from 'ink';
import type { CommandMeta } from './commands.ts';

// At most this many commands at once; the window slides with the
// highlighted entry and says how many more there are. The list takes its
// rows from the chat above it (the frame keeps its height, docs/display.md
// "The screen"), so it is kept short enough to leave the chat visible in a
// small pane (2026-11-22: 20 rows ate a whole herdr pane).
export const MAX_VISIBLE = 8;

// Slash-autocomplete popup. Sits between the status line and the input;
// shows matching commands while the user is still typing the command name.
export function SlashAutocomplete({
  matches,
  selectedIndex,
  maxVisible = MAX_VISIBLE,
}: {
  matches: CommandMeta[];
  selectedIndex: number;
  /** Fewer in a short window, so the input and hints stay on screen with
   *  two rows of chat left (the list's "more" lines count too). */
  maxVisible?: number;
}) {
  const MAX_VISIBLE = Math.max(1, maxVisible);
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
            wrap="truncate-end"
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
