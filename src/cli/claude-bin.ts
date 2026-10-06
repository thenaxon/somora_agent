// Which Claude Code binary the CLI hands a login to.
//
// somora ships Claude Code: the Agent SDK depends on a native package
// per platform (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, a
// `-musl` variant on Alpine-like Linux) that holds the full `claude`
// binary. The engine runs that binary unless a separately installed one
// exists at ~/.local/bin/claude (or SOMORA_CLAUDE_BIN), so a login needs
// no extra install either.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** A Claude Code the person installed themselves, if any. */
export function installedClaudeBinary(): string | null {
  if (process.env.SOMORA_CLAUDE_BIN && existsSync(process.env.SOMORA_CLAUDE_BIN)) return process.env.SOMORA_CLAUDE_BIN;
  const local = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  const r = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The Claude Code that comes with somora's Agent SDK dependency. */
export function bundledClaudeBinary(): string | null {
  const req = createRequire(import.meta.url);
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const variant of [`${process.platform}-${process.arch}`, `${process.platform}-${process.arch}-musl`]) {
    try {
      const pkg = req.resolve(`@anthropic-ai/claude-agent-sdk-${variant}/package.json`);
      const bin = join(dirname(pkg), exe);
      if (existsSync(bin)) return bin;
    } catch {
      // that variant is not installed on this machine
    }
  }
  return null;
}

/** The binary to log in with: the person's own when present (the engine
 *  prefers it too), else the bundled one. */
export function claudeBinaryForLogin(): { path: string; bundled: boolean } | null {
  const own = installedClaudeBinary();
  if (own) return { path: own, bundled: false };
  const bundled = bundledClaudeBinary();
  return bundled ? { path: bundled, bundled: true } : null;
}
