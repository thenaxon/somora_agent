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

const transport = pino.transport({
  targets: [
    { target: 'pino/file', options: { destination: logFile, mkdir: true }, level },
    isTty
      ? { target: 'pino-pretty', options: { destination: 1, colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }, level }
      : { target: 'pino/file', options: { destination: 1 }, level },
  ],
});

export const logger: Logger = pino({ level, base: undefined }, transport);
export const SOMORA_HOME_DIR = SOMORA_HOME;
