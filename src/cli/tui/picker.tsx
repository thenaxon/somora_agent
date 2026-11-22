// A list to pick from by typing (docs/display.md "Pickers"): agents
// (Ctrl+G), the agent's sessions (Ctrl+P), models (Ctrl+O). The idea and
// the keys follow OpenClaw's TUI (src/tui/tui-session-picker.ts there),
// except Ctrl+L, which stays the terminal's.
//
// Typing narrows the list by a loose match: the letters in order, not
// necessarily next to each other ("lmn" finds "loki:main-notes"), words
// that start with them ranked first. Up and Down move, Enter picks, Esc
// closes. It sits where the slash command list sits, takes as many rows,
// and has the keys while it is open.

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

export interface PickItem {
  /** What picking it runs or names (an agent name, a session id, a model). */
  value: string;
  label: string;
  /** Gray text after the label: a description, a message count. */
  hint?: string;
  /** Marks the one in use. */
  current?: boolean;
}

/**
 * How well `query` matches `text`: its letters in order, ignoring case;
 * null when they are not all there. Higher is better: letters next to
 * each other, at the start of the text or of a word.
 */
export function looseScore(text: string, query: string): number | null {
  if (query.length === 0) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    if (i === last + 1) score += 3;
    if (i === 0 || /[\s:/_.-]/.test(t[i - 1]!)) score += 2;
    score += 1;
    last = i;
    from = i + 1;
  }
  return score - t.length / 100;
}

/** The items that match, best first; all of them in order for no query. */
export function rankItems(items: readonly PickItem[], query: string): PickItem[] {
  if (query.length === 0) return [...items];
  return items
    .map((item, i) => ({ item, i, score: looseScore(`${item.label} ${item.hint ?? ''}`, query) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => b.score! - a.score! || a.i - b.i)
    .map((x) => x.item);
}

export function Picker({
  title,
  items,
  maxVisible,
  onPick,
  onCancel,
}: {
  title: string;
  items: readonly PickItem[];
  maxVisible: number;
  onPick: (item: PickItem) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => Math.max(0, items.findIndex((i) => i.current)));
  const ranked = rankItems(items, query);
  const index = Math.min(selected, Math.max(0, ranked.length - 1));

  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === 'c' || input === 'g' || input === 'p' || input === 'o'))) return onCancel();
    if (key.return) {
      const item = ranked[index];
      return item ? onPick(item) : onCancel();
    }
    if (key.upArrow) return setSelected(Math.max(0, index - 1));
    if (key.downArrow) return setSelected(Math.min(ranked.length - 1, index + 1));
    if (key.backspace || key.delete) {
      setQuery([...query].slice(0, -1).join(''));
      return setSelected(0);
    }
    if (key.ctrl || key.meta || key.tab || !input || /[\u0000-\u001f]/.test(input)) return;
    setQuery(query + input);
    setSelected(0);
  });

  const rows = Math.max(1, maxVisible);
  const start = Math.min(Math.max(0, index - rows + 1), Math.max(0, ranked.length - rows));
  const visible = ranked.slice(start, start + rows);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color="magenta" bold>
          {title}{' '}
        </Text>
        <Text color="cyan">{query}</Text>
        <Text inverse> </Text>
        <Text color="gray">
          {'  '}
          {ranked.length}/{items.length} · Enter picks · Esc closes
        </Text>
      </Text>
      {visible.length === 0 ? <Text color="yellow">  nothing matches</Text> : null}
      {visible.map((item, i) => {
        const on = start + i === index;
        return (
          <Text key={item.value} wrap="truncate-end" color={on ? 'cyan' : undefined} bold={on}>
            {on ? '▸ ' : '  '}
            {item.label}
            {item.current ? ' *' : ''}
            {item.hint ? <Text color="gray">{`  ${item.hint}`}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
