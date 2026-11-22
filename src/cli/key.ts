// `somora key` — the login key of this installation (docs/security.md).
//
//   somora key [show]          print the key
//   somora key link            a link that signs a browser in, plus a QR
//                              code for the phone; opens the browser when
//                              this machine has a screen (--no-open: don't)
//   somora key rotate          a new key: every browser and script needs it
//                              again; the running server picks it up itself

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from '../config/yaml.ts';
import { ensureKeyFile, generateKey, keyFilePath, writeKeyFile } from '../server/auth-key.ts';

function usage(): string {
  return `somora key — the login key of this installation

Usage:
  somora key [show]           print the key
  somora key link [--no-open] a link that signs a browser in, and a QR code
                              for the phone; opens the browser here if this
                              machine has a screen
  somora key rotate           make a new key; browsers sign in again, scripts
                              need the new one; the server picks it up itself

Programs send it as "Authorization: Bearer <key>". With server.auth: off in
config.yaml the server does not ask for it.
`;
}

interface ServerInfo {
  port: number;
  host: string;
  publicHost?: string;
  auth: 'on' | 'off';
}

function serverInfo(): ServerInfo {
  const home = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  const info: ServerInfo = { port: 18737, host: '127.0.0.1', auth: 'on' };
  try {
    const raw = parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8')) as {
      server?: { port?: unknown; host?: unknown; auth?: unknown; tls?: { publicHost?: unknown } };
    } | null;
    const s = raw?.server;
    if (typeof s?.port === 'number') info.port = s.port;
    if (typeof s?.host === 'string') info.host = s.host;
    if (s?.auth === 'off') info.auth = 'off';
    if (typeof s?.tls?.publicHost === 'string') info.publicHost = s.tls.publicHost;
  } catch {
    /* defaults */
  }
  if (process.env.SOMORA_PORT) info.port = Number(process.env.SOMORA_PORT);
  return info;
}

/** Addresses a browser can open: the HTTPS name, else loopback plus —
 *  when the server listens on every interface — this machine's LAN
 *  addresses for the phone. */
export function browserBases(info: ServerInfo, lan = lanAddresses()): { local: string; phone: string } {
  if (info.publicHost) {
    const base = `https://${info.publicHost}:${info.port}`;
    return { local: base, phone: base };
  }
  const local = `http://127.0.0.1:${info.port}`;
  const open = info.host === '0.0.0.0' || info.host === '::';
  return { local, phone: open && lan[0] ? `http://${lan[0]}:${info.port}` : local };
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((rows) => rows ?? [])
    .filter((r) => r.family === 'IPv4' && !r.internal)
    .map((r) => r.address);
}

function hasScreen(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function openBrowser(url: string): boolean {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function qr(text: string): Promise<string> {
  const QRCode = (await import('qrcode')).default;
  return QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
}

/** Said once, when an installation gets its key: on the first
 *  `somora init` of a version with the key — which `somora update`
 *  runs from the NEW version, so updaters from older releases see it. */
export function newKeyNotice(): string | null {
  if (serverInfo().auth === 'off') return null;
  return (
    '\n' +
    '  ┌──────────────────────────────────────────────────────────────────┐\n' +
    '  │ somora now asks for a key. Programs here (TUI, somora commands,  │\n' +
    '  │ agents) use it on their own. Each browser and phone signs in     │\n' +
    '  │ once — run in a terminal:                                        │\n' +
    '  │                                                                  │\n' +
    '  │     somora key link     a link to open, and a QR code to scan    │\n' +
    '  │     somora key          the key, for scripts:                    │\n' +
    '  │                         -H "Authorization: Bearer <key>"         │\n' +
    '  │                                                                  │\n' +
    '  │ Switch it off with  server.auth: off  in ~/.somora/config.yaml   │\n' +
    '  └──────────────────────────────────────────────────────────────────┘\n'
  );
}

/**
 * The sign-in links one by one, for the setup assistant: the browser's,
 * the phone's, whether the phone can reach this machine at all (not when
 * somora answers only on 127.0.0.1), and the phone link as a QR code.
 */
export async function signInParts(): Promise<{ webLink: string; phoneLink: string; phoneBase: string; phoneReachable: boolean; authOff: boolean; qr: string; openWeb: () => boolean }> {
  const info = serverInfo();
  const { key } = ensureKeyFile();
  const { local, phone } = browserBases(info);
  const phoneLink = `${phone}/mobile/#key=${key}`;
  const webLink = `${local}/web/#key=${key}`;
  return {
    webLink,
    phoneLink,
    phoneBase: phone,
    phoneReachable: !/^http:\/\/127\.0\.0\.1[:/]/.test(phone),
    authOff: info.auth === 'off',
    qr: await qr(info.auth === 'off' ? `${phone}/mobile/` : phoneLink),
    openWeb: () => hasScreen() && openBrowser(webLink),
  };
}

export async function runKeyCli(args: string[]): Promise<number> {
  const [sub = 'show', ...rest] = args;
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(usage());
    return 0;
  }
  const info = serverInfo();
  if (sub === 'show') {
    const { key } = ensureKeyFile();
    process.stdout.write(`${key}\n`);
    if (info.auth === 'off' && process.stderr.isTTY) process.stderr.write('(server.auth is off: the server does not ask for it)\n');
    return 0;
  }
  if (sub === 'link') {
    const { key } = ensureKeyFile();
    const { local, phone } = browserBases(info);
    const webLink = `${local}/web/#key=${key}`;
    const phoneLink = `${phone}/mobile/#key=${key}`;
    process.stdout.write(`Open this link once to sign a browser in:\n\n  ${webLink}\n\nOn the phone (scan, or open ${phone}/mobile/ and paste the key):\n\n`);
    process.stdout.write(await qr(phoneLink));
    process.stdout.write(`\nAnyone with this link can use somora — don't share it.\n`);
    if (info.auth === 'off') process.stdout.write('Note: server.auth is off, so the server does not ask for the key.\n');
    if (!rest.includes('--no-open') && hasScreen() && openBrowser(webLink)) {
      process.stdout.write('Opened in your browser.\n');
    }
    return 0;
  }
  if (sub === 'rotate') {
    const key = generateKey();
    writeKeyFile(key);
    process.stdout.write(
      `New key written to ${keyFilePath()}:\n\n  ${key}\n\n` +
        'The running server switches to it within seconds. Every browser signs in again\n' +
        '(somora key link), and scripts need the new key.\n',
    );
    return 0;
  }
  process.stderr.write(`unknown subcommand: ${sub}\n\n${usage()}`);
  return 2;
}
