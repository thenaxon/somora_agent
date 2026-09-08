// Shared browser service — one managed Chromium per profile, driven by
// agents through the `browser` tool and (stage 2/3) watched and taken
// over by the user in the web client. Design: private/browser-design.md,
// spec: somora_feedback/2026-09-07_shared-browser-agent-handoff.md.
//
// Ownership model:
//   profile   = a Chromium user-data-dir = a cookie jar = ONE process.
//               Every agent has its own (`agent:<name>`) unless
//               config.browser.profiles names a shared one.
//   browser   = the running process for a profile, with its tabs.
//   tab       = a Playwright Page, owned by the agent+session that
//               opened it, with a `generation` that bumps on every
//               main-frame navigation — refs from an older generation
//               are refused by `act`.
//   control   = per browser: agent_control | handoff_requested |
//               human_control | paused. While a human controls, every
//               agent operation is refused with BROWSER_HUMAN_CONTROL.
//
// Playwright (playwright-core, no bundled browser) drives the pages —
// actionability checks, auto-wait, iframes, dialogs — against the host
// Chromium. The raw CDP session (screencast, wheel, insertText) is
// stage 2 and lives in screencast.ts.
//
// The service exists ONLY in the server process. The MCP tool child
// (claude-cli/codex-cli) reaches it over HTTP (`POST /browser/op`).

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { BrowserConfig } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { checkNavigationAllowed } from './policy.ts';
import { compactAriaSnapshot } from './snapshot.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

export type ControlMode = 'agent_control' | 'handoff_requested' | 'human_control' | 'paused';

export interface Handoff {
  id: string;
  agent: string;
  session: string;
  reason: string;
  resumeNote?: string;
  requestedAt: number;
}

export interface ControlState {
  mode: ControlMode;
  handoff?: Handoff;
  /** Who holds human control (web client connection id), stage 2. */
  humanBy?: string;
  since: number;
}

interface TabRec {
  id: string;
  page: Page;
  agent: string;
  session?: string;
  generation: number;
  createdByAgent: boolean;
  lastUsed: number;
  /** Refs of the last snapshot, keyed by generation — an `act` with a
   *  ref that was never in a snapshot of this generation is refused. */
  snapshotRefs: Set<string>;
  snapshotGeneration: number;
  /** A denied URL the tab was navigated to (redirect, in-page script)
   *  and evicted from; reported once by the next op. */
  evictedFrom?: string;
}

interface BrowserRec {
  id: string;
  profile: string;
  profileDir: string;
  ephemeral: boolean;
  /** Agents allowed on this profile. */
  agents: ReadonlySet<string> | 'any';
  context: BrowserContext;
  tabs: Map<string, TabRec>;
  control: ControlState;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
  closing: Promise<void> | null;
}

export interface TabInfo {
  tab_id: string;
  url: string;
  title: string;
  agent: string;
  session?: string;
  generation: number;
}

export interface BrowserInfo {
  browser_id: string;
  profile: string;
  ephemeral: boolean;
  state: 'running' | 'stopped';
  control: ControlMode;
  handoff?: Handoff;
  tabs: TabInfo[];
  last_used: number;
}

export interface ServiceDeps {
  /** Stage 3: wake the agent in its session after "Agent übernimmt". */
  dispatchWakeTurn?: (args: { agent: string; session: string; text: string }) => Promise<void>;
  /** Stage 3: tell the session that a handoff was requested (notice). */
  notifyHandoff?: (handoff: Handoff, browserId: string) => Promise<void>;
}

export class BrowserOpError extends Error {
  constructor(
    readonly code:
      | 'BROWSER_DISABLED'
      | 'BROWSER_NOT_FOUND'
      | 'BROWSER_HUMAN_CONTROL'
      | 'BROWSER_NAVIGATION_DENIED'
      | 'BROWSER_TAB_NOT_FOUND'
      | 'BROWSER_STALE_REF'
      | 'BROWSER_TAB_LIMIT'
      | 'BROWSER_NOT_ALLOWED'
      | 'BROWSER_LAUNCH_FAILED'
      | 'BROWSER_ACTION_FAILED',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const EXECUTABLE_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/opt/homebrew/bin/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function detectExecutable(configured?: string): { path: string | null; tried: string[] } {
  const tried = configured ? [configured] : EXECUTABLE_CANDIDATES;
  for (const p of tried) if (existsSync(p)) return { path: p, tried };
  return { path: null, tried };
}

function nowMs(): number {
  return Date.now();
}

/** Something a viewer should redraw: tabs came or went, control changed. */
export type ChangeListener = (browserId: string) => void;

export class BrowserService {
  private cfg: BrowserConfig;
  private deps: ServiceDeps;
  private listeners = new Set<ChangeListener>();
  private browsers = new Map<string, BrowserRec>();
  private launching = new Map<string, Promise<BrowserRec>>();
  /** Tab ids are unique across ALL browsers (an agent can have its
   *  persistent and an ephemeral browser at once), so a tab id alone
   *  identifies the browser too. */
  private nextTab = 1;
  /** Control state survives a stop/restart of the process for the
   *  pending-handoff case; persisted per browser id. */
  private persisted: Record<string, { control: ControlState }> = {};

  constructor(cfg: BrowserConfig, deps: ServiceDeps = {}) {
    this.cfg = cfg;
    this.deps = deps;
  }

  static get dir(): string {
    return join(SOMORA_HOME, 'browser');
  }
  static get profilesDir(): string {
    return join(BrowserService.dir, 'profiles');
  }
  static get statePath(): string {
    return join(BrowserService.dir, 'state.json');
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  get config(): BrowserConfig {
    return this.cfg;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(browserId: string): void {
    for (const l of this.listeners) {
      try {
        l(browserId);
      } catch {
        /* listener errors never reach the service */
      }
    }
  }

  async init(): Promise<void> {
    mkdirSync(BrowserService.profilesDir, { recursive: true });
    try {
      const raw = await readFile(BrowserService.statePath, 'utf8');
      const parsed = JSON.parse(raw) as { browsers?: Record<string, { control: ControlState }> };
      this.persisted = parsed.browsers ?? {};
    } catch {
      this.persisted = {};
    }
    const exe = detectExecutable(this.cfg.executablePath);
    logger.info({
      msg: 'browser.service_ready',
      enabled: this.cfg.enabled,
      executable: exe.path,
      profilesDir: BrowserService.profilesDir,
      pendingHandoffs: Object.values(this.persisted).filter((p) => p.control?.handoff).length,
    });
  }

  private async persist(): Promise<void> {
    const browsers: Record<string, { control: ControlState }> = { ...this.persisted };
    for (const b of this.browsers.values()) browsers[b.id] = { control: b.control };
    try {
      await writeFile(BrowserService.statePath, JSON.stringify({ browsers }, null, 2), 'utf8');
    } catch (err) {
      logger.warn({ msg: 'browser.state_persist_failed', err: (err as Error).message });
    }
  }

  // ── profiles ──────────────────────────────────────────────────────

  /** The profile an agent works in: a shared one it is listed on, else its own. */
  profileFor(agent: string): { id: string; profile: string; agents: ReadonlySet<string> | 'any'; dir: string } {
    for (const [name, p] of Object.entries(this.cfg.profiles)) {
      if (p.agents.includes(agent)) {
        return { id: `profile:${name}`, profile: name, agents: new Set(p.agents), dir: join(BrowserService.profilesDir, `shared-${name}`) };
      }
    }
    return { id: `agent:${agent}`, profile: agent, agents: new Set([agent]), dir: join(BrowserService.profilesDir, agent) };
  }

  private assertAllowed(b: BrowserRec, agent: string): void {
    if (b.agents !== 'any' && !b.agents.has(agent)) {
      throw new BrowserOpError('BROWSER_NOT_ALLOWED', `agent '${agent}' is not allowed on browser '${b.id}'`);
    }
  }

  private assertAgentControl(b: BrowserRec): void {
    if (b.control.mode === 'human_control') {
      throw new BrowserOpError(
        'BROWSER_HUMAN_CONTROL',
        `the user is controlling browser '${b.id}' right now — do not retry; end your turn and wait until the user hands control back`,
      );
    }
    if (b.control.mode === 'handoff_requested') {
      throw new BrowserOpError(
        'BROWSER_HUMAN_CONTROL',
        `browser '${b.id}' is waiting for the user (handoff requested: ${b.control.handoff?.reason ?? ''}) — end your turn; you will be woken when the user hands control back`,
      );
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────

  private async ensureBrowser(agent: string, opts: { ephemeral?: boolean }): Promise<BrowserRec> {
    if (!this.cfg.enabled) throw new BrowserOpError('BROWSER_DISABLED', 'browser.enabled is false in config.yaml');
    const base = this.profileFor(agent);
    const id = opts.ephemeral ? `${base.id}:tmp` : base.id;
    const existing = this.browsers.get(id);
    if (existing && !existing.closing) {
      this.assertAllowed(existing, agent);
      this.touch(existing);
      return existing;
    }
    const pending = this.launching.get(id);
    if (pending) return pending;
    const p = this.launch(id, base, Boolean(opts.ephemeral)).finally(() => this.launching.delete(id));
    this.launching.set(id, p);
    return p;
  }

  private async launch(
    id: string,
    base: ReturnType<BrowserService['profileFor']>,
    ephemeral: boolean,
  ): Promise<BrowserRec> {
    const exe = detectExecutable(this.cfg.executablePath);
    if (!exe.path) {
      throw new BrowserOpError(
        'BROWSER_LAUNCH_FAILED',
        `no Chromium found (tried ${exe.tried.join(', ')}) — install chromium or set browser.executablePath`,
      );
    }
    const dir = ephemeral ? join(BrowserService.profilesDir, `.tmp-${base.profile}-${randomUUID().slice(0, 8)}`) : base.dir;
    mkdirSync(dir, { recursive: true });
    const t0 = nowMs();
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(dir, {
        executablePath: exe.path,
        headless: true,
        viewport: { width: this.cfg.viewport.width, height: this.cfg.viewport.height },
        acceptDownloads: false,
        args: ['--no-first-run', '--disable-background-networking', '--disable-sync'],
      });
    } catch (err) {
      throw new BrowserOpError('BROWSER_LAUNCH_FAILED', `${exe.path}: ${(err as Error).message}`);
    }
    const rec: BrowserRec = {
      id,
      profile: base.profile,
      profileDir: dir,
      ephemeral,
      agents: base.agents,
      context,
      tabs: new Map(),
      control: this.persisted[id]?.control ?? { mode: 'agent_control', since: nowMs() },
      lastUsed: nowMs(),
      idleTimer: null,
      closing: null,
    };
    // A pending handoff from before a restart stays pending — the user
    // may still be about to take over. Anything else starts fresh.
    if (rec.control.mode === 'human_control' || rec.control.mode === 'paused') {
      rec.control = { mode: 'agent_control', since: nowMs() };
    }
    // Every document request (incl. redirects and target=_blank) runs
    // through the policy — the route is the safety net behind the
    // pre-check in open()/act().
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (req.resourceType() !== 'document') return route.continue();
      const verdict = await checkNavigationAllowed(req.url(), this.cfg);
      if (verdict.ok) return route.continue();
      logger.warn({ msg: 'browser.navigation_denied', browser: id, url: req.url(), reason: verdict.reason });
      return route.abort('blockedbyclient');
    });
    context.on('page', (page) => this.adoptPage(rec, page, { agent: '_user', createdByAgent: false }));
    context.on('close', () => {
      this.browsers.delete(id);
      if (rec.idleTimer) clearTimeout(rec.idleTimer);
      logger.info({ msg: 'browser.closed', browser: id });
      this.emitChange(id);
    });
    // Playwright opens one blank page with a persistent context; keep
    // it as the first tab so `open` without a tab reuses it.
    for (const page of context.pages()) this.adoptPage(rec, page, { agent: '_init', createdByAgent: false });
    this.browsers.set(id, rec);
    this.touch(rec);
    void this.persist();
    logger.info({ msg: 'browser.launched', browser: id, profile: base.profile, dir, ephemeral, ms: nowMs() - t0, executable: exe.path });
    return rec;
  }

  private adoptPage(b: BrowserRec, page: Page, owner: { agent: string; session?: string; createdByAgent: boolean }): TabRec {
    for (const t of b.tabs.values()) if (t.page === page) return t;
    const id = `t${this.nextTab++}`;
    const tab: TabRec = {
      id,
      page,
      agent: owner.agent,
      ...(owner.session ? { session: owner.session } : {}),
      generation: 1,
      createdByAgent: owner.createdByAgent,
      lastUsed: nowMs(),
      snapshotRefs: new Set(),
      snapshotGeneration: 0,
    };
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      tab.generation++;
      tab.snapshotRefs = new Set();
      // Redirect hops are not routed through the request interception
      // (Chromium follows them before Playwright sees a new request), so
      // a page that ended up somewhere the policy forbids is evicted
      // right after the fact: back to about:blank, and the next op on
      // the tab reports where it was sent. Documented limit: the first
      // request to that host has already been made.
      const url = frame.url();
      if (!/^https?:/.test(url)) return;
      void checkNavigationAllowed(url, this.cfg).then((verdict) => {
        if (verdict.ok || page.isClosed()) return;
        tab.evictedFrom = url;
        logger.warn({ msg: 'browser.navigation_evicted', browser: b.id, tab: id, url, reason: verdict.reason });
        page.goto('about:blank').catch(() => {});
      });
    });
    page.on('close', () => {
      b.tabs.delete(id);
      this.emitChange(b.id);
    });
    b.tabs.set(id, tab);
    this.emitChange(b.id);
    return tab;
  }

  private touch(b: BrowserRec): void {
    b.lastUsed = nowMs();
    if (b.idleTimer) clearTimeout(b.idleTimer);
    b.idleTimer = setTimeout(() => {
      // Never stop under a human's hands or with a handoff pending.
      if (b.control.mode === 'human_control' || b.control.mode === 'handoff_requested') {
        this.touch(b);
        return;
      }
      logger.info({ msg: 'browser.idle_stop', browser: b.id, idleMinutes: this.cfg.idleStopMinutes });
      void this.stopBrowser(b);
    }, this.cfg.idleStopMinutes * 60_000);
    b.idleTimer.unref();
  }

  private async stopBrowser(b: BrowserRec): Promise<void> {
    if (b.closing) return b.closing;
    b.closing = (async () => {
      if (b.idleTimer) clearTimeout(b.idleTimer);
      try {
        await b.context.close();
      } catch (err) {
        logger.warn({ msg: 'browser.close_failed', browser: b.id, err: (err as Error).message });
      }
      this.browsers.delete(b.id);
      if (b.ephemeral) await rm(b.profileDir, { recursive: true, force: true }).catch(() => {});
      await this.persist();
    })();
    return b.closing;
  }

  /** The agent's running browsers: persistent first, then ephemeral. */
  private browsersFor(agent: string): BrowserRec[] {
    const id = this.profileFor(agent).id;
    return [this.browsers.get(id), this.browsers.get(`${id}:tmp`)].filter((b): b is BrowserRec => Boolean(b) && !b!.closing);
  }

  private browserOf(agent: string, tabId?: string): BrowserRec {
    const candidates = this.browsersFor(agent);
    if (candidates.length === 0) throw new BrowserOpError('BROWSER_NOT_FOUND', `no running browser for agent '${agent}' — call op:"open" first`);
    const b = tabId ? candidates.find((c) => c.tabs.has(tabId)) ?? candidates[0]! : candidates[0]!;
    this.assertAllowed(b, agent);
    return b;
  }

  private tabOf(b: BrowserRec, tabId: string): TabRec {
    const t = b.tabs.get(tabId);
    if (!t || t.page.isClosed()) throw new BrowserOpError('BROWSER_TAB_NOT_FOUND', `tab '${tabId}' not found in browser '${b.id}' — op:"tabs" lists the open ones`);
    t.lastUsed = nowMs();
    this.touch(b);
    return t;
  }

  /** Take the pending eviction note off a tab (reported once). */
  private evicted(t: TabRec): string | undefined {
    if (!t.evictedFrom) return undefined;
    const url = t.evictedFrom;
    delete t.evictedFrom;
    return `the page was sent to '${url}', which the navigation policy forbids — the tab was reset to about:blank`;
  }

  private async tabInfo(t: TabRec): Promise<TabInfo> {
    let title = '';
    try {
      title = await t.page.title();
    } catch {
      /* closed mid-way */
    }
    return {
      tab_id: t.id,
      url: t.page.url(),
      title,
      agent: t.agent,
      ...(t.session ? { session: t.session } : {}),
      generation: t.generation,
    };
  }

  // ── operations ────────────────────────────────────────────────────

  async open(
    agent: string,
    session: string | undefined,
    args: { url: string; tab?: string; ephemeral?: boolean },
  ): Promise<{ browser_id: string; tab: TabInfo; control: ControlMode; blocked?: string }> {
    const verdict = await checkNavigationAllowed(args.url, this.cfg);
    if (!verdict.ok) throw new BrowserOpError('BROWSER_NAVIGATION_DENIED', verdict.reason!);
    const b = args.tab ? this.browserOf(agent, args.tab) : await this.ensureBrowser(agent, { ephemeral: args.ephemeral });
    this.assertAgentControl(b);
    let tab: TabRec;
    if (args.tab) {
      tab = this.tabOf(b, args.tab);
    } else {
      // Reuse the initial blank tab once; otherwise a new one under the cap.
      const blank = [...b.tabs.values()].find((t) => t.agent === '_init' && t.page.url() === 'about:blank');
      if (blank) {
        tab = blank;
        tab.agent = agent;
        if (session) tab.session = session;
        tab.createdByAgent = true;
      } else {
        if (b.tabs.size >= this.cfg.maxTabsPerAgent) {
          throw new BrowserOpError(
            'BROWSER_TAB_LIMIT',
            `browser '${b.id}' already has ${b.tabs.size} tabs (browser.maxTabsPerAgent) — close one with op:"close_tab" or reuse one with tab:"t<n>"`,
          );
        }
        const page = await b.context.newPage();
        tab = this.adoptPage(b, page, { agent, ...(session ? { session } : {}), createdByAgent: true });
      }
    }
    let blocked: string | undefined;
    try {
      await tab.page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      const msg = (err as Error).message;
      if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(msg)) blocked = 'a redirect target was denied by the navigation policy';
      else throw new BrowserOpError('BROWSER_ACTION_FAILED', `open ${args.url}: ${msg.split('\n')[0]}`);
    }
    await tab.page.waitForTimeout(150);
    blocked = blocked ?? this.evicted(tab);
    if (tab.page.url().startsWith('chrome-error://')) blocked = blocked ?? 'the navigation ended on an error page (unreachable host)';
    logger.info({ msg: 'browser.open', browser: b.id, tab: tab.id, agent, url: args.url, blocked: blocked ?? null });
    return { browser_id: b.id, tab: await this.tabInfo(tab), control: b.control.mode, ...(blocked ? { blocked } : {}) };
  }

  async tabs(agent: string): Promise<{ browser_id: string; control: ControlMode; tabs: TabInfo[] }> {
    const bs = this.browsersFor(agent);
    if (bs.length === 0) throw new BrowserOpError('BROWSER_NOT_FOUND', `no running browser for agent '${agent}' — call op:"open" first`);
    for (const b of bs) this.assertAllowed(b, agent);
    const tabs = (
      await Promise.all(bs.map((b) => Promise.all([...b.tabs.values()].filter((t) => !t.page.isClosed()).map((t) => this.tabInfo(t)))))
    ).flat();
    return { browser_id: bs[0]!.id, control: bs[0]!.control.mode, tabs };
  }

  async status(agent: string): Promise<{
    enabled: boolean;
    executable: string | null;
    profile: string;
    browser_id: string;
    running: boolean;
    control?: ControlMode;
    handoff?: Handoff;
    tabs?: TabInfo[];
  }> {
    const exe = detectExecutable(this.cfg.executablePath);
    const base = this.profileFor(agent);
    const b = this.browsers.get(base.id);
    if (!b || b.closing) return { enabled: this.cfg.enabled, executable: exe.path, profile: base.profile, browser_id: base.id, running: false };
    const tabs = await Promise.all([...b.tabs.values()].filter((t) => !t.page.isClosed()).map((t) => this.tabInfo(t)));
    return {
      enabled: this.cfg.enabled,
      executable: exe.path,
      profile: base.profile,
      browser_id: b.id,
      running: true,
      control: b.control.mode,
      ...(b.control.handoff ? { handoff: b.control.handoff } : {}),
      tabs,
    };
  }

  async snapshot(
    agent: string,
    args: { tab: string; full?: boolean; max_chars?: number },
  ): Promise<{ tab: TabInfo; generation: number; snapshot: string; truncated: boolean }> {
    const b = this.browserOf(agent, args.tab);
    this.assertAgentControl(b);
    const t = this.tabOf(b, args.tab);
    const raw = await t.page.ariaSnapshot({ mode: 'ai', timeout: 15_000 });
    const gen = t.generation;
    const result = args.full ? { text: raw, truncated: false } : compactAriaSnapshot(raw, args.max_chars ?? 20_000);
    // Playwright numbers refs `e<n>`, prefixed `f<n>` once the page has
    // navigated within the context (frame generation) — accept both.
    t.snapshotRefs = new Set([...raw.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map((m) => m[1]!));
    t.snapshotGeneration = gen;
    return { tab: await this.tabInfo(t), generation: gen, snapshot: result.text, truncated: result.truncated };
  }

  async act(
    agent: string,
    args: {
      tab: string;
      action: 'click' | 'fill' | 'press' | 'scroll' | 'select';
      ref?: string;
      value?: string;
      generation?: number;
    },
  ): Promise<{ tab: TabInfo; generation: number; navigated: boolean; blocked?: string }> {
    const b = this.browserOf(agent, args.tab);
    this.assertAgentControl(b);
    const t = this.tabOf(b, args.tab);
    const genBefore = t.generation;
    if (args.generation !== undefined && args.generation !== t.generation) {
      throw new BrowserOpError(
        'BROWSER_STALE_REF',
        `tab '${t.id}' navigated since generation ${args.generation} (now ${t.generation}) — take a new snapshot before acting`,
      );
    }
    if (args.ref) {
      if (t.snapshotGeneration !== t.generation || !t.snapshotRefs.has(args.ref)) {
        throw new BrowserOpError(
          'BROWSER_STALE_REF',
          `ref '${args.ref}' is not from a snapshot of the current page state of tab '${t.id}' — take a new snapshot first`,
        );
      }
    }
    const loc = args.ref ? t.page.locator(`aria-ref=${args.ref}`) : null;
    const timeout = 10_000;
    try {
      switch (args.action) {
        case 'click':
          if (!loc) throw new Error('click needs a ref');
          await loc.click({ timeout });
          break;
        case 'fill':
          if (!loc) throw new Error('fill needs a ref');
          await loc.fill(args.value ?? '', { timeout });
          break;
        case 'press':
          if (!args.value) throw new Error('press needs value (a key name like Enter, Tab, Escape, ArrowDown)');
          if (loc) await loc.press(args.value, { timeout });
          else await t.page.keyboard.press(args.value);
          break;
        case 'scroll':
          if (loc) await loc.scrollIntoViewIfNeeded({ timeout });
          else await t.page.mouse.wheel(0, Number(args.value ?? '600') || 600);
          break;
        case 'select':
          if (!loc) throw new Error('select needs a ref');
          await loc.selectOption(args.value ?? '', { timeout });
          break;
      }
    } catch (err) {
      throw new BrowserOpError('BROWSER_ACTION_FAILED', `${args.action}${args.ref ? ` ${args.ref}` : ''}: ${(err as Error).message.split('\n')[0]}`);
    }
    // Give a navigation the action may have started a moment to land.
    await t.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await t.page.waitForTimeout(150);
    const navigated = t.generation !== genBefore;
    const blocked = this.evicted(t) ?? (t.page.url().startsWith('chrome-error://') ? 'the navigation ended on an error page (unreachable host)' : undefined);
    return { tab: await this.tabInfo(t), generation: t.generation, navigated, ...(blocked ? { blocked } : {}) };
  }

  async screenshot(agent: string, args: { tab: string }): Promise<{ tab: TabInfo; png: Buffer }> {
    const b = this.browserOf(agent, args.tab);
    this.assertAgentControl(b);
    const t = this.tabOf(b, args.tab);
    const png = await t.page.screenshot({ type: 'png', timeout: 15_000 });
    return { tab: await this.tabInfo(t), png };
  }

  async requestHandoff(
    agent: string,
    session: string | undefined,
    args: { reason: string; resume_note?: string },
  ): Promise<{ browser_id: string; handoff_id: string; control: ControlMode }> {
    const b = this.browserOf(agent);
    if (!session) throw new BrowserOpError('BROWSER_ACTION_FAILED', 'request_handoff needs a session to resume in');
    if (b.control.mode === 'human_control') {
      throw new BrowserOpError('BROWSER_HUMAN_CONTROL', `the user already controls browser '${b.id}'`);
    }
    const handoff: Handoff = {
      id: randomUUID(),
      agent,
      session,
      reason: args.reason,
      ...(args.resume_note ? { resumeNote: args.resume_note } : {}),
      requestedAt: nowMs(),
    };
    b.control = { mode: 'handoff_requested', handoff, since: nowMs() };
    this.touch(b);
    await this.persist();
    this.emitChange(b.id);
    logger.info({ msg: 'browser.handoff_requested', browser: b.id, agent, session, reason: args.reason });
    if (this.deps.notifyHandoff) await this.deps.notifyHandoff(handoff, b.id).catch((err) => logger.warn({ msg: 'browser.handoff_notify_failed', err: String(err) }));
    return { browser_id: b.id, handoff_id: handoff.id, control: b.control.mode };
  }

  async closeTab(agent: string, args: { tab: string }): Promise<{ closed: string; remaining: number }> {
    const b = this.browserOf(agent, args.tab);
    this.assertAgentControl(b);
    const t = this.tabOf(b, args.tab);
    await t.page.close().catch(() => {});
    b.tabs.delete(t.id);
    return { closed: t.id, remaining: [...b.tabs.values()].filter((x) => !x.page.isClosed()).length };
  }

  async stop(agent: string): Promise<{ stopped: string | null }> {
    const bs = this.browsersFor(agent);
    if (bs.length === 0) return { stopped: null };
    for (const b of bs) {
      this.assertAllowed(b, agent);
      if (b.control.mode === 'human_control') throw new BrowserOpError('BROWSER_HUMAN_CONTROL', `the user controls browser '${b.id}'`);
    }
    await Promise.all(bs.map((b) => this.stopBrowser(b)));
    return { stopped: bs.map((b) => b.id).join(', ') };
  }

  // ── UI / control (stage 3 surfaces; HTTP-testable now) ────────────

  async listAll(): Promise<BrowserInfo[]> {
    const out: BrowserInfo[] = [];
    for (const b of this.browsers.values()) {
      if (b.closing) continue;
      const tabs = await Promise.all([...b.tabs.values()].filter((t) => !t.page.isClosed()).map((t) => this.tabInfo(t)));
      out.push({
        browser_id: b.id,
        profile: b.profile,
        ephemeral: b.ephemeral,
        state: 'running',
        control: b.control.mode,
        ...(b.control.handoff ? { handoff: b.control.handoff } : {}),
        tabs,
        last_used: b.lastUsed,
      });
    }
    for (const [id, p] of Object.entries(this.persisted)) {
      if (this.browsers.has(id)) continue;
      if (!p.control?.handoff) continue;
      out.push({ browser_id: id, profile: id.replace(/^(agent|profile):/, ''), ephemeral: false, state: 'stopped', control: 'paused', handoff: p.control.handoff, tabs: [], last_used: 0 });
    }
    return out;
  }

  /**
   * Human takes or returns control. `agent` = hand back: if a handoff
   * was pending, the requesting agent is woken exactly once in its
   * session (idempotent per handoff id).
   */
  async setControl(browserId: string, mode: 'human' | 'agent', opts: { by?: string; handoffId?: string } = {}): Promise<ControlState> {
    const b = this.browsers.get(browserId);
    if (!b || b.closing) throw new BrowserOpError('BROWSER_NOT_FOUND', `browser '${browserId}' is not running`);
    if (mode === 'human') {
      b.control = { mode: 'human_control', ...(b.control.handoff ? { handoff: b.control.handoff } : {}), ...(opts.by ? { humanBy: opts.by } : {}), since: nowMs() };
      this.touch(b);
      await this.persist();
      logger.info({ msg: 'browser.human_control', browser: b.id, by: opts.by ?? null });
      this.emitChange(b.id);
      return b.control;
    }
    const handoff = b.control.handoff;
    if (handoff && opts.handoffId && opts.handoffId !== handoff.id) {
      // A stale button press for an older handoff: just switch, no wake.
      b.control = { mode: 'agent_control', since: nowMs() };
      await this.persist();
      return b.control;
    }
    b.control = { mode: 'agent_control', since: nowMs() };
    this.touch(b);
    await this.persist();
    logger.info({ msg: 'browser.agent_control', browser: b.id, wake: handoff ? handoff.id : null });
    this.emitChange(b.id);
    if (handoff && this.deps.dispatchWakeTurn) {
      const text =
        `[browser] The user handed browser '${b.id}' back to you (handoff ${handoff.id}). ` +
        `Reason you asked for it: ${handoff.reason}. ` +
        (handoff.resumeNote ? `Your note: ${handoff.resumeNote}. ` : '') +
        'Take a fresh snapshot before acting — the page may have changed.';
      void this.deps.dispatchWakeTurn({ agent: handoff.agent, session: handoff.session, text }).catch((err) =>
        logger.warn({ msg: 'browser.wake_failed', browser: b.id, err: String(err) }),
      );
    }
    return b.control;
  }

  // ── viewer surface (stage 2: web client) ──────────────────────────

  /** Running browser by id, for the viewer path. */
  private runningBrowser(browserId: string): BrowserRec {
    const b = this.browsers.get(browserId);
    if (!b || b.closing) throw new BrowserOpError('BROWSER_NOT_FOUND', `browser '${browserId}' is not running`);
    return b;
  }

  /** Summary of one browser for the viewer header. */
  async browserInfo(browserId: string): Promise<BrowserInfo> {
    const b = this.runningBrowser(browserId);
    const tabs = await Promise.all([...b.tabs.values()].filter((t) => !t.page.isClosed()).map((t) => this.tabInfo(t)));
    return {
      browser_id: b.id,
      profile: b.profile,
      ephemeral: b.ephemeral,
      state: 'running',
      control: b.control.mode,
      ...(b.control.handoff ? { handoff: b.control.handoff } : {}),
      tabs,
      last_used: b.lastUsed,
    };
  }

  /** The page a viewer wants to watch: the given tab, else the most
   *  recently used one. Touches the browser (viewers count as activity). */
  viewerPage(browserId: string, tabId?: string): { tabId: string; page: Page; generation: number } {
    const b = this.runningBrowser(browserId);
    this.touch(b);
    const live = [...b.tabs.values()].filter((t) => !t.page.isClosed());
    const t = (tabId ? live.find((x) => x.id === tabId) : undefined) ?? live.sort((a, c) => c.lastUsed - a.lastUsed)[0];
    if (!t) throw new BrowserOpError('BROWSER_TAB_NOT_FOUND', `browser '${browserId}' has no open tab`);
    return { tabId: t.id, page: t.page, generation: t.generation };
  }

  /** True when this viewer connection may drive the browser. */
  humanControls(browserId: string, by: string): boolean {
    const b = this.browsers.get(browserId);
    return Boolean(b && !b.closing && b.control.mode === 'human_control' && (b.control.humanBy === undefined || b.control.humanBy === by));
  }

  /** Human navigation (URL bar) — same policy as the agent's `open`. */
  async humanNavigate(browserId: string, tabId: string, url: string): Promise<void> {
    const verdict = await checkNavigationAllowed(url, this.cfg);
    if (!verdict.ok) throw new BrowserOpError('BROWSER_NAVIGATION_DENIED', verdict.reason!);
    const { page } = this.viewerPage(browserId, tabId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
      throw new BrowserOpError('BROWSER_ACTION_FAILED', (err as Error).message.split('\n')[0]!);
    });
  }

  /** A tab the human opened (not the agent's, so tab cleanup leaves it). */
  async humanNewTab(browserId: string, by: string): Promise<string> {
    const b = this.runningBrowser(browserId);
    if (b.tabs.size >= this.cfg.maxTabsPerAgent) throw new BrowserOpError('BROWSER_TAB_LIMIT', `browser '${b.id}' already has ${b.tabs.size} tabs`);
    const page = await b.context.newPage();
    const tab = this.adoptPage(b, page, { agent: `_user:${by}`, createdByAgent: false });
    this.touch(b);
    return tab.id;
  }

  async humanCloseTab(browserId: string, tabId: string): Promise<void> {
    const b = this.runningBrowser(browserId);
    const t = b.tabs.get(tabId);
    if (!t) return;
    await t.page.close().catch(() => {});
    b.tabs.delete(tabId);
    this.emitChange(b.id);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.browsers.values()].map((b) => this.stopBrowser(b)));
  }
}

let service: BrowserService | null = null;

export function configureBrowserService(cfg: BrowserConfig, deps: ServiceDeps = {}): BrowserService {
  service = new BrowserService(cfg, deps);
  return service;
}

export function getBrowserService(): BrowserService {
  if (!service) throw new BrowserOpError('BROWSER_DISABLED', 'browser service is not configured in this process');
  return service;
}
