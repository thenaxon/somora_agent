// Speech-sanitizer: turn assistant-written Markdown into something
// that reads naturally when spoken aloud.
//
// Strategies (in order):
//   1. Skip the whole text when it's structurally non-speakable
//      (heavy code, lots of tables) — return {skipped:true, reason}.
//   2. Strip Markdown noise that adds nothing in speech (emphasis
//      markers, inline-code backticks, simple bullets, heading hashes).
//   3. Replace structural blocks that have a brief spoken form:
//      code fences → "[Codeblock]", URLs → "[Link]", tables →
//      "[table omitted]".
//   4. Hard-cap at MAX_CHARS so a runaway essay doesn't lock the
//      TTS upstream for minutes.
//
// Never throws. Always returns a SanitizeResult — caller checks
// `skipped` to decide whether to enqueue TTS at all.

const MAX_CHARS = 2000;
const MAX_CODE_FENCE_FRACTION = 0.4; // ≥40 % code by char count ⇒ skip
const MAX_TABLE_ROWS = 6;            // tables with > N rows ⇒ skip
const MIN_REMAINING_CHARS = 8;       // after stripping, must still say something

export interface SanitizeResult {
  text: string;
  /** True ⇒ caller should NOT enqueue TTS for this turn. */
  skipped: boolean;
  /** Set when skipped — human-readable reason for logs/diagnostics. */
  reason?: string;
  /** Char count after sanitization (for logging). */
  charsOut: number;
}

const URL_RE = /https?:\/\/\S+/gi;
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const EMPHASIS_RE = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
const HEADING_RE = /^#{1,6}\s+/gm;
const BULLET_RE = /^[\s]*[-*+]\s+/gm;
const NUM_LIST_RE = /^[\s]*\d+\.\s+/gm;
// One full table row counts as "starts with `|` AND contains another `|`".
const TABLE_ROW_RE = /^\s*\|.*\|.*$/gm;
// Multi-blank-lines → single newline for spoken flow.
const MULTI_BLANK_RE = /\n{3,}/g;

export function prepareForTts(input: string): SanitizeResult {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { text: '', skipped: true, reason: 'empty input', charsOut: 0 };
  }

  // ── 1. Structural pre-check (skip-or-go) ──
  const codeFenceLen = (input.match(CODE_FENCE_RE) ?? []).reduce((acc, m) => acc + m.length, 0);
  if (codeFenceLen / input.length >= MAX_CODE_FENCE_FRACTION) {
    return {
      text: '',
      skipped: true,
      reason: `>=${Math.round(MAX_CODE_FENCE_FRACTION * 100)}% of text is fenced code`,
      charsOut: 0,
    };
  }
  const tableRows = (input.match(TABLE_ROW_RE) ?? []).length;
  if (tableRows > MAX_TABLE_ROWS) {
    return {
      text: '',
      skipped: true,
      reason: `table with ${tableRows} rows is not readable aloud`,
      charsOut: 0,
    };
  }

  // ── 2. Replace structural blocks with spoken markers ──
  let out = input
    .replace(CODE_FENCE_RE, ' [Codeblock] ')
    .replace(URL_RE, '[Link]')
    .replace(INLINE_CODE_RE, '$1');

  // Tables: collapse the whole markdown table region. Simple
  // heuristic — consecutive lines starting with `|` get replaced
  // with one "[Tabelle]" line.
  out = out.replace(/(?:^\s*\|.*\|.*$\n?)+/gm, ' [table omitted] ');

  // ── 3. Strip emphasis + headings + list markers ──
  out = out
    .replace(EMPHASIS_RE, (_full, a, b, c, d) => a ?? b ?? c ?? d ?? '')
    .replace(HEADING_RE, '')
    .replace(BULLET_RE, '')
    .replace(NUM_LIST_RE, '');

  // ── 4. Normalize whitespace ──
  out = out.replace(MULTI_BLANK_RE, '\n\n').trim();

  if (out.length < MIN_REMAINING_CHARS) {
    return {
      text: '',
      skipped: true,
      reason: 'too little content after sanitization',
      charsOut: out.length,
    };
  }

  // ── 5. Hard cap ──
  if (out.length > MAX_CHARS) {
    // Cut on a sentence boundary if possible, else hard.
    const cut = out.slice(0, MAX_CHARS);
    const lastBoundary = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? '),
      cut.lastIndexOf('\n'),
    );
    out = lastBoundary > MAX_CHARS - 200 ? cut.slice(0, lastBoundary + 1) : cut;
  }

  return { text: out, skipped: false, charsOut: out.length };
}
