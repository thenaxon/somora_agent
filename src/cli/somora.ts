// Top-level somora CLI — `somora <subcommand>`.
//
// Subcommands:
//   init                     idempotent setup (~/.somora/, systemd unit)
//   server start [--foreground]
//   server stop
//   server status
//   server restart
//   tui                      launch TUI against running server
//   update [<version>]       npm install -g somora@<version> + restart
//   --version | -v
//   --help | -h
//
// See DECISIONS #42.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOMORA_VERSION } from '../version.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const LOCKFILE_PATH = join(SOMORA_HOME, 'locks', 'server.lock');
const SYSTEMD_USER_DIR = join(homedir(), '.config', 'systemd', 'user');
const SYSTEMD_UNIT_PATH = join(SYSTEMD_USER_DIR, 'somora.service');
const SYSTEMD_UNIT_NAME = 'somora.service';

// Resolve absolute paths to the somora bin entry and the package root.
// SOMORA_BIN_PATH is set by bin/somora.mjs (the actual entry point);
// process.argv[1] inside tsx points at the .ts source, not the bin —
// hence the env fallback chain.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN_PATH = process.env.SOMORA_BIN_PATH
  ?? resolve(PKG_ROOT, 'bin', 'somora.mjs');

function usage(): string {
  return `somora ${SOMORA_VERSION}

Usage:
  somora init                        idempotent setup (data dir + systemd unit)
  somora server start [--foreground] start the server (via systemd, or direct)
  somora server stop                 stop the running server
  somora server restart              restart via systemd
  somora server status               show server status + lockfile info
  somora tui                         launch the TUI against the running server
  somora skill <subcommand>          list/check/add/update/remove skills
                                     (run \`somora skill\` for sub-help)
  somora update [<version>]          npm install -g somora@<version> + restart
  somora --version                   show version
  somora --help                      this help
`;
}

function run(cmd: string, args: string[], opts: { stdio?: 'inherit' | 'pipe' } = {}): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { stdio: opts.stdio ?? 'pipe', encoding: 'utf8' });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function buildSystemdUnit(): string {
  // ExecStart uses the absolute path to the installed somora binary so
  // systemd doesn't need the user's PATH. --foreground keeps the
  // process attached to systemd (Type=simple).
  return `[Unit]
Description=somora — Local-first AI agent gateway
After=network.target

[Service]
Type=simple
ExecStart=${BIN_PATH} server start --foreground
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function isSystemdAvailable(): boolean {
  const r = run('systemctl', ['--user', '--version']);
  return r.code === 0;
}

function readLockfile(): { pid: number; port: number; host: string; startedAt: string; version: string } | null {
  try {
    const raw = readFileSync(LOCKFILE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

// ─── init ───────────────────────────────────────────────────────────

function cmdInit(): number {
  const created: string[] = [];
  const kept: string[] = [];

  if (!existsSync(SOMORA_HOME)) {
    mkdirSync(SOMORA_HOME, { recursive: true });
    created.push(SOMORA_HOME);
  } else {
    kept.push(SOMORA_HOME);
  }

  const locksDir = join(SOMORA_HOME, 'locks');
  if (!existsSync(locksDir)) {
    mkdirSync(locksDir, { recursive: true });
    created.push(locksDir);
  } else {
    kept.push(locksDir);
  }

  ensureDir(SYSTEMD_USER_DIR);
  const unitContent = buildSystemdUnit();
  let unitChanged = false;
  if (!existsSync(SYSTEMD_UNIT_PATH)) {
    writeFileSync(SYSTEMD_UNIT_PATH, unitContent);
    created.push(SYSTEMD_UNIT_PATH);
    unitChanged = true;
  } else {
    const existing = readFileSync(SYSTEMD_UNIT_PATH, 'utf8');
    if (existing.trim() !== unitContent.trim()) {
      writeFileSync(SYSTEMD_UNIT_PATH, unitContent);
      kept.push(`${SYSTEMD_UNIT_PATH} (updated)`);
      unitChanged = true;
    } else {
      kept.push(SYSTEMD_UNIT_PATH);
    }
  }

  if (unitChanged && isSystemdAvailable()) {
    const r = run('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    if (r.code !== 0) {
      process.stderr.write('warning: systemctl --user daemon-reload failed; you may need to reload manually\n');
    }
  }

  process.stdout.write(`somora init: data dir ${SOMORA_HOME}\n`);
  if (created.length) {
    process.stdout.write('  created:\n');
    for (const c of created) process.stdout.write(`    ${c}\n`);
  }
  if (kept.length) {
    process.stdout.write('  kept:\n');
    for (const k of kept) process.stdout.write(`    ${k}\n`);
  }
  if (!isSystemdAvailable()) {
    process.stdout.write('  note: systemctl --user not available — only `somora server start --foreground` will work\n');
  }
  process.stdout.write('\nNext: `somora server start` to launch the server.\n');
  return 0;
}

// ─── server ─────────────────────────────────────────────────────────

function spawnServerForeground(): Promise<number> {
  const tsxBin = resolve(PKG_ROOT, 'node_modules', '.bin', 'tsx');
  const tsconfigPath = resolve(PKG_ROOT, 'tsconfig.json');
  const serverEntry = resolve(PKG_ROOT, 'src', 'server', 'index.ts');
  const child = spawn(tsxBin, ['--tsconfig', tsconfigPath, serverEntry], { stdio: 'inherit' });
  const fwd = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on('SIGTERM', fwd('SIGTERM'));
  process.on('SIGINT', fwd('SIGINT'));
  return new Promise<number>((res) => {
    child.on('exit', (code) => res(code ?? 0));
  });
}

async function cmdServerStart(args: string[]): Promise<number> {
  const foreground = args.includes('--foreground') || args.includes('-f');

  if (foreground) {
    return await spawnServerForeground();
  }

  if (!isSystemdAvailable()) {
    process.stderr.write('systemctl --user not available. Try: somora server start --foreground\n');
    return 1;
  }
  if (!existsSync(SYSTEMD_UNIT_PATH)) {
    process.stderr.write('systemd unit not installed. Run: somora init\n');
    return 1;
  }
  const r = run('systemctl', ['--user', 'start', SYSTEMD_UNIT_NAME], { stdio: 'inherit' });
  if (r.code !== 0) return r.code;
  process.stdout.write(`somora server started (systemd: ${SYSTEMD_UNIT_NAME}).\n`);
  return 0;
}

function cmdServerStop(): number {
  if (isSystemdAvailable() && existsSync(SYSTEMD_UNIT_PATH)) {
    const r = run('systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME], { stdio: 'inherit' });
    if (r.code === 0) {
      process.stdout.write('somora server stopped.\n');
      return 0;
    }
  }
  // Fallback: kill via lockfile-PID
  const lock = readLockfile();
  if (lock && isPidAlive(lock.pid)) {
    try {
      process.kill(lock.pid, 'SIGTERM');
      process.stdout.write(`sent SIGTERM to pid ${lock.pid}.\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`failed to kill pid ${lock.pid}: ${(err as Error).message}\n`);
      return 1;
    }
  }
  process.stdout.write('no running somora server found.\n');
  return 0;
}

function cmdServerRestart(): number {
  if (!isSystemdAvailable() || !existsSync(SYSTEMD_UNIT_PATH)) {
    process.stderr.write('restart needs systemd unit. Run: somora init\n');
    return 1;
  }
  const r = run('systemctl', ['--user', 'restart', SYSTEMD_UNIT_NAME], { stdio: 'inherit' });
  if (r.code !== 0) return r.code;
  process.stdout.write('somora server restarted.\n');
  return 0;
}

function cmdServerStatus(): number {
  const lock = readLockfile();
  if (lock) {
    const alive = isPidAlive(lock.pid);
    process.stdout.write(`lockfile: ${LOCKFILE_PATH}\n`);
    process.stdout.write(`  pid:        ${lock.pid} (${alive ? 'alive' : 'STALE — process gone'})\n`);
    process.stdout.write(`  port:       ${lock.port}\n`);
    process.stdout.write(`  host:       ${lock.host}\n`);
    process.stdout.write(`  startedAt:  ${lock.startedAt}\n`);
    process.stdout.write(`  version:    ${lock.version}\n`);
  } else {
    process.stdout.write(`lockfile: ${LOCKFILE_PATH} (none — no server running)\n`);
  }
  if (isSystemdAvailable() && existsSync(SYSTEMD_UNIT_PATH)) {
    process.stdout.write('\n');
    run('systemctl', ['--user', 'status', SYSTEMD_UNIT_NAME, '--no-pager'], { stdio: 'inherit' });
  }
  return 0;
}

async function cmdServer(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'start':
      return await cmdServerStart(rest);
    case 'stop':
      return cmdServerStop();
    case 'restart':
      return cmdServerRestart();
    case 'status':
      return cmdServerStatus();
    default:
      process.stderr.write(`unknown subcommand: somora server ${sub ?? ''}\n${usage()}`);
      return 2;
  }
}

// ─── tui ─────────────────────────────────────────────────────────────

function cmdTui(): Promise<number> {
  const tsxBin = resolve(PKG_ROOT, 'node_modules', '.bin', 'tsx');
  const tsconfigPath = resolve(PKG_ROOT, 'tsconfig.json');
  const tuiEntry = resolve(PKG_ROOT, 'src', 'cli', 'tui', 'index.tsx');
  const child = spawn(tsxBin, ['--tsconfig', tsconfigPath, tuiEntry], { stdio: 'inherit' });
  return new Promise<number>((res) => {
    child.on('exit', (code) => res(code ?? 0));
  });
}

// ─── update ─────────────────────────────────────────────────────────

async function cmdUpdate(args: string[]): Promise<number> {
  const target = args[0]; // optional version, e.g. "2026.05.08.2"
  const pkgSpec = target ? `somora@${target}` : 'somora@latest';

  process.stdout.write(`somora update: npm install -g ${pkgSpec}\n`);
  const r = run('npm', ['install', '-g', pkgSpec], { stdio: 'inherit' });
  if (r.code !== 0) return r.code;

  if (isSystemdAvailable() && existsSync(SYSTEMD_UNIT_PATH)) {
    process.stdout.write('restarting systemd service…\n');
    return cmdServerRestart();
  }
  process.stdout.write('done. Restart any running server manually.\n');
  return 0;
}

// ─── main ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(usage());
    return argv.length === 0 ? 1 : 0;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${SOMORA_VERSION}\n`);
    return 0;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'init':
      return cmdInit();
    case 'server':
      return await cmdServer(rest);
    case 'tui':
      return await cmdTui();
    case 'skill': {
      const { runSkillCli } = await import('./skill.ts');
      return await runSkillCli(rest);
    }
    case 'update':
      return await cmdUpdate(rest);
    default:
      process.stderr.write(`unknown command: ${cmd}\n${usage()}`);
      return 2;
  }
}

const code = await main();
process.exit(code);
