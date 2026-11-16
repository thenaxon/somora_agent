// One look at a tmux pane: what it shows, its title, which program runs
// in its foreground and — for a coding agent — the state herdr's rules
// read from it (detection/). One shell command, so a pane on an SSH
// resource costs one round trip like a local one.

import { detectionScreen } from './detection/engine.ts';
import type { Detection } from './detection/engine.ts';
import { detectAgentState, resolveAgent } from './detection/manifests.ts';
import { identifyForeground, parsePs, type ProcessRow } from './detection/identify.ts';
import { detectSuggestion } from './tui-markers.ts';
import type { TmuxSessionKind } from './origin-store.ts';

export interface RunResult {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}
/** Runs a shell command where the pane lives (locally or over SSH). */
export type Runner = (command: string, timeoutMs?: number) => Promise<RunResult>;

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const SEP = '\u001fSOMORA-OBSERVE\u001f';

export interface ObserveOptions {
  /** Lines of scrollback for `content` (the visible rows are always read). */
  lines: number;
  /** `content` with ANSI styling. */
  ansi?: boolean;
  /** `content` with soft-wrapped lines joined (capture-pane -J). */
  joinWrapped?: boolean;
}

export function observeCommand(name: string, opts: ObserveOptions): string {
  const t = shQuote(`=${name}:`);
  const lines = Math.max(1, Math.floor(opts.lines));
  const content = `tmux capture-pane -p${opts.ansi ? ' -e' : ''}${opts.joinWrapped ? ' -J' : ''} -t ${t} -S -${lines}`;
  return [
    `tmux display-message -p -t ${t} '#{pane_height} #{pane_width} #{pane_current_command}'`,
    `echo '${SEP}'`,
    `tmux display-message -p -t ${t} '#{pane_title}'`,
    `echo '${SEP}'`,
    `tty=$(tmux display-message -p -t ${t} '#{pane_tty}'); ps -o pid=,pgid=,tpgid=,args= -t "\${tty#/dev/}" 2>/dev/null`,
    `echo '${SEP}'`,
    // The visible rows, plain and styled: detection and ghost text read these.
    `tmux capture-pane -p -t ${t}`,
    `echo '${SEP}'`,
    `tmux capture-pane -p -e -t ${t}`,
    `echo '${SEP}'`,
    content,
  ].join('; ');
}

export interface PaneLook {
  height: number;
  width: number;
  currentCommand: string;
  title: string;
  processes: ProcessRow[];
  /** The visible rows, trailing blank rows dropped (what detection reads). */
  screen: string;
  /** The visible rows with ANSI styling. */
  screenAnsi: string;
  /** What the caller asked for (lines, ansi, joined). */
  content: string;
}

export function parseObserve(stdout: string): PaneLook | null {
  const parts = stdout.split(`${SEP}\n`);
  if (parts.length !== 6) return null;
  const [geom, title, ps, visible, visibleAnsi, content] = parts as [string, string, string, string, string, string];
  const m = /^(\d+) (\d+) ?(.*)$/.exec(geom.trim());
  if (!m) return null;
  const height = Number(m[1]);
  return {
    height,
    width: Number(m[2]),
    currentCommand: m[3] ?? '',
    title: title.replace(/\n$/, ''),
    processes: parsePs(ps),
    screen: detectionScreen(visible, height),
    screenAnsi: visibleAnsi,
    content,
  };
}

/** A coding agent's state in a pane, as the tool reports it. */
export interface AgentStateField {
  /** The agent's id (claude, codex, opencode, pi, …). */
  name: string;
  /** idle: ready for input. working: busy. blocked: an approval,
   *  question or startup dialog waits for an answer. unknown: the
   *  screen says nothing (e.g. a transcript viewer is open). */
  state: Detection['state'];
  /** The rule that decided (for explain / bug reports). */
  rule?: string;
  /** How the agent was recognised. */
  identified_by: 'process' | 'kind';
  /** Dim ghost text on the input line: the agent's suggestion for a
   *  human, not typed input. */
  suggestion_visible?: boolean;
  suggestion_text?: string;
}

const KIND_FOR_SUGGESTION: Record<string, TmuxSessionKind> = { claude: 'claude-code', codex: 'codex' };

/** Which agent runs in the pane: its foreground process first, the kind
 *  declared at create second (a remote host without `ps -t`). */
export function paneAgent(look: PaneLook, declaredKind?: string): { agent: string; by: 'process' | 'kind' } | null {
  const byProcess = identifyForeground(look.processes);
  if (byProcess && resolveAgent(byProcess)) return { agent: resolveAgent(byProcess)!, by: 'process' };
  // A declared kind only counts while no other program holds the pane:
  // the agent may have exited back to the shell.
  if (declaredKind && declaredKind !== 'shell' && look.processes.length === 0) {
    const id = resolveAgent(declaredKind);
    if (id) return { agent: id, by: 'kind' };
  }
  return null;
}

/** The agent field for a look, or null for a pane without a known agent. */
export function agentStateOf(look: PaneLook, declaredKind?: string): AgentStateField | null {
  const who = paneAgent(look, declaredKind);
  if (!who) return null;
  const d = detectAgentState(who.agent, { screen: look.screen, title: look.title });
  if (!d) return null;
  const field: AgentStateField = {
    name: who.agent,
    state: d.state,
    ...(d.rule ? { rule: d.rule.id } : {}),
    identified_by: who.by,
  };
  const kind = KIND_FOR_SUGGESTION[who.agent];
  if (kind) {
    const s = detectSuggestion(look.screenAnsi, kind);
    if (s?.suggestion_visible) {
      field.suggestion_visible = true;
      if (s.suggestion_text !== undefined) field.suggestion_text = s.suggestion_text;
    }
  }
  return field;
}

/** Look at a pane. Null with the error when tmux could not be asked. */
export async function observePane(
  run: Runner,
  name: string,
  opts: ObserveOptions,
): Promise<{ look: PaneLook } | { error: string }> {
  const r = await run(observeCommand(name, opts));
  if (!r.ok) return { error: r.stderr.trim() || `exit ${r.exit_code}` };
  const look = parseObserve(r.stdout);
  return look ? { look } : { error: 'could not read the pane (unexpected tmux output)' };
}
