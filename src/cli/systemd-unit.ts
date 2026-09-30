// Pure helpers for generating + preserving the somora systemd user unit.
// Extracted from somora.ts so they can be unit-tested without importing
// the CLI entry point (which runs main() + process.exit on import).

/** Build the systemd user-unit text.
 *
 *  `extraEnvLines` carries forward operator-added `Environment=` /
 *  `EnvironmentFile=` lines from an existing unit (see extractCustomEnvLines).
 *  Without this, a `somora update` rebake would silently drop e.g.
 *  `Environment=SOMORA_HOST=0.0.0.0`, dropping the server back to the
 *  loopback default and locking out LAN/Tailscale clients. */
export function buildSystemdUnit(binPath: string, extraEnvLines: string[] = [], nodePathLine: string | null = null): string {
  // An operator's own PATH line wins over the generated one.
  const ownPath = extraEnvLines.some((l) => l.startsWith('Environment=PATH='));
  const pathLines = nodePathLine && !ownPath ? [NODE_PATH_MARKER, nodePathLine] : [];
  return [
    '[Unit]',
    'Description=somora — Local-first AI agent gateway',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${binPath} server start --foreground`,
    'Restart=on-failure',
    'RestartSec=5',
    'Environment=NODE_ENV=production',
    ...pathLines,
    ...extraEnvLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Extract operator-added `Environment=` / `EnvironmentFile=` lines from an
 *  existing unit so a rebake preserves them instead of silently dropping
 *  the server's bind host, credentials env-file, etc. The template's own
 *  `Environment=NODE_ENV=production` is excluded (it's re-emitted). */
export function extractCustomEnvLines(existingUnit: string): string[] {
  const out: string[] = [];
  let prev = '';
  for (const raw of existingUnit.split('\n')) {
    const line = raw.trim();
    const generated = prev === NODE_PATH_MARKER;
    prev = line;
    if (generated) continue;
    if (line === 'Environment=NODE_ENV=production') continue;
    if (line.startsWith('Environment=') || line.startsWith('EnvironmentFile=')) {
      out.push(line);
    }
  }
  return out;
}

const NODE_PATH_MARKER = '# node lives outside the system PATH (written by somora init)';
const SYSTEM_BIN_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

/** The unit starts `bin/somora.mjs` through its `#!/usr/bin/env node`
 *  shebang, and a systemd user service only searches the system
 *  directories. A Node installed in the home folder (the installer's
 *  no-admin path, nvm, Homebrew) would not be found and the service
 *  would fail with 203/EXEC — so in that case the unit names the
 *  directory. Returns null when Node is in a system directory and the
 *  unit needs nothing. */
export function nodePathLine(nodeDir: string, home: string, npmBinDir: string | null = null): string | null {
  if (SYSTEM_BIN_DIRS.includes(nodeDir)) return null;
  // npmBinDir: where `somora` itself (and other npm-installed CLIs the
  // agents call) lives when npm's global folder is in the home directory.
  const dirs = [nodeDir, ...(npmBinDir ? [npmBinDir] : []), `${home}/.local/bin`, ...SYSTEM_BIN_DIRS].filter((d, i, a) => a.indexOf(d) === i);
  return `Environment=PATH=${dirs.join(':')}`;
}
