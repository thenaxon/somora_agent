// Keeps the HTTPS certificate fresh while the server runs — no restart.
//
// Two jobs, on one timer:
//   1. `server.tls.renew: tailscale` → ask Tailscale for a certificate
//      that is valid for at least 30 more days (it re-issues only when
//      the current one is closer to its end than that).
//   2. Whatever renewed the files (this, a cron job, a person): when
//      they differ from what the listener holds, swap them in with
//      setSecureContext(). Running connections keep their session; new
//      ones get the new certificate.
//
// Before this, a Tailscale certificate (90 days) had to be re-issued by
// hand and the server restarted — which interrupts every running turn.

import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const MIN_VALIDITY = '720h';
const WARN_BELOW_DAYS = 14;

export interface SecureContextHolder {
  setSecureContext(opts: { cert: Buffer; key: Buffer }): void;
}

export interface TlsKeeperLog {
  info(o: Record<string, unknown>): void;
  warn(o: Record<string, unknown>): void;
}

export interface TlsKeeperOpts {
  server: SecureContextHolder;
  certPath: string;
  keyPath: string;
  publicHost: string;
  renew?: 'tailscale';
  log: TlsKeeperLog;
  /** What the listener was started with. */
  loadedCert: Buffer;
  /** Test seam: run the renewal command. */
  runRenew?: (args: string[]) => Promise<{ code: number; stderr: string }>;
}

/** Whole days until the certificate ends; null when it cannot be read. */
export function certDaysLeft(pem: Buffer | string, now: number = Date.now()): number | null {
  try {
    const end = Date.parse(new X509Certificate(pem).validTo);
    return Number.isFinite(end) ? Math.floor((end - now) / 86_400_000) : null;
  } catch {
    return null;
  }
}

export function tailscaleCertArgs(certPath: string, keyPath: string, host: string, minValidity: string | null): string[] {
  return ['cert', ...(minValidity ? ['--min-validity', minValidity] : []), '--cert-file', certPath, '--key-file', keyPath, host];
}

function runTailscale(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stderr: stderr.trim() });
    };
    const child = spawn('tailscale', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += ' (timed out after 90 s)'; finish(124); }, 90_000);
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { stderr += err.message; finish(127); });
    child.on('exit', (code) => finish(code ?? 1));
  });
}

export class TlsKeeper {
  private current: Buffer;
  private timer: NodeJS.Timeout | null = null;
  private readonly run: (args: string[]) => Promise<{ code: number; stderr: string }>;

  constructor(private readonly opts: TlsKeeperOpts) {
    this.current = opts.loadedCert;
    this.run = opts.runRenew ?? runTailscale;
  }

  start(): void {
    const first = setTimeout(() => {
      void this.check();
      this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
      this.timer.unref();
    }, FIRST_CHECK_MS);
    first.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One round: renew if asked to, then reload if the files changed. */
  async check(): Promise<'reloaded' | 'unchanged' | 'failed'> {
    const { certPath, keyPath, publicHost, log } = this.opts;
    if (this.opts.renew === 'tailscale') {
      let r = await this.run(tailscaleCertArgs(certPath, keyPath, publicHost, MIN_VALIDITY));
      // Tailscale before 1.62 does not know --min-validity.
      if (r.code !== 0 && /flag provided but not defined|unknown flag/i.test(r.stderr)) {
        r = await this.run(tailscaleCertArgs(certPath, keyPath, publicHost, null));
      }
      if (r.code !== 0) {
        log.warn({
          msg: 'server.tls.renew_failed',
          publicHost,
          days_left: certDaysLeft(this.current),
          err: r.stderr.slice(0, 400),
          hint: 'run `tailscale cert` by hand to see why; a common cause is a missing `sudo tailscale set --operator=$USER`',
        });
      }
    }
    let cert: Buffer;
    let key: Buffer;
    try {
      cert = readFileSync(certPath);
      key = readFileSync(keyPath);
    } catch (err) {
      log.warn({ msg: 'server.tls.read_failed', cert: certPath, err: (err as Error).message });
      return 'failed';
    }
    const daysLeft = certDaysLeft(cert);
    if (cert.equals(this.current)) {
      if (daysLeft !== null && daysLeft < WARN_BELOW_DAYS) {
        log.warn({
          msg: 'server.tls.expires_soon',
          publicHost,
          days_left: daysLeft,
          hint: this.opts.renew ? 'automatic renewal is on but has not produced a new certificate — see server.tls.renew_failed' : 'renew the certificate files; the server picks them up without a restart. For Tailscale: set `server.tls.renew: tailscale`.',
        });
      }
      return 'unchanged';
    }
    try {
      this.opts.server.setSecureContext({ cert, key });
    } catch (err) {
      // Typically a half-written pair (new cert, old key). The next
      // round sees both files and succeeds.
      log.warn({ msg: 'server.tls.reload_failed', err: (err as Error).message });
      return 'failed';
    }
    this.current = cert;
    log.info({ msg: 'server.tls.reloaded', publicHost, days_left: daysLeft });
    return 'reloaded';
  }
}
