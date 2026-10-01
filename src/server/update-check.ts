// Daily update check — the one request somora makes to somora.ai.
//
// Once a day the server asks `GET https://somora.ai/api/latest-version`
// whether a newer version exists and shows the answer in the clients.
// The request carries no body and no identifier, only the program's
// User-Agent line (version, OS, Node version, CPU, server|cli). Like
// any web server, somora.ai logs the request with its IP address and
// counts installations from those logs — documented in docs/setup.md,
// never published. Off with DO_NOT_TRACK=1, in CI, or
// `updateCheck.enabled: false`.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { compareVersions } from '../cli/update-args.ts';

export const DEFAULT_UPDATE_ENDPOINT = 'https://somora.ai/api/latest-version';
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const FIRST_DELAY_MS = 60 * 1000;
const FIRST_JITTER_MS = 5 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 3000;
const NOTE_MAX = 500;

export type UpdateSurface = 'server' | 'cli';

export type UpdateCheckReason = 'enabled' | 'do-not-track' | 'automated-environment' | 'config-disabled';

export interface UpdateCheckState {
  lastCheckedAt?: number;
  lastSuccessAt?: number;
  latestVersion?: string;
  note?: string;
  lastError?: string;
}

export interface UpdateCheckStatus {
  enabled: boolean;
  reason: UpdateCheckReason;
  endpoint: string;
  userAgent: string;
  lastCheckedAt: number | null;
  latestVersion: string | null;
  note: string | null;
  /** The running version is older than the published one. */
  updateAvailable: boolean;
}

export function isTruthy(v: string | undefined): boolean {
  return v !== undefined && !['', '0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());
}

/** Why the check is on or off — env wins over config, as everywhere. */
export function resolveUpdateCheckReason(configEnabled: boolean, env: NodeJS.ProcessEnv = process.env): UpdateCheckReason {
  if (isTruthy(env.DO_NOT_TRACK)) return 'do-not-track';
  // CI jobs are not installations and should not count as such.
  if (isTruthy(env.CI)) return 'automated-environment';
  if (!configEnabled) return 'config-disabled';
  return 'enabled';
}

export function buildUserAgent(version: string, surface: UpdateSurface, p: { platform: string; node: string; arch: string } = { platform: process.platform, node: process.versions.node, arch: process.arch }): string {
  return `somora/${version} (${p.platform}; node/${p.node}; ${p.arch}; ${surface})`;
}

/** The server's answer, validated; null when it is not usable. */
export function parseLatestVersion(body: unknown): { version: string; note?: string } | null {
  if (!body || typeof body !== 'object') return null;
  const v = (body as { version?: unknown }).version;
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v.trim())) return null;
  const n = (body as { note?: unknown }).note;
  const note = typeof n === 'string' && n.trim() ? n.trim().slice(0, NOTE_MAX) : undefined;
  return { version: v.trim(), ...(note ? { note } : {}) };
}

export function readState(path: string): UpdateCheckState {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as UpdateCheckState;
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export function writeState(path: string, state: UpdateCheckState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** Is a check due? Once a day after a success, an hour after a failure. */
export function isDue(state: UpdateCheckState, now: number = Date.now()): boolean {
  if (state.lastSuccessAt && now - state.lastSuccessAt < INTERVAL_MS) return false;
  if (state.lastCheckedAt && !state.lastSuccessAt && now - state.lastCheckedAt < RETRY_AFTER_FAILURE_MS) return false;
  if (state.lastCheckedAt && state.lastSuccessAt && state.lastCheckedAt > state.lastSuccessAt && now - state.lastCheckedAt < RETRY_AFTER_FAILURE_MS) return false;
  return true;
}

export function statusFrom(args: { version: string; configEnabled: boolean; endpoint: string; surface: UpdateSurface; state: UpdateCheckState; env?: NodeJS.ProcessEnv }): UpdateCheckStatus {
  const reason = resolveUpdateCheckReason(args.configEnabled, args.env);
  const latest = args.state.latestVersion ?? null;
  return {
    enabled: reason === 'enabled',
    reason,
    endpoint: args.endpoint,
    userAgent: buildUserAgent(args.version, args.surface),
    lastCheckedAt: args.state.lastSuccessAt ?? null,
    latestVersion: latest,
    note: args.state.note ?? null,
    updateAvailable: latest !== null && compareVersions(latest, args.version) > 0,
  };
}

export interface UpdateCheckerOpts {
  version: string;
  endpoint: string;
  statePath: string;
  configEnabled: boolean;
  surface: UpdateSurface;
  log: { info(o: Record<string, unknown>): void; warn(o: Record<string, unknown>): void };
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export class UpdateChecker {
  private state: UpdateCheckState;
  private timers: NodeJS.Timeout[] = [];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: UpdateCheckerOpts) {
    this.state = readState(opts.statePath);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  status(): UpdateCheckStatus {
    return statusFrom({ ...this.opts, state: this.state });
  }

  /** Boot: one check after a short random delay (so a fleet restarting
   *  at once does not knock in unison), then an hourly look at the clock. */
  start(): void {
    const s = this.status();
    if (!s.enabled) {
      this.opts.log.info({ msg: 'update.check_disabled', reason: s.reason });
      return;
    }
    const first = setTimeout(() => {
      void this.checkIfDue();
      const tick = setInterval(() => void this.checkIfDue(), TICK_MS);
      tick.unref();
      this.timers.push(tick);
    }, FIRST_DELAY_MS + Math.floor(Math.random() * FIRST_JITTER_MS));
    first.unref();
    this.timers.push(first);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  async checkIfDue(now: number = Date.now()): Promise<'checked' | 'skipped'> {
    if (!isDue(this.state, now)) return 'skipped';
    await this.check(now);
    return 'checked';
  }

  /** One request, result into the state file. Never throws. */
  async check(now: number = Date.now()): Promise<UpdateCheckStatus> {
    const { endpoint, log } = this.opts;
    this.state = { ...this.state, lastCheckedAt: now };
    try {
      const res = await this.fetchImpl(endpoint, {
        method: 'GET',
        headers: { 'User-Agent': buildUserAgent(this.opts.version, this.opts.surface), Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseLatestVersion(await res.json());
      if (!parsed) throw new Error('unusable answer');
      this.state = { lastCheckedAt: now, lastSuccessAt: now, latestVersion: parsed.version, ...(parsed.note ? { note: parsed.note } : {}) };
      const available = compareVersions(parsed.version, this.opts.version) > 0;
      log.info({ msg: available ? 'update.available' : 'update.check', latest: parsed.version, running: this.opts.version, ...(parsed.note ? { note: parsed.note } : {}) });
    } catch (err) {
      const message = (err as Error).name === 'TimeoutError' ? 'timed out after 3 s' : (err as Error).message;
      // The same failure every hour is one fact, not twenty-four: warn
      // once, then only when the reason changes.
      const repeat = this.state.lastError === message;
      this.state = { ...this.state, lastError: message };
      log[repeat ? 'info' : 'warn']({ msg: repeat ? 'update.check_failed_again' : 'update.check_failed', endpoint, err: message });
    }
    try {
      writeState(this.opts.statePath, this.state);
    } catch (err) {
      log.warn({ msg: 'update.state_write_failed', err: (err as Error).message });
    }
    return this.status();
  }
}
