// How file_read presents text — shared by the local and the SSH path.
//
// Every line carries its 1-based number as `12: text`, the way coding
// harnesses show files: the model can cite `path:line`, page with a
// known offset, and see at the end whether it has read everything
// ("End of file") or where to continue. Without numbers a model reading
// a 3 000-line file had no way to know which part it held.
//
// `offset` stays what it was — the number of lines to SKIP (0-based) —
// so existing callers keep working; the numbers shown are absolute.
// Without `limit` a read returns at most DEFAULT_READ_LINES lines (a
// whole file was up to 200k chars in one result before). A single line
// longer than MAX_LINE_CHARS is cut with a marker; JSONL logs and
// minified bundles have lines of 30k+ chars.

export const DEFAULT_READ_LINES = 2000;
export const MAX_LINE_CHARS = 2000;
export const READ_HARD_CAP = 200_000; // chars, whole result

export interface FormattedRead {
  content: string;
  /** Total lines in the file. */
  lines: number;
  /** 1-based inclusive range of the lines in `content` (from=0,to=0 when empty). */
  range: { from: number; to: number };
  truncated: boolean;
  truncated_reason?: string;
  next_offset?: number;
  /** One line the model can act on: "End of file (342 lines)" or
   *  "Showing lines 1-2000 of 5000. Continue with offset=2000." */
  summary: string;
}

export function formatRead(all: string, offsetIn?: number, limitIn?: number): FormattedRead {
  const lines = all === '' ? [] : all.split('\n');
  // A file ending in '\n' splits into a trailing empty string that is
  // not a line the model should see numbered.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const offset = Math.max(0, offsetIn ?? 0);
  const limit = Math.max(1, limitIn ?? DEFAULT_READ_LINES);

  if (offset >= total && total > 0) {
    return {
      content: '',
      lines: total,
      range: { from: 0, to: 0 },
      truncated: false,
      summary: `offset ${offset} is past the end of the file (${total} lines). Use offset between 0 and ${total - 1}.`,
    };
  }

  const slice = lines.slice(offset, offset + limit);
  const numbered: string[] = [];
  let chars = 0;
  let byteCapped = false;
  for (let i = 0; i < slice.length; i++) {
    let text = slice[i]!;
    if (text.length > MAX_LINE_CHARS) {
      text = text.slice(0, MAX_LINE_CHARS) + ` … [line cut at ${MAX_LINE_CHARS} chars]`;
    }
    const row = `${offset + i + 1}: ${text}`;
    if (chars + row.length + 1 > READ_HARD_CAP) {
      byteCapped = true;
      break;
    }
    numbered.push(row);
    chars += row.length + 1;
  }

  const shown = numbered.length;
  const from = shown > 0 ? offset + 1 : 0;
  const to = shown > 0 ? offset + shown : 0;
  const more = offset + shown < total;
  const next = offset + shown;

  let summary: string;
  let truncatedReason: string | undefined;
  if (!more) {
    summary = total === 0 ? 'Empty file (0 lines).' : `End of file (${total} lines).`;
  } else if (byteCapped) {
    truncatedReason = `result cap (${READ_HARD_CAP} chars)`;
    summary = `Showing lines ${from}-${to} of ${total} (result cap reached). Continue with offset=${next}.`;
  } else {
    truncatedReason = `more lines available (offset=${next})`;
    summary = `Showing lines ${from}-${to} of ${total}. Continue with offset=${next}.`;
  }

  return {
    content: numbered.join('\n'),
    lines: total,
    range: { from, to },
    truncated: more,
    ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
    ...(more ? { next_offset: next } : {}),
    summary,
  };
}

/** Up to `max` names from `candidates` closest to `wanted` (by edit
 *  distance on the basename, prefix matches first). */
export function nearestNames(wanted: string, candidates: string[], max = 3): string[] {
  const w = wanted.toLowerCase();
  const scored = candidates
    .map((c) => {
      const l = c.toLowerCase();
      const prefix = l.startsWith(w) || w.startsWith(l) ? 0 : 1;
      return { c, score: prefix * 100 + editDistance(w, l) };
    })
    .filter((x) => x.score < 100 + Math.max(3, Math.floor(w.length / 2)))
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((x) => x.c);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}
