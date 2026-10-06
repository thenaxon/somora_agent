// `somora config check [file]` — validate config.yaml exactly as the
// server does (YAML, schema, unique aliases) without starting anything.
// An agent that edits the file runs it before relying on the change.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configPath, validateConfigText } from '../config/loader.ts';

function usage(): string {
  return `somora config — the server configuration (~/.somora/config.yaml)

Usage:
  somora config check [file]   validate the file exactly as the server does;
                               exit code 0 = valid, 1 = invalid, 2 = unreadable
  somora config path           print the path of the config file
`;
}

export function checkConfigFile(file: string): { code: number; out: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { code: 2, out: `cannot read ${file}: ${(err as Error).message}\n` };
  }
  const r = validateConfigText(raw);
  if (r.ok) return { code: 0, out: `${file}: valid\n` };
  return {
    code: 1,
    out: `${file}: invalid — ${r.issues.length} problem(s)\n${r.issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}\n`,
  };
}

export async function runConfigCli(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === 'check') {
    const file = args[1] ? resolve(args[1]) : configPath();
    const r = checkConfigFile(file);
    (r.code === 0 ? process.stdout : process.stderr).write(r.out);
    return r.code;
  }
  if (sub === 'path') {
    process.stdout.write(`${configPath()}\n`);
    return 0;
  }
  process.stdout.write(usage());
  return sub && sub !== '--help' && sub !== '-h' ? 2 : 0;
}
