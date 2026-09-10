// Opt-in integration smoke: built /web, real server and Chromium, all data in /tmp.
// npm --prefix web run build
// SOMORA_BROWSER_WEB_SMOKE=1 node --import tsx src/browser/web-smoke.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

test('scratch /web: handoff notice → streamed frame → OTP → hand-back, reconnect and gates', { skip: process.env.SOMORA_BROWSER_WEB_SMOKE !== '1', timeout: 100_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'somora-browser-web-'));
  let loggedIn = false;
  let wakes = 0;
  const fixture = createServer((req, res) => {
    if (req.url?.startsWith('/v1/')) {
      wakes++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"id":"smoke","choices":[{"index":0,"delta":{"role":"assistant","content":"Browser resumed."},"finish_reason":null}]}\n\ndata: {"id":"smoke","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (url.pathname === '/done') loggedIn = url.searchParams.get('otp') === '123456';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>OTP fixture</title><body style="margin:0"><form action="/done"><input name="otp" aria-label="Code" style="position:absolute;left:40px;top:40px;width:200px;height:40px"><button style="position:absolute;left:40px;top:110px">Verify</button></form><h1 style="position:absolute;top:160px">${loggedIn ? 'Welcome' : 'One-time code'}</h1></body>`);
  });
  const fixturePort = await listen(fixture);
  const reserve = createServer(); const port = await listen(reserve); await new Promise<void>(r => reserve.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const dir = join(scratch, 'agents', 'smoke');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), '---\nname: smoke\n---\nBrowser smoke test agent.\n');
  await writeFile(join(dir, 'agent.yaml'), 'model: fake\n');
  await writeFile(join(scratch, 'config.yaml'), JSON.stringify({
    server: { host: '127.0.0.1', port },
    providers: { fixture: { engine: 'openai-compatible', baseUrl: `http://127.0.0.1:${fixturePort}/v1`, apiKey: 'fixture', models: [{ id: 'fake', alias: 'fake', capabilities: ['text'], contextWindow: 32000 }] } },
    claudeCli: { sharedUserCredentials: false },
    memory: { embedding: { provider: 'openai', model: 'unused-fixture' } },
    browser: { enabled: true, executablePath: '/usr/bin/chromium', allowPrivate: ['127.0.0.1'], viewport: { width: 1000, height: 700 } },
  }));
  const log = openSync(join(scratch, 'server.log'), 'w');
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(), stdio: ['ignore', log, log],
    env: { ...process.env, SOMORA_HOME: scratch, SOMORA_PORT: String(port), SOMORA_HOST: '127.0.0.1', SOMORA_AGENT: '', CLAUDE_CONFIG_DIR: join(scratch, 'claude-home') },
  });
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(origin + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return await r.json() as any;
  };
  const op = (input: unknown, session = 'main') => api('/browser/op', { agent: 'smoke', session, input });
  try {
    let ready = false;
    for (let n = 0; n < 160; n++) {
      if (server.exitCode !== null) throw new Error(`scratch server exited: ${await readFile(join(scratch, 'server.log'), 'utf8')}`);
      try { if ((await fetch(origin + '/browser/status')).ok) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(ready, `server did not start; see ${scratch}/server.log`);
    const opened = await op({ op: 'open', url: `http://127.0.0.1:${fixturePort}/` });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal((await op({ op: 'request_handoff', reason: 'Please enter the test OTP' }, 'missing')).ok, false);
    const handoff = await op({ op: 'request_handoff', reason: 'Please enter the test OTP' });
    assert.equal(handoff.ok, true, JSON.stringify(handoff));
    await page.goto(origin + '/web/');
    await page.locator('.browser-attention').waitFor();
    // The user may reopen a chat after the request: the current snapshot restores the notice.
    await page.locator('.agent-icon').filter({ hasText: 'smoke' }).first().click();
    await page.locator('.browser-handoff-notice').waitFor();
    assert.match(await page.locator('.browser-handoff-notice').innerText(), /Please enter the test OTP/);
    await page.getByRole('button', { name: 'Open browser', exact: true }).click();
    await page.locator('.browser-stage img').waitFor();
    await page.getByRole('button', { name: 'Take over', exact: true }).click();
    await page.getByRole('button', { name: 'Hand back', exact: true }).waitFor();
    assert.equal((await op({ op: 'snapshot', tab: opened.tab.tab_id })).ok, false);
    // Pixel click in the actual streamed image, followed by normal keyboard input.
    await delay(500);
    const img = page.locator('.browser-stage img');
    const box = (await img.boundingBox())!;
    const dims = await img.evaluate((el: HTMLImageElement) => ({ w: el.naturalWidth, h: el.naturalHeight }));
    await page.mouse.click(box.x + 90 * box.width / dims.w, box.y + 60 * box.height / dims.h);
    await page.keyboard.type('123456');
    await page.keyboard.press('Enter');
    for (let n = 0; n < 40 && !loggedIn; n++) await delay(100);
    assert.ok(loggedIn, 'OTP entered through the viewer reaches the managed browser');
    // Drop both streams, then let EventSource and the viewer recover.
    await context.setOffline(true); await delay(800); await context.setOffline(false);
    await page.getByRole('button', { name: 'Hand back', exact: true }).waitFor({ timeout: 20_000 });
    await page.locator('.browser-stage img').waitFor();
    await page.getByRole('button', { name: 'Hand back', exact: true }).click();
    await page.locator('.browser-handoff-notice').waitFor({ state: 'detached' });
    await page.locator('.browser-attention').waitFor({ state: 'detached' });
    for (let n = 0; n < 100 && !wakes; n++) await delay(100);
    assert.equal(wakes, 1, 'one wake reaches the local model fixture');
    const duplicate = await api('/browser/agent:smoke/control', { mode: 'agent', handoffId: handoff.handoff_id });
    assert.equal(duplicate.ok, true); await delay(300); assert.equal(wakes, 1);
    await writeFile(join(dir, 'agent.yaml'), 'model: fake\ntools:\n  deny: [toolset:browser]\n');
    assert.equal((await op({ op: 'status' })).ok, false);
    assert.deepEqual(errors, []);
    console.log(`Scratch web smoke passed; logs: ${scratch}/server.log`);
  } catch (error) {
    console.error(`Scratch diagnostics: ${scratch}`);
    await page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-6000));
    throw error;
  } finally {
    await browser.close();
    const exited = once(server, 'exit'); server.kill('SIGTERM');
    await Promise.race([exited, delay(5000).then(() => server.kill('SIGKILL'))]);
    closeSync(log); fixture.closeAllConnections(); fixture.close();
  }
});
