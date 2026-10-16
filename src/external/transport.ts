// Where an external agent's ACP command runs, and the byte streams to it.
// ACP standardises only stdio (the remote transport is still an RFD), so
// somora starts the command itself — on this machine, or over one of its
// SSH resources, whose channel then carries stdin/stdout across the LAN.
// On the agent's machine nothing has to be exposed or unlocked.

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { Config } from '../config/types.ts';
import { holdConnection } from '../ssh/pool.ts';
import { logger } from '../server/logger.ts';

export interface AgentProcess {
  /** To the agent (its stdin). */
  input: WritableStream<Uint8Array>;
  /** From the agent (its stdout). */
  output: ReadableStream<Uint8Array>;
  /** Where it runs, for logs and messages. */
  where: string;
  /** The last lines the command wrote to stderr — the reason when it fails. */
  stderrTail(): string;
  /** Resolves once with the exit (code or signal) of the command. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** End it: closes stdin, then terminates after a grace period. */
  stop(): void;
}

const STDERR_KEEP = 4000;

function keepTail(prev: string, chunk: string): string {
  const next = prev + chunk;
  return next.length > STDERR_KEEP ? next.slice(-STDERR_KEEP) : next;
}

/** `'…'` for a POSIX shell: the command runs as one argument of `bash -lc`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Start the command as `bash -lc <command>` — locally or on a resource. */
export async function startAgentProcess(
  transport: { local: true } | { resource: string },
  command: string,
  config: Config,
): Promise<AgentProcess> {
  if ('local' in transport) return startLocal(command);
  const resource = config.resources[transport.resource];
  if (!resource) throw new Error(`resource '${transport.resource}' is not in config.yaml resources`);
  return startOnResource(transport.resource, resource, command);
}

function startLocal(command: string): AgentProcess {
  const child = spawn('bash', ['-lc', command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let tail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => (tail = keepTail(tail, d)));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (err) => {
      tail = keepTail(tail, `\n${err.message}`);
      resolve({ code: -1, signal: null });
    });
  });
  return {
    input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    output: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    where: 'local',
    stderrTail: () => tail.trim(),
    exited,
    stop: () => {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      const t = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }, 2000);
      t.unref();
    },
  };
}

async function startOnResource(name: string, resource: Config['resources'][string], command: string): Promise<AgentProcess> {
  const { client, release } = await holdConnection(name, resource);
  let channel: import('ssh2').ClientChannel;
  try {
    channel = await new Promise((resolve, reject) => {
      client.exec(`bash -lc ${shellQuote(command)}`, (err, ch) => (err ? reject(err) : resolve(ch)));
    });
  } catch (err) {
    release();
    throw new Error(`ssh to '${name}': could not start the command: ${(err as Error).message}`);
  }
  let tail = '';
  channel.stderr.setEncoding('utf8');
  channel.stderr.on('data', (d: string) => (tail = keepTail(tail, d)));
  let done = false;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const finish = (code: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      release();
      resolve({ code, signal });
    };
    channel.once('exit', (code: number | null, signal?: string) => finish(code ?? null, signal ?? null));
    channel.once('close', () => finish(null, null));
  });
  logger.info({ msg: 'external.ssh_channel_open', resource: name });
  return {
    input: Writable.toWeb(channel) as WritableStream<Uint8Array>,
    output: Readable.toWeb(channel) as ReadableStream<Uint8Array>,
    where: name,
    stderrTail: () => tail.trim(),
    exited,
    stop: () => {
      // EOF on stdin ends an ACP agent; the channel close is the backstop.
      try {
        channel.end();
      } catch {
        /* closed */
      }
      const t = setTimeout(() => {
        try {
          channel.signal('TERM');
        } catch {
          /* not supported by every sshd */
        }
        try {
          channel.close();
        } catch {
          /* closed */
        }
      }, 2000);
      t.unref();
    },
  };
}
