// Driving a coding agent in a tmux pane: start it, hand it a prompt and
// wait until it settles. After herdr's `agent start`, `agent prompt
// --wait` and `agent wait`: each a whole step, so the driving agent does
// not have to type, press Enter, poll and read the screen itself.
//
// Rules learned on real panes (src/tmux/__fixtures__, 2026-11-16):
// - Nothing is sent to a blocked, working or unknown agent. Codex keeps
//   text typed while it works in its input instead of queueing it, and
//   an approval dialog would take the keystrokes as answers.
// - The text goes in as a bracketed paste, then Enter after a pause:
//   typed fast, Codex takes the burst for a paste and the Enter for a
//   newline; a paste is a paste for every agent, newlines included.
// - Submitted is proven by activity: the agent shows working or blocked,
//   or the screen moved on from how it looked with the text pasted (a
//   fast local model can answer between two looks).

import { agentStateOf, observePane, shQuote, type AgentStateField, type PaneLook, type Runner } from './observe.ts';
import { foregroundIsShell } from './detection/identify.ts';

export interface DriveClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realClock: DriveClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Herdr waits 5 s for activity after a prompt; a cold local model can
 *  take longer to draw its first sign. */
export const ACTIVITY_GATE_MS = 10_000;
const POLL_MS = 400;
/** A settled state must hold this long (two looks): screens flicker
 *  between tool calls. */
const SETTLE_MS = 800;
const LOOK_LINES = 60;
/** prompt to a working agent: this many more looks before agent_busy. */
const BUSY_GRACE_LOOKS = 7;
/** Starting: idle must hold longer, on a screen that shows something —
 *  while an agent loads, a near-blank screen reads idle by herdr's
 *  fallback (no rule matches). */
const STARTUP_SETTLE_MS = 2_000;

export type DriveError =
  | 'no_agent' // no coding agent recognised in the pane
  | 'agent_blocked' // a dialog waits for an answer
  | 'agent_busy' // the agent is working
  | 'agent_state_unknown' // the screen says nothing (e.g. transcript viewer)
  | 'agent_prompt_stalled' // sent, but no sign the agent took it
  | 'agent_not_ready' // start: the agent did not come up ready
  | 'not_a_shell' // start: another program holds the pane
  | 'not_supported' // new_conversation: no known command for this agent
  | 'timeout'
  | 'tmux_error';

export interface DriveResult {
  ok: boolean;
  error?: DriveError;
  /** What to do about the error, for the model. */
  hint?: string;
  agent?: AgentStateField;
  /** prompt: the text reached the agent and it reacted. */
  submitted?: boolean;
  /** The agent reached idle or blocked (prompt with wait, wait). */
  settled?: boolean;
  /** The pane at the end, the last `lines` lines. */
  content: string;
  ms: number;
}

async function look(run: Runner, name: string, lines: number, kind?: string) {
  const r = await observePane(run, name, { lines });
  if ('error' in r) return { error: r.error } as const;
  return { look: r.look, agent: agentStateOf(r.look, kind) } as const;
}

const HINT: Record<Exclude<DriveError, 'tmux_error'>, string> = {
  no_agent: 'No coding agent runs in this pane. Use send for a shell, or start to launch an agent.',
  agent_blocked:
    'The agent shows an approval, question or startup dialog. Read content, decide (or ask the person), ' +
    'answer it with send (key: or keys:), then prompt again. Never answer a dialog you do not understand.',
  agent_busy:
    'The agent is still working. Wait with wait_idle, or interrupt with send key:"Escape" if the person wants that. ' +
    'Do not type into it now: Codex keeps text typed while it works in its input.',
  agent_state_unknown:
    'The screen does not show the agent\'s state (an overlay or viewer may be open). Capture to look; ' +
    'send key:"Escape" usually closes it.',
  agent_prompt_stalled:
    'The text was sent but the agent showed no sign of taking it. Capture to look before sending again — ' +
    'it may sit in the input box. Do not send it twice blindly.',
  agent_not_ready: 'The agent did not come up ready. Capture to see why (a login, a dialog, an error).',
  not_supported:
    'somora does not know this agent\'s command for a fresh conversation. Send it yourself with prompt ' +
    '(often /new or /clear), or kill the session and start it anew.',
  not_a_shell:
    'Another program (an editor, a REPL, a running command) holds this session, so the start command was not typed. ' +
    'Capture to see it; use a new session, or end that program first.',
  timeout:
    'Still not settled. Keep going with wait_idle, or end your turn: somora wakes you when the agent ' +
    'finishes or needs an answer.',
};

function fail(error: DriveError, start: number, clock: DriveClock, extra: Partial<DriveResult> & { content?: string }, detail?: string): DriveResult {
  return {
    ok: false,
    error,
    hint: error === 'tmux_error' ? (detail ?? 'tmux failed') : HINT[error],
    content: extra.content ?? '',
    ms: clock.now() - start,
    ...(extra.agent ? { agent: extra.agent } : {}),
    ...(extra.submitted !== undefined ? { submitted: extra.submitted } : {}),
    ...(extra.settled !== undefined ? { settled: extra.settled } : {}),
  };
}

/** The shell command that pastes `text` into the pane and presses Enter
 *  after a pause. */
export function pasteSubmitCommand(name: string, text: string, enter = true): string {
  const t = shQuote(`=${name}:`);
  const buf = `somora-${Math.random().toString(36).slice(2, 10)}`;
  const steps = [
    `printf '%s' ${shQuote(text)} | tmux load-buffer -b ${buf} -`,
    `tmux paste-buffer -p -d -b ${buf} -t ${t}`,
  ];
  if (enter) steps.push('sleep 0.4', `tmux send-keys -t ${t} Enter`);
  return steps.join(' && ');
}

function contentOf(l: PaneLook | undefined, lines: number): string {
  if (!l) return '';
  const all = l.content.replace(/\n+$/, '').split('\n');
  return all.slice(-lines).join('\n');
}

/** Wait until the agent settles (idle or blocked, held for SETTLE_MS).
 *  Unknown and working keep waiting. */
export async function waitSettled(
  run: Runner,
  name: string,
  opts: { timeoutMs: number; lines: number; kind?: string; clock?: DriveClock },
): Promise<DriveResult> {
  const clock = opts.clock ?? realClock;
  const start = clock.now();
  let settledSince: number | null = null;
  let lastState: string | null = null;
  let last: { look: PaneLook; agent: AgentStateField | null } | null = null;
  for (;;) {
    const r = await look(run, name, Math.max(opts.lines, LOOK_LINES), opts.kind);
    if ('error' in r) return fail('tmux_error', start, clock, { content: contentOf(last?.look, opts.lines) }, r.error);
    last = { look: r.look, agent: r.agent };
    if (!r.agent) return fail('no_agent', start, clock, { content: contentOf(r.look, opts.lines) });
    const s = r.agent.state;
    if ((s === 'idle' || s === 'blocked') && s === lastState) {
      if (settledSince !== null && clock.now() - settledSince >= SETTLE_MS) {
        return { ok: true, settled: true, agent: r.agent, content: contentOf(r.look, opts.lines), ms: clock.now() - start };
      }
    } else {
      settledSince = s === 'idle' || s === 'blocked' ? clock.now() : null;
    }
    lastState = s;
    if (clock.now() - start >= opts.timeoutMs) {
      return fail('timeout', start, clock, { agent: r.agent, settled: false, content: contentOf(r.look, opts.lines) });
    }
    await clock.sleep(POLL_MS);
  }
}

export interface PromptOptions {
  text: string;
  /** Wait until the agent settles after taking the prompt. */
  wait: boolean;
  timeoutMs: number;
  lines: number;
  kind?: string;
  clock?: DriveClock;
}

/** Hand a prompt to the agent in the pane. */
export async function promptAgent(run: Runner, name: string, opts: PromptOptions): Promise<DriveResult> {
  const clock = opts.clock ?? realClock;
  const start = clock.now();
  let before = await look(run, name, LOOK_LINES, opts.kind);
  if ('error' in before) return fail('tmux_error', start, clock, {}, before.error);
  // A moment of "working" right after the agent drew a fresh screen
  // (Codex after /new) passes by itself: give it a few looks.
  for (let i = 0; i < BUSY_GRACE_LOOKS && before.agent?.state === 'working'; i += 1) {
    await clock.sleep(POLL_MS);
    const again = await look(run, name, LOOK_LINES, opts.kind);
    if ('error' in again) return fail('tmux_error', start, clock, {}, again.error);
    before = again;
  }
  const content0 = contentOf(before.look, opts.lines);
  if (!before.agent) return fail('no_agent', start, clock, { content: content0 });
  const s0 = before.agent.state;
  if (s0 === 'blocked') return fail('agent_blocked', start, clock, { agent: before.agent, content: content0 });
  if (s0 === 'working') return fail('agent_busy', start, clock, { agent: before.agent, content: content0 });
  if (s0 === 'unknown') return fail('agent_state_unknown', start, clock, { agent: before.agent, content: content0 });

  // Paste, look at the pane with the text in it, then Enter.
  const paste = await run(pasteSubmitCommand(name, opts.text, false));
  if (!paste.ok) return fail('tmux_error', start, clock, { content: content0 }, paste.stderr.trim() || 'paste failed');
  await clock.sleep(400);
  const pasted = await look(run, name, LOOK_LINES, opts.kind);
  if ('error' in pasted) return fail('tmux_error', start, clock, {}, pasted.error);
  const enter = await run(`tmux send-keys -t ${shQuote(`=${name}:`)} Enter`);
  if (!enter.ok) return fail('tmux_error', start, clock, { content: contentOf(pasted.look, opts.lines) }, enter.stderr.trim() || 'Enter failed');

  // Activity gate.
  const gateEnd = clock.now() + ACTIVITY_GATE_MS;
  let active = false;
  let last = pasted;
  while (clock.now() < gateEnd) {
    await clock.sleep(POLL_MS);
    const r = await look(run, name, LOOK_LINES, opts.kind);
    if ('error' in r) return fail('tmux_error', start, clock, { submitted: false }, r.error);
    last = r;
    const s = r.agent?.state;
    if (s === 'working' || s === 'blocked') {
      active = true;
      break;
    }
    // Answered between two looks: idle again, but the screen moved on
    // from how it looked with the text pasted.
    if (s === 'idle' && r.look.screen !== pasted.look.screen) {
      active = true;
      break;
    }
  }
  if (!active) {
    return fail('agent_prompt_stalled', start, clock, {
      ...(last.agent ? { agent: last.agent } : {}),
      submitted: false,
      content: contentOf(last.look, opts.lines),
    });
  }
  if (!opts.wait) {
    return { ok: true, submitted: true, settled: false, ...(last.agent ? { agent: last.agent } : {}), content: contentOf(last.look, opts.lines), ms: clock.now() - start };
  }
  const remaining = Math.max(0, opts.timeoutMs - (clock.now() - start));
  const w = await waitSettled(run, name, { timeoutMs: remaining, lines: opts.lines, ...(opts.kind ? { kind: opts.kind } : {}), clock });
  return { ...w, submitted: true, ms: clock.now() - start };
}

export interface StartOptions {
  /** The command line that starts the agent, typed into the pane's shell. */
  command: string;
  /** The agent declared for the session, for a host whose ps shows nothing. */
  kind?: string;
  timeoutMs: number;
  lines: number;
  clock?: DriveClock;
}

/** Start an agent in a pane that shows a shell, and wait until it is
 *  ready (idle) or stops at a dialog (blocked). */
export async function startAgent(run: Runner, name: string, opts: StartOptions): Promise<DriveResult> {
  const clock = opts.clock ?? realClock;
  const start = clock.now();
  // Before typing: ps decides (no kind) — with no ps there is no telling
  // the shell from an agent, and the kind would claim an agent.
  const before = await look(run, name, LOOK_LINES);
  if ('error' in before) return fail('tmux_error', start, clock, {}, before.error);
  if (before.agent) {
    return {
      ok: false,
      error: 'agent_busy',
      hint: `An agent (${before.agent.name}) already runs in this pane. Use prompt, or kill and create the session anew.`,
      agent: before.agent,
      content: contentOf(before.look, opts.lines),
      ms: clock.now() - start,
    };
  }
  if (foregroundIsShell(before.look.processes) === false) {
    return fail('not_a_shell', start, clock, { content: contentOf(before.look, opts.lines) });
  }
  const t = shQuote(`=${name}:`);
  const typed = await run(`tmux send-keys -t ${t} -l -- ${shQuote(opts.command)} && sleep 0.2 && tmux send-keys -t ${t} Enter`);
  if (!typed.ok) return fail('tmux_error', start, clock, {}, typed.stderr.trim() || 'send failed');
  let settledSince: number | null = null;
  let lastState: string | null = null;
  let last: { look: PaneLook; agent: AgentStateField | null } | null = null;
  while (clock.now() - start < opts.timeoutMs) {
    await clock.sleep(POLL_MS);
    const r = await look(run, name, LOOK_LINES, opts.kind);
    if ('error' in r) return fail('tmux_error', start, clock, {}, r.error);
    last = r;
    const s = r.agent?.state;
    if (s === 'blocked') {
      return fail('agent_not_ready', start, clock, { agent: r.agent!, content: contentOf(r.look, opts.lines) });
    }
    const shows = r.look.screen.trim().split('\n').filter((l) => l.trim()).length >= 3;
    if (s === 'idle' && shows && s === lastState) {
      if (settledSince !== null && clock.now() - settledSince >= STARTUP_SETTLE_MS) {
        return { ok: true, settled: true, agent: r.agent!, content: contentOf(r.look, opts.lines), ms: clock.now() - start };
      }
    } else {
      settledSince = s === 'idle' && shows ? clock.now() : null;
    }
    lastState = s === 'idle' && !shows ? null : (s ?? null);
  }
  return fail('agent_not_ready', start, clock, { ...(last?.agent ? { agent: last.agent } : {}), content: contentOf(last?.look, opts.lines) });
}

/** Each agent's own command for a fresh conversation. */
export const NEW_CONVERSATION_COMMAND: Record<string, string> = {
  claude: '/clear',
  codex: '/new',
  opencode: '/new',
  pi: '/new',
};

export interface NewConversationOptions {
  timeoutMs: number;
  lines: number;
  kind?: string;
  clock?: DriveClock;
}

/** Give the agent a fresh conversation: its own command (/new, /clear),
 *  Codex's follow-up question answered with the current worktree (only
 *  when that is the preselected choice — anything else is handed back
 *  as blocked), and back when the agent is idle again. */
export async function newConversation(
  run: Runner,
  name: string,
  opts: NewConversationOptions,
): Promise<DriveResult & { command?: string }> {
  const clock = opts.clock ?? realClock;
  const start = clock.now();
  const first = await look(run, name, LOOK_LINES, opts.kind);
  if ('error' in first) return fail('tmux_error', start, clock, {}, first.error);
  if (!first.agent) return fail('no_agent', start, clock, { content: contentOf(first.look, opts.lines) });
  const command = NEW_CONVERSATION_COMMAND[first.agent.name];
  if (!command) return fail('not_supported', start, clock, { agent: first.agent, content: contentOf(first.look, opts.lines) });

  const sent = await promptAgent(run, name, {
    text: command,
    wait: true,
    timeoutMs: opts.timeoutMs,
    lines: opts.lines,
    ...(opts.kind ? { kind: opts.kind } : {}),
    clock,
  });
  if (!sent.ok) return { ...sent, command, ms: clock.now() - start };

  // Codex asks where the new conversation runs.
  if (sent.agent?.state === 'blocked' && sent.agent.rule === 'somora_new_conversation_dialog') {
    const dlg = await look(run, name, LOOK_LINES, opts.kind);
    if ('error' in dlg) return fail('tmux_error', start, clock, {}, dlg.error);
    const currentPreselected = /^\s*›\s*1\.\s*Use current Git worktree/m.test(dlg.look.screen);
    if (!currentPreselected) {
      return { ...fail('agent_blocked', start, clock, { ...(dlg.agent ? { agent: dlg.agent } : {}), content: contentOf(dlg.look, opts.lines) }), command };
    }
    const enter = await run(`tmux send-keys -t ${shQuote(`=${name}:`)} Enter`);
    if (!enter.ok) return fail('tmux_error', start, clock, {}, enter.stderr.trim() || 'Enter failed');
    const remaining = Math.max(1_000, opts.timeoutMs - (clock.now() - start));
    const w = await waitSettled(run, name, { timeoutMs: remaining, lines: opts.lines, ...(opts.kind ? { kind: opts.kind } : {}), clock });
    return { ...w, submitted: true, command, ms: clock.now() - start };
  }
  return { ...sent, command, ms: clock.now() - start };
}
