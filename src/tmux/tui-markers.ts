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
