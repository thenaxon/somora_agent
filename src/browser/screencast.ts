// Screencast + input bridge between the web client and a browser tab.
//
// One ScreencastHub per (browser, tab): a raw CDP session on the page,
// `Page.startScreencast` (JPEG), frames fanned out to every attached
// viewer WebSocket. Patterns lifted from OpenClaw's screencast session
// after reading it (private/browser-design.md §2.1):
//
//   - Ack-pacing instead of a frame queue: each frame is acknowledged
//     only after FRAME_INTERVAL_MS, so Chromium never produces faster
//     than viewers consume (~20 fps max) and nothing buffers up.
//   - Backpressure per viewer: a socket with more than MAX_BUFFERED
//     bytes pending is skipped for this frame — a slow viewer drops
//     frames, it does not eat memory.
//   - One encoded message shared by all viewers.
//   - Generation-tagged frames: the header carries the tab generation,
//     so a viewer can discard a picture of the previous page after a
//     navigation instead of clicking into it.
//
// Wire format (binary frames):  [u32 BE header length][JSON header][JPEG]
// Header: { tabId, generation, seq, url, cssWidth, cssHeight, scrollX, scrollY, ts }
// Text frames (JSON) both ways: ping/pong, tabs/control/error/notice
// from the server, input/navigation/control requests from the viewer.
//
// Input goes through Playwright's mouse/keyboard (actionability-free,
// they are raw events) and — for text — CDP `Input.insertText`, which
// is what makes umlauts, dead keys and paste work; OpenClaw only
// forwards key names and blocks modifiers, which leaves a German login
// form unusable. A viewer may only send input while it holds human
// control (`service.humanControls`); everyone else just watches.

import type { CDPSession, Page } from 'playwright-core';
import { logger } from '../server/logger.ts';
import { BrowserOpError, type BrowserService } from './service.ts';

const FRAME_INTERVAL_MS = 50;
const MAX_BUFFERED = 2 * 1024 * 1024;

export interface ViewerSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  /** `ws.bufferedAmount` of the underlying socket, for backpressure. */
  buffered(): number;
}

export interface ViewerMessage {
  type: string;
  [k: string]: unknown;
}

interface FrameHeader {
  tabId: string;
  generation: number;
  seq: number;
  url: string;
  cssWidth: number;
  cssHeight: number;
  scrollX: number;
  scrollY: number;
  ts: number;
}

function encodeFrame(header: FrameHeader, jpeg: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length, 0);
  return Buffer.concat([len, h, jpeg]);
}

export class ScreencastHub {
  private cdp: CDPSession | null = null;
  private viewers = new Set<ViewerSocket>();
  private seq = 0;
  private started = false;
  private stopping = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private epoch = -1;
  private ackTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    readonly browserId: string,
    readonly tabId: string,
    private page: Page,
    private generationOf: () => number,
    private quality: number,
    private maxWidth: number,
    private maxHeight: number,
    private maxFps = 15,
  ) {}

  get size(): number {
    return this.viewers.size;
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.catch(() => {}).then(fn);
    this.lifecycle = next;
    return next;
  }

  async add(v: ViewerSocket): Promise<void> {
    this.viewers.add(v);
    try {
      await this.serial(async () => {
        if (this.viewers.size && (!this.cdp || this.epoch !== this.generationOf())) {
          await this.stop();
          await this.start();
        }
      });
    } catch (error) { this.viewers.delete(v); throw error; }
  }

  async remove(v: ViewerSocket): Promise<void> {
    this.viewers.delete(v);
    await this.serial(async () => { if (!this.viewers.size) await this.stop(); });
  }

  refresh(): void {
    void this.serial(async () => {
      if (this.viewers.size && this.epoch !== this.generationOf()) {
        await this.stop();
        await this.start();
      }
    }).catch(() => this.closeAll(4001, 'capture stopped'));
  }

  private async start(): Promise<void> {
    this.started = true;
    const epoch = this.generationOf();
    this.epoch = epoch;
    const cdp = await this.page.context().newCDPSession(this.page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (ev: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number; timestamp?: number } }) => {
      if (this.cdp !== cdp || this.stopping || this.generationOf() !== epoch) {
        void cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
        return;
      }
      const jpeg = Buffer.from(ev.data, 'base64');
      const frame = encodeFrame(
        {
          tabId: this.tabId,
          generation: epoch,
          seq: ++this.seq,
          url: this.page.url(),
          cssWidth: ev.metadata.deviceWidth,
          cssHeight: ev.metadata.deviceHeight,
          scrollX: ev.metadata.scrollOffsetX,
          scrollY: ev.metadata.scrollOffsetY,
          ts: Date.now(),
        },
        jpeg,
      );
      for (const v of this.viewers) {
        if (v.buffered() >= MAX_BUFFERED) continue; // slow viewer: drop this frame
        try {
          v.send(frame);
        } catch {
          /* closed mid-send; the close handler removes it */
        }
      }
      // Pace the source: the next frame is produced only after the ack.
      const timer = setTimeout(() => {
        this.ackTimers.delete(timer);
        cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      }, Math.max(FRAME_INTERVAL_MS, Math.ceil(1000 / this.maxFps)));
      this.ackTimers.add(timer);
    });
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.quality,
        maxWidth: this.maxWidth,
        maxHeight: this.maxHeight,
        everyNthFrame: 1,
      });
    } catch (error) { await this.stop(); throw error; }
    logger.info({ msg: 'browser.screencast_start', browser: this.browserId, tab: this.tabId });
  }

  private async stop(): Promise<void> {
    if (this.stopping || !this.cdp) return;
    this.stopping = true;
    for (const timer of this.ackTimers) clearTimeout(timer);
    this.ackTimers.clear();
    try {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      await this.cdp.detach().catch(() => {});
    } finally {
      this.cdp = null;
      this.started = false;
      this.stopping = false;
      logger.info({ msg: 'browser.screencast_stop', browser: this.browserId, tab: this.tabId });
    }
  }

  /** Raw CDP for input that Playwright's API does not cover (insertText, wheel). */
  get session(): CDPSession | null {
    return this.cdp;
  }

  async closeAll(code: number, reason: string): Promise<void> {
    for (const v of [...this.viewers]) {
      try {
        v.close(code, reason);
      } catch {
        /* ignore */
      }
    }
    this.viewers.clear();
    await this.serial(() => this.stop());
  }
}

export class ScreencastRegistry {
  private hubs = new Map<string, ScreencastHub>();

  constructor(private service: BrowserService) {
    service.onChange((browserId) => this.onBrowserChange(browserId));
  }

  private key(browserId: string, tabId: string): string {
    return `${browserId}|${tabId}`;
  }

  async attach(browserId: string, tabId: string | undefined, viewer: ViewerSocket): Promise<{ tabId: string; page: Page; hub: ScreencastHub }> {
    const target = this.service.viewerPage(browserId, tabId);
    const k = this.key(browserId, target.tabId);
    let hub = this.hubs.get(k);
    if (!hub) {
      const cfg = this.service.config;
      hub = new ScreencastHub(
        browserId,
        target.tabId,
        target.page,
        () => {
          try {
            return this.service.viewerPage(browserId, target.tabId).generation;
          } catch {
            return -1;
          }
        },
        cfg.stream.quality,
        cfg.viewport.width,
        cfg.viewport.height,
        cfg.stream.maxFps,
      );
      this.hubs.set(k, hub);
    }
    try { await hub.add(viewer); }
    catch (error) {
      if (hub.size === 0 && this.hubs.get(k) === hub) this.hubs.delete(k);
      throw error;
    }
    return { tabId: target.tabId, page: target.page, hub };
  }

  detach(browserId: string, tabId: string, viewer: ViewerSocket): void {
    const k = this.key(browserId, tabId);
    const hub = this.hubs.get(k);
    if (!hub) return;
    void hub.remove(viewer).then(() => {
      if (hub.size === 0 && this.hubs.get(k) === hub) this.hubs.delete(k);
    });
  }

  private onBrowserChange(browserId: string): void {
    // Tabs that vanished take their hub with them.
    for (const [k, hub] of this.hubs) {
      if (!k.startsWith(`${browserId}|`)) continue;
      try {
        this.service.viewerPage(browserId, hub.tabId);
        hub.refresh();
      } catch {
        void hub.closeAll(4001, 'tab closed');
        this.hubs.delete(k);
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.hubs.values()].map((h) => h.closeAll(1012, 'server shutdown')));
    this.hubs.clear();
  }
}

/**
 * Apply one viewer input message to a page. Coordinates arrive in CSS
 * pixels of the streamed viewport (the client scales from its image).
 * Returns a notice for the viewer when the input was not applied.
 */
export async function applyViewerInput(
  page: Page,
  cdp: CDPSession | null,
  msg: ViewerMessage,
): Promise<string | null> {
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  switch (msg.type) {
    case 'mousemove':
      await page.mouse.move(num(msg.x), num(msg.y));
      return null;
    case 'click': {
      const button = msg.button === 'right' ? 'right' : msg.button === 'middle' ? 'middle' : 'left';
      await page.mouse.click(num(msg.x), num(msg.y), { button, clickCount: num(msg.clickCount, 1) });
      return null;
    }
    case 'mousedown':
      await page.mouse.move(num(msg.x), num(msg.y));
      await page.mouse.down({ button: msg.button === 'right' ? 'right' : 'left' });
      return null;
    case 'mouseup':
      await page.mouse.move(num(msg.x), num(msg.y));
      await page.mouse.up({ button: msg.button === 'right' ? 'right' : 'left' });
      return null;
    case 'wheel':
      if (cdp) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: num(msg.x),
          y: num(msg.y),
          deltaX: num(msg.deltaX),
          deltaY: num(msg.deltaY),
        });
      } else {
        await page.mouse.move(num(msg.x), num(msg.y));
        await page.mouse.wheel(num(msg.deltaX), num(msg.deltaY));
      }
      return null;
    case 'text':
      // Composed text (typing, IME, paste): one insert, no key events.
      if (typeof msg.text !== 'string' || !msg.text) return null;
      if (cdp) await cdp.send('Input.insertText', { text: msg.text });
      else await page.keyboard.insertText(msg.text);
      return null;
    case 'key': {
      // Non-text keys and shortcuts: Enter, Tab, Backspace, arrows,
      // Control+a … Playwright's key syntax ("Control+a").
      if (typeof msg.key !== 'string' || !msg.key) return null;
      const mods: string[] = [];
      if (msg.ctrl) mods.push('Control');
      if (msg.alt) mods.push('Alt');
      if (msg.shift && msg.key.length > 1) mods.push('Shift');
      if (msg.meta) mods.push('Meta');
      const combo = [...mods, msg.key].join('+');
      if (msg.action === 'down') await page.keyboard.down(msg.key);
      else if (msg.action === 'up') await page.keyboard.up(msg.key);
      else await page.keyboard.press(combo);
      return null;
    }
    case 'resize': {
      const w = Math.max(320, Math.min(3840, Math.round(num(msg.width, 1280))));
      const h = Math.max(240, Math.min(2160, Math.round(num(msg.height, 800))));
      await page.setViewportSize({ width: w, height: h });
      return null;
    }
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
      return null;
    case 'forward':
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
      return null;
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      return null;
    default:
      return `unknown input '${msg.type}'`;
  }
}

export function isBrowserOpError(err: unknown): err is BrowserOpError {
  return err instanceof BrowserOpError;
}
