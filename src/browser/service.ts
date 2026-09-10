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
//   view      = one agent's window on a process (`<browser id>@<agent>`).
//               A shared profile has ONE process but one view per agent,
//               so hans and lisa each get their own window, tabs, control
//               state and handoff (private/browser-design.md §10).
//   control   = per view: agent_control | handoff_requested |
//               human_control | paused. While a human controls a view,
//               that view's agent operations are refused with
//               BROWSER_HUMAN_CONTROL; the other agents keep working.
//
// Playwright (playwright-core, no bundled browser) drives the pages —
// actionability checks, auto-wait, iframes, dialogs — against the host
// Chromium. The raw CDP session (screencast, wheel, insertText) is
// stage 2 and lives in screencast.ts.
//
// The service exists ONLY in the server process. The MCP tool child
// (claude-cli/codex-cli) reaches it over HTTP (`POST /browser/op`).

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, devices, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import type { BrowserConfig } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { checkNavigationAllowed } from './policy.ts';
import { compactAriaSnapshot } from './snapshot.ts';
import { planHeaded, startVirtualDisplay, type HeadedPlan, type VirtualDisplay } from './display.ts';

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
  /** The human did something (click, typing, navigation) while in
   *  control — a hand-back then wakes the agent even without a pending
   *  handoff. A look-and-return leaves it false: no turn is spent. */
  humanTouched?: boolean;
  since: number;
}

/** One agent's window on a browser process. */
export interface ViewState {
  agent: string;
  control: ControlState;
}

/** `<browser id>@<agent>` — what every viewer surface addresses. `@` is
 *  safe in a URL path and query and cannot occur in an agent name. */
export function viewIdOf(browserId: string, agent: string): string {
  return `${browserId}@${agent}`;
}

/** The Chromium process behind a view id; a process id passes through. */
export function processIdOf(id: string): string {
  const i = id.lastIndexOf('@');
  return i < 0 ? id : id.slice(0, i);
}

/** The owning agent of a view id, or undefined for a bare process id. */
export function agentOfViewId(id: string): string | undefined {
  const i = id.lastIndexOf('@');
  return i < 0 ? undefined : id.slice(i + 1);
}

interface TabRec {
  id: string;
  page: Page;
  agent: string;
  session?: string;
  generation: number;
  createdByAgent: boolean;
  /** The blank page a persistent context always opens; the first
   *  `open` without a tab reuses it instead of adding a second tab. */
  initialBlank?: boolean;
  lastUsed: number;
  /** Refs of the last snapshot, keyed by generation — an `act` with a
   *  ref that was never in a snapshot of this generation is refused. */
  snapshotRefs: Set<string>;
  snapshotGeneration: number;
  /** Per-tab emulation set by open {device, locale} — reported in TabInfo. */
  emulation?: { device?: string; locale?: string };
  /** CDP session used for emulation (kept for the tab's lifetime). */
  cdp?: CDPSession;
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
  /** One view per agent that has used this process, keyed by agent. */
  views: Map<string, ViewState>;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
  closing: Promise<void> | null;
  /** Launched with a window (browser.headed). */
  headed: boolean;
  /** The Xvfb this browser runs on, when somora started one. */
  display?: VirtualDisplay;
}

export interface TabInfo {
  tab_id: string;
  url: string;
  title: string;
  agent: string;
  session?: string;
  generation: number;
  /** Device/locale emulation active on this tab (open {device, locale}). */
  emulation?: { device?: string; locale?: string };
}

export interface BrowserInfo {
  /** `<browser id>@<agent>` — what control, attach and restart take. */
  view_id: string;
  /** The agent this window belongs to. */
  agent: string;
  browser_id: string;
  profile: string;
  ephemeral: boolean;
  state: 'running' | 'stopped';
  control: ControlMode;
  handoff?: Handoff;
  tabs: TabInfo[];
  human_by?: string;
  last_used: number;
  /** Launched with a window (browser.headed); absent for stopped entries. */
  headed?: boolean;
}

export interface ServiceDeps {
  /** Wake the agent in its session after "Hand back". */
  dispatchWakeTurn?: (args: { agent: string; session: string; text: string }) => Promise<void>;
  /** Resolve and validate a live session before binding a browser or waking it. */
  resolveSession?: (agent: string, ref: string) => Promise<string>;
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

/** Something a viewer should redraw: tabs came or went, control changed.
 *  The id is the PROCESS id — a viewer on `<id>@<agent>` redraws too. */
export type ChangeListener = (browserId: string) => void;

/** Pre-§10 state files stored one control per process. Keep only what
 *  still means something: a pending handoff, moved to its agent's view. */
export function migratePersisted(
  saved: Record<string, { control: ControlState }>,
): Record<string, { control: ControlState }> {
  const out: Record<string, { control: ControlState }> = {};
  for (const [id, entry] of Object.entries(saved)) {
    if (id.includes('@')) {
      out[id] = entry;
      continue;
    }
    const agent = entry?.control?.handoff?.agent;
    if (agent) out[viewIdOf(id, agent)] = entry;
  }
  return out;
}

export class BrowserService {
  private cfg: BrowserConfig;
  private deps: ServiceDeps;
  private writes: Promise<void> = Promise.resolve();
  private operations = new Map<string, Promise<unknown>>();
  private listeners = new Set<ChangeListener>();
  private browsers = new Map<string, BrowserRec>();
  private launching = new Map<string, Promise<BrowserRec>>();
  /** Tab ids are unique across ALL browsers (an agent can have its
   *  persistent and an ephemeral browser at once), so a tab id alone
   *  identifies the browser too. */
  private nextTab = 1;
  /** Control state survives a stop/restart of the process for the
   *  pending-handoff case; persisted per VIEW id (`<browser>@<agent>`). */
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
      this.persisted = migratePersisted(parsed.browsers ?? {});
    } catch {
      this.persisted = {};
    }
    const exe = detectExecutable(this.cfg.executablePath);
    const headed = planHeaded(this.cfg.headed);
    logger.info({
      msg: 'browser.service_ready',
      enabled: this.cfg.enabled,
      executable: exe.path,
      headed: headed.mode,
      profilesDir: BrowserService.profilesDir,
      pendingHandoffs: Object.values(this.persisted).filter((p) => p.control?.handoff).length,
    });
    if (this.cfg.enabled && headed.mode === 'unavailable') {
      logger.warn({ msg: 'browser.headed_unavailable', reason: headed.reason });
    }
  }

  /** Headed-mode plan for this host (config + DISPLAY + Xvfb), without launching. */
  headedPlan(): HeadedPlan {
    return planHeaded(this.cfg.headed);
  }

  /** Operator-facing warnings for the status route and the browser list. */
  warnings(): string[] {
    const out: string[] = [];
    if (!this.cfg.enabled) return out;
    const exe = detectExecutable(this.cfg.executablePath);
    if (!exe.path) out.push(`no Chromium found (tried ${exe.tried.join(', ')}) — install chromium or set browser.executablePath`);
    const headed = planHeaded(this.cfg.headed);
    if (headed.mode === 'unavailable') out.push(headed.reason);
    return out;
  }

  /** Shared by agent operations and viewer input: takeover waits for accepted
   * work, and a queued agent action checks control again before executing. */
  async withBrowserLock<T>(viewOrBrowserId: string, fn: () => Promise<T>): Promise<T> {
    const id = processIdOf(viewOrBrowserId);
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.operations.set(id, next);
    try { return await next; }
    finally { if (this.operations.get(id) === next) this.operations.delete(id); }
  }

  private persist(change?: { browser: BrowserRec; view: ViewState; control: ControlState }): Promise<void> {
    const next = this.writes.catch(() => {}).then(async () => {
      // Build inside the write queue from committed controls. Another browser's
      // pending transition must not leak into this snapshot before its own save.
      const saved = { ...this.persisted };
      for (const b of this.browsers.values()) {
        for (const v of b.views.values()) saved[viewIdOf(b.id, v.agent)] = { control: v.control };
      }
      if (change) saved[viewIdOf(change.browser.id, change.view.agent)] = { control: change.control };
      const tmp = `${BrowserService.statePath}.tmp`;
      await writeFile(tmp, JSON.stringify({ browsers: saved }, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, BrowserService.statePath);
      this.persisted = saved;
      if (change) change.view.control = change.control;
    });
    this.writes = next;
    return next;
  }

  /** Publish a control transition only after its durable state write succeeds. */
  private commitControl(browser: BrowserRec, view: ViewState, control: ControlState): Promise<void> {
    return this.persist({ browser, view, control });
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

  /** The agent's window on this process. Created on first use. */
  private viewOf(b: BrowserRec, agent: string, create = false): ViewState {
    const existing = b.views.get(agent);
    if (existing) return existing;
    if (!create) {
      throw new BrowserOpError('BROWSER_NOT_FOUND', `agent '${agent}' has no window on browser '${b.id}' — call op:"open" first`);
    }
    const view: ViewState = { agent, control: { mode: 'agent_control', since: nowMs() } };
    b.views.set(agent, view);
    return view;
  }

  private assertAgentControl(b: BrowserRec, view: ViewState): void {
    if (b.closing || this.browsers.get(b.id) !== b) throw new BrowserOpError('BROWSER_NOT_FOUND', `browser '${b.id}' is no longer running`);
    const id = viewIdOf(b.id, view.agent);
    if (view.control.mode === 'human_control' || view.control.mode === 'paused') {
      throw new BrowserOpError(
        'BROWSER_HUMAN_CONTROL',
        `browser '${id}' is paused for the user — do not retry; end your turn and wait until the user hands control back`,
      );
    }
    if (view.control.mode === 'handoff_requested') {
      throw new BrowserOpError(
        'BROWSER_HUMAN_CONTROL',
        `browser '${id}' is waiting for the user (handoff requested: ${view.control.handoff?.reason ?? ''}) — end your turn; you will be woken when the user hands control back`,
      );
    }
  }

  /** Resolve what a viewer addressed: a view id, or a process id while
   *  exactly one agent has a window on it. */
  private resolveView(id: string): { browser: BrowserRec; view: ViewState } {
    const browser = this.runningBrowser(processIdOf(id));
    const agent = agentOfViewId(id);
    if (agent) {
      const view = browser.views.get(agent);
      if (!view) throw new BrowserOpError('BROWSER_NOT_FOUND', `browser '${id}' is not running`);
      return { browser, view };
    }
    const views = [...browser.views.values()];
    if (views.length === 1) return { browser, view: views[0]! };
    if (views.length === 0) throw new BrowserOpError('BROWSER_NOT_FOUND', `browser '${id}' has no open window`);
    throw new BrowserOpError(
      'BROWSER_NOT_FOUND',
      `browser '${id}' has ${views.length} windows — address one of ${views.map((v) => viewIdOf(browser.id, v.agent)).join(', ')}`,
    );
  }

  // ── lifecycle ─────────────────────────────────────────────────────

  private async ensureBrowser(agent: string, opts: { ephemeral?: boolean }): Promise<BrowserRec> {
    if (!this.cfg.enabled) throw new BrowserOpError('BROWSER_DISABLED', 'browser.enabled is false in config.yaml');
    const base = this.profileFor(agent);
    const id = opts.ephemeral ? `${base.id}:tmp` : base.id;
    const existing = this.browsers.get(id);
    if (existing && !existing.closing) {
      this.assertAllowed(existing, agent);
      this.viewOf(existing, agent, true);
      this.touch(existing);
      return existing;
    }
    const pending = this.launching.get(id);
    if (pending) return pending;
    const p = this.launch(id, base, Boolean(opts.ephemeral), agent).finally(() => this.launching.delete(id));
    this.launching.set(id, p);
    return p;
  }

  private async launch(
    id: string,
    base: ReturnType<BrowserService['profileFor']>,
    ephemeral: boolean,
    owner: string,
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
    // Headed: a window on $DISPLAY, or on an Xvfb somora starts for this
    // browser. No display and no Xvfb → refuse, never fall back to
    // headless (that would silently bring the headless signals back).
    const plan = planHeaded(this.cfg.headed);
    if (plan.mode === 'unavailable') throw new BrowserOpError('BROWSER_LAUNCH_FAILED', plan.reason);
    let display: VirtualDisplay | undefined;
    if (plan.mode === 'xvfb') {
      try {
        display = await startVirtualDisplay(plan.xvfb, this.cfg.viewport);
      } catch (err) {
        throw new BrowserOpError('BROWSER_LAUNCH_FAILED', `Xvfb: ${(err as Error).message}`);
      }
    }
    const headed = plan.mode !== 'headless';
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(dir, {
        executablePath: exe.path,
        headless: !headed,
        viewport: { width: this.cfg.viewport.width, height: this.cfg.viewport.height },
        acceptDownloads: false,
        args: [
          '--no-first-run',
          '--disable-background-networking',
          '--disable-sync',
          // Headed = a browser a person could have opened: no automation
          // banner flag and no AutomationControlled blink feature, so
          // navigator.webdriver is false (measured 2026-09-08; the
          // ignoreDefaultArgs alone leaves it true). Headless keeps the
          // HeadlessChrome user agent whatever the flags, so nothing is
          // changed there.
          ...(headed ? ['--disable-blink-features=AutomationControlled'] : []),
          ...(this.cfg.extraArgs ?? []),
        ],
        ...(headed ? { ignoreDefaultArgs: ['--enable-automation'] } : {}),
        ...(display ? { env: { ...process.env, DISPLAY: display.display } } : {}),
      });
    } catch (err) {
      if (display) await display.stop().catch(() => {});
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
      views: new Map(),
      lastUsed: nowMs(),
      idleTimer: null,
      closing: null,
      headed,
      ...(display ? { display } : {}),
    };
    // Every agent that had a window on this process before the restart
    // gets it back. A pending handoff stays pending — the user may still
    // be about to take over. Anything else starts paused, so no stored
    // action is replayed until an agent or the user touches it again.
    for (const [savedId, saved] of Object.entries(this.persisted)) {
      if (processIdOf(savedId) !== id) continue;
      const agent = agentOfViewId(savedId);
      if (!agent) continue;
      rec.views.set(agent, {
        agent,
        control: { ...saved.control, mode: saved.control.handoff ? 'handoff_requested' : 'paused', humanBy: undefined, humanTouched: false },
      });
    }
    if (!rec.views.has(owner)) rec.views.set(owner, { agent: owner, control: { mode: 'agent_control', since: nowMs() } });
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
    // A popup (target=_blank, window.open) belongs to the window that
    // opened it; only a page with no traceable opener stays unowned.
    context.on('page', (page) => void this.adoptPopup(rec, page));
    context.on('close', () => {
      for (const v of rec.views.values()) {
        this.persisted[viewIdOf(id, v.agent)] = { control: { ...v.control, mode: 'paused', humanBy: undefined, humanTouched: false } };
      }
      this.browsers.delete(id);
      void this.persist().catch((err) => logger.warn({ msg: 'browser.state_persist_failed', err: String(err) }));
      if (rec.display) void rec.display.stop().catch(() => {});
      if (rec.ephemeral) void rm(rec.profileDir, { recursive: true, force: true }).catch(() => {});
      if (rec.idleTimer) clearTimeout(rec.idleTimer);
      logger.info({ msg: 'browser.closed', browser: id });
      this.emitChange(id);
    });
    // Playwright opens one blank page with a persistent context; keep
    // it as the first tab so `open` without a tab reuses it.
    for (const page of context.pages()) this.adoptPage(rec, page, { agent: owner, createdByAgent: false, initialBlank: true });
    this.browsers.set(id, rec);
    this.touch(rec);
    void this.persist().catch((err) => logger.warn({ msg: 'browser.state_persist_failed', err: String(err) }));
    logger.info({ msg: 'browser.launched', browser: id, profile: base.profile, dir, ephemeral, ms: nowMs() - t0, executable: exe.path });
    return rec;
  }

  /** Attribute a page Chromium opened on its own to the view that opened it. */
  private async adoptPopup(b: BrowserRec, page: Page): Promise<void> {
    let owner: { agent: string; session?: string; createdByAgent: boolean } = { agent: '_user', createdByAgent: false };
    try {
      const opener = await page.opener();
      if (opener) {
        for (const t of b.tabs.values()) {
          if (t.page !== opener) continue;
          owner = { agent: t.agent, ...(t.session ? { session: t.session } : {}), createdByAgent: false };
          break;
        }
      }
    } catch {
      /* the opener may already be gone — the page stays unowned */
    }
    if (page.isClosed()) return;
    this.adoptPage(b, page, owner);
  }

  private adoptPage(b: BrowserRec, page: Page, owner: { agent: string; session?: string; createdByAgent: boolean; initialBlank?: boolean }): TabRec {
    for (const t of b.tabs.values()) if (t.page === page) return t;
    const id = `t${this.nextTab++}`;
    const tab: TabRec = {
      id,
      page,
      agent: owner.agent,
      ...(owner.session ? { session: owner.session } : {}),
      generation: 1,
      createdByAgent: owner.createdByAgent,
      ...(owner.initialBlank ? { initialBlank: true } : {}),
      lastUsed: nowMs(),
      snapshotRefs: new Set(),
      snapshotGeneration: 0,
    };
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      tab.generation++;
      tab.snapshotRefs = new Set();
      this.emitChange(b.id);
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
      // Never stop under a human's hands or with a handoff pending —
      // in ANY of the windows on this process.
      const busy = [...b.views.values()].some((v) => v.control.mode === 'human_control' || v.control.handoff);
      if (busy || this.operations.has(b.id)) {
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
      if (b.display) await b.display.stop().catch(() => {});
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

  /** The live tabs of one agent's window. */
  private viewTabs(b: BrowserRec, agent: string): TabRec[] {
    return [...b.tabs.values()].filter((t) => t.agent === agent && !t.page.isClosed());
  }

  private browserOf(agent: string, tabId?: string): BrowserRec {
    const candidates = this.browsersFor(agent);
    if (candidates.length === 0) throw new BrowserOpError('BROWSER_NOT_FOUND', `no running browser for agent '${agent}' — call op:"open" first`);
    const b = tabId ? candidates.find((c) => c.tabs.has(tabId)) ?? candidates[0]! : candidates[0]!;
    this.assertAllowed(b, agent);
    return b;
  }

  private tabOf(b: BrowserRec, tabId: string, agent?: string): TabRec {
    const t = b.tabs.get(tabId);
    if (!t || t.page.isClosed()) throw new BrowserOpError('BROWSER_TAB_NOT_FOUND', `tab '${tabId}' not found in browser '${b.id}' — op:"tabs" lists the open ones`);
    // Tabs belong to one window. In a shared profile that keeps hans out
    // of lisa's tabs even though both drive the same Chromium.
    if (agent && t.agent !== agent) {
      throw new BrowserOpError('BROWSER_TAB_NOT_FOUND', `tab '${tabId}' belongs to another agent's window on browser '${b.id}' — op:"tabs" lists yours`);
    }
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

  /**
   * Per-tab device/locale emulation — what the Chrome DevTools device
   * mode does: user agent, viewport, pixel ratio, touch and language of
   * that one tab. `device` is a Playwright device name ("iPhone 15",
   * "Pixel 7", "iPad Pro 11"); `locale` a BCP-47 tag ("de-AT").
   */
  private async emulate(tab: TabRec, args: { device?: string; locale?: string }): Promise<void> {
    let descriptor: (typeof devices)[string] | undefined;
    if (args.device) {
      descriptor = devices[args.device];
      if (!descriptor) {
        const known = Object.keys(devices).filter((n) => !/landscape/i.test(n));
        const hint = known.filter((n) => /^(iPhone 15|iPhone 14|Pixel 7|Galaxy S24|iPad Pro 11|iPad Mini|Desktop Chrome)/.test(n)).slice(0, 8);
        throw new BrowserOpError('BROWSER_ACTION_FAILED', `unknown device '${args.device}' — known names include ${hint.join(', ')} (${known.length} in total)`);
      }
    }
    const cdp = tab.cdp ?? (await tab.page.context().newCDPSession(tab.page));
    tab.cdp = cdp;
    const userAgent = descriptor?.userAgent ?? (await tab.page.evaluate(() => navigator.userAgent));
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent,
      ...(args.locale ? { acceptLanguage: args.locale } : {}),
      ...(descriptor?.isMobile ? { platform: /iPhone|iPad/.test(descriptor.userAgent) ? 'iPhone' : 'Linux armv8l' } : {}),
    });
    if (args.locale) await cdp.send('Emulation.setLocaleOverride', { locale: args.locale });
    if (descriptor) {
      await tab.page.setViewportSize({ ...descriptor.viewport });
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: descriptor.viewport.width,
        height: descriptor.viewport.height,
        deviceScaleFactor: descriptor.deviceScaleFactor,
        mobile: descriptor.isMobile,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: descriptor.hasTouch });
    }
    tab.emulation = { ...(tab.emulation ?? {}), ...(args.device ? { device: args.device } : {}), ...(args.locale ? { locale: args.locale } : {}) };
    logger.info({ msg: 'browser.emulate', tab: tab.id, device: args.device ?? null, locale: args.locale ?? null });
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
      ...(t.emulation ? { emulation: t.emulation } : {}),
      generation: t.generation,
    };
  }

  // ── operations ────────────────────────────────────────────────────

  async open(
    agent: string,
    session: string | undefined,
    args: { url: string; tab?: string; ephemeral?: boolean; device?: string; locale?: string },
  ): Promise<{ view_id: string; browser_id: string; tab: TabInfo; control: ControlMode; blocked?: string }> {
    if (session && this.deps.resolveSession) session = await this.deps.resolveSession(agent, session);
    const verdict = await checkNavigationAllowed(args.url, this.cfg);
    if (!verdict.ok) throw new BrowserOpError('BROWSER_NAVIGATION_DENIED', verdict.reason!);
    const b = args.tab ? this.browserOf(agent, args.tab) : await this.ensureBrowser(agent, { ephemeral: args.ephemeral });
    return this.withBrowserLock(b.id, async () => {
      // Navigating an existing tab needs an existing window; a fresh
      // `open` may create one (ensureBrowser already did for a new process).
      const view = this.viewOf(b, agent, !args.tab);
      // An explicit new navigation may resume an idle/restarted window; old
      // operations are never replayed, and a pending handoff still blocks it.
      if (view.control.mode === 'paused' && !view.control.handoff) {
        await this.commitControl(b, view, { mode: 'agent_control', since: nowMs() });
      }
      this.assertAgentControl(b, view);
      const own = this.viewTabs(b, agent);
      let tab: TabRec;
      if (args.tab) {
        tab = this.tabOf(b, args.tab, agent);
      } else {
        // Reuse the initial blank tab once; otherwise a new one under the cap.
        const blank = own.find((t) => t.initialBlank && t.page.url() === 'about:blank');
        if (blank) {
          tab = blank;
          delete tab.initialBlank;
          if (session) tab.session = session;
          tab.createdByAgent = true;
        } else {
          if (own.length >= this.cfg.maxTabsPerAgent) {
            throw new BrowserOpError(
              'BROWSER_TAB_LIMIT',
              `your window on browser '${b.id}' already has ${own.length} tabs (browser.maxTabsPerAgent) — close one with op:"close_tab" or reuse one with tab:"t<n>"`,
            );
          }
          const page = await b.context.newPage();
          tab = this.adoptPage(b, page, { agent, ...(session ? { session } : {}), createdByAgent: true });
        }
      }
      tab.agent = agent;
      if (session) tab.session = session;
      tab.createdByAgent = true;
      this.touch(b);
      if (args.device || args.locale) await this.emulate(tab, { ...(args.device ? { device: args.device } : {}), ...(args.locale ? { locale: args.locale } : {}) });
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
      this.emitChange(b.id);
      logger.info({ msg: 'browser.open', browser: b.id, tab: tab.id, agent, url: args.url, blocked: blocked ?? null });
      return { view_id: viewIdOf(b.id, agent), browser_id: b.id, tab: await this.tabInfo(tab), control: view.control.mode, ...(blocked ? { blocked } : {}) };
    });
  }

  async tabs(agent: string): Promise<{ view_id: string; browser_id: string; control: ControlMode; tabs: TabInfo[] }> {
    const bs = this.browsersFor(agent);
    if (bs.length === 0) throw new BrowserOpError('BROWSER_NOT_FOUND', `no running browser for agent '${agent}' — call op:"open" first`);
    for (const b of bs) this.assertAllowed(b, agent);
    // Only this agent's window: a shared profile lists the other agent's
    // tabs nowhere, they are not his to act on.
    const tabs = (await Promise.all(bs.map((b) => Promise.all(this.viewTabs(b, agent).map((t) => this.tabInfo(t)))))).flat();
    const first = bs[0]!;
    return {
      view_id: viewIdOf(first.id, agent),
      browser_id: first.id,
      control: first.views.get(agent)?.control.mode ?? 'paused',
      tabs,
    };
  }

  async status(agent: string): Promise<{
    enabled: boolean;
    executable: string | null;
    profile: string;
    view_id: string;
    browser_id: string;
    running: boolean;
    /** headless | display | xvfb, or unavailable with the reason. */
    headed: HeadedPlan;
    warnings: string[];
    control?: ControlMode;
    handoff?: Handoff;
    tabs?: TabInfo[];
  }> {
    const exe = detectExecutable(this.cfg.executablePath);
    const base = this.profileFor(agent);
    const b = this.browsers.get(base.id);
    const headed = planHeaded(this.cfg.headed);
    const warnings = this.warnings();
    const view = b && !b.closing ? b.views.get(agent) : undefined;
    if (!b || b.closing || !view) {
      return { enabled: this.cfg.enabled, executable: exe.path, profile: base.profile, view_id: viewIdOf(base.id, agent), browser_id: base.id, running: false, headed, warnings };
    }
    const tabs = await Promise.all(this.viewTabs(b, agent).map((t) => this.tabInfo(t)));
    return {
      enabled: this.cfg.enabled,
      executable: exe.path,
      profile: base.profile,
      view_id: viewIdOf(b.id, agent),
      browser_id: b.id,
      running: true,
      headed,
      warnings,
      control: view.control.mode,
      ...(view.control.handoff ? { handoff: view.control.handoff } : {}),
      ...(view.control.humanBy ? { human_by: view.control.humanBy } : {}),
      tabs,
    };
  }

  async snapshot(
    agent: string,
    args: { tab: string; full?: boolean; max_chars?: number },
  ): Promise<{ tab: TabInfo; generation: number; snapshot: string; truncated: boolean }> {
    const b = this.browserOf(agent, args.tab);
    return this.withBrowserLock(b.id, async () => {
      this.assertAgentControl(b, this.viewOf(b, agent));
      const t = this.tabOf(b, args.tab, agent);
      const raw = await t.page.ariaSnapshot({ mode: 'ai', timeout: 15_000 });
      const gen = t.generation;
      const result = args.full ? { text: raw, truncated: false } : compactAriaSnapshot(raw, args.max_chars ?? 20_000);
      // Playwright numbers refs `e<n>`, prefixed `f<n>` once the page has
      // navigated within the context (frame generation) — accept both.
      t.snapshotRefs = new Set([...raw.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map((m) => m[1]!));
      t.snapshotGeneration = gen;
      return { tab: await this.tabInfo(t), generation: gen, snapshot: result.text, truncated: result.truncated };
    });
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
    return this.withBrowserLock(b.id, async () => {
      this.assertAgentControl(b, this.viewOf(b, agent));
      const t = this.tabOf(b, args.tab, agent);
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
    });
  }

  async screenshot(agent: string, args: { tab: string }): Promise<{ tab: TabInfo; png: Buffer }> {
    const b = this.browserOf(agent, args.tab);
    return this.withBrowserLock(b.id, async () => {
      this.assertAgentControl(b, this.viewOf(b, agent));
      const t = this.tabOf(b, args.tab, agent);
      const png = await t.page.screenshot({ type: 'png', timeout: 15_000 });
      return { tab: await this.tabInfo(t), png };
    });
  }

  async requestHandoff(
    agent: string,
    session: string | undefined,
    args: { reason: string; resume_note?: string },
  ): Promise<{ view_id: string; browser_id: string; handoff_id: string; control: ControlMode }> {
    if (session && this.deps.resolveSession) session = await this.deps.resolveSession(agent, session);
    const b = this.browserOf(agent);
    const id = viewIdOf(b.id, agent);
    return this.withBrowserLock(b.id, async () => {
      if (!session) throw new BrowserOpError('BROWSER_ACTION_FAILED', 'request_handoff needs a session to resume in');
      const view = this.viewOf(b, agent, true);
      if (view.control.mode === 'human_control') {
        throw new BrowserOpError('BROWSER_HUMAN_CONTROL', `the user already controls browser '${id}'`);
      }
      if (view.control.handoff) {
        if (view.control.handoff.agent !== agent || view.control.handoff.session !== session)
          throw new BrowserOpError('BROWSER_HUMAN_CONTROL', 'another session is already waiting for this browser');
        return { view_id: id, browser_id: b.id, handoff_id: view.control.handoff.id, control: view.control.mode };
      }
      const handoff: Handoff = {
        id: randomUUID(),
        agent,
        session,
        reason: args.reason,
        ...(args.resume_note ? { resumeNote: args.resume_note } : {}),
        requestedAt: nowMs(),
      };
      await this.commitControl(b, view, { mode: 'handoff_requested', handoff, since: nowMs() });
      this.touch(b);
      this.emitChange(b.id);
      logger.info({ msg: 'browser.handoff_requested', browser: id, agent, session, reason: args.reason });
      return { view_id: id, browser_id: b.id, handoff_id: handoff.id, control: view.control.mode };
    });
  }

  async closeTab(agent: string, args: { tab: string }): Promise<{ closed: string; remaining: number }> {
    const b = this.browserOf(agent, args.tab);
    return this.withBrowserLock(b.id, async () => {
      this.assertAgentControl(b, this.viewOf(b, agent));
      const t = this.tabOf(b, args.tab, agent);
      await t.page.close().catch(() => {});
      b.tabs.delete(t.id);
      return { closed: t.id, remaining: this.viewTabs(b, agent).length };
    });
  }

  /**
   * Close this agent's window. The Chromium process only ends when no
   * other agent still has one on it — in a shared profile hans must not
   * pull the browser out from under lisa.
   */
  async stop(agent: string): Promise<{ stopped: string | null }> {
    const bs = this.browsersFor(agent).filter((b) => b.views.has(agent));
    if (bs.length === 0) return { stopped: null };
    for (const b of bs) {
      this.assertAllowed(b, agent);
      const view = this.viewOf(b, agent);
      if (view.control.mode === 'human_control') throw new BrowserOpError('BROWSER_HUMAN_CONTROL', `the user controls browser '${viewIdOf(b.id, agent)}'`);
    }
    await Promise.all(bs.map((b) => this.withBrowserLock(b.id, async () => {
      const view = this.viewOf(b, agent);
      this.assertAgentControl(b, view);
      for (const t of this.viewTabs(b, agent)) {
        await t.page.close().catch(() => {});
        b.tabs.delete(t.id);
      }
      b.views.delete(agent);
      delete this.persisted[viewIdOf(b.id, agent)];
      if (b.views.size === 0) await this.stopBrowser(b);
      else {
        await this.persist();
        this.emitChange(b.id);
      }
    })));
    return { stopped: bs.map((b) => viewIdOf(b.id, agent)).join(', ') };
  }

  // ── UI / control (stage 3 surfaces; HTTP-testable now) ────────────

  /**
   * One entry per open window, not per process: in a shared profile hans
   * and lisa are two rows with their own tabs and control state. Stopped
   * browsers are left out the way the tmux list leaves dead sessions out
   * — except one still holding an unanswered handoff, which is the only
   * trail back to that request (private/browser-design.md §10.4).
   */
  async listAll(): Promise<BrowserInfo[]> {
    const out: BrowserInfo[] = [];
    for (const b of this.browsers.values()) {
      if (b.closing) continue;
      for (const view of b.views.values()) {
        const tabs = await Promise.all(this.viewTabs(b, view.agent).map((t) => this.tabInfo(t)));
        // An empty window is only worth a row while something is pending.
        if (tabs.length === 0 && !view.control.handoff && view.control.mode !== 'human_control') continue;
        out.push({
          view_id: viewIdOf(b.id, view.agent),
          agent: view.agent,
          browser_id: b.id,
          profile: b.profile,
          ephemeral: b.ephemeral,
          state: 'running',
          control: view.control.mode,
          ...(view.control.handoff ? { handoff: view.control.handoff } : {}),
          ...(view.control.humanBy ? { human_by: view.control.humanBy } : {}),
          tabs,
          last_used: b.lastUsed,
          headed: b.headed,
        });
      }
    }
    for (const [id, p] of Object.entries(this.persisted)) {
      const browserId = processIdOf(id);
      const agent = agentOfViewId(id);
      if (!agent || !p.control?.handoff) continue;
      if (this.browsers.get(browserId)?.views.has(agent)) continue;
      out.push({
        view_id: id,
        agent,
        browser_id: browserId,
        profile: browserId.replace(/^(agent|profile):/, '').replace(/:tmp$/, ''),
        ephemeral: browserId.endsWith(':tmp'),
        state: 'stopped',
        control: 'paused',
        handoff: p.control.handoff,
        tabs: [],
        last_used: 0,
      });
    }
    return out;
  }

  /** Explicit user recovery starts a blank page in the same profile. */
  async restartForViewer(viewOrBrowserId: string): Promise<void> {
    const browserId = processIdOf(viewOrBrowserId);
    const savedViews = Object.keys(this.persisted).filter((k) => processIdOf(k) === browserId);
    if (!this.persisted[viewOrBrowserId] && savedViews.length === 0) throw new BrowserOpError('BROWSER_NOT_FOUND', 'unknown browser');
    const match = /^(agent|profile):(.+?)(:tmp)?$/.exec(browserId);
    if (!match) throw new BrowserOpError('BROWSER_NOT_FOUND', 'invalid browser id');
    // The window's own agent restarts the process; for a bare process id
    // take a saved window, else the first agent the profile still lists.
    const agent =
      agentOfViewId(viewOrBrowserId) ??
      (savedViews.length ? agentOfViewId(savedViews[0]!) : undefined) ??
      (match[1] === 'profile' ? this.cfg.profiles[match[2]!]?.agents[0] : match[2]);
    if (!agent || this.profileFor(agent).id + (match[3] ?? '') !== browserId)
      throw new BrowserOpError('BROWSER_NOT_ALLOWED', 'profile is no longer configured');
    await this.ensureBrowser(agent, { ephemeral: Boolean(match[3]) });
    this.emitChange(browserId);
  }

  /**
   * Human takes or returns ONE window. `agent` = hand back: with a
   * pending handoff the requesting agent is woken exactly once in its
   * session (idempotent per handoff id); without one, only the window's
   * own agent is woken, and only after real activity. The other agents
   * on a shared profile keep working throughout.
   */
  async setControl(viewId: string, mode: 'human' | 'agent', opts: { by?: string; handoffId?: string } = {}): Promise<ControlState> {
    return this.withBrowserLock(viewId, async () => {
      const { browser: b, view } = this.resolveView(viewId);
      const id = viewIdOf(b.id, view.agent);
      if (mode === 'human') {
        await this.commitControl(b, view, { mode: 'human_control', ...(view.control.handoff ? { handoff: view.control.handoff } : {}), ...(opts.by ? { humanBy: opts.by } : {}), since: nowMs() });
        this.touch(b);
        logger.info({ msg: 'browser.human_control', browser: id, by: opts.by ?? null });
        this.emitChange(b.id);
        return view.control;
      }
      const handoff = view.control.handoff;
      if (opts.handoffId && handoff && opts.handoffId !== handoff.id) {
        throw new BrowserOpError('BROWSER_ACTION_FAILED', 'stale handoff — refresh before handing back');
      }
      if (opts.handoffId && !handoff) return view.control; // duplicate, never release a newer manual takeover
      if (opts.by && view.control.humanBy && opts.by !== view.control.humanBy) {
        throw new BrowserOpError('BROWSER_HUMAN_CONTROL', 'another viewer controls this browser');
      }
      if (handoff && this.deps.resolveSession) await this.deps.resolveSession(handoff.agent, handoff.session);
      const touched = view.control.humanTouched === true;
      await this.commitControl(b, view, { mode: 'agent_control', since: nowMs() });
      this.touch(b);
      // Whom to wake: the requesting agent+session when a handoff was
      // pending; otherwise — only if the human actually did something —
      // the session of the last tab used IN THIS WINDOW (Rene 2026-09-10).
      let wake: { agent: string; session: string; text: string } | null = null;
      if (handoff) {
        wake = {
          agent: handoff.agent,
          session: handoff.session,
          text:
            `[browser] The user handed browser '${id}' back to you (handoff ${handoff.id}). ` +
            `Reason you asked for it: ${handoff.reason}. ` +
            (handoff.resumeNote ? `Your note: ${handoff.resumeNote}. ` : '') +
            'Take a fresh snapshot before acting — the page may have changed.',
        };
      } else if (touched) {
        const last = this.lastAgentTab(b, view.agent);
        if (last) {
          wake = {
            agent: last.agent,
            session: last.session,
            text:
              `[browser] The user took over browser '${id}', did something there (navigation, clicks or typing) and handed it back to you. ` +
              'If you still have work in this browser, take a fresh snapshot before acting — the page may have changed. Otherwise just acknowledge briefly.',
          };
        }
      }
      logger.info({ msg: 'browser.agent_control', browser: id, wake: handoff ? handoff.id : wake ? 'activity' : null, ...(wake ? { agent: wake.agent, session: wake.session } : {}) });
      this.emitChange(b.id);
      if (wake && this.deps.dispatchWakeTurn) {
        void this.deps.dispatchWakeTurn(wake).catch((err) => logger.warn({ msg: 'browser.wake_failed', browser: id, err: String(err) }));
      }
      return view.control;
    });
  }

  /** The tab this window's agent used most recently (has a session), or null. */
  private lastAgentTab(b: BrowserRec, agent: string): { agent: string; session: string } | null {
    let best: TabRec | null = null;
    for (const t of this.viewTabs(b, agent)) {
      if (!t.session || !t.createdByAgent) continue;
      if (!best || t.lastUsed > best.lastUsed) best = t;
    }
    return best && best.session ? { agent: best.agent, session: best.session } : null;
  }

  /** Record human activity in one window (see ControlState.humanTouched). */
  markHumanActivity(viewId: string, kind: string): void {
    if (kind === 'mousemove' || kind === 'resize' || kind === 'tab') return;
    let view: ViewState;
    try {
      view = this.resolveView(viewId).view;
    } catch {
      return;
    }
    if (view.control.mode !== 'human_control' || view.control.humanTouched) return;
    view.control.humanTouched = true;
    void this.persist().catch((err) => logger.warn({ msg: 'browser.state_persist_failed', err: String(err) }));
  }

  // ── viewer surface (stage 2: web client) ──────────────────────────

  /** Running browser by id, for the viewer path. */
  private runningBrowser(browserId: string): BrowserRec {
    const b = this.browsers.get(browserId);
    if (!b || b.closing) throw new BrowserOpError('BROWSER_NOT_FOUND', `browser '${browserId}' is not running`);
    return b;
  }

  /** Summary of one window for the viewer header. */
  async browserInfo(viewId: string): Promise<BrowserInfo> {
    const { browser: b, view } = this.resolveView(viewId);
    const tabs = await Promise.all(this.viewTabs(b, view.agent).map((t) => this.tabInfo(t)));
    return {
      view_id: viewIdOf(b.id, view.agent),
      agent: view.agent,
      browser_id: b.id,
      profile: b.profile,
      ephemeral: b.ephemeral,
      state: 'running',
      control: view.control.mode,
      ...(view.control.handoff ? { handoff: view.control.handoff } : {}),
      ...(view.control.humanBy ? { human_by: view.control.humanBy } : {}),
      tabs,
      last_used: b.lastUsed,
      headed: b.headed,
    };
  }

  /** The page a viewer wants to watch: the given tab of THIS window, else
   *  its most recently used one. Touches the browser (viewers count as
   *  activity). A tab of another agent's window is not reachable here. */
  viewerPage(viewId: string, tabId?: string): { tabId: string; page: Page; generation: number } {
    const { browser: b, view } = this.resolveView(viewId);
    this.touch(b);
    const live = this.viewTabs(b, view.agent);
    const t = tabId ? live.find((x) => x.id === tabId) : live.sort((a, c) => c.lastUsed - a.lastUsed)[0];
    if (!t) throw new BrowserOpError('BROWSER_TAB_NOT_FOUND', `browser '${viewId}' has no open tab`);
    return { tabId: t.id, page: t.page, generation: t.generation };
  }

  /** True when this viewer connection may drive this window. */
  humanControls(viewId: string, by: string): boolean {
    let view: ViewState;
    try {
      view = this.resolveView(viewId).view;
    } catch {
      return false;
    }
    return view.control.mode === 'human_control' && (view.control.humanBy === undefined || view.control.humanBy === by);
  }

  /** Human navigation (URL bar) — same policy as the agent's `open`. */
  async humanNavigate(viewId: string, tabId: string, url: string): Promise<void> {
    const verdict = await checkNavigationAllowed(url, this.cfg);
    if (!verdict.ok) throw new BrowserOpError('BROWSER_NAVIGATION_DENIED', verdict.reason!);
    const { page } = this.viewerPage(viewId, tabId);
    this.markHumanActivity(viewId, 'navigate');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
      throw new BrowserOpError('BROWSER_ACTION_FAILED', (err as Error).message.split('\n')[0]!);
    });
  }

  /** A tab the human opened: it belongs to this window (so the agent can
   *  use it afterwards), but not to the agent (tab cleanup leaves it). */
  async humanNewTab(viewId: string, _by: string): Promise<string> {
    const { browser: b, view } = this.resolveView(viewId);
    const own = this.viewTabs(b, view.agent);
    if (own.length >= this.cfg.maxTabsPerAgent) throw new BrowserOpError('BROWSER_TAB_LIMIT', `this window already has ${own.length} tabs`);
    const page = await b.context.newPage();
    const tab = this.adoptPage(b, page, { agent: view.agent, createdByAgent: false });
    this.markHumanActivity(viewId, 'newtab');
    this.touch(b);
    return tab.id;
  }

  async humanCloseTab(viewId: string, tabId: string): Promise<void> {
    const { browser: b, view } = this.resolveView(viewId);
    const t = b.tabs.get(tabId);
    if (!t || t.agent !== view.agent) return;
    this.markHumanActivity(viewId, 'closetab');
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
