// Top-level somora CLI — `somora <subcommand>`.
//
// Subcommands:
//   init                              idempotent setup (~/.somora/, systemd unit)
//   server start [--foreground]
//   server stop
//   server status
//   server restart
//   tui                               launch TUI against running server
//   update [<version>] [--edge]       install + rebake systemd + restart
//                                     (see `somora update --help`)
//   --version | -v
//   --help | -h
//
// See DECISIONS #42.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOMORA_VERSION } from '../version.ts';
import { buildSystemdUnit, extractCustomEnvLines } from './systemd-unit.ts';

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
  somora auth status|sync            shared claude-cli login: inspect / reconcile
                                     the two credential stores
  somora update [<version>|--edge]   install + rebake systemd + restart
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

  ensureDir(SYSTEMD_USER_DIR);
  // Preserve operator-added Environment= / EnvironmentFile= lines across
  // the rebake — otherwise a `somora update` silently drops e.g.
  // SOMORA_HOST=0.0.0.0 and the server falls back to loopback, locking
  // out LAN/Tailscale clients (2026-07-23 report).
  const existingUnit = existsSync(SYSTEMD_UNIT_PATH)
    ? readFileSync(SYSTEMD_UNIT_PATH, 'utf8')
    : null;
  const preservedEnv = existingUnit ? extractCustomEnvLines(existingUnit) : [];
  const unitContent = buildSystemdUnit(BIN_PATH, preservedEnv);
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

const SOMORA_REPO = 'thenaxon/somora_agent';
const SOMORA_GIT_URL = `https://github.com/${SOMORA_REPO}.git`;

function updateUsage(): string {
  return `somora update — install a new version + rebake systemd + restart

Usage:
  somora update                latest GitHub release (curated, default)
  somora update --edge         latest git tag (incl. interim status markers)
  somora update <version>      specific version, e.g. 2026.05.12.7
  somora update --no-reinit    skip re-running \`somora init\` after install

Channels:
  --release   default. Installs only versions you've published as
              GitHub Releases — safe path for external users.
  --edge      power-user channel. Installs the latest git tag,
              including between-release status markers.

Other:
  --no-reinit  skip rebaking the systemd unit's ExecStart. Default is
               to re-run \`somora init\` after install so the unit
               points at the freshly installed global binary.
  --help, -h   this help
`;
}

type UpdateOpts =
  | { kind: 'opts'; channel: 'release' | 'edge'; version?: string; reinit: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

function parseUpdateArgs(args: string[]): UpdateOpts {
  let channel: 'release' | 'edge' = 'release';
  let reinit = true;
  let version: string | undefined;
  for (const arg of args) {
    if (arg === '--edge') channel = 'edge';
    else if (arg === '--release') channel = 'release';
    else if (arg === '--no-reinit') reinit = false;
    else if (arg === '--help' || arg === '-h') return { kind: 'help' };
    else if (arg.startsWith('--')) return { kind: 'error', message: `unknown flag: ${arg}` };
    else if (version) return { kind: 'error', message: `multiple version args: ${version}, ${arg}` };
    else version = arg;
  }
  if (version && channel === 'edge') {
    return { kind: 'error', message: '--edge and an explicit version are mutually exclusive' };
  }
  return { kind: 'opts', channel, version, reinit };
}

/** Latest tag from `gh release view`, with a curl fallback to the public
 *  GitHub API. Returns the tag name (e.g. "v2026.05.12.4") or null. */
function resolveLatestRelease(): string | null {
  const gh = run('gh', ['release', 'view', '--repo', SOMORA_REPO, '--json', 'tagName']);
  if (gh.code === 0) {
    try {
      const j = JSON.parse(gh.stdout);
      if (typeof j.tagName === 'string') return j.tagName;
    } catch { /* fall through */ }
  }
  const cr = run('curl', ['-fsSL', `https://api.github.com/repos/${SOMORA_REPO}/releases/latest`]);
  if (cr.code === 0) {
    try {
      const j = JSON.parse(cr.stdout);
      if (typeof j.tag_name === 'string') return j.tag_name;
    } catch { /* fall through */ }
  }
  return null;
}

/** Highest version-sorted tag on the remote. Doesn't require gh — uses
 *  plain git so it works on minimal installs. */
function resolveLatestTag(): string | null {
  const r = run('git', ['ls-remote', '--tags', '--refs', '--sort=-version:refname', SOMORA_GIT_URL]);
  if (r.code !== 0) return null;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/refs\/tags\/(v[0-9][0-9.]*)$/);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** Resolve the freshly-installed global somora bin so reinit fires
 *  against the new binary, not whatever was running before. */
function resolveGlobalBin(): string | null {
  const r = run('npm', ['root', '-g']);
  if (r.code !== 0) return null;
  const candidate = join(r.stdout.trim(), 'somora', 'bin', 'somora.mjs');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Re-resolve the installed package's node_modules in place so the
 * `overrides` in its package.json take effect. npm honours overrides
 * only for the ROOT project — `npm install -g <tgz>` treats somora as
 * a dependency of the global prefix and silently ignores them, which
 * left the live copy on the vulnerable sharp/adm-zip pins the repo had
 * already overridden (2026-09-03). Running `npm install` inside the
 * installed directory makes it the root and applies them; there is no
 * prepare/postinstall script on somora itself, so this only touches
 * node_modules. Non-fatal: a failure leaves a working (if
 * un-overridden) install behind.
 */
function applyPackageOverridesInPlace(): void {
  const r = run('npm', ['root', '-g']);
  if (r.code !== 0) return;
  const pkgDir = join(r.stdout.trim(), 'somora');
  if (!existsSync(join(pkgDir, 'package.json'))) return;
  process.stdout.write('  applying package overrides in the installed copy (npm install --omit=dev)…\n');
  const res = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  if (res.status !== 0) {
    process.stderr.write(`warning: in-place npm install failed (exit ${res.status ?? 'unknown'}) — overrides not applied\n`);
  }
}

async function cmdUpdate(args: string[]): Promise<number> {
  const parsed = parseUpdateArgs(args);
  if (parsed.kind === 'help') { process.stdout.write(updateUsage()); return 0; }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\nrun \`somora update --help\` for usage\n`);
    return 2;
  }
  const { channel, version, reinit } = parsed;

  let ref: string;
  let label: string;
  if (version) {
    ref = version.startsWith('v') ? version : `v${version}`;
    label = `${ref} (explicit version)`;
  } else if (channel === 'edge') {
    const tag = resolveLatestTag();
    if (!tag) {
      process.stderr.write('could not resolve latest git tag from GitHub\n');
      return 1;
    }
    ref = tag;
    label = `${ref} (edge channel — latest git tag)`;
  } else {
    const tag = resolveLatestRelease();
    if (!tag) {
      process.stderr.write(
        'could not resolve latest GitHub release.\n' +
        '  - check connectivity / `gh auth status`\n' +
        '  - if no releases are published yet, try `somora update --edge`\n',
      );
      return 1;
    }
    ref = tag;
    label = `${ref} (release channel — latest GitHub release)`;
  }

  process.stdout.write(`somora update → ${label}\n`);

  // Pack-then-install is the only reliable path:
  //  - `npm install -g git+…#<ref>` races on the shared cacache when
  //    prepack triggers nested `npm ci` inside web/, producing
  //    half-extracted dep tarballs (ENOTEMPTY rename / TAR_ENTRY_ERROR).
  //  - `npm install -g .` from a local dir only symlinks (npm-link
  //    style), so deps + the built web/dist never land in the global.
  // So we clone the target ref, run `npm pack` (which fires prepack
  // → builds web/dist → produces a real tarball with everything
  // baked in), then install that tarball globally.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'somora-update-'));
  const cloneDir = join(tmpRoot, 'src');
  let installCode = 0;
  try {
    process.stdout.write(`  cloning ${ref} into ${cloneDir}\n`);
    const cl = run('git', ['clone', '--depth', '1', '--branch', ref, SOMORA_GIT_URL, cloneDir], { stdio: 'inherit' });
    if (cl.code !== 0) {
      process.stderr.write(`git clone failed (exit ${cl.code})\n`);
      return cl.code;
    }

    process.stdout.write('  packing tarball (builds web bundle)…\n');
    const pk = spawnSync('npm', ['pack'], { cwd: cloneDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
    if (pk.status !== 0) {
      process.stderr.write(`npm pack failed (exit ${pk.status ?? 'unknown'})\n`);
      return pk.status ?? 1;
    }
    // npm pack prints the tarball filename as its last stdout line.
    const tarballName = pk.stdout.trim().split('\n').pop();
    if (!tarballName) {
      process.stderr.write('could not parse tarball name from `npm pack` output\n');
      return 1;
    }
    const tarballPath = join(cloneDir, tarballName);

    process.stdout.write(`  npm install -g ${tarballPath}\n`);
    const ri = run('npm', ['install', '-g', tarballPath], { stdio: 'inherit' });
    installCode = ri.code;
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  if (installCode !== 0) return installCode;
  applyPackageOverridesInPlace();

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
    default:
      process.stderr.write(`unknown command: ${cmd}\n${usage()}`);
      return 2;
  }
}

const code = await main();
process.exit(code);
