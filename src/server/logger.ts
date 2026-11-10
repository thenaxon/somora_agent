import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

// Last line of defence for test isolation. `npm test` (scripts/run-tests.mjs)
// already points SOMORA_HOME at a throwaway directory before anything is
// imported. Someone running a single file by hand does not, and this module
// opens its log file at import time — that is how test errors ended up in
// the live server log and made its error count worthless (2026-09-08 report).
// Under node:test without an explicit home, log to a temp directory instead.
// Only the destination changes: stdout stays untouched, because the MCP
// child speaks JSON-RPC over it.
const UNDER_NODE_TEST = Boolean(process.env.NODE_TEST_CONTEXT);
const SOMORA_HOME =
  process.env.SOMORA_HOME ?? (UNDER_NODE_TEST ? mkdtempSync(join(tmpdir(), 'somora-test-log-')) : join(homedir(), '.somora'));
const LOG_DIR = join(SOMORA_HOME, 'logs');
mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
// The log holds commands, paths and message text: other users on the
// machine keep out. Also tightens a folder an older version created.
try {
  chmodSync(LOG_DIR, 0o700);
} catch {
  /* not ours to change — logging still works */
}

const level = process.env.SOMORA_LOG_LEVEL ?? 'info';
// Pretty lines on the terminal are for someone watching the SERVER in
// the foreground. The interactive CLI commands (setup, wiki migrate, …)
// own the terminal themselves and switch this off (SOMORA_LOG_TTY=0);
// and an install where pino-pretty is missing must never fail to start
// over it — the file log is the record either way.
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}
const isTty = Boolean(process.stdout.isTTY) && process.env.SOMORA_LOG_TTY !== '0' && prettyAvailable();

// File target uses `pino-roll` so events after midnight land in the
// new day's file even when the server has been running for days.
// `frequency: 'daily'` rolls at 00:00 local; `dateFormat: 'yyyy-MM-dd'`
// produces `server.YYYY-MM-DD.log`; `file: 'server'` is the basename.
// Pre-fix behavior: filename was chosen exactly once at module load
// (`new Date().toISOString().slice(0,10)`), so an overnight server
// kept writing 2026-05-14 events into `server-2026-05-13.log` until
// restart. Ada 2026-05-14 forensics report.
//
// stdout target is ONLY added when stdout is a TTY (running
// `npm run dev:server` in a terminal). When stdout is a pipe — e.g.
// the somora MCP server spawned as a child by claude-cli/codex-cli,
// where stdout is the JSON-RPC stream to the parent — writing pino
// JSON to it would corrupt the protocol stream and silently break
// tool registration.
const targets: pino.TransportTargetOptions[] = [
  {
    target: 'pino-roll',
    options: {
      file: join(LOG_DIR, 'server'),
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      extension: '.log',
      mkdir: true,
    },
    level,
  },
];
if (isTty) {
  targets.push({
    target: 'pino-pretty',
    options: {
      destination: 1,
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
      singleLine: true,
    },
    level,
  });
}
const transport = pino.transport({ targets });

// When the log worker dies (a full disk, 2026-11-10) every later write
// emits 'error' on the transport. Without a listener that became an
// uncaught exception, whose handler logged it, which emitted the next
// 'error' — an endless loop that kept the server at ~80 % CPU and made
// every tool call ~20 s slow. Now the first error is reported once on
// stderr and every later line goes to stderr instead of the dead worker.
let fileLogBroken = false;
transport.on('error', (err: Error) => {
  if (fileLogBroken) return;
  fileLogBroken = true;
  try {
    process.stderr.write(
      `[somora] server log stopped (${err.message}); log lines go to stderr until the server restarts\n`,
    );
  } catch {
    /* nowhere left to report */
  }
});
export function fileLogStopped(): boolean {
  return fileLogBroken;
}
const LEVEL_NAMES: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
function writeToStderr(lvl: number, args: unknown[]): void {
  try {
    const first = args[0];
    const line =
      first && typeof first === 'object'
        ? { level: lvl, time: Date.now(), ...(first as Record<string, unknown>), ...(typeof args[1] === 'string' ? { msg: args[1] } : {}) }
        : { level: lvl, time: Date.now(), msg: String(first) };
    process.stderr.write(`${LEVEL_NAMES[lvl] ?? lvl} ${JSON.stringify(line)}\n`);
  } catch {
    /* a log line never throws */
  }
}

// Listeners that read structured log lines as they are written — the
// inbox (src/server/inbox-sources.ts) turns some of them into notices.
// A listener must be cheap and must not throw; it never changes the line.
type LogListener = (level: number, line: Record<string, unknown>) => void;
const logListeners = new Set<LogListener>();
export function onLog(listener: LogListener): () => void {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}

export const logger: Logger = pino(
  {
    level,
    base: undefined,
    hooks: {
      logMethod(args, method, lvl) {
        if (logListeners.size > 0 && args[0] && typeof args[0] === 'object') {
          for (const l of logListeners) {
            try {
              l(lvl, args[0] as Record<string, unknown>);
            } catch {
              /* a listener never breaks logging */
            }
          }
        }
        if (fileLogBroken) {
          writeToStderr(lvl, args);
          return;
        }
        return method.apply(this, args as Parameters<typeof method>);
      },
    },
  },
  transport,
);
export const SOMORA_HOME_DIR = SOMORA_HOME;
