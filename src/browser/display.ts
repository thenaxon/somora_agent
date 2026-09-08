// Headed mode needs a display. On a desktop that is $DISPLAY; on a
// server it is a virtual X server (Xvfb) that somora starts per browser
// process and stops with it. Nothing installs Xvfb here — that is a
// system package (docs/setup.md); without it headed mode refuses to
// start LOUDLY instead of silently falling back to headless, because
// the fallback would bring back exactly the "HeadlessChrome" signal the
// operator switched headed on to avoid.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { logger } from '../server/logger.ts';

export const XVFB_INSTALL_HINT =
  'install it (Debian/Ubuntu: sudo apt install xvfb · Fedora: sudo dnf install xorg-x11-server-Xvfb · Arch: sudo pacman -S xorg-server-xvfb), ' +
  'or run somora inside a desktop session, or set browser.headed: false';

/** Where Xvfb is, or null. PATH lookup only — no download, no install. */
export function findXvfb(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.SOMORA_XVFB_PATH;
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'Xvfb');
    if (existsSync(p)) return p;
  }
  return null;
}

export type HeadedPlan =
  | { mode: 'headless' }
  | { mode: 'display'; display: string }
  | { mode: 'xvfb'; xvfb: string }
  | { mode: 'unavailable'; reason: string };

/** What headed mode would use on this host, without starting anything. */
export function planHeaded(headed: boolean, env: NodeJS.ProcessEnv = process.env): HeadedPlan {
  if (!headed) return { mode: 'headless' };
  if (process.platform === 'darwin' || process.platform === 'win32') return { mode: 'display', display: env.DISPLAY ?? '' };
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return { mode: 'display', display: env.DISPLAY ?? env.WAYLAND_DISPLAY ?? '' };
  const xvfb = findXvfb(env);
  if (xvfb) return { mode: 'xvfb', xvfb };
  return {
    mode: 'unavailable',
    reason: `browser.headed is true but this host has neither a DISPLAY nor Xvfb — ${XVFB_INSTALL_HINT}`,
  };
}

export interface VirtualDisplay {
  display: string;
  stop(): Promise<void>;
}

function displayFree(n: number): boolean {
  return !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`);
}

/** Start one Xvfb for one browser process. Resolves once the X socket
 *  exists; rejects with the process's stderr if it dies first. */
export async function startVirtualDisplay(
  xvfb: string,
  size: { width: number; height: number },
  opts: { timeoutMs?: number } = {},
): Promise<VirtualDisplay> {
  let n = 90;
  while (!displayFree(n) && n < 190) n++;
  const display = `:${n}`;
  const child: ChildProcess = spawn(xvfb, [display, '-screen', '0', `${size.width}x${size.height}x24`, '-nolisten', 'tcp', '-nocursor'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (child.exitCode !== null) return reject(new Error(`Xvfb ${display} exited (${child.exitCode}): ${stderr.trim().split('\n')[0] ?? ''}`));
      if (existsSync(`/tmp/.X11-unix/X${n}`)) return resolve();
      if (Date.now() > deadline) {
        child.kill('SIGTERM');
        return reject(new Error(`Xvfb ${display} did not come up within ${opts.timeoutMs ?? 5000} ms`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
  logger.info({ msg: 'browser.xvfb_started', display, pid: child.pid, size: `${size.width}x${size.height}` });
  return {
    display,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          r();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
      logger.info({ msg: 'browser.xvfb_stopped', display });
    },
  };
}
