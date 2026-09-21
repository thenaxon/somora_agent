// Dream workers are asked for bare JSON and mostly comply — but a model
// that adds a sentence after the closing bracket, or leaks a reasoning
// tail before the opening one, has still answered. This finds that
// answer by structure, so the callers can tell "readable, plus noise"
// from "cut off / broken", which must count as a failed call.

/** The first complete top-level JSON value in `text` that opens with
 *  `open` (`[` or `{`), or null. Walks brackets with string/escape
 *  awareness: `[] followed by prose` yields the array, a cut-off value
 *  yields null — truncation is detected by structure, never by
 *  finish_reason (routers rewrite it). */
export function firstCompleteJson(text: string, open: '[' | '{'): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
