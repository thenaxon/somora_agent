// Remote tmux command helpers — same operations as local, routed
// through ssh/exec.ts:remoteExec. Each call opens a short-lived
// ssh exec; the actual tmux session lives on the resource and
// persists across our calls.
//
// Why this works robustly: tmux on the remote is a long-running
// daemon (the tmux server) that owns the session. Our individual
// `tmux send-keys` / `tmux capture-pane` calls just talk to that
// daemon over short ssh connections. Network blip between calls
// = no problem; the session keeps running on the remote.

import { getConnection, remoteExec } from '../../ssh/index.ts';
import { resolveVisibleResourceFresh } from '../resources/visibility.ts';
import { logger } from '../../server/logger.ts';

const DEFAULT_CAPTURE_LINES = 200;

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Mirrors local.ts:buildSendKeysScript — see there for the
// multilineSafe / M-Enter rationale, the `--` end-of-flags guard, and
// the trailing-\n strip-before-split (the bug report 2026-05-07).
function buildSendKeysScript(name: string, keys: string, multilineSafe: boolean): string {
  const endsWithNewline = keys.endsWith('\n');
  const body = endsWithNewline ? keys.slice(0, -1) : keys;
  const parts = body.split('\n');
  const cmds: string[] = [];
  parts.forEach((part, idx) => {
    if (part.length > 0) {
      cmds.push(`tmux send-keys -t ${shQuote(name)} -l -- ${shQuote(part)}`);
    }
    if (idx < parts.length - 1) {
      const keyName = multilineSafe ? 'M-Enter' : 'Enter';
      cmds.push(`tmux send-keys -t ${shQuote(name)} ${keyName}`);
    }
  });
  if (endsWithNewline) {
    if (cmds.length > 0) {
      cmds.push('sleep 0.1');
    }
    cmds.push(`tmux send-keys -t ${shQuote(name)} Enter`);
  }
  return cmds.join(' && ');
}

export interface TmuxRemoteResult {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

async function runRemoteTmux(
  agent: string,
  target: string,
  command: string,
  timeoutMs: number = 10_000,
): Promise<TmuxRemoteResult> {
  const resource = await resolveVisibleResourceFresh(agent, target);
  if (!resource) {
    throw new Error(
      `tmux: target '${target}' is not a configured resource (or denied for this agent). ` +
        `Use resource_list to see available targets.`,
    );
  }
  if (resource.type !== 'ssh') {
    throw new Error(`tmux: resource '${target}' has unsupported type '${resource.type}'`);
  }
  const conn = await getConnection(target, resource);
  const r = await remoteExec(conn, command, { timeoutMs });
  return {
    ok: r.code === 0,
    exit_code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

export async function tmuxRemoteCreate(
  agent: string,
  target: string,
  name: string,
  cwd?: string,
): Promise<TmuxRemoteResult> {
  const cwdFlag = cwd ? ` -c ${shQuote(cwd)}` : '';
  const cmd = `tmux new-session -d -s ${shQuote(name)}${cwdFlag}`;
  logger.info({ msg: 'tmux.remote.create', target, name, cwd });
  return runRemoteTmux(agent, target, cmd);
}

export async function tmuxRemoteSend(
  agent: string,
  target: string,
  name: string,
  keys: string,
  multilineSafe = false,
): Promise<TmuxRemoteResult> {
  const cmd = buildSendKeysScript(name, keys, multilineSafe);
  if (!cmd) {
    return { ok: true, exit_code: 0, stdout: '', stderr: '' };
  }
  logger.info({ msg: 'tmux.remote.send', target, name, keys_len: keys.length, multilineSafe });
  return runRemoteTmux(agent, target, cmd);
}

// Mirrors local.ts:tmuxLocalSendKey — see there for rationale.
export async function tmuxRemoteSendKey(
  agent: string,
  target: string,
  name: string,
  key: string,
): Promise<TmuxRemoteResult> {
  const tokens = key.trim().split(/\s+/);
  const cmd = `tmux send-keys -t ${shQuote(name)} ${tokens.join(' ')}`;
  logger.info({ msg: 'tmux.remote.send_key', target, name, key });
  return runRemoteTmux(agent, target, cmd);
}

export async function tmuxRemoteCapture(
  agent: string,
  target: string,
  name: string,
  lines: number = DEFAULT_CAPTURE_LINES,
  includeAnsi = false,
): Promise<TmuxRemoteResult> {
  const ansiFlag = includeAnsi ? ' -e' : '';
  const cmd = `tmux capture-pane -t ${shQuote(name)} -p${ansiFlag} -S -${lines}`;
  return runRemoteTmux(agent, target, cmd);
}

export async function tmuxRemoteList(
  agent: string,
  target: string,
): Promise<{ ok: boolean; sessions: Array<{ name: string; created_at: number; windows: number }> }> {
  const cmd = `tmux list-sessions -F '#{session_name}|#{session_created}|#{session_windows}' 2>/dev/null || true`;
  const r = await runRemoteTmux(agent, target, cmd);
  if (!r.stdout.trim()) {
    return { ok: true, sessions: [] };
  }
  const sessions = r.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [name, created, windows] = line.split('|');
      return {
        name: name ?? '',
        created_at: parseInt(created ?? '0', 10) * 1000,
        windows: parseInt(windows ?? '0', 10),
      };
    })
    .filter((s) => s.name.length > 0);
  return { ok: true, sessions };
}

export async function tmuxRemoteKill(
  agent: string,
  target: string,
  name: string,
): Promise<TmuxRemoteResult> {
  const cmd = `tmux kill-session -t ${shQuote(name)}`;
  logger.info({ msg: 'tmux.remote.kill', target, name });
  return runRemoteTmux(agent, target, cmd);
}
