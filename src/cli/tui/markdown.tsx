// Minimal inline-markdown rendering for chat output.
//
// Scope:
//   **bold**      → Text bold
//   *italic*      → Text italic
//   `code`        → Text colored
//
// Anything that doesn't match (incomplete token, escaped, multi-line) stays
// as literal text — important during streaming where the closing token may
// not have arrived yet.
//
// Block-level markdown (lists, headings, code fences, links) is intentionally
// out of scope here. We render line-by-line in turn-views.tsx and the
// caller passes one line at a time.

import type { ReactNode } from 'react';
import { Text } from 'ink';

// Combined regex:
//   group 1: **bold**         no internal asterisks or newlines
//   group 2: `code`           no internal backticks or newlines
//   group 3: *italic*         single asterisks not adjacent to other asterisks
const PATTERN =
  /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|((?<!\*)\*(?!\*)[^*\n]+?(?<!\*)\*(?!\*))/g;

export function renderInline(input: string): ReactNode {
  if (!input) return input;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  PATTERN.lastIndex = 0;
  while ((match = PATTERN.exec(input)) !== null) {
    if (match.index > lastIndex) {
      parts.push(input.slice(lastIndex, match.index));
    }
    const [tok] = match;
    if (tok.startsWith('**')) {
      parts.push(
        <Text key={`b${key++}`} bold>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith('`')) {
      parts.push(
        <Text key={`c${key++}`} color="yellowBright">
          {tok.slice(1, -1)}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={`i${key++}`} italic>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    lastIndex = match.index + tok.length;
  }
  if (lastIndex < input.length) {
    parts.push(input.slice(lastIndex));
  }
  return parts.length > 0 ? parts : input;
}
