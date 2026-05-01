import { Box, Text } from 'ink';
import type { CommandMeta } from './commands.ts';

const MAX_VISIBLE = 6;

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
  const visible = matches.slice(0, MAX_VISIBLE);
  const overflow = matches.length - visible.length;
  return (
    <Box flexDirection="column">
      {visible.map((cmd, i) => (
        <Text
          key={cmd.name}
          color={i === selectedIndex ? 'cyan' : 'gray'}
          bold={i === selectedIndex}
        >
          {i === selectedIndex ? '▸ ' : '  '}
          {cmd.usage}
        </Text>
      ))}
      {overflow > 0 ? <Text color="gray">{`  +${overflow} more (Tab to cycle)`}</Text> : null}
    </Box>
  );
}
