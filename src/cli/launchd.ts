// macOS background service: a per-user LaunchAgent, the counterpart of
// the systemd user unit on Linux.
//
//   init      writes ~/Library/LaunchAgents/ai.somora.server.plist
//   start     launchctl bootstrap   (loads it; RunAtLoad starts the server)
//   stop      launchctl bootout
//   restart   bootout + bootstrap   (also picks up a rewritten plist)
//
// Once the plist is in LaunchAgents, macOS loads it at every login of
// that user — that is the autostart. A LaunchAgent never runs before
// the user has logged in; a Mac used as a server needs automatic login.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export const LAUNCHD_LABEL = 'ai.somora.server';

export function launchdPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface PlistOpts {
  binPath: string;
  /** Directories for the service's PATH, most specific first. */
  pathDirs: string[];
  home: string;
  logPath: string;
}

export function buildLaunchdPlist(o: PlistOpts): string {
  const str = (s: string): string => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(LAUNCHD_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${str(o.binPath)}
    <string>server</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    ${str(o.pathDirs.join(':'))}
    <key>HOME</key>
    ${str(o.home)}
  </dict>
  <key>WorkingDirectory</key>
  ${str(o.home)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  ${str(o.logPath)}
  <key>StandardErrorPath</key>
  ${str(o.logPath)}
</dict>
</plist>
`;
}

/** The directory `node` is found in on this PATH — the stable one
 *  (`/opt/homebrew/bin`), not the versioned folder process.execPath
 *  resolves to, which a `brew upgrade` deletes. */
export function nodeDirOnPath(envPath: string = process.env.PATH ?? '', exists: (p: string) => boolean = existsSync): string {
  for (const dir of envPath.split(delimiter)) {
    if (dir && exists(join(dir, 'node'))) return dir;
  }
  return dirname(process.execPath);
}

const MAC_SYSTEM_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export function launchdPathDirs(nodeDir: string, npmBinDir: string | null, home: string): string[] {
  return [nodeDir, ...(npmBinDir ? [npmBinDir] : []), `${home}/.local/bin`, ...MAC_SYSTEM_DIRS].filter((d, i, a) => a.indexOf(d) === i);
}

/** Write the plist when it differs. Returns what happened. */
export function writeLaunchdPlist(binPath: string, npmBinDir: string | null, somoraHome: string): 'created' | 'updated' | 'kept' {
  const home = homedir();
  const path = launchdPlistPath(home);
  const text = buildLaunchdPlist({
    binPath,
    pathDirs: launchdPathDirs(nodeDirOnPath(), npmBinDir, home),
    home,
    logPath: join(somoraHome, 'logs', 'launchd.log'),
  });
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(somoraHome, 'logs'), { recursive: true });
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (before === text) return 'kept';
  writeFileSync(path, text);
  return before === null ? 'created' : 'updated';
}

function launchctl(args: string[]): { code: number; out: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { code: r.error ? 127 : (r.status ?? 1), out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** `gui/<uid>` when the user has a desktop session (the normal case),
 *  else the plain per-user domain (ssh-only login). */
export function launchdDomain(): string {
  const uid = userInfo().uid;
  return launchctl(['print', `gui/${uid}`]).code === 0 ? `gui/${uid}` : `user/${uid}`;
}

export function launchdAvailable(): boolean {
  return process.platform === 'darwin';
}

export function launchdLoaded(): boolean {
  return launchctl(['print', `${launchdDomain()}/${LAUNCHD_LABEL}`]).code === 0;
}

export function launchdPid(): number | null {
  const r = launchctl(['print', `${launchdDomain()}/${LAUNCHD_LABEL}`]);
  const m = r.code === 0 ? r.out.match(/^\s*pid = (\d+)/m) : null;
  return m ? Number(m[1]) : null;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function launchdStop(): { ok: boolean; detail: string } {
  if (!launchdLoaded()) return { ok: true, detail: 'not loaded' };
  const r = launchctl(['bootout', `${launchdDomain()}/${LAUNCHD_LABEL}`]);
  // bootout returns before the job is gone; wait so a following
  // bootstrap does not hit "operation already in progress".
  for (let i = 0; i < 40 && launchdLoaded(); i++) sleepMs(250);
  return { ok: !launchdLoaded(), detail: r.out };
}

export function launchdStart(): { ok: boolean; detail: string } {
  if (launchdLoaded()) {
    // Loaded but maybe not running (crashed, throttled): kick it.
    const k = launchctl(['kickstart', `${launchdDomain()}/${LAUNCHD_LABEL}`]);
    return { ok: k.code === 0, detail: k.out };
  }
  let r = { code: 1, out: '' };
  for (let i = 0; i < 8; i++) {
    r = launchctl(['bootstrap', launchdDomain(), launchdPlistPath()]);
    if (r.code === 0) return { ok: true, detail: '' };
    sleepMs(500);
  }
  return { ok: false, detail: r.out };
}

export function launchdRestart(): { ok: boolean; detail: string } {
  const s = launchdStop();
  if (!s.ok) return s;
  return launchdStart();
}
