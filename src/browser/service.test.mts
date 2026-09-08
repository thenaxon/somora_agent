// Stage-1 acceptance for the shared browser, against the real host
// Chromium: profile isolation (6), stale refs (7), crash-free errors,
// navigation policy (spec 9), tab cap, handoff state machine (3/4/5 at
// the service level — the web client comes in stage 2/3).
//
// A tiny local web app (login form → OTP → welcome, cookie-based) is
// served from this file so the test has a login flow without touching
// the internet. Skipped when no Chromium is on the host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { findXvfb, planHeaded } from './display.ts';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-browser-test-'));
const { BrowserService, BrowserOpError, detectExecutable } = await import('./service.ts');

const chromium = detectExecutable();
const PAGE = (body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Somora Test App</title></head><body>${body}</body></html>`;

function app(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const cookie = req.headers.cookie ?? '';
      const loggedIn = /session=ok/.test(cookie);
      const send = (html: string, headers: Record<string, string> = {}) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
        res.end(PAGE(html));
      };
      if (url.pathname === '/') {
        if (loggedIn) return send('<h1>Welcome back</h1><p id="who">logged in</p><a href="/redirect-private">private link</a>');
        return send('<h1>Sign in</h1><form method="GET" action="/otp"><label>Username <input name="user"></label><label>Password <input type="password" name="pass"></label><button type="submit">Continue</button></form>');
      }
      if (url.pathname === '/otp') {
        return send('<h1>One-time code</h1><form method="GET" action="/login"><label>Code <input name="otp"></label><button type="submit">Verify</button></form>');
      }
      if (url.pathname === '/login') {
        if (url.searchParams.get('otp') === '123456') return send('<h1>Welcome</h1><p id="who">logged in</p>', { 'Set-Cookie': 'session=ok; Path=/' });
        return send('<h1>Wrong code</h1>');
      }
      if (url.pathname === '/redirect-private') {
        // 127.0.0.2 is loopback too (reachable on Linux) but NOT in
        // allowPrivate — a redirect the policy must catch after the fact.
        res.writeHead(302, { Location: `http://127.0.0.2:${(server.address() as { port: number }).port}/secret` });
        return res.end();
      }
      if (url.pathname === '/secret') return send('<h1>Internal secret</h1>');
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const cfg = {
  enabled: true,
  headed: false,
  extraArgs: [] as string[],
  maxTabsPerAgent: 2,
  idleStopMinutes: 30,
  viewport: { width: 1000, height: 700 },
  stream: { quality: 60, maxFps: 15 },
  allowPrivate: ['127.0.0.1'],
  deny: ['*.example.org'],
  profiles: { team: { agents: ['hans', 'lisa'] } },
};

test('shared browser stage 1', { skip: chromium.path ? false : 'no Chromium on this host' }, async (t) => {
  const { server, base } = await app();
  const wakes: Array<{ agent: string; session: string; text: string }> = [];
  const svc = new BrowserService(cfg as never, { dispatchWakeTurn: async (w) => { wakes.push(w); } });
  await svc.init();
  t.after(async () => {
    await svc.shutdown();
    server.close();
    rmSync(process.env.SOMORA_HOME!, { recursive: true, force: true });
  });

  await t.test('login flow: open → snapshot → fill → click → otp → welcome', async () => {
    const opened = await svc.open('naxon', 'main', { url: `${base}/` });
    assert.equal(opened.browser_id, 'agent:naxon');
    const tab = opened.tab.tab_id;
    let snap = await svc.snapshot('naxon', { tab });
    assert.match(snap.snapshot, /textbox "Username" \[ref=(?:f\d+)?e\d+\]/);
    assert.doesNotMatch(snap.snapshot, /^\s*- generic \[ref=/m, 'compact snapshot drops bare containers');
    const user = /textbox "Username" \[ref=((?:f\d+)?e\d+)\]/.exec(snap.snapshot)![1]!;
    const pass = /textbox "Password" \[ref=((?:f\d+)?e\d+)\]/.exec(snap.snapshot)![1]!;
    const btn = /button "Continue" \[ref=((?:f\d+)?e\d+)\]/.exec(snap.snapshot)![1]!;
    await svc.act('naxon', { tab, action: 'fill', ref: user, value: 'rene', generation: snap.generation });
    await svc.act('naxon', { tab, action: 'fill', ref: pass, value: 'geheim', generation: snap.generation });
    const clicked = await svc.act('naxon', { tab, action: 'click', ref: btn, generation: snap.generation });
    assert.equal(clicked.navigated, true);
    assert.match(clicked.tab.url, /\/otp\?user=rene/);
    // stale ref from the previous page is refused (acceptance 7)
    await assert.rejects(svc.act('naxon', { tab, action: 'click', ref: btn }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_STALE_REF');
    await assert.rejects(svc.act('naxon', { tab, action: 'click', ref: btn, generation: snap.generation }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_STALE_REF');
    snap = await svc.snapshot('naxon', { tab });
    const otp = /textbox "Code" \[ref=((?:f\d+)?e\d+)\]/.exec(snap.snapshot)![1]!;
    await svc.act('naxon', { tab, action: 'fill', ref: otp, value: '123456' });
    await svc.act('naxon', { tab, action: 'press', ref: otp, value: 'Enter' });
    snap = await svc.snapshot('naxon', { tab });
    assert.match(snap.snapshot, /heading "Welcome"/);
    const shot = await svc.screenshot('naxon', { tab });
    assert.ok(shot.png.length > 1000);
  });

  await t.test('profile isolation: another agent is not logged in (acceptance 6)', async () => {
    const opened = await svc.open('spielberg', 'main', { url: `${base}/` });
    assert.equal(opened.browser_id, 'agent:spielberg');
    const snap = await svc.snapshot('spielberg', { tab: opened.tab.tab_id });
    assert.match(snap.snapshot, /heading "Sign in"/);
    // and naxon's own browser is still logged in
    const again = await svc.open('naxon', 'main', { url: `${base}/`, tab: 't1' });
    const s2 = await svc.snapshot('naxon', { tab: again.tab.tab_id });
    assert.match(s2.snapshot, /heading "Welcome back"/);
    await assert.rejects(svc.tabs('lisa'), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_NOT_FOUND');
  });

  await t.test('shared profile: hans and lisa share one browser, others are refused', async () => {
    const h = await svc.open('hans', 'main', { url: `${base}/` });
    assert.equal(h.browser_id, 'profile:team');
    const l = await svc.tabs('lisa');
    assert.equal(l.browser_id, 'profile:team');
    assert.equal(l.tabs.length, 1);
  });

  await t.test('navigation policy: private host denied, deny list, redirect into LAN blocked', async () => {
    await assert.rejects(svc.open('naxon', 'main', { url: 'http://10.0.0.1/' }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_NAVIGATION_DENIED');
    await assert.rejects(svc.open('naxon', 'main', { url: 'https://www.example.org/' }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_NAVIGATION_DENIED');
    await assert.rejects(svc.open('naxon', 'main', { url: 'file:///etc/passwd' }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_NAVIGATION_DENIED');
    // a page that redirects into the LAN: the route interception stops it
    const r = await svc.open('naxon', 'main', { url: `${base}/redirect-private`, tab: 't1' });
    assert.ok(r.blocked, 'redirect target denied: ' + JSON.stringify(r));
    assert.equal(r.tab.url, 'about:blank');
    const s = await svc.snapshot('naxon', { tab: 't1' });
    assert.doesNotMatch(s.snapshot, /Internal secret/);
  });

  await t.test('tab cap', async () => {
    const second = await svc.open('naxon', 'main', { url: `${base}/otp` }); // second tab
    await assert.rejects(svc.open('naxon', 'main', { url: `${base}/otp` }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_TAB_LIMIT');
    const closed = await svc.closeTab('naxon', { tab: second.tab.tab_id });
    assert.equal(closed.remaining, 1);
  });

  await t.test('handoff: request → human control refuses agent ops → hand back wakes once', async () => {
    const h = await svc.requestHandoff('naxon', 'main', { reason: 'login needed', resume_note: 'continue with the profile page' });
    assert.equal(h.control, 'handoff_requested');
    await assert.rejects(svc.snapshot('naxon', { tab: 't1' }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_HUMAN_CONTROL');
    const human = await svc.setControl('agent:naxon', 'human', { by: 'web-1' });
    assert.equal(human.mode, 'human_control');
    await assert.rejects(svc.act('naxon', { tab: 't1', action: 'press', value: 'Enter' }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_HUMAN_CONTROL');
    await assert.rejects(svc.stop('naxon'), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_HUMAN_CONTROL');
    const back = await svc.setControl('agent:naxon', 'agent', { handoffId: h.handoff_id });
    assert.equal(back.mode, 'agent_control');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]!.session, 'main');
    assert.match(wakes[0]!.text, /login needed/);
    // a second hand-back must not wake again (acceptance 5)
    await svc.setControl('agent:naxon', 'agent', { handoffId: h.handoff_id });
    assert.equal(wakes.length, 1);
    const list = await svc.listAll();
    assert.ok(list.some((b) => b.browser_id === 'agent:naxon' && b.control === 'agent_control'));
  });

  await t.test('hand-back without handoff: wakes only after human activity, in the last agent session', async () => {
    const before = wakes.length;
    // look and return: no turn
    await svc.setControl('agent:naxon', 'human', { by: 'web-2' });
    await svc.setControl('agent:naxon', 'agent');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(wakes.length, before);
    // the agent used t1 from session 'research' last; the user navigates, then hands back
    await svc.snapshot('naxon', { tab: 't1' }); // t1 was opened from session 'main'
    await svc.setControl('agent:naxon', 'human', { by: 'web-2' });
    svc.markHumanActivity('agent:naxon', 'click');
    await svc.setControl('agent:naxon', 'agent');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(wakes.length, before + 1);
    assert.equal(wakes[before]!.agent, 'naxon');
    assert.equal(wakes[before]!.session, 'main');
    assert.match(wakes[before]!.text, /took over browser/);
    // mousemove alone is not activity
    await svc.setControl('agent:naxon', 'human', { by: 'web-2' });
    svc.markHumanActivity('agent:naxon', 'mousemove');
    await svc.setControl('agent:naxon', 'agent');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(wakes.length, before + 1);
  });

  await t.test('stop keeps the profile; ephemeral is separate', async () => {
    const e = await svc.open('naxon', 'main', { url: `${base}/`, ephemeral: true });
    assert.equal(e.browser_id, 'agent:naxon:tmp');
    const s = await svc.snapshot('naxon', { tab: e.tab.tab_id });
    assert.match(s.snapshot, /heading "Sign in"/, 'ephemeral profile has no cookie');
    const stopped = await svc.stop('naxon');
    assert.ok(stopped.stopped);
  });
});

test('browser launch options: extraArgs, device/locale emulation, headed on Xvfb', { skip: chromium.path ? false : 'no Chromium on this host' }, async (t) => {
  const { server, base } = await app();
  t.after(() => server.close());

  await t.test('extraArgs reach Chromium (a --user-agent flag is visible to the page)', async () => {
    const svc = new BrowserService({ ...cfg, extraArgs: ['--user-agent=somora-test-ua/1'] } as never, {});
    await svc.init();
    try {
      const opened = await svc.open('jarvis', 'main', { url: `${base}/` });
      const { page } = svc.viewerPage(opened.browser_id, opened.tab.tab_id);
      assert.equal(await page.evaluate(() => navigator.userAgent), 'somora-test-ua/1');
    } finally {
      await svc.shutdown();
    }
  });

  await t.test('open {device, locale}: user agent, viewport, touch and language of that tab only', async () => {
    const svc = new BrowserService(cfg as never, {});
    await svc.init();
    try {
      const phone = await svc.open('jarvis', 'main', { url: `${base}/`, device: 'iPhone 15', locale: 'de-AT' });
      assert.deepEqual(phone.tab.emulation, { device: 'iPhone 15', locale: 'de-AT' });
      const p1 = svc.viewerPage(phone.browser_id, phone.tab.tab_id).page;
      const a = await p1.evaluate(() => ({ ua: navigator.userAgent, w: window.innerWidth, touch: navigator.maxTouchPoints > 0, lang: navigator.language, dpr: window.devicePixelRatio }));
      assert.match(a.ua, /iPhone/);
      assert.equal(a.w, 393);
      assert.equal(a.touch, true);
      assert.equal(a.lang, 'de-AT');
      assert.equal(a.dpr, 3);
      const plain = await svc.open('jarvis', 'main', { url: `${base}/` });
      const p2 = svc.viewerPage(plain.browser_id, plain.tab.tab_id).page;
      const b = await p2.evaluate(() => ({ ua: navigator.userAgent, w: window.innerWidth, touch: navigator.maxTouchPoints > 0 }));
      assert.doesNotMatch(b.ua, /iPhone/);
      assert.equal(b.w, 1000);
      assert.equal(b.touch, false);
      assert.equal(plain.tab.emulation, undefined);
      // (tab cap is 2 in this cfg — reuse the plain tab for the negative case)
      await assert.rejects(svc.open('jarvis', 'main', { url: `${base}/`, tab: plain.tab.tab_id, device: 'Nokia 3310' }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_ACTION_FAILED' && /iPhone 15/.test(e.message));
    } finally {
      await svc.shutdown();
    }
  });

  await t.test('headed without a display and without Xvfb refuses loudly (no headless fallback)', async () => {
    const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XV: process.env.SOMORA_XVFB_PATH };
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    process.env.SOMORA_XVFB_PATH = '/nonexistent/Xvfb';
    try {
      const plan = planHeaded(true);
      assert.equal(plan.mode, process.platform === 'linux' ? 'unavailable' : 'display');
      if (plan.mode === 'unavailable') {
        assert.match(plan.reason, /apt install xvfb/);
        const svc = new BrowserService({ ...cfg, headed: true } as never, {});
        await svc.init();
        assert.match(svc.warnings().join('\n'), /Xvfb/);
        await assert.rejects(svc.open('jarvis', 'main', { url: `${base}/` }), (e: unknown) => e instanceof BrowserOpError && e.code === 'BROWSER_LAUNCH_FAILED' && /Xvfb/.test(e.message));
        assert.equal((await svc.status('jarvis')).headed.mode, 'unavailable');
        await svc.shutdown();
      }
    } finally {
      if (saved.DISPLAY !== undefined) process.env.DISPLAY = saved.DISPLAY;
      if (saved.WAYLAND_DISPLAY !== undefined) process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY;
      if (saved.XV === undefined) delete process.env.SOMORA_XVFB_PATH;
      else process.env.SOMORA_XVFB_PATH = saved.XV;
    }
  });

  const xvfb = process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? null : findXvfb();
  const xSockets = () => (existsSync('/tmp/.X11-unix') ? readdirSync('/tmp/.X11-unix').filter((s) => /^X(9\d|1\d\d)$/.test(s)) : []);
  await t.test('headed on Xvfb: normal user agent, navigator.webdriver false, screencast works, Xvfb stops with the browser', { skip: xvfb ? false : 'no Xvfb on this host, or a DISPLAY is set' }, async () => {
    const svc = new BrowserService({ ...cfg, headed: true } as never, {});
    await svc.init();
    assert.equal(svc.headedPlan().mode, 'xvfb');
    const before = xSockets();
    try {
      const opened = await svc.open('buffet', 'main', { url: `${base}/` });
      const list = await svc.listAll();
      assert.equal(list.find((b) => b.browser_id === opened.browser_id)?.headed, true);
      const { page } = svc.viewerPage(opened.browser_id, opened.tab.tab_id);
      const r = await page.evaluate(() => ({ ua: navigator.userAgent, webdriver: navigator.webdriver }));
      assert.doesNotMatch(r.ua, /Headless/);
      assert.match(r.ua, /Chrome\/\d+/);
      assert.equal(r.webdriver, false);
      const cdp = await page.context().newCDPSession(page);
      const frame = await new Promise<{ w: number }>((resolve) => {
        cdp.on('Page.screencastFrame', (ev: { metadata: { deviceWidth: number }; sessionId: number }) => {
          void cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId });
          resolve({ w: ev.metadata.deviceWidth });
        });
        void cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 1000, maxHeight: 700 });
      });
      assert.ok(frame.w > 0);
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      assert.equal((await svc.status('buffet')).headed.mode, 'xvfb');
      assert.equal(xSockets().length, before.length + 1, 'somora started one Xvfb for this browser');
      await svc.stop('buffet');
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(xSockets().length, before.length, 'the Xvfb is gone with the browser');
    } finally {
      await svc.shutdown();
    }
  });
});

