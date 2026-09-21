// Every local tool that returns file content honours the read blacklist.
//
// Run: npx tsx src/tools/file/read-policy-coverage.test.mts
//
// Found 2026-09-21: file_read and file_list checked the blacklist,
// file_search and the image/PDF branch of file_read did not —
// file_search({pattern:"BEGIN", path:"~/.ssh"}) returned key lines.
// Remote write/patch ran no policy at all.
//
// Runs against a FAKE home (HOME is swapped before any import), so the
// blocked directories it pokes at are its own.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_HOME = join(tmpdir(), `somora-read-policy-${process.pid}`);
process.env.HOME = FAKE_HOME;
process.env.SOMORA_HOME = join(FAKE_HOME, '.somora');
const WS = join(FAKE_HOME, 'ws');
mkdirSync(join(FAKE_HOME, '.ssh'), { recursive: true });
mkdirSync(join(FAKE_HOME, '.gnupg'), { recursive: true });
mkdirSync(join(WS, 'notes'), { recursive: true });
mkdirSync(join(process.env.SOMORA_HOME, 'agents', 'tester'), { recursive: true });
writeFileSync(join(process.env.SOMORA_HOME, 'agents', 'tester', 'AGENTS.md'), '# tester\n');
writeFileSync(join(process.env.SOMORA_HOME, 'agents', 'tester', 'agent.yaml'), `model: x\nworkspace: ${WS}\n`);
writeFileSync(join(FAKE_HOME, '.ssh', 'id_fake'), '-----BEGIN FAKE PRIVATE KEY-----\nSECRETLINE\n');
writeFileSync(join(WS, 'notes', 'a.md'), 'BEGIN of an ordinary note\n');
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
writeFileSync(join(FAKE_HOME, '.gnupg', 'card.png'), PNG);
writeFileSync(join(WS, 'ok.png'), PNG);
symlinkSync(join(FAKE_HOME, '.ssh'), join(WS, 'innocent-link'));

const { localSearch } = await import('./local.ts');
const { fileTools } = await import('./tools.ts').then((m) => ({ fileTools: (m as Record<string, unknown>) }));
const { checkRemoteWriteAllowed, checkRemoteReadAllowed } = await import('./policy.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}
const config = { workspace: { default: WS }, resources: {}, vision: {} } as never;
async function rejects(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// ── file_search ──
{
  const direct = await rejects(localSearch({ pattern: 'BEGIN', agent: 'tester', config, path: '~/.ssh' }));
  check('search in ~/.ssh: refused', direct !== null && /read blocked/.test(direct), String(direct));
  const viaLink = await rejects(localSearch({ pattern: 'BEGIN', agent: 'tester', config, path: join(WS, 'innocent-link') }));
  check('search via a symlink into ~/.ssh: refused', viaLink !== null && /read blocked/.test(viaLink), String(viaLink));
  const ok = await localSearch({ pattern: 'BEGIN', agent: 'tester', config, path: WS });
  check('search in the workspace: works', ok.hits.some((h) => h.path.endsWith('a.md')), JSON.stringify(ok));
  check('search in the workspace: nothing from the blocked dir leaks', !ok.hits.some((h) => /SECRET|FAKE PRIVATE/.test(h.text) || h.path.includes('.ssh')), JSON.stringify(ok.hits));
  check('search: count matches the returned hits', ok.count === ok.hits.length);
}

// ── file_read image branch ──
{
  const tools = fileTools as Record<string, { name?: string; handler?: (i: unknown, c: unknown) => Promise<unknown> }>;
  const fileRead = Object.values(tools).find((t) => t && typeof t === 'object' && t.name === 'file_read');
  check('file_read tool found', Boolean(fileRead));
  if (fileRead?.handler) {
    const ctx = {
      agent: 'tester',
      config,
      activeModel: { model: { capabilities: ['text', 'image'] } },
    };
    const blocked = await rejects(fileRead.handler({ path: '~/.gnupg/card.png', target: 'local' }, ctx));
    check('image under ~/.gnupg: refused', blocked !== null && /read blocked/.test(blocked), String(blocked));
    const allowed = (await fileRead.handler({ path: join(WS, 'ok.png'), target: 'local' }, ctx)) as { contentBlocks?: unknown[] };
    check('image in the workspace: still delivered', Array.isArray(allowed?.contentBlocks), JSON.stringify(allowed).slice(0, 200));
  }
}

// ── remote write policy ──
{
  const home = '/home/remoteuser';
  check('remote write ~/.ssh/authorized_keys: blocked', !checkRemoteWriteAllowed(`${home}/.ssh/authorized_keys`, home).ok);
  check('remote write /etc/shadow: blocked', !checkRemoteWriteAllowed('/etc/shadow', home).ok);
  const r = checkRemoteWriteAllowed(`${home}/.ssh/x`, home);
  check('remote write: reason says write', /^write blocked/.test(r.reason ?? ''), r.reason);
  check('remote write /etc/nginx/nginx.conf: allowed (admin work)', checkRemoteWriteAllowed('/etc/nginx/nginx.conf', home).ok);
  check('remote write into a project dir: allowed', checkRemoteWriteAllowed(`${home}/project/app.py`, home).ok);
  check('remote read policy unchanged', !checkRemoteReadAllowed(`${home}/.ssh/id`, home).ok && checkRemoteReadAllowed(`${home}/notes.md`, home).ok);
}

rmSync(FAKE_HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
