// `somora config check [file]` — validate config.yaml exactly as the
// server does (YAML, schema, unique aliases) without starting anything.
// An agent that edits the file runs it before relying on the change.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { configPath, validateConfigText } from '../config/loader.ts';
import { parseYaml } from '../config/yaml.ts';

/** agent.yaml files that still carry keys the `dreams` switch replaced
 *  (the server rewrites them at start; one written by hand later stays).
 *  A note, not an error: the old keys still mean what they meant. */
export function oldDreamKeyNotes(agentsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(agentsDir);
  } catch {
    return [];
  }
  const notes: string[] = [];
  for (const name of names.sort()) {
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(join(agentsDir, name, 'agent.yaml'), 'utf8'));
    } catch {
      continue;
    }
    const rem = (doc as { rem?: Record<string, unknown> } | undefined)?.rem;
    const old = ['enabled', 'participate_in_wiki'].filter((k) => rem && typeof rem === 'object' && k in rem);
    if (old.length > 0) notes.push(`  note: agents/${name}/agent.yaml: rem.${old.join(' and rem.')} replaced by \`dreams: true|false\` (docs/dream-phases.md)`);
  }
  return notes;
}

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
    if (!args[1]) {
      const notes = oldDreamKeyNotes(join(dirname(file), 'agents'));
      if (notes.length > 0) process.stdout.write(`${notes.join('\n')}\n`);
    }
    return r.code;
  }
  if (sub === 'path') {
    process.stdout.write(`${configPath()}\n`);
    return 0;
  }
  process.stdout.write(usage());
  return sub && sub !== '--help' && sub !== '-h' ? 2 : 0;
}
