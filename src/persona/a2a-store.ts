// Write the `a2a:` switch of an agent.yaml without touching the rest
// (comments, order) — the Agent window's switch (PUT /agents/:agent/a2a,
// docs/a2a.md).

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { replacePersonaFile } from './files.ts';
import { assertNotRenaming } from './rename-lock.ts';
import { setRootSwitchInText } from './yaml-switch.ts';

/** The file's text with `a2a:` set to `on` (yaml-switch.ts). */
export function setA2AInText(text: string, on: boolean): string {
  return setRootSwitchInText(text, 'a2a', on);
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
