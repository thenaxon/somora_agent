// Language server client + manager against the fake server (no network,
// no real server). Run: npm test src/lsp/lsp.test.mts
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrame } from './client.ts';
import { formatFileErrors } from './format.ts';
import { LspManager } from './manager.ts';
import { rootFor, serverForFile, LSP_SERVERS } from './registry.ts';

// framing: a message split across chunks, two messages in one chunk
{
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
  const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  assert.equal(parseFrame(frame.subarray(0, 10)), null, 'incomplete header');
  assert.equal(parseFrame(frame.subarray(0, frame.length - 3)), null, 'incomplete body');
  const two = Buffer.concat([frame, frame]);
  const first = parseFrame(two)!;
  assert.equal(first.body, body);
  assert.equal(parseFrame(two.subarray(first.consumed))!.body, body);
}
// formatting: errors only, capped, 1-based positions
{
  const d = (line: number, sev: number, message: string) => ({ range: { start: { line, character: 4 }, end: { line, character: 5 } }, severity: sev, message });
  const lines = formatFileErrors([d(0, 1, 'x is not defined'), d(1, 2, 'unused'), d(2, 1, 'bad\n  thing')], 1);
  assert.deepEqual(lines, ['ERROR [1:5] x is not defined', '… 1 more error(s) in this file']);
}
// registry: extension → server, root detection bounded by the workdir
{
  assert.equal(serverForFile('/x/a.tsx')!.id, 'typescript');
  assert.equal(serverForFile('/x/a.py')!.id, 'pyright');
  assert.equal(serverForFile('/x/a.md'), null);
  const wd = await mkdtemp(join(tmpdir(), 'somora-lsp-root-'));
  await mkdir(join(wd, 'packages', 'a', 'src'), { recursive: true });
  await writeFile(join(wd, 'packages', 'a', 'tsconfig.json'), '{}');
  const ts = LSP_SERVERS.find((s) => s.id === 'typescript')!;
  assert.equal(await rootFor(ts, join(wd, 'packages', 'a', 'src', 'x.ts'), wd), join(wd, 'packages', 'a'));
  assert.equal(await rootFor(ts, join(wd, 'other.ts'), wd), wd, 'no marker: the workdir');
}
// manager against the fake server
{
  const wd = await mkdtemp(join(tmpdir(), 'somora-lsp-'));
  const helper = fileURLToPath(new URL('./fake-server.helper.mjs', import.meta.url));
  const wrapper = join(wd, 'fake-lsp.sh');
  await writeFile(wrapper, `#!/bin/sh\nexec node ${helper} "$@"\n`);
  await chmod(wrapper, 0o755);
  const cfg = { enabled: true, waitMs: 1500, servers: { typescript: { command: wrapper } } };
  const m = new LspManager(() => cfg);
  const a = join(wd, 'a.ts');
  await writeFile(a, 'const ok = 1;\nBAD here\n');
  const r1 = await m.diagnosticsAfterWrite(wd, a);
  assert.ok(r1, 'diagnostics came back');
  assert.deepEqual(r1!.errors, ['ERROR [2:1] BAD token on line 2']);
  assert.deepEqual(r1!.errors_in_other_files, {});
  // a second file with errors: reported once as "other" for the first file's next write
  const b = join(wd, 'b.ts');
  await writeFile(b, 'BAD\n');
  const r2 = await m.diagnosticsAfterWrite(wd, b);
  assert.deepEqual(r2!.errors, ['ERROR [1:1] BAD token on line 1']);
  await writeFile(a, 'const ok = 1;\n');
  const r3 = await m.diagnosticsAfterWrite(wd, a);
  assert.deepEqual(r3!.errors, [], 'fixed');
  assert.deepEqual(r3!.errors_in_other_files, {}, "b's verdict was delivered with its own write and has not changed");
  await writeFile(a, 'const ok = 1; // BREAK\n');
  const r4 = await m.diagnosticsAfterWrite(wd, a);
  assert.deepEqual(r4!.errors, []);
  assert.deepEqual(r4!.errors_in_other_files, { 'b.ts': ['ERROR [1:1] BAD token on line 1', 'ERROR [1:1] broken by a change in a.ts'] }, 'a change that breaks another file reports it');
  const r5 = await m.diagnosticsAfterWrite(wd, a);
  assert.deepEqual(r5!.errors_in_other_files, {}, 'unchanged verdict not repeated');
  assert.equal(m.status().length, 1);
  assert.equal(m.status()[0]!.docs, 2);
  // a file no server serves
  assert.equal(await m.diagnosticsAfterWrite(wd, join(wd, 'notes.md')), null);
  // disabled → nothing
  cfg.enabled = false;
  assert.equal(await m.diagnosticsAfterWrite(wd, a), null);
  cfg.enabled = true;
  await m.shutdownAll();
  assert.equal(m.status().length, 0);
}
// a slow server: no answer in time → null, no throw
{
  const wd = await mkdtemp(join(tmpdir(), 'somora-lsp-slow-'));
  const helper = fileURLToPath(new URL('./fake-server.helper.mjs', import.meta.url));
  const wrapper = join(wd, 'slow-lsp.sh');
  await writeFile(wrapper, `#!/bin/sh\nFAKE_LSP_DELAY_MS=3000 exec node ${helper} "$@"\n`);
  await chmod(wrapper, 0o755);
  const m = new LspManager(() => ({ enabled: true, waitMs: 300, servers: { typescript: { command: wrapper } } }));
  const a = join(wd, 'a.ts');
  await writeFile(a, 'BAD\n');
  // firstWaitMs (8 s) applies to the first write; force the short path by a second write
  const t0 = Date.now();
  const first = await m.diagnosticsAfterWrite(wd, a);
  assert.ok(first, 'first write waits up to firstWaitMs and gets the delayed answer');
  assert.ok(Date.now() - t0 >= 2500);
  await writeFile(a, 'BAD\nBAD\n');
  const t1 = Date.now();
  const second = await m.diagnosticsAfterWrite(wd, a);
  assert.equal(second, null, 'after the first verdict the short wait applies');
  assert.ok(Date.now() - t1 < 1500);
  await m.shutdownAll();
}
// a missing binary: null, no throw
{
  const m = new LspManager(() => ({ enabled: true, waitMs: 300, servers: { typescript: { command: '/nonexistent/lsp-bin' } } }));
  const wd = await mkdtemp(join(tmpdir(), 'somora-lsp-missing-'));
  const a = join(wd, 'a.ts');
  await writeFile(a, 'x');
  assert.equal(await m.diagnosticsAfterWrite(wd, a), null);
}
console.log('lsp.test: ok');
