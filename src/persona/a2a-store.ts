// Write the `a2a:` switch of an agent.yaml without touching the rest
// (comments, order) — the Agent window's switch (PUT /agents/:agent/a2a,
// docs/a2a.md).

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMap, isScalar, parseDocument } from 'yaml';
import { parseYaml } from '../config/yaml.ts';
import { replacePersonaFile } from './files.ts';
import { assertNotRenaming } from './rename-lock.ts';

/** The file's text with `a2a:` set to `on`: the value of the root key is
 *  replaced in place, however the key is written (`a2a:`, `"a2a":`,
 *  `a2a :`), or the line is added. Throws when the file is not valid YAML
 *  or the result would not read back as the switch — the file is then
 *  left as it is: a broken agent.yaml loads as no settings at all. */
export function setA2AInText(text: string, on: boolean): string {
  let next: string;
  const blank = text.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line));
  if (blank) {
    const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    next = `${text}${sep}a2a: ${on}\n`;
  } else {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw new Error(`agent.yaml is not valid YAML: ${doc.errors[0]!.message}`);
    if (!isMap(doc.contents)) throw new Error('agent.yaml is not a map of settings');
    const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'a2a');
    if (pair) {
      const value = pair.value;
      if (!isScalar(value) || !value.range) throw new Error('agent.yaml: a2a is not a plain true/false');
      next = text.slice(0, value.range[0]) + String(on) + text.slice(value.range[1]);
    } else {
      const sep = text.endsWith('\n') ? '' : '\n';
      next = `${text}${sep}a2a: ${on}\n`;
    }
  }
  let back: unknown;
  try {
    back = parseYaml(next);
  } catch (err) {
    throw new Error(`agent.yaml would not be valid YAML with the switch: ${(err as Error).message}`);
  }
  if ((back as { a2a?: unknown } | undefined)?.a2a !== on) throw new Error('agent.yaml would not read back with the switch set; edit it by hand');
  return next;
}

export async function writeAgentA2A(agent: string, on: boolean): Promise<void> {
  // Mid-rename the folder moves; mkdir below would make the old one again.
  assertNotRenaming(agent);
  const home = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  const path = join(home, 'agents', agent, 'agent.yaml');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (err) {
    // agent.yaml is optional; it is created with just the switch. Any
    // other read failure must not become an empty file.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const next = setA2AInText(current, on);
  await mkdir(dirname(path), { recursive: true });
  await replacePersonaFile(path, next);
}
