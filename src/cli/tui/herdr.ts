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
let pending: string[] | null = null;
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
    await send(args);
  }
}

export function reportHerdr(agent: string, session: string, state: ReturnType<typeof herdrState>, message: string): void {
  if (!enabled || stopped) return;
  const argv = resumeArgs(agent, session);
  // Invalid resume arguments must not suppress lifecycle reports.
  const args = ['pane', 'report-agent', env.HERDR_PANE_ID!, ...owner, '--state', state,
    '--message', message, ...(argv ? ['--agent-session-id', JSON.stringify([agent, session]), '--', ...argv] : [])];
  const key = JSON.stringify(args);
  if (key === previous) return;
  previous = key;
  pending = args;
  if (!flight) flight = drain().finally(() => { flight = null; });
}

export async function releaseHerdr(): Promise<void> {
  if (!enabled || stopped) return;
  stopped = true;
  pending = null;
  await flight;
  await send(['pane', 'release-agent', env.HERDR_PANE_ID!, ...owner]);
  released = true;
}

// Covers termination paths that bypass Ink's normal shutdown.
if (enabled) process.once('exit', () => {
  if (released) return;
  try {
    execFileSync(env.HERDR_BIN_PATH!, ['pane', 'release-agent', env.HERDR_PANE_ID!, ...owner], { timeout: 250, stdio: 'ignore' });
  } catch { /* Herdr is optional. */ }
});
