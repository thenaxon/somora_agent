// Shared helpers for file_search hit shaping — used by both the local
// and the remote (ssh-exec'd) ripgrep paths.
//
// Why: `rg --json` reports the ENTIRE matched line. Lines in JSONL
// session logs run to 30k+ chars, so a handful of hits blew past the
// tool-result budget (7 hits → 212k chars). `limit` caps the number of
// hits, not their size. Two guards here:
//   1. windowMatchLine — a bounded window around the first submatch,
//      with `…` at the cut edges and `col` pointing at the match.
//   2. applyTextBudget — an overall character budget across all hits.

/** Chars kept on each side of the first submatch. The match text itself
 *  is kept up to the same length, so a window is at most 3× this. */
export const SEARCH_WINDOW_CHARS = 200;

/** Total `text` chars across all hits of one file_search result. */
export const SEARCH_TEXT_BUDGET_CHARS = 100_000;

const ELLIPSIS = '…';

/** Subset of ripgrep's JSON `match` submatch entry. `start`/`end` are
 *  BYTE offsets into `lines.text`. */
export interface RgSubmatch {
  start?: number;
  end?: number;
  match?: { text?: string };
}

export interface WindowedLine {
  /** Windowed text (or the full line when it fits). */
  text: string;
  /** 1-based column of the match start in the original line. */
  col: number;
  /** True when text was cut on at least one side. */
  truncated: boolean;
}

/**
 * Translate a UTF-8 byte offset into a JS string (UTF-16 code unit)
 * offset. Fast path for ASCII-only text where both agree. Offsets that
 * fall inside a multibyte sequence are rounded to the code point that
 * contains them; out-of-range offsets clamp to the text length.
 */
export function byteOffsetToCharOffset(text: string, byteOffset: number): number {
  if (!Number.isFinite(byteOffset) || byteOffset <= 0) return 0;
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (byteOffset >= totalBytes) return text.length;
  if (totalBytes === text.length) return byteOffset; // pure ASCII
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) as number;
    const cpBytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + cpBytes > byteOffset) return i;
    bytes += cpBytes;
    i += cp > 0xffff ? 2 : 1;
  }
  return text.length;
}

/**
 * Cut a window of `windowChars` on each side of the first submatch.
 * Lines that fit come back unchanged (`truncated: false`). Without
 * submatches the window starts at column 1.
 */
export function windowMatchLine(
  lineText: string,
  submatches?: RgSubmatch[] | null,
  windowChars: number = SEARCH_WINDOW_CHARS,
): WindowedLine {
  const line = lineText.replace(/\r?\n$/, '');
  const w = Math.max(1, Math.floor(windowChars));

  let matchStart = 0;
  let matchEnd = 0;
  const first = submatches?.[0];
  if (first && typeof first.start === 'number') {
    matchStart = byteOffsetToCharOffset(line, first.start);
    const rawEnd = typeof first.end === 'number' ? first.end : first.start;
    matchEnd = Math.max(matchStart, byteOffsetToCharOffset(line, rawEnd));
  }
  const col = matchStart + 1;

  if (line.length <= w) return { text: line, col, truncated: false };

  const start = Math.max(0, matchStart - w);
  // Keep the match itself, but bounded — a greedy pattern can match
  // the whole 30k line and we would be back where we started.
  const keptMatch = Math.min(matchEnd - matchStart, w);
  const end = Math.min(line.length, matchStart + keptMatch + w);

  if (start === 0 && end === line.length) return { text: line, col, truncated: false };

  const text = (start > 0 ? ELLIPSIS : '') + line.slice(start, end) + (end < line.length ? ELLIPSIS : '');
  return { text, col, truncated: true };
}

/**
 * Enforce an overall `text` budget across hits. Returns the prefix of
 * `hits` that fits and whether anything was dropped. A single hit is
 * always admitted when it is the first one, so a result is never empty
 * purely because of the budget.
 */
export function applyTextBudget<T extends { text: string }>(
  hits: T[],
  budgetChars: number = SEARCH_TEXT_BUDGET_CHARS,
): { hits: T[]; truncated: boolean } {
  let used = 0;
  for (let i = 0; i < hits.length; i++) {
    const len = hits[i]?.text.length ?? 0;
    if (i > 0 && used + len > budgetChars) {
      return { hits: hits.slice(0, i), truncated: true };
    }
    used += len;
  }
  return { hits, truncated: false };
}
