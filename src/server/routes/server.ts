// Moved unchanged from src/server/index.ts, which calls registerServerRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { LAUNCHD_LABEL, launchdAvailable, launchdDomain, launchdLoaded } from '../../cli/launchd.ts';
import { configPath, currentConfigProblem, getFreshConfig, loadConfig, primeFreshConfig } from '../../config/loader.ts';
import { RESTART_REQUIRED_SECTIONS, diffConfigSections, restartRequiredFor } from '../../config/reload.ts';
import type { Config } from '../../config/types.ts';
import { configureModelAvailability, resetModelAvailability } from '../../engine/model-availability.ts';
import { clearCatalogCache } from '../../media/capabilities.ts';
import { loadPersona } from '../../persona/loader.ts';
import { resolveSessionId } from '../../storage/sessions.ts';
import { SOMORA_VERSION } from '../../version.ts';
import { getEffectiveEnv } from '../env.ts';
import { readAgentOrder, parseAgentOrder, writeAgentOrder } from '../agent-order.ts';
import { logger } from '../logger.ts';
import { writeRestartIntent } from '../restart-intent.ts';
import { config, configLoadedAt, configLoadedMtimeMs, setConfig, setConfigLoadedAt, setConfigMtime } from '../server-state.ts';
import { listAllSessionLockStates } from '../session-queue.ts';
import { execSync, spawn as spawnChild, spawnSync as spawnSyncChild } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus as osCpus, freemem as osFreemem, loadavg as osLoadavg, totalmem as osTotalmem } from 'node:os';

export interface ServerRoutesDeps {
  configFileMtime: typeof Server.configFileMtime;
  refreshSubagentDenyCheck: typeof Server.refreshSubagentDenyCheck;
  syncDreamers: typeof Server.syncDreamers;
  updateChecker: typeof Server.updateChecker;
}

export function registerServerRoutes(app: Hono, routeDeps: ServerRoutesDeps): void {
  const { configFileMtime, refreshSubagentDenyCheck, syncDreamers, updateChecker } = routeDeps;
  /** Version plus, when known, what somora.ai says is current. */
  app.get('/version', (c) => {
    const u = updateChecker.status();
    return c.json({
      version: SOMORA_VERSION,
      update: u.latestVersion ? { latestVersion: u.latestVersion, available: u.updateAvailable, ...(u.note ? { note: u.note } : {}) } : null,
    });
  });

  // ─── Config reload + restart ─────────────────────────────────────────
  // Web taskbar gear + TUI /reload, /restart. Reload re-reads config.yaml,
  // validates it, and swaps the in-memory Config only on success — a typo
  // leaves the running config untouched and comes back as 400 with the
  // schema issues. Sections consumed at boot (see RESTART_REQUIRED_SECTIONS)
  // are reported so the client can say "restart needed".
  app.get('/config/status', async (c) => {
    const mtimeMs = await configFileMtime();
    // Re-checks the file (cheap when unchanged) so a broken edit shows up
    // here even before the next turn.
    await getFreshConfig().catch(() => undefined);
    const problem = currentConfigProblem();
    return c.json({
      // Set while config.yaml does not validate: the last valid version
      // keeps running. `since` = when this broken version was first seen.
      invalid: problem ? { since: problem.since, message: problem.message } : null,
      path: configPath(),
      loadedAt: configLoadedAt,
      changedOnDisk: mtimeMs > configLoadedMtimeMs,
      restartRequiredSections: RESTART_REQUIRED_SECTIONS,
      // Linux unit or macOS LaunchAgent — whatever POST /server/restart would use.
      restartAvailable: serviceRestartCommand() !== null,
    });
  });

  app.post('/config/reload', async (c) => {
    let next: Config;
    try {
      next = await loadConfig();
    } catch (err) {
      logger.warn({ msg: 'config.reload_rejected', err: (err as Error).message });
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    const changed = diffConfigSections(config, next);
    const restartRequired = restartRequiredFor(changed, config, next);
    setConfig(next);
    setConfigLoadedAt(new Date().toISOString());
    setConfigMtime(await configFileMtime());
    primeFreshConfig(next, configLoadedMtimeMs);
    // A reload is also the operator's "try the models again": every
    // unavailable mark is dropped and the TTL re-read.
    configureModelAvailability(next.fallback.retryUnavailableMinutes);
    resetModelAvailability();
    // And "read the provider catalogs again": a model or parameter added
    // there must not stay rejected until the cache expires.
    clearCatalogCache();
    logger.info({ msg: 'config.reloaded', changed, restartRequired });
    await refreshSubagentDenyCheck();
    // The central rem.model may have changed: REM follows at once.
    await syncDreamers();
    return c.json({ ok: true, changed, restartRequired, loadedAt: configLoadedAt });
  });

  function systemdUnitActive(): boolean {
    if (process.platform !== 'linux') return false;
    const r = spawnSyncChild('systemctl', ['--user', 'is-active', 'somora.service'], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() === 'active';
  }

  /** How this server is brought back after a stop: the systemd user unit
   *  on Linux, the LaunchAgent on macOS. null = started by hand
   *  (foreground), nothing would restart it. */
  function serviceRestartCommand(): { via: 'systemd' | 'launchd'; cmd: string; args: string[] } | null {
    if (systemdUnitActive()) return { via: 'systemd', cmd: 'systemctl', args: ['--user', 'restart', 'somora.service'] };
    if (launchdAvailable() && launchdLoaded()) {
      // kickstart -k: launchd kills and restarts the job itself. bootout +
      // bootstrap from a child of this process would die with the job.
      return { via: 'launchd', cmd: 'launchctl', args: ['kickstart', '-k', `${launchdDomain()}/${LAUNCHD_LABEL}`] };
    }
    return null;
  }

  function restartServiceNow(svc: { cmd: string; args: string[] }): void {
    const child = spawnChild(svc.cmd, svc.args, { detached: true, stdio: 'ignore' });
    child.unref();
  }

  /** A requested restart that waits for its turn to end (restart-intent.ts). */
  let pendingRestart: { agent: string; session: string; since: number } | null = null;
  const RESTART_WAIT_MAX_MS = 10 * 60 * 1000;
  const RESTART_OTHERS_GRACE_MS = 30 * 1000;

  function sessionBusy(agent: string, session: string): boolean {
    return listAllSessionLockStates().some((x) => x.agent === agent && x.session === session && x.busy);
  }

  function restartWhenTurnEnded(svc: { via: string; cmd: string; args: string[] }, agent: string, session: string): void {
    const since = Date.now();
    pendingRestart = { agent, session, since };
    let ownEndedAt: number | null = null;
    const tick = setInterval(() => {
      const now = Date.now();
      if (ownEndedAt === null) {
        if (sessionBusy(agent, session) && now - since < RESTART_WAIT_MAX_MS) return;
        ownEndedAt = now;
      }
      // The requester is done. Give turns running elsewhere a short grace;
      // what is still running after it is cut and marked at boot.
      const others = listAllSessionLockStates().filter((x) => x.busy && !(x.agent === agent && x.session === session));
      if (others.length > 0 && now - ownEndedAt < RESTART_OTHERS_GRACE_MS) return;
      clearInterval(tick);
      logger.warn({ msg: 'server.restart_now', via: svc.via, requestedBy: `${agent}/${session}`, waitedMs: now - since, cutting: others.map((x) => `${x.agent}/${x.session}`) });
      restartServiceNow(svc);
    }, 500);
    tick.unref();
  }

  // Restart through the service manager (systemd user unit, or the
  // LaunchAgent on macOS). 409 when somora was started by hand — a
  // foreground `somora server start` has nothing to bring it back.
  //
  // With `agent` + `session` in the body the restart is a REQUEST from
  // inside that session's turn: it is written down, waits until the turn
  // has ended, and after boot the session is woken with the outcome
  // (`somora server restart` / `somora update` send this when an agent
  // runs them). Without them — the web gear menu, the TUI — it restarts
  // right away, responding first so the client gets its 200.
  app.post('/server/restart', async (c) => {
    const svc = serviceRestartCommand();
    if (!svc) {
      return c.json(
        { ok: false, error: 'somora is not running as a background service (systemd user unit / LaunchAgent) — restart it the way you started it' },
        409,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { agent?: unknown; session?: unknown; reason?: unknown };
    if (typeof body.agent === 'string' && typeof body.session === 'string' && body.agent && body.session) {
      const agent = body.agent;
      if (!(await loadPersona(agent))) return c.json({ ok: false, error: `agent '${agent}' not found` }, 404);
      const session = (await resolveSessionId(agent, body.session)) ?? body.session;
      if (pendingRestart) {
        return c.json({ ok: true, deferred: true, already: true, via: svc.via, requestedBy: `${pendingRestart.agent}/${pendingRestart.session}`, message: 'A restart is already scheduled; it happens when the turn that asked for it has ended.' });
      }
      writeRestartIntent({
        agent,
        session,
        requestedAt: Date.now(),
        fromVersion: SOMORA_VERSION,
        ...(typeof body.reason === 'string' && body.reason.trim() ? { reason: body.reason.trim().slice(0, 300) } : {}),
      });
      const busy = sessionBusy(agent, session);
      logger.warn({ msg: 'server.restart_requested', via: svc.via, agent, session, deferred: busy });
      restartWhenTurnEnded(svc, agent, session);
      return c.json({
        ok: true,
        deferred: true,
        via: svc.via,
        message: busy
          ? 'Restart scheduled. It happens when your current turn has ended — finish what you are saying and end the turn now, do not wait or poll for it. You are woken in this session when the server is back.'
          : 'Restart scheduled. You are woken in this session when the server is back.',
      });
    }
    logger.warn({ msg: 'server.restart_requested', via: svc.via });
    setTimeout(() => restartServiceNow(svc), 300);
    return c.json({ ok: true, via: svc.via, expectedDowntimeSeconds: 8 });
  });

  app.get('/env', (c) => c.json(getEffectiveEnv()));

  // Host machine stats — CPU load + memory usage of the box somora is
  // running on. Surfaced to the web taskbar (`cpu` / `mem` widgets) and
  // useful for ad-hoc curl when somora lives on a VM you don't otherwise
  // have a metrics dashboard for.
  //
  // CPU: 1-minute load average from `os.loadavg()` divided by core count.
  //   `percent` > 100 means the box is overloaded (more runnable
  //   processes than CPUs), which is honest signal — we don't cap.
  //   On Windows `loadavg` returns zeros, but somora doesn't target
  //   Windows so we accept the degraded value.
  // Mem: platform-specific because `os.freemem()` is misleading on both
  //   Linux (excludes reclaimable page cache) and macOS (excludes
  //   inactive + speculative pages that the kernel hands back under
  //   pressure). We read each platform's "available memory" notion:
  //     - Linux:  /proc/meminfo:MemAvailable
  //     - macOS:  `vm_stat` pages: free + inactive + speculative
  //     - other:  os.freemem() fallback (degraded but non-erroring)
  function readLinuxMemAvailable(): number | null {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf8');
      const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      return m ? Number(m[1]) * 1024 : null;
    } catch {
      return null;
    }
  }
  function readDarwinMemAvailable(): number | null {
    try {
      const out = execSync('vm_stat', { encoding: 'utf8', timeout: 1000 });
      const pageSizeMatch = out.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
      const pages = (label: string): number => {
        const m = out.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
        return m ? Number(m[1]) : 0;
      };
      // Mirrors what macOS Activity Monitor calls "available": free
      // pages plus inactive + speculative (file-backed pages the kernel
      // can hand back under memory pressure without I/O).
      const available = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative');
      return available * pageSize;
    } catch {
      return null;
    }
  }
  function readPlatformMemAvailable(): number {
    if (process.platform === 'linux') {
      const v = readLinuxMemAvailable();
      if (v !== null) return v;
    } else if (process.platform === 'darwin') {
      const v = readDarwinMemAvailable();
      if (v !== null) return v;
    }
    return osFreemem();
  }
  app.get('/host-stats', (c) => {
    const cores = osCpus().length || 1;
    const load1 = osLoadavg()[0] ?? 0;
    const totalBytes = osTotalmem();
    const availableBytes = readPlatformMemAvailable();
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    return c.json({
      cpu: {
        loadAvg1: load1,
        cores,
        percent: cores > 0 ? (load1 / cores) * 100 : 0,
      },
      mem: {
        totalBytes,
        availableBytes,
        usedBytes,
        percent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
      },
    });
  });

  // Display preferences for thin clients (TUI, future web). Server is the
  // single config reader — clients fetch this rather than parsing config.yaml
  // themselves.
  app.get('/tui-config', (c) => c.json(config.tui));
  app.get('/mobile-config', (c) => c.json(config.mobile));

  // The order of the agent tiles in /mobile, shared by every device.
  app.get('/mobile-agent-order', async (c) => c.json({ order: await readAgentOrder() }));
  app.put('/mobile-agent-order', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body must be JSON: {"order": ["agent", ...]}' }, 400);
    }
    const parsed = parseAgentOrder(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    await writeAgentOrder(parsed.order);
    logger.info({ msg: 'mobile.agent_order.saved', count: parsed.order.length });
    return c.json({ order: parsed.order });
  });
}
