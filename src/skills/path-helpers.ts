// Bin lookup + PATH expansion shared by the skill availability check
// (src/skills/load.ts) and by the `exec` tool's env build
// (src/tools/exec/local.ts).
//
// Why: somora runs as a systemd user-service with a minimal default
// PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin`). User
// shell init (`.bashrc`, `.profile`) is not sourced for the service,
// so brew/cargo/go/pip-user installs are invisible to both `which`
// and `exec`-spawned commands.
//
// Hans hit this 2026-05-09: gog installed via linuxbrew was tagged
// `available: false` ("missing bin: gog") in skill metadata, AND
// `exec({command:"gog ..."})` failed with command-not-found. Two
// distinct symptoms, one root cause — both fixed here by:
//
//   - findBin(name): try a fast `which` first (uses inherited PATH);
//     on miss, stat the binary directly in well-known user-install
//     dirs.
//   - extendedPath(): returns `process.env.PATH` augmented with the
//     same known dirs. exec.ts merges this into the spawned env so
//     calling brew/cargo/go binaries by bare name actually finds
//     them.
//
// Dirs included by default (file existence is required, no warning
// on missing dirs — keeps the helper portable across machines):
//
//   /home/linuxbrew/.linuxbrew/{bin,sbin}    Linuxbrew (Linux)
//   /opt/homebrew/{bin,sbin}                  Homebrew on Apple Silicon
//   /usr/local/Homebrew/bin                   Homebrew on Intel macOS
//   ~/.local/bin                              pip --user, pipx
//   ~/go/bin                                  Go binaries
//   ~/.cargo/bin                              Rust / cargo install
//   ~/bin                                     historical user bin
//
// If the user wants more, a future config-level override can extend
// the list. For now hardcoded — covers ~all real-world cases that
// surfaced.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function knownBinDirs(): string[] {
  const home = homedir();
  return [
    '/home/linuxbrew/.linuxbrew/bin',
    '/home/linuxbrew/.linuxbrew/sbin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/Homebrew/bin',
    join(home, '.local', 'bin'),
    join(home, 'go', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, 'bin'),
  ];
}

/** Resolve a bin to true/false for "is it findable somewhere reachable
 *  for spawning". Fast path: `which` against inherited PATH. Fallback:
 *  fs-stat each known user-install dir. Returns true on first hit. */
export async function findBin(bin: string): Promise<boolean> {
  try {
    await execFileP('which', [bin]);
    return true;
  } catch {
    /* fall through to stat-based scan */
  }
  for (const dir of knownBinDirs()) {
    try {
      const s = await stat(join(dir, bin));
      if (s.isFile() || s.isSymbolicLink()) return true;
      // SFTP-style symlink may also be a directory in pathological
      // cases; we accept FIFO/socket as no — only real exes / symlinks.
    } catch {
      /* not in this dir */
    }
  }
  return false;
}

/** Return PATH with the known user-install dirs appended (after the
 *  inherited PATH, so anything the user explicitly set still wins).
 *  Used by the exec tool to enrich the spawned subprocess env. */
export function extendedPath(): string {
  const inherited = process.env.PATH ?? '';
  const extras = knownBinDirs().filter((dir) => {
    // Avoid duplicates if the user / systemd already exported them.
    return !inherited.split(':').includes(dir);
  });
  return extras.length > 0 ? `${inherited}:${extras.join(':')}` : inherited;
}
