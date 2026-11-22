// The TUI's input as data (docs/display.md "Sending and keys"): text plus
// a cursor, and every edit as a pure function, so the keys can be tested
// without a terminal. editor.tsx draws it and maps keys onto these.
//
// The cursor moves by grapheme, not by UTF-16 unit: an emoji, a flag or
// a ZWJ family is one step and one Backspace (2026-11-22: ink-text-input
// deleted half of an emoji and sent the broken rest).

export interface EditorState {
  text: string;
  /** UTF-16 offset, always on a grapheme boundary. */
  cursor: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Offsets of every grapheme boundary of `text`, 0 and text.length included. */
export function boundaries(text: string): number[] {
  const out = [0];
  for (const seg of segmenter.segment(text)) out.push(seg.index + seg.segment.length);
  if (out[out.length - 1] !== text.length) out.push(text.length);
  return out;
}

function prevBoundary(text: string, at: number): number {
  let prev = 0;
  for (const b of boundaries(text)) {
    if (b >= at) break;
    prev = b;
  }
  return prev;
}

function nextBoundary(text: string, at: number): number {
  for (const b of boundaries(text)) if (b > at) return b;
  return text.length;
}

const lineStart = (text: string, at: number): number => (at <= 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1);
const lineEnd = (text: string, at: number): number => {
  const i = text.indexOf('\n', at);
  return i < 0 ? text.length : i;
};

export function insert(s: EditorState, piece: string): EditorState {
  return { text: s.text.slice(0, s.cursor) + piece + s.text.slice(s.cursor), cursor: s.cursor + piece.length };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const from = prevBoundary(s.text, s.cursor);
  return { text: s.text.slice(0, from) + s.text.slice(s.cursor), cursor: from };
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  const to = nextBoundary(s.text, s.cursor);
  return { text: s.text.slice(0, s.cursor) + s.text.slice(to), cursor: s.cursor };
}

export const left = (s: EditorState): EditorState => ({ ...s, cursor: prevBoundary(s.text, s.cursor) });
export const right = (s: EditorState): EditorState => ({ ...s, cursor: nextBoundary(s.text, s.cursor) });
export const home = (s: EditorState): EditorState => ({ ...s, cursor: lineStart(s.text, s.cursor) });
export const end = (s: EditorState): EditorState => ({ ...s, cursor: lineEnd(s.text, s.cursor) });

const isWordChar = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);

// Word moves step whole graphemes, so a letter and its combining accent
// stay together; a grapheme is part of a word when its first character is.
export function wordLeft(s: EditorState): EditorState {
  const b = boundaries(s.text);
  let k = b.findIndex((x) => x >= s.cursor);
  if (k < 0) k = b.length - 1;
  const word = (i: number): boolean => isWordChar(s.text.slice(b[i - 1]!, b[i]!).charAt(0));
  while (k > 0 && !word(k)) k--;
  while (k > 0 && word(k)) k--;
  return { ...s, cursor: b[k]! };
}

export function wordRight(s: EditorState): EditorState {
  const b = boundaries(s.text);
  let k = b.findIndex((x) => x >= s.cursor);
  if (k < 0) return s;
  const word = (i: number): boolean => isWordChar(s.text.slice(b[i]!, b[i + 1]!).charAt(0));
  while (k < b.length - 1 && !word(k)) k++;
  while (k < b.length - 1 && word(k)) k++;
  return { ...s, cursor: b[k]! };
}

/** Ctrl+W: the word before the cursor and the spaces after it. */
export function deleteWordBack(s: EditorState): EditorState {
  const to = wordLeft(s).cursor;
  return { text: s.text.slice(0, to) + s.text.slice(s.cursor), cursor: to };
}

/** Ctrl+U: from the start of the line to the cursor. */
export function killToLineStart(s: EditorState): EditorState {
  const from = lineStart(s.text, s.cursor);
  return { text: s.text.slice(0, from) + s.text.slice(s.cursor), cursor: from };
}

/** Ctrl+K: from the cursor to the end of the line. */
export function killToLineEnd(s: EditorState): EditorState {
  const to = lineEnd(s.text, s.cursor);
  return { text: s.text.slice(0, s.cursor) + s.text.slice(to), cursor: s.cursor };
}

/** The cursor's line and its column in graphemes. */
export function position(s: EditorState): { line: number; column: number; lines: number } {
  const before = s.text.slice(0, s.cursor);
  const line = before.split('\n').length - 1;
  const start = lineStart(s.text, s.cursor);
  const column = boundaries(s.text.slice(start, s.cursor)).length - 1;
  return { line, column, lines: s.text.split('\n').length };
}

/** Up or Down one line, keeping the column where the line is long enough. */
export function vertical(s: EditorState, dir: -1 | 1): EditorState {
  const { line, column, lines } = position(s);
  const target = line + dir;
  if (target < 0 || target >= lines) return s;
  const starts = [0];
  for (let i = 0; i < s.text.length; i++) if (s.text[i] === '\n') starts.push(i + 1);
  const start = starts[target]!;
  const stop = lineEnd(s.text, start);
  const b = boundaries(s.text.slice(start, stop));
  return { ...s, cursor: start + b[Math.min(column, b.length - 1)]! };
}

// ── Pasting ───────────────────────────────────────────────────────────

/** A paste longer than this stands in the input as one short marker. */
export const PASTE_MARKER_LINES = 8;
export const PASTE_MARKER_CHARS = 800;

/** Line endings of a paste (terminals send CR) made into '\n'. */
export const normalizePaste = (text: string): string => text.replace(/\r\n?/g, '\n');

export function pasteMarker(n: number, text: string): string {
  const lines = text.split('\n').length;
  return lines > 1 ? `[paste #${n} · ${lines} lines]` : `[paste #${n} · ${text.length} chars]`;
}

/** The text to send: every marker still in it replaced by its paste. */
export function expandPastes(text: string, pastes: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [marker, content] of pastes) out = out.split(marker).join(content);
  return out;
}

// ── Typed chunks ──────────────────────────────────────────────────────

/**
 * What a chunk of typed input means. Terminals and tools that type for a
 * person (`herdr pane run`, `tmux send-keys` with the text and Enter in
 * one write) deliver "text\r" as one chunk without a key flag: the CR at
 * its end sends, a CR or LF inside it starts a new line. A chunk with no
 * line break is just text.
 */
export function splitTypedChunk(chunk: string): { text: string; submit: boolean } {
  const submit = /\r$/.test(chunk);
  const body = submit ? chunk.slice(0, -1) : chunk;
  return { text: body.replace(/\r\n?/g, '\n'), submit };
}

/** Control characters that have no place in a message. */
export const stripControls = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

// ── History search (Ctrl+R) ───────────────────────────────────────────

/**
 * The newest history entry at or before `from` that contains `query`,
 * ignoring case; -1 when none does. An empty query matches the entry at
 * `from` itself.
 */
export function searchHistory(history: readonly string[], query: string, from = history.length - 1): number {
  const q = query.toLowerCase();
  for (let i = Math.min(from, history.length - 1); i >= 0; i--) {
    if (history[i]!.toLowerCase().includes(q)) return i;
  }
  return -1;
}
