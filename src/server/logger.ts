import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const LOG_DIR = join(SOMORA_HOME, 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const logFile = join(LOG_DIR, `server-${today}.log`);

const level = process.env.SOMORA_LOG_LEVEL ?? 'info';
const isTty = Boolean(process.stdout.isTTY);

// File target is unconditional — the canonical log channel.
// stdout target is ONLY added when stdout is a TTY (i.e. someone is
// running `npm run dev:server` in a terminal and wants the live
// pino-pretty output). When stdout is a pipe — e.g. the somora MCP
// server spawned as a child by claude-cli/codex-cli, where stdout is
// the JSON-RPC stream to the parent — writing pino JSON to it would
// corrupt the protocol stream and silently break tool registration.
// Logs in that case still go to ~/.somora/logs/server-YYYY-MM-DD.log.
const targets: pino.TransportTargetOptions[] = [
  { target: 'pino/file', options: { destination: logFile, mkdir: true }, level },
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
