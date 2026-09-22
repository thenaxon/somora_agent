// Tolerant find-and-replace for file_patch — the part that decides WHERE
// `old_string` is in the file.
//
// Why: the model's `old_string` is a reconstruction of what it read, and
// weak models reconstruct badly — indentation off by a level, a tab for
// four spaces, `\n` written as two characters, a line-number prefix
// copied from a numbered read. Byte-exact matching turned every one of
// those into "not found" and a retry with the same mistake. Coding
// harnesses (opencode's edit tool, itself after cline's diff-apply and
// gemini-cli's editCorrector) solve this with a chain of increasingly
// tolerant matchers plus a brake against a tolerant matcher grabbing a
// block that is much larger than what the model asked for. This is that
// chain.
//
// Contract:
//   - exact wins whenever it matches; nothing tolerant runs before it.
//   - a tolerant strategy is used only when it yields exactly one match
//     (or `replaceAll` is set); several candidates → try the next
//     strategy, and if none is unique the error says "multiple matches".
//   - a tolerant match that spans far more than `old_string` is refused
//     (isDisproportionate) — the caller is told to re-read and retry.
//   - `allowFuzzy: false` turns the chain off (exact only); used for
//     somora's own home, where a wrong-place edit costs the most.
//   - CRLF files are matched on LF and written back as CRLF.

export type Strategy =
  | 'exact'
  | 'line_trimmed'
  | 'block_anchor'
  | 'whitespace_normalized'
  | 'indentation_flexible'
  | 'escape_normalized'
  | 'trimmed_boundary'
  | 'context_aware';

export interface Span {
  /** Char offsets into the (LF-normalized) content. */
  start: number;
  end: number;
}

export interface ReplaceOutcome {
  updated: string;
  count: number;
  strategy: Strategy;
  /** True when `old_string` carried `N: ` line-number prefixes that
   *  were stripped before matching. */
  lineNumbersStripped: boolean;
  /** 1-based line range of the first replaced span in the ORIGINAL. */
  firstSpanLines: { from: number; to: number };
}

export class ReplaceError extends Error {
  constructor(
    message: string,
    public readonly kind: 'not_found' | 'multiple' | 'disproportionate' | 'no_change' | 'empty',
  ) {
    super(message);
  }
}

export interface ReplaceOptions {
  replaceAll?: boolean;
  /** Default true. */
  allowFuzzy?: boolean;
}

// Similarity threshold for the middle lines of a block-anchor match.
const BLOCK_SIMILARITY_THRESHOLD = 0.65;

export function replaceInContent(
  content: string,
  oldString: string,
  newString: string,
  opts: ReplaceOptions = {},
): ReplaceOutcome {
  if (oldString.length === 0) {
    throw new ReplaceError('old_string is empty — give the exact text to replace', 'empty');
  }
  if (oldString === newString) {
    throw new ReplaceError('no change: old_string and new_string are identical', 'no_change');
  }
  const replaceAll = Boolean(opts.replaceAll);
  const allowFuzzy = opts.allowFuzzy !== false;

  const crlf = content.includes('\r\n');
  const text = crlf ? content.replace(/\r\n/g, '\n') : content;
  const findRaw = oldString.replace(/\r\n/g, '\n');
  const repl = newString.replace(/\r\n/g, '\n');

  let attempt = tryChain(text, findRaw, replaceAll, allowFuzzy);
  let stripped = false;
  if (!attempt.spans && hasLineNumberPrefixes(findRaw)) {
    const findStripped = stripLineNumberPrefixes(findRaw);
    const second = tryChain(text, findStripped, replaceAll, allowFuzzy);
    if (second.spans) {
      attempt = second;
      stripped = true;
    }
  }

  if (!attempt.spans) {
    if (attempt.sawMultiple) {
      throw new ReplaceError(
        'old_string matches more than one place in the file. Include more surrounding lines so ' +
          'the match is unique, or pass replace_all=true to change every occurrence.',
        'multiple',
      );
    }
    throw new ReplaceError(
      'old_string was not found in the file — it must match the file text, including ' +
        'indentation and line breaks. Read the file again and copy the exact lines' +
        (hasLineNumberPrefixes(findRaw) ? ' without the line-number prefix' : '') +
        '.',
      'not_found',
    );
  }

  const spans = attempt.spans;
  const strategy = attempt.strategy;
  if (strategy !== 'exact') {
    for (const s of spans) {
      if (isDisproportionate(text, s, stripped ? stripLineNumberPrefixes(findRaw) : findRaw)) {
        throw new ReplaceError(
          'refusing the replacement: the closest match spans much more text than old_string. ' +
            'Read the file again and pass the full exact old_string for the lines you mean.',
          'disproportionate',
        );
      }
    }
  }

  // Apply back to front so earlier offsets stay valid.
  let updated = text;
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  for (const s of ordered) {
    updated = updated.slice(0, s.start) + repl + updated.slice(s.end);
  }
  const first = spans.reduce((a, b) => (a.start <= b.start ? a : b));
  const firstSpanLines = {
    from: lineOf(text, first.start),
    to: lineOf(text, Math.max(first.start, first.end - 1)),
  };
  return {
    updated: crlf ? updated.replace(/\n/g, '\r\n') : updated,
    count: spans.length,
    strategy,
    lineNumbersStripped: stripped,
    firstSpanLines,
  };
}

interface ChainResult {
  spans: Span[] | null;
  strategy: Strategy;
  sawMultiple: boolean;
}

function tryChain(text: string, find: string, replaceAll: boolean, allowFuzzy: boolean): ChainResult {
  const chain: Array<[Strategy, (t: string, f: string) => Span[]]> = [['exact', exactSpans]];
  if (allowFuzzy) {
    chain.push(
      ['line_trimmed', lineTrimmedSpans],
      ['block_anchor', blockAnchorSpans],
      ['whitespace_normalized', whitespaceNormalizedSpans],
      ['indentation_flexible', indentationFlexibleSpans],
      ['escape_normalized', escapeNormalizedSpans],
      ['trimmed_boundary', trimmedBoundarySpans],
      ['context_aware', contextAwareSpans],
    );
  }
  let sawMultiple = false;
  for (const [strategy, fn] of chain) {
    const spans = dedupeSpans(fn(text, find));
    if (spans.length === 0) continue;
    if (replaceAll || spans.length === 1) return { spans, strategy, sawMultiple };
    sawMultiple = true;
  }
  return { spans: null, strategy: 'exact', sawMultiple };
}

function dedupeSpans(spans: Span[]): Span[] {
  const seen = new Set<string>();
  const out: Span[] = [];
  for (const s of spans) {
    const k = `${s.start}:${s.end}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  // Overlapping spans would double-apply; keep the first of any overlap.
  out.sort((a, b) => a.start - b.start);
  const nonOverlapping: Span[] = [];
  let lastEnd = -1;
  for (const s of out) {
    if (s.start < lastEnd) continue;
    nonOverlapping.push(s);
    lastEnd = s.end;
  }
  return nonOverlapping;
}

// ── strategies ─────────────────────────────────────────────────────

function exactSpans(text: string, find: string): Span[] {
  const out: Span[] = [];
  let idx = text.indexOf(find);
  while (idx !== -1) {
    out.push({ start: idx, end: idx + find.length });
    idx = text.indexOf(find, idx + find.length);
  }
  return out;
}

interface Line {
  text: string;
  start: number; // offset of first char
  end: number; // offset after last char (before '\n')
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  for (const raw of text.split('\n')) {
    out.push({ text: raw, start: pos, end: pos + raw.length });
    pos += raw.length + 1;
  }
  return out;
}

/** Spans for every block of consecutive lines where `cmp(line, findLine)`
 *  holds for all lines of `find`. */
function lineBlockSpans(text: string, find: string, cmp: (a: string, b: string) => boolean): Span[] {
  const lines = splitLines(text);
  const findLines = find.split('\n');
  // A trailing newline in `find` means "the block ends at a line end";
  // it does not add a line to match.
  if (findLines.length > 1 && findLines[findLines.length - 1] === '') findLines.pop();
  if (findLines.length === 0) return [];
  const out: Span[] = [];
  for (let i = 0; i + findLines.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < findLines.length; k++) {
      if (!cmp(lines[i + k]!.text, findLines[k]!)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out.push({ start: lines[i]!.start, end: lines[i + findLines.length - 1]!.end });
    }
  }
  return out;
}

function lineTrimmedSpans(text: string, find: string): Span[] {
  return lineBlockSpans(text, find, (a, b) => a.trim() === b.trim());
}

const normWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

function whitespaceNormalizedSpans(text: string, find: string): Span[] {
  const findLines = find.split('\n');
  if (findLines.length === 1 || (findLines.length === 2 && findLines[1] === '')) {
    // Single line: allow the find to be a substring of a line, with any
    // run of whitespace standing for any other run.
    const single = findLines[0]!.trim();
    if (!single) return [];
    const re = new RegExp(
      single
        .split(/\s+/)
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+'),
      'g',
    );
    const out: Span[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
    return out;
  }
  return lineBlockSpans(text, find, (a, b) => normWs(a) === normWs(b));
}

function commonIndent(lines: string[]): number {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const m = /^[ \t]*/.exec(l);
    min = Math.min(min, m ? m[0].length : 0);
  }
  return Number.isFinite(min) ? min : 0;
}

function indentationFlexibleSpans(text: string, find: string): Span[] {
  const findLines = find.split('\n');
  if (findLines.length > 1 && findLines[findLines.length - 1] === '') findLines.pop();
  const fIndent = commonIndent(findLines);
  const stripped = findLines.map((l) => (l.trim() === '' ? '' : l.slice(fIndent)));
  const lines = splitLines(text);
  const out: Span[] = [];
  for (let i = 0; i + stripped.length <= lines.length; i++) {
    const block = lines.slice(i, i + stripped.length).map((l) => l.text);
    const bIndent = commonIndent(block);
    let ok = true;
    for (let k = 0; k < stripped.length; k++) {
      const b = block[k]!;
      const bs = b.trim() === '' ? '' : b.slice(bIndent);
      if (bs !== stripped[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ start: lines[i]!.start, end: lines[i + stripped.length - 1]!.end });
  }
  return out;
}

function unescape(s: string): string {
  return s.replace(/\\(n|t|r|'|"|`|\\|\$)/g, (_, c: string) => {
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      default:
        return c;
    }
  });
}

function escapeNormalizedSpans(text: string, find: string): Span[] {
  const un = unescape(find);
  if (un === find) return [];
  const direct = exactSpans(text, un);
  if (direct.length > 0) return direct;
  return lineBlockSpans(text, un, (a, b) => a.trim() === b.trim() || unescape(a).trim() === b.trim());
}

function trimmedBoundarySpans(text: string, find: string): Span[] {
  const t = find.trim();
  if (t === find || t.length === 0) return [];
  return exactSpans(text, t);
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** First and last line as anchors; the block may differ in length by up
 *  to a quarter; middle lines are compared by Levenshtein similarity. With
 *  several candidates the most similar one wins (if above threshold). */
function blockAnchorSpans(text: string, find: string): Span[] {
  const findLines = find.split('\n');
  if (findLines.length > 1 && findLines[findLines.length - 1] === '') findLines.pop();
  if (findLines.length < 3) return [];
  const first = findLines[0]!.trim();
  const last = findLines[findLines.length - 1]!.trim();
  if (!first || !last) return [];
  const lines = splitLines(text);
  const size = findLines.length;
  const tolerance = Math.max(1, Math.floor(size * 0.25));
  const candidates: Array<{ span: Span; score: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.text.trim() !== first) continue;
    for (let j = i + size - 1 - tolerance; j <= i + size - 1 + tolerance; j++) {
      if (j <= i || j >= lines.length) continue;
      if (lines[j]!.text.trim() !== last) continue;
      const midFind = findLines.slice(1, -1).map((l) => l.trim());
      const midText = lines.slice(i + 1, j).map((l) => l.text.trim());
      let score: number;
      if (midFind.length === 0 && midText.length === 0) score = 1;
      else {
        const n = Math.max(midFind.length, midText.length);
        let sum = 0;
        for (let k = 0; k < n; k++) sum += similarity(midFind[k] ?? '', midText[k] ?? '');
        score = sum / n;
      }
      candidates.push({ span: { start: lines[i]!.start, end: lines[j]!.end }, score });
    }
  }
  const good = candidates.filter((c) => c.score >= BLOCK_SIMILARITY_THRESHOLD);
  if (good.length === 0) return [];
  if (good.length === 1) return [good[0]!.span];
  // Several: the best one, only if it is clearly ahead of the runner-up.
  good.sort((a, b) => b.score - a.score);
  if (good[0]!.score > good[1]!.score) return [good[0]!.span];
  return good.map((c) => c.span);
}

/** Anchors at both ends, same block length, at least half of the
 *  non-empty middle lines identical (trimmed). */
function contextAwareSpans(text: string, find: string): Span[] {
  const findLines = find.split('\n');
  if (findLines.length > 1 && findLines[findLines.length - 1] === '') findLines.pop();
  if (findLines.length < 3) return [];
  const first = findLines[0]!.trim();
  const last = findLines[findLines.length - 1]!.trim();
  if (!first || !last) return [];
  const lines = splitLines(text);
  const size = findLines.length;
  const out: Span[] = [];
  for (let i = 0; i + size <= lines.length; i++) {
    if (lines[i]!.text.trim() !== first) continue;
    if (lines[i + size - 1]!.text.trim() !== last) continue;
    let total = 0;
    let same = 0;
    for (let k = 1; k < size - 1; k++) {
      const f = findLines[k]!.trim();
      if (!f) continue;
      total++;
      if (lines[i + k]!.text.trim() === f) same++;
    }
    if (total === 0 || same / total >= 0.5) {
      out.push({ start: lines[i]!.start, end: lines[i + size - 1]!.end });
    }
  }
  return out;
}

// ── guards + helpers ───────────────────────────────────────────────

function isDisproportionate(text: string, span: Span, find: string): boolean {
  const findLines = find.split('\n').length;
  const spanText = text.slice(span.start, span.end);
  const spanLines = spanText.split('\n').length;
  if (spanLines >= Math.max(findLines + 3, findLines * 2)) return true;
  if (findLines > 1 && spanText.length > Math.max(find.length + 500, find.length * 4)) return true;
  return false;
}

const LINE_NUMBER_PREFIX = /^\s*\d+(?::|\t| \|)\s?/;

/** True when every non-empty line starts like `12: ` (a numbered read
 *  copied verbatim). */
export function hasLineNumberPrefixes(s: string): boolean {
  const lines = s.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return false;
  return lines.every((l) => LINE_NUMBER_PREFIX.test(l));
}

export function stripLineNumberPrefixes(s: string): string {
  return s
    .split('\n')
    .map((l) => (l.trim() === '' ? l : l.replace(LINE_NUMBER_PREFIX, '')))
    .join('\n');
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * A compact `-`/`+` view of what changed between two texts, with line
 * numbers of the original. Shows only the changed region (common head
 * and tail trimmed), capped per side.
 */
export function diffSnippet(before: string, after: string, maxLinesPerSide = 30): string {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const out: string[] = [];
  const cap = (arr: string[], sign: '-' | '+', startLine: number): void => {
    const shown = arr.slice(0, maxLinesPerSide);
    shown.forEach((l, i) => out.push(`${sign}${startLine + i}: ${l}`));
    if (arr.length > shown.length) out.push(`${sign}… (${arr.length - shown.length} more lines)`);
  };
  cap(removed, '-', head + 1);
  cap(added, '+', head + 1);
  return out.join('\n');
}
