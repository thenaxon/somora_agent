import { Text, useWindowSize } from 'ink';

// Adapts to the actual terminal width — falls back to 80 columns when
// stdout doesn't report (e.g. piped output, edge cases).
//
// One column short of the full width (2026-11-22): `─` is an
// ambiguous-width character that some terminals draw two cells wide, and
// a row that reaches the last column wraps on those. A wrapped row is one
// Ink did not count, and the frame below it shifts.
//
// `gray` instead of dimColor: on dark terminals dimColor is near-invisible
// because it just halves intensity; gray is a real color with usable
// contrast against both backgrounds.
export function Separator() {
  const width = useWindowSize().columns || 80;
  return (
    <Text color="gray" wrap="truncate-end">
      {'─'.repeat(Math.max(10, width - 1))}
    </Text>
  );
}
