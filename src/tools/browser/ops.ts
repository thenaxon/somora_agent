// The `browser` tool's operations, executed against the BrowserService.
// One implementation for both entry points: the in-process tool handler
// (openai-compatible engine) and `POST /browser/op` (what the MCP tool
// child calls for claude-cli/codex-cli — the Chromium lives in the
// server process, a child spawned per turn cannot own it).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../../config/types.ts';
import { isToolAllowed } from '../gating.ts';
import { loadPersona } from '../../persona/loader.ts';
import { effectiveWorkspace } from '../../server/workspace.ts';
import { BrowserOpError, getBrowserService, type ControlMode, type TabInfo } from '../../browser/service.ts';

export type BrowserOp =
  | { op: 'open'; url: string; tab?: string; ephemeral?: boolean; device?: string; locale?: string }
  | { op: 'tabs' }
  | { op: 'status' }
  | { op: 'snapshot'; tab: string; full?: boolean; max_chars?: number }
  | { op: 'act'; tab: string; action: 'click' | 'fill' | 'press' | 'scroll' | 'select'; ref?: string; value?: string; generation?: number }
  | { op: 'screenshot'; tab: string }
  | { op: 'request_handoff'; reason: string; resume_note?: string }
  | { op: 'close_tab'; tab: string }
  | { op: 'stop' };

export interface BrowserOpContext {
  agent: string;
  session?: string;
  config: Config;
}

export interface BrowserOpResult {
  op: BrowserOp['op'];
  ok: boolean;
  /** `<browser id>@<agent>` — this agent's window on the process. */
  view_id?: string;
  browser_id?: string;
  control?: ControlMode;
  tab?: TabInfo;
  tabs?: TabInfo[];
  generation?: number;
  snapshot?: string;
  truncated?: boolean;
  navigated?: boolean;
  blocked?: string;
  path?: string;
  handoff_id?: string;
  closed?: string;
  remaining?: number;
  stopped?: string | null;
  running?: boolean;
  enabled?: boolean;
  executable?: string | null;
  profile?: string;
  error?: string;
  hint?: string;
}

const HINTS: Record<string, string> = {
  BROWSER_HUMAN_CONTROL: 'End your turn and tell the user what you were doing; you will be woken when they hand the browser back.',
  BROWSER_STALE_REF: 'Call op:"snapshot" on this tab and use refs from that result.',
  BROWSER_NAVIGATION_DENIED: 'Only public http(s) hosts and hosts listed in browser.allowPrivate are reachable. Do not retry the same URL.',
  BROWSER_TAB_LIMIT: 'Close a tab with op:"close_tab" or reuse one via tab:"t<n>".',
  BROWSER_NOT_FOUND: 'Start with op:"open".',
  BROWSER_LAUNCH_FAILED: 'The host needs a Chromium; tell the user to install it or set browser.executablePath.',
};

export async function runBrowserOp(ctx: BrowserOpContext, input: BrowserOp): Promise<BrowserOpResult> {
  const svc = getBrowserService();
  try {
    if (!ctx.config.browser.enabled) throw new BrowserOpError('BROWSER_DISABLED', 'browser.enabled is false');
    const persona = await loadPersona(ctx.agent);
    if (!persona || !isToolAllowed('browser', 'browser', persona.toolGating)) throw new BrowserOpError('BROWSER_NOT_ALLOWED', 'browser ability is not allowed for this agent');
    switch (input.op) {
      case 'open': {
        const r = await svc.open(ctx.agent, ctx.session, {
          url: input.url,
          ...(input.tab ? { tab: input.tab } : {}),
          ...(input.ephemeral ? { ephemeral: true } : {}),
          ...(input.device ? { device: input.device } : {}),
          ...(input.locale ? { locale: input.locale } : {}),
        });
        return { op: 'open', ok: true, view_id: r.view_id, browser_id: r.browser_id, tab: r.tab, generation: r.tab.generation, control: r.control, ...(r.blocked ? { blocked: r.blocked } : {}) };
      }
      case 'tabs': {
        const r = await svc.tabs(ctx.agent);
        return { op: 'tabs', ok: true, view_id: r.view_id, browser_id: r.browser_id, control: r.control, tabs: r.tabs };
      }
      case 'status': {
        const r = await svc.status(ctx.agent);
        return { op: 'status', ok: true, ...r };
      }
      case 'snapshot': {
        const r = await svc.snapshot(ctx.agent, { tab: input.tab, ...(input.full ? { full: true } : {}), ...(input.max_chars ? { max_chars: input.max_chars } : {}) });
        return { op: 'snapshot', ok: true, tab: r.tab, generation: r.generation, snapshot: r.snapshot, truncated: r.truncated };
      }
      case 'act': {
        const r = await svc.act(ctx.agent, {
          tab: input.tab,
          action: input.action,
          ...(input.ref ? { ref: input.ref } : {}),
          ...(input.value !== undefined ? { value: input.value } : {}),
          ...(input.generation !== undefined ? { generation: input.generation } : {}),
        });
        return { op: 'act', ok: true, tab: r.tab, generation: r.generation, navigated: r.navigated, ...(r.blocked ? { blocked: r.blocked } : {}) };
      }
      case 'screenshot': {
        const r = await svc.screenshot(ctx.agent, { tab: input.tab });
        const persona = await loadPersona(ctx.agent);
        if (!persona) throw new BrowserOpError('BROWSER_ACTION_FAILED', `agent '${ctx.agent}' not found`);
        const dir = join(effectiveWorkspace(persona, ctx.config), 'browser', ctx.agent);
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        const path = join(dir, `${stamp}-${r.tab.tab_id}.png`);
        await writeFile(path, r.png);
        return { op: 'screenshot', ok: true, tab: r.tab, path };
      }
      case 'request_handoff': {
        const r = await svc.requestHandoff(ctx.agent, ctx.session, { reason: input.reason, ...(input.resume_note ? { resume_note: input.resume_note } : {}) });
        return {
          op: 'request_handoff',
          ok: true,
          view_id: r.view_id,
          browser_id: r.browser_id,
          handoff_id: r.handoff_id,
          control: r.control,
          hint: 'Handoff recorded. End your turn now and tell the user what to do in the browser window; you will be woken in this session when they hand control back.',
        };
      }
      case 'close_tab': {
        const r = await svc.closeTab(ctx.agent, { tab: input.tab });
        return { op: 'close_tab', ok: true, closed: r.closed, remaining: r.remaining };
      }
      case 'stop': {
        const r = await svc.stop(ctx.agent);
        return { op: 'stop', ok: true, stopped: r.stopped };
      }
    }
  } catch (err) {
    if (err instanceof BrowserOpError) {
      return { op: input.op, ok: false, error: err.message, ...(HINTS[err.code] ? { hint: HINTS[err.code] } : {}) };
    }
    return { op: input.op, ok: false, error: `${input.op}: ${(err as Error).message.split('\n')[0]}` };
  }
}
