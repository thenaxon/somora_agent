import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = await mkdtemp(join(tmpdir(), 'somora-browser-session-'));
process.env.SOMORA_HOME = scratch;
const { resolveBrowserSession } = await import('./session.ts');
const { createSession, sessionMetaStore } = await import('../storage/sessions.ts');
const { runBrowserOp } = await import('../tools/browser/ops.ts');
const { configureBrowserService } = await import('./service.ts');
const { ConfigSchema } = await import('../config/types.ts');

test('browser sessions resolve slugs and refuse missing or archived owners; ability gates apply to direct ops', async () => {
  try {
    const dir = join(scratch, 'agents', 'fixture');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), '# Fixture\nTest agent.\n');
    const id = await createSession('fixture', 'login');
    assert.equal(await resolveBrowserSession('fixture', 'login'), id);
    assert.equal(await resolveBrowserSession('fixture', 'main'), 'main');
    await assert.rejects(resolveBrowserSession('fixture', 'missing'), /not found/);
    await assert.rejects(resolveBrowserSession('gone', 'main'), /no longer exists/);
    await sessionMetaStore.set('fixture', id, { archived: true });
    await assert.rejects(resolveBrowserSession('fixture', id), /archived/);
    const config = ConfigSchema.parse({ providers: {}, browser: { enabled: true } });
    configureBrowserService(config.browser, { dispatchWakeTurn: async () => {} });
    await writeFile(join(dir, 'agent.yaml'), 'tools:\n  deny: [toolset:browser]\n');
    const denied = await runBrowserOp({ agent: 'fixture', config }, { op: 'status' });
    assert.equal(denied.ok, false);
    assert.match(denied.error!, /not allowed/);
    await writeFile(join(dir, 'agent.yaml'), 'tools:\n  allow: [web_search]\n');
    assert.equal((await runBrowserOp({ agent: 'fixture', config }, { op: 'status' })).ok, false);
    config.browser.enabled = false;
    assert.match((await runBrowserOp({ agent: 'fixture', config }, { op: 'status' })).error!, /enabled is false/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
