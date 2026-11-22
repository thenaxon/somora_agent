// Pure layout helpers of the TUI's screen (docs/display.md "The screen").
//
// The client draws one frame exactly as tall as the terminal: the tail of
// the chat on top, the bottom panel (separator, status, command list,
// input, hints) below. A message moves into the terminal's own scrollback
// (Ink's <Static>) only once it has left the top of that frame. Because
// the frame never changes height, nothing below it can be left behind
// when the command list closes or a reply ends — the input line stays on
// the last rows of the terminal (2026-11-22: it used to jump up to 23
// rows when the command list closed).
//
// What moves into the scrollback moves whole, and it moves as soon as its
// first row has left the top of the frame — never later, or rows above
// the screen would be in neither place (2026-11-22: twelve-line blocks
// that stuck out at the top hid up to eleven lines of a reply). So a
// reply is split into its lines here: each can leave on its own, and at
// most a wrapped line's upper rows show as blank at the top for a moment.

import stringWidth from 'string-width';
import { THINKING_MAX_LINES, capLines, hiddenLinesMarker } from './thinking-text.ts';
import type { Turn } from './types.ts';
import { systemNoticeOf } from './turn-views.tsx';
import { classifyReply, rowPrefixWidth, rowText } from './blocks.ts';

/**
 * A reply's text as the pieces that scroll away one by one: its lines.
 * Joined with '\n' they give back the text unchanged.
 */
export function splitReply(text: string): string[] {
  return text.split('\n');
}

/**
 * A chat entry as the items that scroll away one by one. A multi-line
 * reply, notice, message or thinking block becomes its first line (with
 * the entry's name, prefix and colour) and `line` items for the rest;
 * everything else stays one item. Thinking keeps its cap
 * (THINKING_MAX_LINES and the `… (+N lines)` marker).
 */
export function explodeTurn(t: Turn, id: () => string, cols = 80): Turn[] {
  // Rows of `text` at this indent: a line wider than the screen is cut
  // into word-wrapped pieces, so no single item is taller than a row or
  // two and none can stick out of the top of the frame for long.
  const rowsOf = (lines: string[], indent: number): string[] =>
    lines.flatMap((line) => wrapLine(line, Math.max(10, cols - indent - 1)));
  const rest = (lines: string[], indent: number, color?: string, bold?: boolean): Turn[] =>
    lines.map((text) => ({ kind: 'line', id: id(), text, indent, ...(color ? { color } : {}), ...(bold ? { bold } : {}) }));
  switch (t.kind) {
    case 'agent': {
      if (t.cont || t.row) return [t];
      // One item per row of the reply's blocks (blocks.ts); a long row is
      // cut into pieces that keep its marker's indent. Table rows and
      // rules are not wrapped (they are cut at the edge when drawn).
      const out: Turn[] = [];
      for (const row of classifyReply(splitReply(t.text))) {
        const text = rowText(row);
        const pieces = row.kind === 'table' || row.kind === 'table-rule' || !text
          ? [text]
          : wrapLine(text, Math.max(10, cols - 2 - rowPrefixWidth(row) - 1));
        pieces.forEach((piece, i) => {
          const r = 'text' in row ? { ...row, text: piece, ...(i > 0 ? { more: true as const } : {}) } : row;
          out.push(out.length === 0 ? { ...t, text: piece, row: r } : { kind: 'agent', id: id(), text: piece, cont: true, row: r });
        });
      }
      return out.length > 0 ? out : [t];
    }
    case 'system': {
      const [first = '', ...more] = rowsOf(t.text.split('\n'), 2);
      if (more.length === 0) return [{ ...t, text: first }];
      const color = t.tone === 'error' ? 'red' : t.tone === 'warn' ? 'yellow' : 'gray';
      return [{ ...t, text: first }, ...rest(more, 2, color, t.tone === 'error')];
    }
    case 'user': {
      // A system inbound draws as one summary line: keep it whole.
      if (systemNoticeOf(t.text, t.fromSystem, t.origin)) return [t];
      const indent = t.fromAgent ? 2 : 6;
      const [first = '', ...more] = rowsOf(t.text.split('\n'), Math.max(indent, 8));
      if (more.length === 0) return [{ ...t, text: first }];
      return [{ ...t, text: first }, ...rest(more, indent)];
    }
    case 'thinking': {
      const { lines, hidden } = capLines(t.text, THINKING_MAX_LINES);
      const [first = '', ...more] = rowsOf(lines, 2);
      return [
        { ...t, text: first },
        ...rest(more, 2, 'gray'),
        ...(hidden > 0 ? rest([hiddenLinesMarker(hidden)], 2, 'gray') : []),
      ];
    }
    default:
      return [t];
  }
}

/**
 * A line cut into pieces no wider than `width` cells: at spaces where it
 * can, inside a word only when the word alone is too wide. A line that
 * fits comes back as it is; an empty line as one empty piece.
 */
export function wrapLine(line: string, width: number): string[] {
  if (cellWidth(line) <= width) return [line];
  const out: string[] = [];
  let current = '';
  for (const word of line.split(/(\s+)/)) {
    if (word === '') continue;
    if (cellWidth(current + word) <= width) {
      current += word;
      continue;
    }
    if (current.trim().length > 0) out.push(current.trimEnd());
    current = /^\s+$/.test(word) ? '' : word;
    while (cellWidth(current) > width) {
      let cut = '';
      for (const ch of current) {
        if (cellWidth(cut + ch) > width) break;
        cut += ch;
      }
      out.push(cut);
      current = current.slice(cut.length);
    }
  }
  if (current.length > 0) out.push(current);
  return out.length > 0 ? out : [''];
}

/**
 * A session's name for the status line. Session ids are
 * `<date>-<time>_<slug>`; the slug is what people typed and recognise,
 * the date only makes the line long.
 */
export function sessionLabel(session: string): string {
  const m = /^\d{8}-\d{6}_(.+)$/.exec(session);
  return m ? m[1]! : session;
}

/** One part of a line that may be left out when the line is too narrow. */
export interface Segment {
  key: string;
  /** The text as the terminal shows it, for measuring. */
  plain: string;
  /** Lower goes first when the line does not fit. */
  priority: number;
}

/** Terminal cells of a text, as Ink and most terminals count them. */
export function cellWidth(text: string): number {
  return stringWidth(text);
}

/**
 * The segments that fit in `width` cells, in their original order. The
 * lowest priority is dropped first until the rest fits; what is left over
 * is cut at the end by the caller's `wrap="truncate-end"`.
 */
export function fitSegments<T extends Segment>(segments: T[], width: number, gap = 3): T[] {
  const kept = [...segments];
  const total = (list: T[]): number =>
    list.reduce((sum, s, i) => sum + cellWidth(s.plain) + (i > 0 ? gap : 0), 0);
  while (kept.length > 1 && total(kept) > width) {
    let lowest = 0;
    for (let i = 1; i < kept.length; i++) if (kept[i]!.priority < kept[lowest]!.priority) lowest = i;
    kept.splice(lowest, 1);
  }
  return kept;
}

/**
 * How many items at the top of the chat move into the scrollback: every
 * item whose first row is above the top of the frame, counting the frame
 * at its tallest (`viewRows`, the chat area with the command list closed),
 * so items only hidden while the list is open come back when it closes.
 */
export function itemsAboveView(heights: number[], viewRows: number): number {
  let hidden = heights.reduce((a, b) => a + b, 0) - viewRows;
  let n = 0;
  for (const h of heights) {
    if (hidden <= 0) break;
    hidden -= h;
    n += 1;
  }
  return n;
}
