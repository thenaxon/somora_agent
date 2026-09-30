// Top-level somora CLI — `somora <subcommand>`.
//
// Subcommands:
//   setup [step]                      guided first-run assistant (src/cli/setup.ts)
//   init                              idempotent setup (~/.somora/, systemd unit)
//   server start [--foreground]
//   server stop
//   server status
//   server restart
//   tui                               launch TUI against running server
//   update [<version>] [--edge]       install from npm + rebake systemd + restart
//                                     (see `somora update --help`)
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
import { buildSystemdUnit, extractCustomEnvLines, nodePathLine } from './systemd-unit.ts';
import { allowScriptsArgs, compareVersions, parseUpdateArgs } from './update-args.ts';
import {
  LAUNCHD_LABEL, launchdAvailable, launchdLoaded, launchdPid, launchdPlistPath, launchdRestart, launchdStart,
  launchdStop, nodeDirOnPath, writeLaunchdPlist,
} from './launchd.ts';
// Plain-ESM helper shared with bin/somora.mjs (must run on the Node we reject).
import { nodeUpgradeHint, satisfiesNode } from '../../bin/node-version.mjs';

// CLI commands talk to the person on this terminal; the logger's pretty
// stdout lines belong to the foreground server only (it gets the
// variable removed again, see serverChildEnv).
process.env.SOMORA_LOG_TTY = '0';
function serverChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SOMORA_LOG_TTY;
  return env;
}

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
  somora setup [step]                the guided assistant: models, first agent, memory,
                                     team, HTTPS — safe to run again (\`somora setup --help\`)
  somora init                        data dir + background service: systemd unit on Linux,
                                     LaunchAgent on macOS (idempotent)
  somora server start [--foreground] start the server (as a service, or direct)
  somora server stop                 stop the running server
  somora server restart              restart the service
  somora server status               show server status + lockfile info
  somora tui                         launch the TUI against the running server
  somora skill <subcommand>          list/check/add/update/remove skills
                                     (run \`somora skill\` for sub-help)
  somora auth status|sync            shared claude-cli login: inspect / reconcile
                                     the two credential stores
  somora codex [args...]             run the bundled Codex CLI (e.g. \`somora codex login\`,
                                     \`somora codex debug models\`); somora mirrors the login
  somora team init|check|show <a>    team.yaml: bootstrap from the agents on disk, validate,
                                     print the "# Your team" block an agent sees
  somora lsp status|install [id…]    language servers for builder agents (docs/lsp.md):
                                     what is installed, install with npm into ~/.somora/lsp
  somora wiki migrate [step] [id]    move a grown wiki onto the folder template (docs/wiki.md):
                                     guided, or plan|judge|status|approve|dry-run|run|undo
  somora update [<version>|--edge]   install from npm + rebake systemd + restart
                                     (run \`somora update --help\` for options)
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

  if (launchdAvailable()) return cmdInitLaunchd(created, kept);

  ensureDir(SYSTEMD_USER_DIR);
  // Preserve operator-added Environment= / EnvironmentFile= lines across
  // the rebake — otherwise a `somora update` silently drops e.g.
  // SOMORA_HOST=0.0.0.0 and the server falls back to loopback, locking
  // out LAN/Tailscale clients (2026-07-23 report).
  const existingUnit = existsSync(SYSTEMD_UNIT_PATH)
    ? readFileSync(SYSTEMD_UNIT_PATH, 'utf8')
    : null;
  const preservedEnv = existingUnit ? extractCustomEnvLines(existingUnit) : [];
  const npmBinDir = npmBinDirOf(BIN_PATH);
  const unitContent = buildSystemdUnit(BIN_PATH, preservedEnv, nodePathLine(nodeDirOnPath(), homedir(), npmBinDir));
  let unitChanged = false;
  if (existingUnit === null) {
    writeFileSync(SYSTEMD_UNIT_PATH, unitContent);
    created.push(SYSTEMD_UNIT_PATH);
    unitChanged = true;
  } else if (existingUnit.trim() !== unitContent.trim()) {
    writeFileSync(SYSTEMD_UNIT_PATH, unitContent);
    kept.push(`${SYSTEMD_UNIT_PATH} (updated)`);
    unitChanged = true;
  } else {
    kept.push(SYSTEMD_UNIT_PATH);
  }
  if (preservedEnv.length) {
    process.stdout.write(`  preserved custom systemd env: ${preservedEnv.join(', ')}\n`);
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

  // Footgun guard: BIN_PATH baked into the unit points at whichever
  // copy of somora ran `init`. If the user ran `somora init` from a
  // dev checkout, the unit pins to that checkout — `npm install -g`
  // tarball updates won't take effect because systemd keeps launching
  // the checkout binary. Warn so the user can re-run init from the
  // global install if that wasn't intentional.
  if (!looksLikeGlobalNpmInstall(BIN_PATH)) {
    const warn = (s: string) => (process.stderr.isTTY ? `\x1b[33m${s}\x1b[0m` : s);
    process.stderr.write('\n');
    process.stderr.write(warn('  ! heads up: ExecStart in the unit points at a non-global path:\n'));
    process.stderr.write(warn(`      ${BIN_PATH}\n`));
    process.stderr.write(warn('    Typical global installs live under .../lib/node_modules/somora/.\n'));
    process.stderr.write(warn('    If this is your dev checkout — fine, ignore.\n'));
    process.stderr.write(warn('    If you meant to install via `npm install -g`, re-run `somora init`\n'));
    process.stderr.write(warn('    from the global binary so the unit picks up the right path:\n'));
    process.stderr.write(warn('      $(npm root -g)/somora/bin/somora.mjs init\n'));
    process.stderr.write(warn('    then `systemctl --user daemon-reload && systemctl --user restart somora.service`\n'));
  }

  process.stdout.write('\nNext: `somora server start` to launch the server.\n');
  return 0;
}

function npmBinDirOf(binPath: string): string | null {
  return looksLikeGlobalNpmInstall(binPath) ? resolve(dirname(binPath), '..', '..', '..', '..', 'bin') : null;
}

/** macOS: the LaunchAgent instead of the systemd unit. */
function cmdInitLaunchd(created: string[], kept: string[]): number {
  const plist = launchdPlistPath();
  const what = writeLaunchdPlist(BIN_PATH, npmBinDirOf(BIN_PATH), SOMORA_HOME);
  if (what === 'created') created.push(plist);
  else kept.push(what === 'updated' ? `${plist} (updated)` : plist);
  process.stdout.write(`somora init: data dir ${SOMORA_HOME}\n`);
  if (created.length) {
    process.stdout.write('  created:\n');
    for (const c of created) process.stdout.write(`    ${c}\n`);
  }
  if (kept.length) {
    process.stdout.write('  kept:\n');
    for (const k of kept) process.stdout.write(`    ${k}\n`);
  }
  if (what === 'updated' && launchdLoaded()) {
    process.stdout.write('  the service definition changed — `somora server restart` applies it\n');
  }
  process.stdout.write('\nNext: `somora server start` to launch the server (it then starts at every login).\n');
  return 0;
}

/** Heuristic: does this absolute path look like it came from an npm
 *  global install (or an `npm link` setup that targets one)? The
 *  canonical marker is `/lib/node_modules/somora/` somewhere in the
 *  path. A pure dev checkout (`/home/<user>/somora/bin/...`) doesn't
 *  match — that's the case the warning is designed to catch. */
function looksLikeGlobalNpmInstall(absPath: string): boolean {
  return absPath.includes('/lib/node_modules/somora/');
}

// ─── server ─────────────────────────────────────────────────────────

function spawnServerForeground(): Promise<number> {
  const tsxBin = resolve(PKG_ROOT, 'node_modules', '.bin', 'tsx');
  const tsconfigPath = resolve(PKG_ROOT, 'tsconfig.json');
  const serverEntry = resolve(PKG_ROOT, 'src', 'server', 'index.ts');
  const child = spawn(tsxBin, ['--tsconfig', tsconfigPath, serverEntry], { stdio: 'inherit', env: serverChildEnv() });
  let stopping = false;
  const fwd = (sig: NodeJS.Signals) => () => { stopping = true; child.kill(sig); };
  process.on('SIGTERM', fwd('SIGTERM'));
  process.on('SIGINT', fwd('SIGINT'));
  return new Promise<number>((res) => {
    // A server that was killed (OOM, kill -9) has no exit code. Unless we
    // asked it to stop, that is a failure — reporting 0 would tell
    // systemd (Restart=on-failure) and launchd (KeepAlive) not to bring
    // it back.
    child.on('exit', (code) => res(code ?? (stopping ? 0 : 1)));
  });
}

async function cmdServerStart(args: string[]): Promise<number> {
  const foreground = args.includes('--foreground') || args.includes('-f');

  if (foreground) {
    return await spawnServerForeground();
  }

  if (launchdAvailable()) {
    if (!existsSync(launchdPlistPath())) {
      process.stderr.write('service not installed. Run: somora init\n');
      return 1;
    }
    const r = launchdStart();
    if (!r.ok) {
      process.stderr.write(`launchctl could not start the service: ${r.detail}\nTry: somora server start --foreground\n`);
      return 1;
    }
    process.stdout.write(`somora server started (launchd: ${LAUNCHD_LABEL}; starts at every login).\n`);
    return 0;
  }
  if (!isSystemdAvailable()) {
    process.stderr.write('systemctl --user not available. Try: somora server start --foreground\n');
    return 1;
  }
  if (!existsSync(SYSTEMD_UNIT_PATH)) {
    process.stderr.write('systemd unit not installed. Run: somora init\n');
    return 1;
  }
  // enable = come back after a reboot; start alone would not.
  run('systemctl', ['--user', 'enable', SYSTEMD_UNIT_NAME]);
  const r = run('systemctl', ['--user', 'start', SYSTEMD_UNIT_NAME], { stdio: 'inherit' });
  if (r.code !== 0) return r.code;
  process.stdout.write(`somora server started (systemd: ${SYSTEMD_UNIT_NAME}).\n`);
  return 0;
}

function cmdServerStop(): number {
  if (launchdAvailable() && launchdLoaded()) {
    const r = launchdStop();
    if (r.ok) {
      process.stdout.write('somora server stopped (it starts again at the next login; `somora server start` sooner).\n');
      return 0;
    }
  }
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
  if (launchdAvailable()) {
    if (!existsSync(launchdPlistPath())) {
      process.stderr.write('restart needs the service. Run: somora init\n');
      return 1;
    }
    const r = launchdRestart();
    if (!r.ok) {
      process.stderr.write(`launchctl could not restart the service: ${r.detail}\n`);
      return 1;
    }
    process.stdout.write('somora server restarted.\n');
    return 0;
  }
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
  if (launchdAvailable()) {
    const installed = existsSync(launchdPlistPath());
    const pid = installed ? launchdPid() : null;
    process.stdout.write(`\nservice (launchd ${LAUNCHD_LABEL}): ${!installed ? 'not installed — run `somora init`' : launchdLoaded() ? `loaded${pid ? `, running as pid ${pid}` : ', not running'}` : 'installed, not loaded — `somora server start`'}\n`);
  } else if (isSystemdAvailable() && existsSync(SYSTEMD_UNIT_PATH)) {
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

const SOMORA_NPM_NAME = 'somora';

function updateUsage(): string {
  return `somora update — install a new version from npm + rebake systemd + restart

Usage:
  somora update                latest release (npm dist-tag "latest", default)
  somora update --edge         newest build, including pre-releases (dist-tag "next")
  somora update <version>      specific version, e.g. 2026.930.1
  somora update --force        reinstall even when that version is already running
  somora update --no-reinit    skip re-running \`somora init\` after install

Channels:
  --release   default. Installs the version published as the current
              release — safe path for external users.
  --edge      power-user channel. Installs whatever is newest on npm,
              which may be a build between releases.

Other:
  --no-reinit  skip rebaking the systemd unit's ExecStart. Default is
               to re-run \`somora init\` after install so the unit
               points at the freshly installed global binary.
  --help, -h   this help
`;
}

interface NpmTarget { version: string; node?: string }

/** Ask the registry what `somora@<spec>` resolves to. `spec` is a
 *  dist-tag or an exact version. */
function npmView(spec: string): NpmTarget | null {
  const r = run('npm', ['view', `${SOMORA_NPM_NAME}@${spec}`, 'version', 'engines', '--json']);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  try {
    const j = JSON.parse(r.stdout) as { version?: string; engines?: { node?: string } };
    if (typeof j.version !== 'string') return null;
    return { version: j.version, node: j.engines?.node };
  } catch {
    return null;
  }
}

/** Resolve the freshly-installed global somora bin so reinit fires
 *  against the new binary, not whatever was running before. */
function resolveGlobalBin(): string | null {
  const r = run('npm', ['root', '-g']);
  if (r.code !== 0) return null;
  const candidate = join(r.stdout.trim(), 'somora', 'bin', 'somora.mjs');
  return existsSync(candidate) ? candidate : null;
}

async function cmdUpdate(args: string[]): Promise<number> {
  const parsed = parseUpdateArgs(args);
  if (parsed.kind === 'help') { process.stdout.write(updateUsage()); return 0; }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\nrun \`somora update --help\` for usage\n`);
    return 2;
  }
  const { channel, version, reinit, force } = parsed;

  let target: NpmTarget | null;
  let label: string;
  if (version) {
    target = npmView(version);
    if (!target) {
      process.stderr.write(`somora ${version} was not found on npm (check the number and your connection)\n`);
      return 1;
    }
    label = `${target.version} (explicit version)`;
  } else {
    const latest = npmView('latest');
    if (!latest) {
      process.stderr.write(
        'could not ask npm for the latest somora version.\n' +
        '  - check connectivity: `npm view somora version`\n',
      );
      return 1;
    }
    target = latest;
    label = `${latest.version} (release channel)`;
    if (channel === 'edge') {
      // "next" only moves when a pre-release is published, so it can be
      // older than "latest" — edge means whichever is newer.
      const next = npmView('next');
      if (next && compareVersions(next.version, latest.version) > 0) target = next;
      label = `${target.version} (edge channel)`;
    }
  }

  process.stdout.write(`somora update → ${label}\n`);

  if (target.version === SOMORA_VERSION && !force) {
    process.stdout.write(`already on ${SOMORA_VERSION} — nothing to do (use --force to reinstall)\n`);
    return 0;
  }

  // The target may require a newer Node than the one running this
  // (older) CLI. Check BEFORE installing: afterwards the new bin would
  // refuse to start and the old one is gone.
  if (target.node && !satisfiesNode(target.node, process.versions.node)) {
    process.stderr.write(`\n${label} needs a newer Node.js than this machine has — update aborted before installing.\n`);
    process.stderr.write(nodeUpgradeHint(target.node, process.versions.node, process.execPath));
    return 1;
  }

  // The package ships npm-shrinkwrap.json, so the dependency tree —
  // including the security overrides — is the one the release was
  // tested with; no in-place re-resolve needed afterwards.
  const spec = `${SOMORA_NPM_NAME}@${target.version}`;
  process.stdout.write(`  npm install -g ${spec}\n`);
  const allow = allowScriptsArgs(run('npm', ['config', 'get', 'allow-scripts']).stdout);
  const ri = spawnSync('npm', ['install', '-g', '--no-audit', '--no-fund', ...allow, spec], { encoding: 'utf8', stdio: ['inherit', 'inherit', 'pipe'] });
  if (ri.stderr) process.stderr.write(ri.stderr);
  if (ri.status !== 0) {
    if (/EACCES/.test(ri.stderr ?? '')) {
      process.stderr.write(
        '\nnpm may not write to its global folder. Either run the installer again\n' +
        '(it moves the global folder into your home directory):\n' +
        '  curl -fsSL https://somora.ai/install.sh | bash\n' +
        'or do it by hand: `npm config set prefix ~/.npm-global` and add ~/.npm-global/bin to PATH.\n',
      );
    }
    return ri.status ?? 1;
  }

  // Re-run init from the freshly-installed global binary so the
  // systemd unit's ExecStart picks up the new path. Without this,
  // a unit that was originally baked from a dev checkout keeps
  // launching the old binary even after `npm install -g` succeeds.
  if (reinit) {
    const globalBin = resolveGlobalBin();
    if (globalBin) {
      process.stdout.write(`\nrebaking systemd ExecStart via init at ${globalBin}\n`);
      const ir = run(process.execPath, [globalBin, 'init'], { stdio: 'inherit' });
      if (ir.code !== 0) {
        process.stderr.write('warning: somora init failed — systemd unit may still point at the old binary\n');
      }
    } else {
      process.stderr.write('warning: could not locate global somora binary — skipping reinit (run `somora init` manually)\n');
    }
  }

  if (launchdAvailable() && existsSync(launchdPlistPath())) {
    if (!launchdLoaded()) {
      process.stdout.write('\ndone. The service is not running — start it with `somora server start`.\n');
      return 0;
    }
    process.stdout.write('\nrestarting the service…\n');
    return cmdServerRestart();
  }
  if (isSystemdAvailable() && existsSync(SYSTEMD_UNIT_PATH)) {
    process.stdout.write('\nrestarting systemd service…\n');
    return cmdServerRestart();
  }
  process.stdout.write('\ndone. Restart any running server manually.\n');
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
    case 'auth': {
      const { runAuthCli } = await import('./auth.ts');
      return runAuthCli(rest);
    }
    case 'update':
      return await cmdUpdate(rest);
    case 'codex': {
      const { runCodexCli } = await import('./codex.ts');
      return await runCodexCli(rest);
    }
    case 'team': {
      const { runTeamCli } = await import('./team.ts');
      return await runTeamCli(rest);
    }
    case 'lsp': {
      const { runLspCli } = await import('./lsp.ts');
      return await runLspCli(rest);
    }
    case 'setup': {
      const { runSetupCli } = await import('./setup.ts');
      return await runSetupCli(rest);
    }
    case 'wiki': {
      const { runWikiCli } = await import('./wiki.ts');
      return await runWikiCli(rest);
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n${usage()}`);
      return 2;
  }
}

const code = await main();
process.exit(code);
