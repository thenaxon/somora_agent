// Ghost text in a coding agent's input line: Claude Code and Codex draw
// a dim suggested next input for a person. It is not typed input, and an
// orchestrating agent must neither submit nor delete it. Read from the
// ANSI-styled pane (capture-pane -e): dim text on the input line.
//
// The agent's state (working, idle, blocked) is detection/'s, with
// herdr's rules; this module only answers "is that text a suggestion?".

import type { TmuxSessionKind } from './origin-store.ts';

/** Input-line prompt prefix per kind, matched against the escape-
 *  stripped line. Conservative: only lines that ARE the input line are
 *  scanned for dim spans — footers/hints elsewhere are dim too and
 *  must not read as suggestions. */
// Live-verified 2026-07-20: current Claude Code renders `❯` followed by
// a NO-BREAK SPACE (U+00A0) as its prompt; older builds used `> `. JS
// `\s` matches U+00A0, so a plain \s after the char class covers both.
const INPUT_LINE_PREFIX: Partial<Record<TmuxSessionKind, RegExp>> = {
  'claude-code': /^\s*[>❯]\s/,
  codex: /^\s*[›>❯]\s/,
  // opencode: intentionally absent. Its input is a multi-line box whose
  // every line starts with `┃` (padding, the text, the model status
  // line), so a prefix can't single out the text line — and the TUI
  // shows no ghost-text suggestion to begin with (verified 2026-08-25).
  // detectSuggestion() therefore returns null for it, like shell.
};

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
// Non-SGR escapes that show up in `capture-pane -e` output (cursor
// moves, charset switches) — stripped before prefix matching.
const ANSI_OTHER_RE = /\x1b(?:\][^\x07]*\x07|[()][0-9A-B]|\[[0-9;?]*[A-Za-z])/g;

function stripAnsi(line: string): string {
  return line.replace(ANSI_SGR_RE, '').replace(ANSI_OTHER_RE, '');
}

/** Collect the visible text that is rendered dim (SGR 2) in a single
 *  ANSI-styled line. Tracks dim state across SGR sequences: `2` sets
 *  it, `22` clears it, `0` / empty resets everything. */
function extractDimText(ansiLine: string): string {
  let dim = false;
  let out = '';
  let i = 0;
  while (i < ansiLine.length) {
    const ch = ansiLine[i]!;
    if (ch === '\x1b') {
      const m = /^\x1b\[([0-9;]*)m/.exec(ansiLine.slice(i));
      if (m) {
        const params = m[1] === '' ? ['0'] : m[1]!.split(';');
        // Walk the parameter list with the extended-colour forms in
        // mind: `38;2;R;G;B` / `48;2;R;G;B` (truecolor) and `38;5;n` /
        // `48;5;n` (256-colour) carry a literal `2` / `5` that is a
        // colour-space selector, NOT SGR 2 (dim). Treating it as dim
        // flagged every truecolor-rendered line as ghost text — which
        // is every line of OpenCode's TUI (2026-08-25).
        for (let k = 0; k < params.length; k++) {
          const p = params[k]!;
          if (p === '38' || p === '48' || p === '58') {
            const mode = params[k + 1];
            if (mode === '2') k += 4;
            else if (mode === '5') k += 2;
            continue;
          }
          if (p === '0' || p === '' || p === '22') dim = false;
          else if (p === '2') dim = true;
        }
        i += m[0].length;
        continue;
      }
      // Non-SGR escape — skip the escape char, let the regex-stripped
      // remainder fall through (cheap; capture lines are short).
      i += 1;
      continue;
    }
    if (dim) out += ch;
    i += 1;
  }
  return out.trim();
}

export interface SuggestionDetectResult {
  suggestion_visible: boolean;
  suggestion_text?: string;
}

/**
 * Scan an ANSI capture (`capture-pane -e`) for ghost-text suggestions
 * on the TUI's input line. Pure function.
 *
 * Returns null for shell/unknown kinds (no input-line concept), else
 * `{ suggestion_visible, suggestion_text? }`. A dim span shorter than
 * 2 visible chars is ignored (cursor artifacts).
 */
export function detectSuggestion(
  ansiContent: string,
  kind: TmuxSessionKind | undefined,
): SuggestionDetectResult | null {
  if (!kind || kind === 'shell') return null;
  const prefix = INPUT_LINE_PREFIX[kind];
  if (!prefix) return null;
  // Scan bottom-up: the input line lives at the bottom of the pane, and
  // scrollback may contain old `>`-prefixed lines from previous turns.
  const lines = ansiContent.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]!;
    const plain = stripAnsi(raw);
    if (!prefix.test(plain)) continue;
    const dimText = extractDimText(raw);
    if (dimText.length >= 2) {
      return { suggestion_visible: true, suggestion_text: dimText };
    }
    return { suggestion_visible: false };
  }
  return { suggestion_visible: false };
}
