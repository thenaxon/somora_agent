// A persona file gets a backup before every tool write. Run: npm test src/tools/file/persona-guard.test.mts
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../../config/types.ts';
import { localPatch, localWrite } from './local.ts';
import { backupPersonaFile, personaFileOf } from './persona-guard.ts';

const home = process.env.SOMORA_HOME!;
assert.ok(home && !home.endsWith('/.somora'));
assert.deepEqual(personaFileOf(join(home, 'agents', 'hans', 'AGENTS.md')), { agent: 'hans', file: 'AGENTS.md' });
assert.equal(personaFileOf(join(home, 'agents', 'hans', 'memory', 'x.md')), null);
assert.equal(personaFileOf(join(home, 'agents', 'hans', 'sessions', 'main.jsonl')), null);
assert.equal(personaFileOf('/tmp/AGENTS.md'), null);
// no file yet → no backup
const dir = join(home, 'agents', 'guard-target'); await mkdir(dir, { recursive: true });
assert.equal(await backupPersonaFile(join(dir, 'SOUL.md'), 'test'), null);
// through the tools, as another agent: the write lands, but a backup exists first
const writer = 'guard-writer'; await mkdir(join(home, 'agents', writer), { recursive: true });
await writeFile(join(home, 'agents', writer, 'AGENTS.md'), `---\nname: ${writer}\n---\nWriter.\n`);
await writeFile(join(dir, 'AGENTS.md'), '---\nname: guard-target\n---\nOriginal persona.\n');
const config = { workspace: { default: home } } as unknown as Config;
const w = await localWrite({ path: join(dir, 'AGENTS.md'), content: 'x', agent: writer, config, mode: 'overwrite' });
assert.ok(w.backup && w.backup.includes('AGENTS.md.bak-'), 'write result names the backup');
assert.match(await readFile(w.backup!, 'utf8'), /Original persona/);
assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), 'x');
await new Promise((r) => setTimeout(r, 1100));
const p = await localPatch({ path: join(dir, 'AGENTS.md'), agent: writer, config, oldString: 'x', newString: 'y', replaceAll: false });
assert.ok(p.backup, 'patch result names the backup');
const baks = (await readdir(dir)).filter((f) => f.startsWith('AGENTS.md.bak-'));
assert.equal(baks.length, 2);
console.log('persona-guard.test: ok');
