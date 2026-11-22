// Block markdown of a reply (docs/display.md "Lines in the chat"): what
// each line is — code inside a fence, a heading, a list item, a quote, a
// rule, a table row — decided over the whole reply, because the lines
// scroll into the scrollback one by one (layout.ts) and each must already
// know its block. renderInline (markdown.tsx) still does **bold**,
// *italic* and `code` inside a line.
//
// Tables are laid out here: every column as wide as its widest cell, so
// the rows line up although each is its own item.

import { cellWidth } from './layout.ts';

export type BlockRow =
  | { kind: 'text'; text: string }
  | { kind: 'blank' }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'bullet'; text: string; marker: string; indent: number }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'fence'; lang: string; open: boolean }
  | { kind: 'code'; text: string }
  | { kind: 'table'; text: string; head: boolean }
  | { kind: 'table-rule'; text: string };

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*\|?\s*$/;

const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function classifyReply(lines: readonly string[]): BlockRow[] {
  const out: BlockRow[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (f && f[1] === fence && line.trim() === fence) {
        out.push({ kind: 'fence', lang: '', open: false });
        fence = null;
      } else {
        out.push({ kind: 'code', text: line });
      }
      continue;
    }
    if (f) {
      fence = f[1]!;
      out.push({ kind: 'fence', lang: f[2] ?? '', open: true });
      continue;
    }
    if (TABLE_ROW.test(line)) {
      // The whole table at once, so its columns line up.
      let j = i;
      while (j < lines.length && TABLE_ROW.test(lines[j]!)) j++;
      out.push(...layoutTable(lines.slice(i, j)));
      i = j - 1;
      continue;
    }
    if (line.trim().length === 0) {
      out.push({ kind: 'blank' });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ kind: 'heading', text: h[2]!, level: h[1]!.length });
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: 'rule' });
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      out.push({ kind: 'bullet', text: b[3]!, marker: '•', indent: b[1]!.length });
      continue;
    }
    const o = ORDERED.exec(line);
    if (o) {
      out.push({ kind: 'bullet', text: o[3]!, marker: o[2]!, indent: o[1]!.length });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      out.push({ kind: 'quote', text: q[1]! });
      continue;
    }
    out.push({ kind: 'text', text: line });
  }
  return out;
}

function layoutTable(lines: string[]): BlockRow[] {
  const rows = lines.map((l) => ({ sep: TABLE_SEP.test(l), cells: cells(l) }));
  const data = rows.filter((r) => !r.sep);
  const cols = Math.max(...data.map((r) => r.cells.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(1, ...data.map((r) => cellWidth(r.cells[c] ?? ''))));
  const hasHead = rows.length > 1 && rows[1]!.sep;
  return rows.map((r, idx): BlockRow => {
    if (r.sep) return { kind: 'table-rule', text: widths.map((w) => '─'.repeat(w)).join('─┼─') };
    const text = widths.map((w, c) => {
      const cell = r.cells[c] ?? '';
      return cell + ' '.repeat(Math.max(0, w - cellWidth(cell)));
    }).join(' │ ');
    return { kind: 'table', text, head: hasHead && idx === 0 };
  });
}

/** The text a row shows, for wrapping and measuring; '' for rows without. */
export function rowText(row: BlockRow): string {
  return 'text' in row ? row.text : '';
}

/** Cells a row's text starts after (marker, gutter), so wrapped pieces line up. */
export function rowPrefixWidth(row: BlockRow): number {
  switch (row.kind) {
    case 'bullet':
      return row.indent + cellWidth(row.marker) + 1;
    case 'quote':
    case 'code':
      return 2;
    default:
      return 0;
  }
}
