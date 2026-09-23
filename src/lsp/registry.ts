// Which language server serves which file, where its binary is, and
// which folder is its root. Two servers to begin with — the ones a
// somora installation is most likely to build in — with room for more.
//
// Binaries are looked up in this order: the operator's `command` in
// config (`lsp.servers.<id>.command`), somora's own install prefix
// (`~/.somora/lsp/node_modules/.bin/`, filled by `somora lsp install`),
// then PATH. Nothing is downloaded during a turn.

import { accessSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, join, normalize, resolve } from 'node:path';

const SOMORA_HOME = process.env.SOMORA_HOME ?? `${homedir()}/.somora`;
export const LSP_INSTALL_PREFIX = join(SOMORA_HOME, 'lsp');

export interface LspServerDef {
  id: string;
  /** Shown in the environment block and the CLI. */
  title: string;
  extensions: readonly string[];
  /** Files that mark a project root, in order of preference. */
  rootMarkers: readonly string[];
  /** Binary name on PATH / under the install prefix. */
  bin: string;
  args: readonly string[];
  /** npm packages `somora lsp install <id>` installs. */
  npmPackages: readonly string[];
  languageId: (file: string) => string;
  initializationOptions?: (root: string) => Record<string, unknown>;
  /** `workspace/didChangeConfiguration` settings sent after initialize. */
  settings?: (root: string) => Record<string, unknown>;
  /** First diagnostics of a root take longer (project load). */
  firstWaitMs: number;
}

const TS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export const LSP_SERVERS: readonly LspServerDef[] = [
  {
    id: 'typescript',
    title: 'TypeScript / JavaScript',
    extensions: TS_EXT,
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json', '.git'],
    bin: 'typescript-language-server',
    args: ['--stdio'],
    npmPackages: ['typescript-language-server', 'typescript'],
    languageId: (file) => {
      const e = extname(file);
      if (e === '.tsx') return 'typescriptreact';
      if (e === '.jsx') return 'javascriptreact';
      return e.startsWith('.j') || e === '.mjs' || e === '.cjs' ? 'javascript' : 'typescript';
    },
    initializationOptions: () => ({
      // Prefer the project's own typescript (tsserver picks it up from
      // node_modules); fall back to the one installed next to the server.
      preferences: { includeCompletionsForModuleExports: false },
    }),
    firstWaitMs: 8000,
  },
  {
    id: 'pyright',
    title: 'Python (pyright)',
    extensions: ['.py', '.pyi'],
    rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pyrightconfig.json', '.git'],
    bin: 'pyright-langserver',
    args: ['--stdio'],
    npmPackages: ['pyright'],
    languageId: () => 'python',
    initializationOptions: (root) => ({ pythonPath: pythonFor(root) }),
    settings: (root) => ({ python: { pythonPath: pythonFor(root), analysis: { diagnosticMode: 'openFilesOnly', typeCheckingMode: 'standard' } } }),
    firstWaitMs: 10000,
  },
];

/** `<root>/.venv/bin/python` when the project has one, else python3. */
export function pythonFor(root: string): string {
  const venv = join(root, '.venv', 'bin', 'python');
  try {
    accessSync(venv, constants.X_OK); // once per server start
    return venv;
  } catch {
    return 'python3';
  }
}

export function serverForFile(file: string): LspServerDef | null {
  const e = extname(file).toLowerCase();
  return LSP_SERVERS.find((s) => s.extensions.includes(e)) ?? null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The root a server is started in for `file`: the nearest folder at or
 * above the file that holds one of the markers, never above `workdir`
 * (the pinned project is the outer limit), else `workdir` itself.
 */
export async function rootFor(def: LspServerDef, file: string, workdir: string): Promise<string> {
  const top = normalize(workdir).replace(/\/+$/, '');
  let dir = dirname(resolve(file));
  while (dir.startsWith(top)) {
    for (const marker of def.rootMarkers) {
      if (await exists(join(dir, marker))) return dir;
    }
    if (dir === top) break;
    dir = dirname(dir);
  }
  return top;
}

export interface BinaryLookup {
  command: string | null;
  source: 'config' | 'somora' | 'path' | null;
}

/** Where the server's executable is, if anywhere. */
export async function findBinary(def: LspServerDef, configured?: string): Promise<BinaryLookup> {
  if (configured) return { command: configured, source: 'config' };
  const own = join(LSP_INSTALL_PREFIX, 'node_modules', '.bin', def.bin);
  if (await exists(own)) return { command: own, source: 'somora' };
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, def.bin);
    if (await exists(p)) return { command: p, source: 'path' };
  }
  return { command: null, source: null };
}
