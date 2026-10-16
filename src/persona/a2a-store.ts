// Write the `a2a:` switch of an agent.yaml without touching the rest
// (comments, order) — the Agent window's switch (PUT /agents/:agent/a2a,
// docs/a2a.md).

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { replacePersonaFile } from './files.ts';

/** The file's text with `a2a:` set to `on`. */
export function setA2AInText(text: string, on: boolean): string {
  if (/^a2a:/m.test(text)) return text.replace(/^a2a:.*$/m, `a2a: ${on}`);
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}a2a: ${on}\n`;
}

export async function writeAgentA2A(agent: string, on: boolean): Promise<void> {
  const home = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  const path = join(home, 'agents', agent, 'agent.yaml');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    // agent.yaml is optional; it is created with just the switch.
  }
  await mkdir(dirname(path), { recursive: true });
  await replacePersonaFile(path, setA2AInText(current, on));
}
