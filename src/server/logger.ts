import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
mkdirSync(LOG_DIR, { recursive: true });

const level = process.env.SOMORA_LOG_LEVEL ?? 'info';
const isTty = Boolean(process.stdout.isTTY);

// File target uses `pino-roll` so events after midnight land in the
// new day's file even when the server has been running for days.
// `frequency: 'daily'` rolls at 00:00 local; `dateFormat: 'yyyy-MM-dd'`
// produces `server.YYYY-MM-DD.log`; `file: 'server'` is the basename.
// Pre-fix behavior: filename was chosen exactly once at module load
// (`new Date().toISOString().slice(0,10)`), so an overnight server
// kept writing 2026-05-14 events into `server-2026-05-13.log` until
// restart. Hans 2026-05-14 forensics report.
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

export const logger: Logger = pino({ level, base: undefined }, transport);
export const SOMORA_HOME_DIR = SOMORA_HOME;
