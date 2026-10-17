// Write the `dreams:` switch of an agent.yaml without touching the rest
// (comments, order) — the Agent window's switch (PUT /agents/:agent/dreams).
// A file from before the switch is brought to the new form on the way
// (dreams-migrate.ts), so the old `rem.enabled` cannot contradict it.

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { rewriteForDreams } from './dreams-migrate.ts';
import { replacePersonaFile } from './files.ts';
import { assertNotRenaming } from './rename-lock.ts';
import { setRootSwitchInText } from './yaml-switch.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

/** The file's text with `dreams:` set to `on` (yaml-switch.ts), after
 *  the old REM keys are rewritten. Throws instead of breaking the file. */
export function setDreamsInText(text: string, on: boolean): string {
  let out = text;
  try {
    out = rewriteForDreams(text)?.text ?? text;
  } catch {
    // An unusual layout the rewrite leaves alone: `dreams:` still wins
    // over the old keys (deriveDreams), so adding it is enough.
  }
  return setRootSwitchInText(out, 'dreams', on);
}

export async function writeAgentDreams(agent: string, on: boolean): Promise<void> {
  const path = join(SOMORA_HOME, 'agents', agent, 'agent.yaml');
  // Mid-rename the folder moves; mkdir below would make the old one again.
  assertNotRenaming(agent);
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (err) {
    // agent.yaml is optional; it is created with just the switch. Any
    // other read failure must not become an empty file.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const next = setDreamsInText(current, on);
  await mkdir(dirname(path), { recursive: true });
  await replacePersonaFile(path, next);
}
