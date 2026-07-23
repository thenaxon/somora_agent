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
export function buildSystemdUnit(binPath: string, extraEnvLines: string[] = []): string {
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
  for (const raw of existingUnit.split('\n')) {
    const line = raw.trim();
    if (line === 'Environment=NODE_ENV=production') continue;
    if (line.startsWith('Environment=') || line.startsWith('EnvironmentFile=')) {
      out.push(line);
    }
  }
  return out;
}
