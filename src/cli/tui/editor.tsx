// The TUI's input (docs/display.md "Sending and keys"), replacing
// ink-text-input (2026-11-22). Its edits live in editor-model.ts; this
// file maps keys onto them and draws the text with the cursor.
//
// - Enter sends. Alt+Enter, Ctrl+J, Shift+Enter (on terminals that report
//   it) or a `\` at the end of the line start a new line.
// - Text and Enter that arrive in one chunk (`herdr pane run`, a script's
//   `tmux send-keys`) send, instead of putting the Enter into the text.
// - A paste arrives whole (bracketed paste, Ink's usePaste) and never
//   sends by itself; a long one stands in as `[paste #1 · 40 lines]` and
//   goes out in full.
// - Up and Down move between the lines of a multi-line draft; on its
//   first or last line they belong to the history (app.tsx reads
//   `edgeRef`).
// Tab, Esc and Ctrl+C stay with app.tsx.

import { Box, Text, useInput, usePaste } from 'ink';
import { useRef, useState, type MutableRefObject } from 'react';
import * as E from './editor-model.ts';

export interface EditorEdges {
  /** The cursor is on the draft's first line: Up goes to the history. */
  atTop: boolean;
  /** The cursor is on the draft's last line: Down goes to the history. */
  atBottom: boolean;
}

export function Editor({
  value,
  onChange,
  onSubmit,
  placeholder,
  edgeRef,
  isActive = true,
  maxRows = 12,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
  placeholder?: string;
  edgeRef?: MutableRefObject<EditorEdges>;
  /** Off while the history search (Ctrl+R) has the keys. */
  isActive?: boolean;
  /** Lines shown at most; a longer draft shows the part around the
   *  cursor, so the input never pushes the panel off the screen. */
  maxRows?: number;
}) {
  const [cursor, setCursor] = useState(value.length);
  // The value this editor last emitted. Another value came from outside
  // (Tab completion, history, /queue rm): the cursor goes to its end.
  const ownValue = useRef(value);
  const pastes = useRef(new Map<string, string>());
  const pasteCount = useRef(0);
  let state: E.EditorState = { text: value, cursor: Math.min(cursor, value.length) };
  if (value !== ownValue.current) {
    state = { text: value, cursor: value.length };
    ownValue.current = value;
    if (value === '') pastes.current.clear();
  }
  // The newest state, current between renders: two keys that arrive
  // before React draws again must both land.
  const live = useRef(state);
  live.current = state;
  const pos = E.position(state);
  if (edgeRef) edgeRef.current = { atTop: pos.line === 0, atBottom: pos.line === pos.lines - 1 };

  const apply = (next: E.EditorState): void => {
    live.current = next;
    ownValue.current = next.text;
    setCursor(next.cursor);
    onChange(next.text);
  };
  const submit = (text: string): void => {
    const full = E.expandPastes(text, pastes.current);
    pastes.current.clear();
    onSubmit(full);
  };

  useInput((input, key) => {
    const state = live.current;
    const pos = E.position(state);
    if (key.tab || key.escape || (key.ctrl && input === 'c')) return;
    if (key.return) {
      if (key.meta || key.shift) return apply(E.insert(state, '\n'));
      if (state.text.slice(0, state.cursor).endsWith('\\')) {
        return apply(E.insert(E.backspace(state), '\n'));
      }
      return submit(state.text);
    }
    if (key.backspace) return apply(key.meta || key.ctrl ? E.deleteWordBack(state) : E.backspace(state));
    if (key.delete) return apply(E.deleteForward(state));
    if (key.leftArrow) return apply(key.ctrl || key.meta ? E.wordLeft(state) : E.left(state));
    if (key.rightArrow) return apply(key.ctrl || key.meta ? E.wordRight(state) : E.right(state));
    if (key.home) return apply(E.home(state));
    if (key.end) return apply(E.end(state));
    if (key.upArrow) return pos.line > 0 ? apply(E.vertical(state, -1)) : undefined;
    if (key.downArrow) return pos.line < pos.lines - 1 ? apply(E.vertical(state, 1)) : undefined;
    if (key.ctrl) {
      if (input === 'a') return apply(E.home(state));
      if (input === 'e') return apply(E.end(state));
      if (input === 'u') return apply(E.killToLineStart(state));
      if (input === 'k') return apply(E.killToLineEnd(state));
      if (input === 'w') return apply(E.deleteWordBack(state));
      return;
    }
    if (key.meta) {
      if (input === 'b') return apply(E.wordLeft(state));
      if (input === 'f') return apply(E.wordRight(state));
      return;
    }
    if (input === '') return;
    if (input === '\n') return apply(E.insert(state, '\n')); // Ctrl+J
    const chunk = E.splitTypedChunk(input);
    const text = E.stripControls(chunk.text);
    const next = text ? E.insert(state, text) : state;
    if (chunk.submit) {
      apply(next);
      return submit(next.text);
    }
    apply(next);
  }, { isActive });

  usePaste((raw) => {
    const state = live.current;
    const text = E.stripControls(E.normalizePaste(raw));
    if (text.split('\n').length > E.PASTE_MARKER_LINES || text.length > E.PASTE_MARKER_CHARS) {
      pasteCount.current += 1;
      const marker = E.pasteMarker(pasteCount.current, text);
      pastes.current.set(marker, text);
      apply(E.insert(state, marker));
      return;
    }
    apply(E.insert(state, text));
  }, { isActive });

  if (state.text.length === 0) {
    return (
      <Box>
        <Text color="cyan">{'> '}</Text>
        <Text inverse> </Text>
        {placeholder ? <Text color="gray">{placeholder}</Text> : null}
      </Box>
    );
  }
  // One row per line of the draft; the cursor is the inverted character
  // under it (a space at a line end).
  const lines = state.text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  // A window of lines around the cursor when the draft is long; its
  // lines are cut at the edge instead of wrapping, so it keeps its height.
  const room = Math.max(1, maxRows - 2);
  const windowed = lines.length > maxRows;
  const first = windowed ? Math.min(Math.max(0, pos.line - Math.floor(room / 2)), lines.length - room) : 0;
  const shown = windowed ? lines.slice(first, first + room) : lines;
  const wrap = windowed ? 'truncate-end' : 'wrap';
  return (
    <Box flexDirection="column">
      {windowed && first > 0 ? <Text color="gray">{`  ↑ ${first} more line${first === 1 ? '' : 's'}`}</Text> : null}
      {shown.map((line, k) => {
        const i = first + k;
        const start = starts[i]!;
        const prefix = i === 0 ? <Text color="cyan">{'> '}</Text> : <Text>{'  '}</Text>;
        if (i !== pos.line) {
          return (
            <Text key={i} wrap={wrap}>
              {prefix}
              {line.length > 0 ? line : ' '}
            </Text>
          );
        }
        const col = state.cursor - start;
        const next = E.boundaries(line).find((b) => b > col) ?? line.length;
        const under = line.slice(col, next);
        return (
          <Text key={i} wrap={wrap}>
            {prefix}
            {line.slice(0, col)}
            <Text inverse>{under.length > 0 ? under : ' '}</Text>
            {line.slice(next)}
          </Text>
        );
      })}
      {windowed && first + room < lines.length ? (
        <Text color="gray">{`  ↓ ${lines.length - first - room} more line${lines.length - first - room === 1 ? '' : 's'}`}</Text>
      ) : null}
    </Box>
  );
}
