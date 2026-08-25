// Tests for the TUI marker tables + ANSI helpers (tui-markers.ts).
//
// Run: npx tsx src/tmux/tui-markers.test.mts
//
// The opencode fixtures are real `tmux capture-pane` tails recorded
// 2026-08-25 against OpenCode 1.18.23 driving a local model behind an
// OpenAI-compatible router — ready, running, queued, permission dialog, done.

import assert from 'node:assert/strict';
import { detectSuggestion, detectTuiState } from './tui-markers.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const OC_READY = "                                                \u2503\n                                                \u2503  Ask anything... \"Fix broken tests\"\n                                                \u2503\n                                                \u2503  Build \u00b7 Local Model (local) Local (OpenAI-compatible)\n                                                \u2579\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\n                                                tab agents  ctrl+p commands\n                                                        \u25cf Tip Set \"tools\": {\"bash\": false} to disable specific tools\n  /tmp/claude-1000/-home-suspect-Projects-naxon-somora/0dd2df6d-c303-4ebd-aebe-44a19c612975/scratchpad/oc-probe:main                                             1.18.23";
const OC_RUNNING = "     \u25a3  Build \u00b7 Local Model (local)\n  \u2503                                                                                                                               /tmp/claude-1000/-home-suspect-\n  \u2503                                                                                                                               Projects-naxon-somora/0dd2df6d-c303-\n  \u2503                                                                                                                               4ebd-aebe-44a19c612975/scratchpad/oc-\n  \u2503  Build \u00b7 Local Model (local) Local (OpenAI-compatible)                                                                 probe:main\n  \u2579\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\n   \u2b1d\u2b1d\u2b1d\u2b1d\u2b1d\u2b1d\u2b1d\u2b1d  esc interrupt                                                                         tab agents  ctrl+p commands    \u2022 OpenCode 1.18.23";
const OC_QUEUED = "  \u2503\n  \u2503  second message while running\n  \u2503   QUEUED\n  \u2503\n  \u2503                                                                                                                               /tmp/claude-1000/-home-suspect-\n  \u2503                                                                                                                               Projects-naxon-somora/0dd2df6d-c303-\n  \u2503                                                                                                                               4ebd-aebe-44a19c612975/scratchpad/oc-\n  \u2503  Build \u00b7 Local Model (local) Local (OpenAI-compatible)                                                                 probe:main\n  \u2579\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\n   \u2b1d\u2b1d\u2b1d\u2b1d\u2b1d\u2b1d\u2b1d\u2b1d  esc interrupt                                                                         tab agents  ctrl+p commands    \u2022 OpenCode 1.18.23";
const OC_PERMISSION = "  \u2503  \u25b3 Permission required\n  \u2503    \u2190 Access external directory /etc\n  \u2503\n  \u2503  Patterns\n  \u2503                                                                                                                               /tmp/claude-1000/-home-suspect-\n  \u2503  - /etc/*                                                                                                                     Projects-naxon-somora/0dd2df6d-c303-\n  \u2503                                                                                                                               4ebd-aebe-44a19c612975/scratchpad/oc-\n  \u2503                                                                                                                               probe:main\n  \u2503   Allow once   Allow always   Reject                                         ctrl+f fullscreen  \u21c6 select  enter confirm\n  \u2503                                                                                                                               \u2022 OpenCode 1.18.23";
const OC_DONE = "     \u25a3  Build \u00b7 Local Model (local) \u00b7 10.0s\n  \u2503\n  \u2503  queued hello                                                                                                                 /tmp/claude-1000/-home-suspect-\n  \u2503                                                                                                                               Projects-naxon-somora/0dd2df6d-c303-\n  \u2503  Build \u00b7 Local Model (local) Local (OpenAI-compatible)                                                                 4ebd-aebe-44a19c612975/scratchpad/oc-\n  \u2579\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580    probe:main\n   /tmp/claude-1000/-home-suspect-Projects-naxon-somora/0dd2df6d-c303-4ebd-aebe-44a19c612975/         8.5K (1%) ctrl+p\n   scratchpad/oc-probe                                                                                          commands          \u2022 OpenCode 1.18.23";

// ── opencode state detection ─────────────────────────────────────────
{
  const r = detectTuiState(OC_READY, 'opencode');
  check('opencode fresh TUI → ready', r?.state === 'ready', JSON.stringify(r));
  const run = detectTuiState(OC_RUNNING, 'opencode');
  check('opencode mid-turn → running', run?.state === 'running', JSON.stringify(run));
  check('opencode running marker is the footer cue', run?.markers.includes('esc interrupt') === true);
  const q = detectTuiState(OC_QUEUED, 'opencode');
  check('opencode message submitted mid-turn → queued (beats running)', q?.state === 'queued', JSON.stringify(q));
  const p = detectTuiState(OC_PERMISSION, 'opencode');
  check('opencode permission dialog → ready (waits for a decision)', p?.state === 'ready', JSON.stringify(p));
  check('permission dialog text is visible for the orchestrator', OC_PERMISSION.includes('Permission required'));
  const d = detectTuiState(OC_DONE, 'opencode');
  check('opencode after turn → ready', d?.state === 'ready', JSON.stringify(d));
  check('shell kind still undetected', detectTuiState(OC_RUNNING, 'shell') === null);
  check('opencode has no input-line probe → suggestion null', detectSuggestion(OC_READY, 'opencode') === null);
}

// ── ANSI dim parsing: truecolor is not dim ───────────────────────────
{
  // Real OpenCode input line: placeholder rendered in truecolor grey
  // (38;2;128;128;128). Before the SGR-parameter walk, the literal `2`
  // colour-space selector flipped dim on and the whole placeholder
  // came back as a "suggestion". Probe it through the claude-code
  // prefix by prepending a prompt marker.
  const TRUECOLOR_LINE = "                                                \u001b[38;2;92;156;245m\u2503\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m  \u001b[38;2;128;128;128mAsk anything... \"Fix broken tests\"\u001b[38;2;255;255;255m                                      \u001b[48;2;10;10;10m";
  const asClaudeLine = '\x1b[0m> ' + TRUECOLOR_LINE;
  const r = detectSuggestion(asClaudeLine, 'claude-code');
  check('truecolor (38;2;…) text is NOT reported as ghost text', r?.suggestion_visible === false, JSON.stringify(r));
  const c256 = '> \x1b[38;5;2mgreen text\x1b[0m';
  const r2 = detectSuggestion(c256, 'claude-code');
  check('256-colour index 2 (38;5;2) is NOT dim', r2?.suggestion_visible === false, JSON.stringify(r2));
  const realDim = '> typed \x1b[2m and a ghost suggestion\x1b[22m';
  const r3 = detectSuggestion(realDim, 'claude-code');
  check('SGR 2 dim span is still detected', r3?.suggestion_visible === true && r3.suggestion_text === 'and a ghost suggestion', JSON.stringify(r3));
  const combined = '> \x1b[38;2;10;10;10;2mdim truecolor ghost\x1b[0m';
  const r4 = detectSuggestion(combined, 'claude-code');
  check('dim flag after a truecolor triple is honoured', r4?.suggestion_visible === true, JSON.stringify(r4));
}

console.log(`${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
