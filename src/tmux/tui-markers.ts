// TUI-state detection for known coding-CLI panes.
//
// Why this exists
//   tmux's raw `wait_idle` only knows "is the pane content changing or
//   not". That works for shell jobs but breaks for coding TUIs that
//   have a queued-input concept (Claude Code, codex): a pane sitting
//   on "Press up to edit queued messages" with a stopped spinner is
//   *content-stable but not ready*. The orchestrating agent then
//   thinks the prompt was processed when it's actually still waiting,
//   sometimes presses Enter again, sometimes proceeds with the next
//   step too early. The 2026-05-17 tmux-queued-input feedback report
//   describes both failure modes.
//
// What this module is
//   A pure-function lookup: given the pane content + the session's
//   declared `kind`, return a structured `{ state, markers }` blob
//   the tool layer can ship back to the agent as `tui_state`. The
//   higher-level `wait_idle` also uses this to decide "should I treat
//   this stable pane as actually idle or not".
//
// What this module is NOT
//   Not a generic terminal parser. Not auto-detection (the agent must
//   declare `kind` at create-time). Not a deep AST of the TUI's UI —
//   just plain-text marker matching against known lines. Cheap,
//   maintainable, easy to extend.
//
// Adding a new TUI
//   Add a new entry to TUI_MARKERS keyed by the kind string. Each
//   entry has `queued` and `running` arrays of substrings; the
//   detection returns the first state whose marker hits. Order
//   matters: queued > running > ready (more specific first).

import type { TmuxSessionKind } from './origin-store.ts';

export type TuiState = 'ready' | 'queued' | 'running' | 'idle_unknown';

interface MarkerSet {
  /** Substrings that mean "agent typed something but the TUI hasn't
   *  submitted it yet — pane is stable only because it's waiting on
   *  the user/agent to confirm/edit". */
  queued: string[];
  /** Substrings that mean "the TUI is actively processing — content
   *  may briefly stop changing during a long step but it's NOT done". */
  running: string[];
}

// Marker tables. Substring match against the pane capture (escape-
// stripped). Keep these conservative — a false positive on `queued`
// would block legitimate idle-completion in wait_idle TUI-mode.
const TUI_MARKERS: Partial<Record<TmuxSessionKind, MarkerSet>> = {
  'claude-code': {
    queued: [
      // The single most reliable Claude Code queued-input marker; lives
      // in the input-area footer when there's pending text.
      'Press up to edit queued messages',
    ],
    running: [
      // Claude Code's interrupt prompt while a tool/turn runs.
      'esc to interrupt',
      // Spinner-words. Claude Code rotates through these during agent
      // work — sampled list, extendable as we encounter more. Each
      // ends in a Unicode ellipsis "…" to reduce false positives on
      // build logs ("Compiling..." uses three dots, not ellipsis).
      'Tempering…',
      'Whisking…',
      'Contemplating…',
      'Pondering…',
      'Brewing…',
      'Simmering…',
      'Sautéing…',
    ],
  },
  codex: {
    queued: [
      // codex 0.130 buffers pasted-while-running input similarly. The
      // exact label is TBD — recorded as feedback (project_codex_*).
      // Conservative empty list for now: codex queue behavior surfaces
      // less often than Claude Code's in observed traffic, so we
      // start with running-only detection and extend when a concrete
      // reproduction lands.
    ],
    running: [
      // codex shows an esc-to-interrupt cue while the run is active.
      'esc to interrupt',
    ],
  },
  opencode: {
    // Live-verified 2026-08-25 against OpenCode 1.18.23 (sst/opencode)
    // driving a local model: a message submitted while a turn runs
    // stays in the input box with a `QUEUED` label under it and is
    // auto-submitted when the turn ends — the pane keeps working, so
    // it must not read as ready.
    queued: ['QUEUED'],
    running: [
      // Footer while a turn runs: `⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt` (spinner
      // dots + cue). Ready footer is `tab agents  ctrl+p commands`
      // without the cue; a `△ Permission required` dialog (Allow once /
      // Allow always / Reject) also drops the cue, so it reads as ready
      // — correct, it is waiting for a human/agent decision.
      'esc interrupt',
    ],
  },
  // 'shell' intentionally has no entry — falls through to the
  // "no detection" path below, so the response shape matches today's
  // behavior for any session that didn't declare a kind.
};

export interface TuiDetectResult {
  state: TuiState;
  markers: string[];
}

/**
 * Scan pane content for known TUI-state markers. Pure function — no
 * side effects, safe to call from any context.
 *
 * Returns `null` when `kind` is shell or unknown — caller should treat
 * that as "no TUI awareness, fall through to raw content-stability".
 *
 * Detection order: queued > running > ready. A pane showing both
 * "Press up to edit queued messages" AND "esc to interrupt" gets
 * reported as queued — the queued state is the more actionable signal
 * for the agent (don't proceed, the input isn't submitted yet).
 */
export function detectTuiState(
  content: string,
  kind: TmuxSessionKind | undefined,
): TuiDetectResult | null {
  if (!kind || kind === 'shell') return null;
  const markerSet = TUI_MARKERS[kind];
  if (!markerSet) return null;

  const hitsQueued = markerSet.queued.filter((m) => content.includes(m));
  if (hitsQueued.length > 0) {
    return { state: 'queued', markers: hitsQueued };
  }
  const hitsRunning = markerSet.running.filter((m) => content.includes(m));
  if (hitsRunning.length > 0) {
    return { state: 'running', markers: hitsRunning };
  }
  return { state: 'ready', markers: [] };
}

// ─────────────────────────────────────────────────────────────────────
// Auto-suggestion (ghost text) detection
//
// Coding TUIs render a predicted next input as dim/faint text on the
// input line — a hint for the human, NOT real typed input. In a
// stripped capture that ghost text is indistinguishable from real
// input, and agents driving the TUI kept "correcting" it (2026-07-14
// tui-autosuggestion feedback). Detection: capture WITH ANSI, find the
// input line by its per-kind prompt prefix, and report any dim-styled
// (SGR 2) span on it as suggestion text.
// ─────────────────────────────────────────────────────────────────────

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
