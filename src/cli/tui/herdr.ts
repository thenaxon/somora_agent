// The TUI inside a herdr pane (docs/display.md "Inside herdr"): it tells
// herdr which agent and session the pane shows and their state (idle,
// working, blocked for an open question, unknown while disconnected),
// hands over the command that reopens the conversation, and frees the
// pane on exit. herdr sets HERDR_ENV, HERDR_BIN_PATH, HERDR_PANE_ID and
// HERDR_SOCKET_PATH in its panes; without them nothing here runs.
// Reports go through herdr's CLI (`pane report-agent`, `report-metadata`,
// `release-agent`), one at a time, unchanged ones skipped.
// Built by packetloss99 in their fork (PR #1 and #5 there).

import { execFile, execFileSync } from 'node:child_process';
import type { SessionWork } from './types.ts';

export function herdrState(connected: boolean, question: boolean, running: boolean, work: SessionWork | null): 'idle' | 'working' | 'blocked' | 'unknown' {
  if (!connected) return 'unknown';
  if (question) return 'blocked';
  if (running || work?.busy || work?.active || work?.queued.length || work?.children.length || work?.pendingWakes.length) return 'working';
  return work ? 'idle' : 'unknown';
}

export function resumeArgs(agent: string, session: string): string[] | null {
  const argv = ['somora', 'tui', '--agent', agent, '--session', session];
  return argv.some((arg) => /['\x00-\x1f\x7f]/.test(arg)) || Buffer.byteLength(argv.join('\0')) > 8192 ? null : argv;
}

const env = process.env;
const enabled = env.HERDR_ENV === '1' && !!env.HERDR_BIN_PATH && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
const owner = ['--source', 'somora-tui', '--agent', 'somora'];
const metadataOwner = [...owner, '--applies-to-source', 'somora-tui'];
const clearDisplay = ['pane', 'report-metadata', env.HERDR_PANE_ID!, ...metadataOwner, '--clear-display-agent'];
let pending: { report: string[]; display: string[] } | null = null;
let latest: { report: string[]; display: string[] } | null = null;
let flight: Promise<void> | null = null;
let previous = '';
let stopped = false;
let released = false;

function send(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(env.HERDR_BIN_PATH!, args, { timeout: 750, maxBuffer: 16_384 }, () => resolve());
  });
}

async function drain(): Promise<void> {
  while (pending) {
    const args = pending;
    pending = null;
    await send(args.report);
    await send(args.display);
  }
}

function flush(): void {
  if (!flight) flight = drain().finally(() => { flight = null; });
}

// Herdr handoff does not retain display metadata; refresh it even while idle.
const refresh = enabled ? setInterval(() => {
  if (stopped || !latest) return;
  pending = latest;
  flush();
}, 30_000).unref() : null;

export function reportHerdr(agent: string, session: string, state: ReturnType<typeof herdrState>, message: string): void {
  if (!enabled || stopped) return;
  const argv = resumeArgs(agent, session);
  // Invalid resume arguments must not suppress lifecycle reports.
  const args = ['pane', 'report-agent', env.HERDR_PANE_ID!, ...owner, '--state', state,
    '--message', message, ...(argv ? ['--agent-session-id', JSON.stringify([agent, session]), '--', ...argv] : [])];
  const key = JSON.stringify(args);
  if (key === previous) return;
  previous = key;
  pending = latest = {
    report: args,
    display: ['pane', 'report-metadata', env.HERDR_PANE_ID!, ...metadataOwner, '--display-agent', `${agent} · Somora`],
  };
  flush();
}

export async function releaseHerdr(): Promise<void> {
  if (!enabled || stopped) return;
  stopped = true;
  if (refresh) clearInterval(refresh);
  pending = latest = null;
  await flight;
  await send(clearDisplay);
  await send(['pane', 'release-agent', env.HERDR_PANE_ID!, ...owner]);
  released = true;
}

// Covers termination paths that bypass Ink's normal shutdown.
if (enabled) process.once('exit', () => {
  if (released) return;
  try {
    execFileSync(env.HERDR_BIN_PATH!, clearDisplay, { timeout: 250, stdio: 'ignore' });
  } catch { /* Herdr is optional. */ }
  try {
    execFileSync(env.HERDR_BIN_PATH!, ['pane', 'release-agent', env.HERDR_PANE_ID!, ...owner], { timeout: 250, stdio: 'ignore' });
  } catch { /* Herdr is optional. */ }
});
