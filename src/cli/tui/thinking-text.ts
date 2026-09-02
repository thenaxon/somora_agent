// Pure text helpers for rendering thinking content in the TUI.
//
// Kept free of React/Ink so they can be unit-tested with plain node
// (see thinking-view.test.mts). Two concerns:
//   - the live streaming view shows only the TAIL of the thinking text
//     (the model is still thinking; the last few lines are what matters)
//   - the finalized scrollback turn is CAPPED so a huge reasoning dump
//     (Qwen-style, thousands of lines) cannot flood the terminal.

/** Lines shown in the streaming view while the model is still thinking. */
export const THINKING_TAIL_LINES = 6;
/** Max lines a finalized thinking turn renders in the scrollback. */
export const THINKING_MAX_LINES = 40;

/** Split into lines, dropping trailing whitespace-only lines. */
function splitLines(text: string): string[] {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.length === 0) return [];
  return trimmed.split('\n');
}

/**
 * Last `n` lines of `text`. Empty text → empty array. Trailing blank
 * lines are dropped first so a delta ending in "\n" doesn't waste a
 * slot on an empty row.
 */
export function tailLines(text: string, n: number = THINKING_TAIL_LINES): string[] {
  if (n <= 0) return [];
  const lines = splitLines(text);
  return lines.length > n ? lines.slice(lines.length - n) : lines;
}

export interface CappedLines {
  /** The lines to render (at most `max`). */
  lines: string[];
  /** How many lines were cut off after `lines`; 0 = nothing hidden. */
  hidden: number;
}

/**
 * First `max` lines of `text` plus the number of lines left out. The
 * caller appends the `… (+N lines)` marker when `hidden > 0`.
 */
export function capLines(text: string, max: number = THINKING_MAX_LINES): CappedLines {
  const lines = splitLines(text);
  if (max <= 0) return { lines: [], hidden: lines.length };
  if (lines.length <= max) return { lines, hidden: 0 };
  return { lines: lines.slice(0, max), hidden: lines.length - max };
}

/** Marker line appended under a capped block. */
export function hiddenLinesMarker(hidden: number): string {
  return `… (+${hidden} line${hidden === 1 ? '' : 's'})`;
}
