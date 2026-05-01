import { Text, useStdout } from 'ink';

// Adapts to the actual terminal width — falls back to 80 columns when
// stdout doesn't report (e.g. piped output, edge cases).
//
// `gray` instead of dimColor: on dark terminals dimColor is near-invisible
// because it just halves intensity; gray is a real color with usable
// contrast against both backgrounds.
export function Separator() {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  return <Text color="gray">{'─'.repeat(Math.max(20, width))}</Text>;
}
