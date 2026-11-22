// Signals for a TUI you are not looking at (docs/display.md "When you
// look away"): the terminal title says what the session is doing, and
// the bell rings when it wants you. Both are understood by nearly every
// terminal; tmux turns the bell into an activity mark on the window, and
// a window manager can flash it. Hermes does the same
// (ui-tui/src/app/useMainApp.ts there).
//
// OSC 7501 (the Program Status Protocol Pi, Hermes and OpenClaw send) is
// left out on purpose: it needs a query whose reply would arrive among
// Ink's keystrokes, few terminals know it, and tmux does not pass it on.
// Inside herdr the TUI reports its state already (herdr.ts).

export type AttentionState = 'idle' | 'working' | 'question' | 'done';

/** A turn shorter than this ends without a bell: you were likely watching. */
export const BELL_AFTER_MS = 10_000;

export function titleFor(state: AttentionState, where: string): string {
  const mark = state === 'working' ? '⏳ ' : state === 'question' ? '⚠ ' : state === 'done' ? '✓ ' : '';
  return `${mark}${where} · somora`;
}

/** OSC 2 (window title) with the text's control characters removed. */
export function titleSequence(text: string): string {
  return `\x1b]2;${text.replace(/[\u0000-\u001f\u007f]/g, ' ')}\x07`;
}

// xterm's title stack: the title from before the TUI comes back on exit.
// Terminals without the stack ignore both sequences.
export const PUSH_TITLE = '\x1b[22;0t';
export const POP_TITLE = '\x1b[23;0t';
export const BELL = '\x07';

function write(seq: string): void {
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write(seq);
  } catch {
    /* a closed terminal is no reason to fail */
  }
}

export const setTitle = (text: string): void => write(titleSequence(text));
export const ringBell = (): void => write(BELL);
export const pushTitle = (): void => write(PUSH_TITLE);
export const popTitle = (): void => write(POP_TITLE);
