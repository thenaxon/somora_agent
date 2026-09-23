// `somora lsp install [id…]` / `somora lsp status` — the language servers
// builder agents use (docs/lsp.md). Installed with npm into
// ~/.somora/lsp so nothing touches the system's global packages.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { findBinary, LSP_INSTALL_PREFIX, LSP_SERVERS } from '../lsp/registry.ts';

function usage(): string {
  return [
    'usage: somora lsp <command>',
    '',
    '  status              which language servers are installed and where',
    '  install [id…]       install servers with npm into ~/.somora/lsp (default: all)',
    '',
    'servers: ' + LSP_SERVERS.map((s) => `${s.id} (${s.extensions.join(' ')})`).join(', '),
    '',
  ].join('\n');
}

async function status(): Promise<number> {
  for (const def of LSP_SERVERS) {
    const bin = await findBinary(def);
    process.stdout.write(`${def.id.padEnd(12)} ${def.title.padEnd(24)} ${bin.command ? `${bin.command} (${bin.source})` : 'not installed — somora lsp install ' + def.id}\n`);
  }
  return 0;
}

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code ?? 1));
    p.on('error', () => resolve(1));
  });
}

async function install(ids: string[]): Promise<number> {
  const defs = ids.length === 0 ? [...LSP_SERVERS] : ids.map((id) => LSP_SERVERS.find((s) => s.id === id)).filter((d): d is (typeof LSP_SERVERS)[number] => Boolean(d));
  if (ids.length > 0 && defs.length !== ids.length) {
    process.stderr.write(`unknown server id in: ${ids.join(' ')}\n${usage()}`);
    return 2;
  }
  await mkdir(LSP_INSTALL_PREFIX, { recursive: true });
  const pkg = join(LSP_INSTALL_PREFIX, 'package.json');
  try {
    await access(pkg);
  } catch {
    await writeFile(pkg, JSON.stringify({ name: 'somora-lsp', private: true, description: 'language servers for somora builder agents' }, null, 2) + '\n');
  }
  const packages = [...new Set(defs.flatMap((d) => d.npmPackages))];
  process.stdout.write(`installing ${packages.join(', ')} into ${LSP_INSTALL_PREFIX}\n`);
  const code = await run('npm', ['install', '--no-audit', '--no-fund', '--save', ...packages], LSP_INSTALL_PREFIX);
  if (code !== 0) {
    process.stderr.write(`npm install failed (${code})\n`);
    return code;
  }
  return status();
}

export async function runLspCli(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'status':
      return status();
    case 'install':
      return install(rest);
    default:
      process.stderr.write(usage());
      return cmd ? 2 : 0;
  }
}
