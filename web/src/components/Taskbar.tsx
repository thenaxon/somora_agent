import { useBrowsers } from './BrowserProvider';
// Bottom taskbar. Layout: somora logo and version, inbox, gear (reload
// config, restart, sign out), screen menu (arrange, save and restore the
// layout, full screen, theme) + window list (one button per open window,
// tinted per agent) + live host CPU/mem from `/host-stats` + clock.

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Grid3x3, LogOut, Maximize, Minimize, Monitor, Pin, Power, RefreshCw, Settings, Sparkles } from 'lucide-react';
import { Koala } from './Koala';
import type { WindowState } from '../types/window';
import { api, type AgentInfo } from '../lib/api';
import { resolveAgentColor } from '../lib/colors';
import { sessionSlug } from '../lib/session-label';
import { signOut } from './KeyGate';
import { InboxMenu } from './InboxMenu';
import { BUILT_IN_THEME_NAME, modesFor, readCustomTheme, readMode, selectTheme, setMode, syncThemes, type ThemeMode, type WebTheme } from '../lib/theme';

interface Props {
  onOpenBrowsers?: () => void;
  windows: WindowState[];
  focusedId: string | null;
  agents: AgentInfo[];
  onFocus: (id: string) => void;
  onAutoArrange: () => void;
  onSaveLayout: () => void;
  onRestoreLayout: () => void;
}

export function Taskbar({
  windows,
  onOpenBrowsers,
  focusedId,
  agents,
  onFocus,
  onAutoArrange,
  onSaveLayout,
  onRestoreLayout,
}: Props) {
  const browserState = useBrowsers();
  const waiting = browserState.browsers.filter((b) => b.handoff);
  const [clock, setClock] = useState(new Date());
  const [version, setVersion] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hostStats, setHostStats] = useState<{ cpuPct: number; memPct: number } | null>(null);
  // Gear menu: reload config.yaml / restart the service. `toast` is the
  // one-line outcome shown in the taskbar for a few seconds.
  const [gearOpen, setGearOpen] = useState(false);
  const [gearBusy, setGearBusy] = useState<'reload' | 'restart' | null>(null);
  const [configStatus, setConfigStatus] = useState<{
    loadedAt: string;
    changedOnDisk: boolean;
    restartAvailable: boolean;
    invalid: { since: string; message: string } | null;
  } | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'warn' | 'error' } | null>(null);
  const gearRef = useRef<HTMLDivElement | null>(null);
  // Screen menu: arrange, save, restore, full screen.
  const [screenOpen, setScreenOpen] = useState(false);
  // Theme: somora or one of your own, picked from a list that folds out
  // under the theme's name; the mode switch below it.
  const [mode, setModeState] = useState<ThemeMode>(() => readMode());
  const [customTheme, setCustomTheme] = useState<WebTheme | null>(() => readCustomTheme());
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  // Themes of your own (GET /themes): fetched once and again each time
  // the menu opens, so a theme dropped into ~/.somora/themes/ shows up
  // without a reload and an edited one is applied as it now is.
  const [customThemes, setCustomThemes] = useState<WebTheme[]>([]);
  const [invalidThemes, setInvalidThemes] = useState<Array<{ id: string; error: string }>>([]);
  const themesFetched = useRef(false);
  useEffect(() => {
    if (!screenOpen) setThemePickerOpen(false);
    if (!screenOpen && themesFetched.current) return;
    let cancelled = false;
    api
      .themes()
      .then((r) => {
        if (cancelled) return;
        themesFetched.current = true;
        setCustomThemes(r.themes);
        setInvalidThemes(r.invalid);
        setCustomTheme(syncThemes(r.themes));
      })
      .catch(() => {
        /* an older server without /themes: somora only */
      });
    return () => {
      cancelled = true;
    };
  }, [screenOpen]);
  const pickTheme = (t: WebTheme | null) => {
    selectTheme(t);
    setCustomTheme(t);
    setThemePickerOpen(false);
  };
  const screenRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!screenOpen) return;
    const onDown = (e: MouseEvent) => {
      if (screenRef.current && !screenRef.current.contains(e.target as Node)) setScreenOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setScreenOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [screenOpen]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === 'info' ? 6000 : 12000);
    return () => clearTimeout(t);
  }, [toast]);

  // A broken config.yaml must be visible without opening the menu: the
  // server keeps the last valid version, and edits silently do nothing.
  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .configStatus()
        .then((r) => {
          if (alive) setConfigStatus({ loadedAt: r.loadedAt, changedOnDisk: r.changedOnDisk, restartAvailable: r.restartAvailable, invalid: r.invalid ?? null });
        })
        .catch(() => undefined);
    void check();
    const t = setInterval(check, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    // Refresh the on-disk marker whenever the menu opens — the point of
    // the menu is to tell the user whether a reload would do anything.
    if (!gearOpen) return;
    api
      .configStatus()
      .then((r) =>
        setConfigStatus({ loadedAt: r.loadedAt, changedOnDisk: r.changedOnDisk, restartAvailable: r.restartAvailable, invalid: r.invalid ?? null }),
      )
      .catch(() => setConfigStatus(null));
    const onDown = (e: MouseEvent) => {
      if (gearRef.current && !gearRef.current.contains(e.target as Node)) setGearOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGearOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [gearOpen]);

  const reloadConfig = async () => {
    setGearBusy('reload');
    try {
      const r = await api.reloadConfig();
      if (!r.ok) {
        setToast({ text: `config not reloaded — ${r.error ?? 'unknown error'}`, tone: 'error' });
        return;
      }
      const what = r.changed.length === 0 ? 'no changes' : `changed: ${r.changed.join(', ')}`;
      if (r.restartRequired.length > 0) {
        setToast({ text: `config reloaded — ${what} · restart needed for: ${r.restartRequired.join(', ')}`, tone: 'warn' });
      } else {
        setToast({ text: `config reloaded — ${what}`, tone: 'info' });
      }
    } catch (err) {
      setToast({ text: `config reload failed — ${(err as Error).message}`, tone: 'error' });
    } finally {
      setGearBusy(null);
      setGearOpen(false);
    }
  };

  const restartServer = async () => {
    if (!window.confirm('Restart somora? Every open chat stream and terminal drops for a few seconds.')) return;
    setGearBusy('restart');
    try {
      const r = await api.restartServer();
      if (!r.ok) {
        setToast({ text: `restart refused — ${r.error ?? 'unknown error'}`, tone: 'error' });
        return;
      }
      setToast({ text: 'restarting somora — reconnecting…', tone: 'warn' });
      // Poll /health until the new process answers, then reload the page
      // so every window re-subscribes cleanly.
      const started = Date.now();
      const poll = async () => {
        if (Date.now() - started > 90_000) {
          setToast({ text: 'somora did not come back within 90 s — check the service', tone: 'error' });
          return;
        }
        try {
          const res = await fetch('/health', { cache: 'no-store' });
          if (res.ok) {
            const body = (await res.json()) as { serverUptimeMs?: number };
            if (typeof body.serverUptimeMs === 'number' && body.serverUptimeMs < 60_000) {
              window.location.reload();
              return;
            }
          }
        } catch {
          // still down
        }
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 2500);
    } catch (err) {
      setToast({ text: `restart failed — ${(err as Error).message}`, tone: 'error' });
    } finally {
      setGearBusy(null);
      setGearOpen(false);
    }
  };

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000 * 30);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // Fetched once at mount — server version doesn't change without a
    // restart, and a restart drops every SSE anyway.
    api
      .version()
      .then((r) => {
        setVersion(r.version);
        // A newer version and somora.ai's note live in the inbox now.
      })
      .catch(() => setVersion(null));
  }, []);

  useEffect(() => {
    // Poll host CPU/mem every 5s. Backend computes from os.loadavg() +
    // /proc/meminfo, so updates are smooth at the 1-min loadavg cadence.
    // Quiet on failure — empty values show as `—` and nothing else is
    // affected.
    let alive = true;
    const refresh = () => {
      api
        .hostStats()
        .then((r) => {
          if (!alive) return;
          setHostStats({ cpuPct: r.cpu.percent, memPct: r.mem.percent });
        })
        .catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    // Track external fullscreen changes — user can press F11 / Esc
    // outside our button, the icon needs to follow.
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Capability detection: most desktop browsers support requestFullscreen;
  // iPadOS Safari does not (the API is on Element but a no-op for non-
  // video elements). Hide the button entirely there — same pattern as
  // the screenshot button.
  const fullscreenSupported =
    typeof document !== 'undefined' &&
    typeof document.documentElement.requestFullscreen === 'function' &&
    document.fullscreenEnabled !== false;

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
  };

  const time = clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = clock.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  // Notices from the gear's actions (reload, restart) — next to the
  // window buttons, where there is room for a line of text.
  const toastNode = toast ? (
    <span className={`taskbar-toast taskbar-toast-${toast.tone}`} role="status" title={toast.text}>
      {toast.text}
    </span>
  ) : null;

  return (
    <div className="taskbar">
      <div className="taskbar-logo">
        <div className="taskbar-logo-mark">
          <Koala size={20} />
        </div>
        <div>
          <div className="taskbar-logo-text">somora</div>
          <div className="taskbar-logo-sub">{version ? `v${version}` : '—'}</div>
        </div>
      </div>


      <div className="taskbar-tools">
        <InboxMenu />
        <div className="taskbar-gear" ref={gearRef}>
          <button
            className="taskbar-tool"
            type="button"
            title={configStatus?.invalid ? 'config.yaml does not validate — the last valid version is running' : 'Server: reload config, restart, sign out'}
            aria-haspopup="menu"
            aria-expanded={gearOpen}
            onClick={() => setGearOpen((v) => !v)}
            style={configStatus?.invalid ? { color: 'var(--danger)' } : undefined}
          >
            <Settings size={14} />
            {configStatus?.invalid && <span className="taskbar-gear-alert" aria-label="config problem">!</span>}
          </button>
          {gearOpen && (
            <div className="taskbar-menu" role="menu">
              {configStatus?.invalid && (
                <div className="taskbar-menu-problem" role="alert">
                  <strong>config.yaml does not validate</strong>
                  <span>
                    since {new Date(configStatus.invalid.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — the last valid version keeps running
                  </span>
                  <pre>{configStatus.invalid.message.replace(/^config\.yaml is invalid \([^)]*\):\n/, '')}</pre>
                </div>
              )}
              <button
                className="taskbar-menu-item"
                type="button"
                role="menuitem"
                disabled={gearBusy !== null}
                onClick={() => void reloadConfig()}
                title="Re-read ~/.somora/config.yaml and apply it without a restart"
              >
                <RefreshCw size={13} />
                <span>
                  Reload config
                  {configStatus?.changedOnDisk && <em className="taskbar-menu-hint"> · changed on disk</em>}
                </span>
              </button>
              <button
                className="taskbar-menu-item"
                type="button"
                role="menuitem"
                disabled={gearBusy !== null || configStatus?.restartAvailable === false}
                onClick={() => void restartServer()}
                title={
                  configStatus?.restartAvailable === false
                    ? 'somora is not running as a background service — restart it the way you started it'
                    : 'Restart the somora service'
                }
              >
                <Power size={13} />
                <span>Restart somora</span>
              </button>
              <button
                className="taskbar-menu-item"
                type="button"
                role="menuitem"
                onClick={() => void signOut()}
                title="Forget the key in this browser; it asks for it again"
              >
                <LogOut size={13} />
                <span>Sign out</span>
              </button>
              <div className="taskbar-menu-meta">
                {version ? `v${version}` : ''}
                {configStatus?.loadedAt
                  ? ` · config loaded ${new Date(configStatus.loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : ''}
              </div>
            </div>
          )}
        </div>
        <div className="taskbar-gear" ref={screenRef}>
          <button
            className="taskbar-tool"
            type="button"
            title="Screen: arrange, save and restore the layout, full screen, theme"
            aria-haspopup="menu"
            aria-expanded={screenOpen}
            onClick={() => setScreenOpen((v) => !v)}
          >
            <Monitor size={14} />
          </button>
          {screenOpen && (
            <div className="taskbar-menu" role="menu">
              <button className="taskbar-menu-item" type="button" role="menuitem" onClick={() => { setScreenOpen(false); onAutoArrange(); }} title="Tile all windows that are not minimized">
                <Grid3x3 size={13} />
                <span>Arrange windows</span>
              </button>
              <button className="taskbar-menu-item" type="button" role="menuitem" onClick={() => { setScreenOpen(false); onSaveLayout(); }} title="Store the current layout">
                <Pin size={13} />
                <span>Save layout</span>
              </button>
              <button className="taskbar-menu-item" type="button" role="menuitem" onClick={() => { setScreenOpen(false); onRestoreLayout(); }} title="Bring the saved layout back">
                <Sparkles size={13} />
                <span>Restore layout</span>
              </button>
              {fullscreenSupported && (
                <button className="taskbar-menu-item" type="button" role="menuitem" onClick={() => { setScreenOpen(false); toggleFullscreen(); }}>
                  {isFullscreen ? <Minimize size={13} /> : <Maximize size={13} />}
                  <span>{isFullscreen ? 'Leave full screen' : 'Full screen'}</span>
                </button>
              )}
              <div className="theme-section">
                <div className="theme-switch-label">Theme</div>
                <button
                  type="button"
                  className="theme-picker"
                  aria-haspopup="listbox"
                  aria-expanded={themePickerOpen}
                  onClick={() => setThemePickerOpen((v) => !v)}
                >
                  <span>{customTheme ? customTheme.name : BUILT_IN_THEME_NAME}</span>
                  <ChevronDown size={13} />
                </button>
                {themePickerOpen && (
                  <div className="theme-list" role="listbox" aria-label="Theme">
                    <button type="button" role="option" aria-selected={!customTheme} onClick={() => pickTheme(null)}>
                      <span>{BUILT_IN_THEME_NAME}</span>
                      {!customTheme && <Check size={12} />}
                    </button>
                    {customThemes.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        role="option"
                        aria-selected={customTheme?.id === t.id}
                        title={`${t.versions.dark && t.versions.light ? 'Dark and light' : t.versions.dark ? 'Dark' : 'Light'}, from ~/.somora/themes/${t.id}`}
                        onClick={() => pickTheme(t)}
                      >
                        <span>{t.name}</span>
                        {customTheme?.id === t.id && <Check size={12} />}
                      </button>
                    ))}
                    {invalidThemes.map((t) => (
                      <button key={t.id} type="button" role="option" aria-selected={false} aria-disabled="true" className="theme-invalid" title={t.error}>
                        <span>{t.id} · invalid</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="theme-switch" role="group" aria-label="Mode">
                  {(['dark', 'light', 'auto'] as const).map((m) => {
                    const offered = modesFor(customTheme).includes(m);
                    return (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={modesFor(customTheme).length === 1 ? modesFor(customTheme)[0] === m : mode === m}
                        aria-disabled={!offered}
                        title={!offered ? `${customTheme?.name} has only a ${modesFor(customTheme)[0]} version` : m === 'auto' ? 'Follow the system setting' : undefined}
                        onClick={() => {
                          if (!offered) return;
                          setMode(m);
                          setModeState(m);
                        }}
                      >
                        {m === 'dark' ? 'Dark' : m === 'light' ? 'Light' : 'Auto'}
                      </button>
                    );
                  })}
                </div>
                {modesFor(customTheme).length === 1 && (
                  <div className="theme-switch-note">
                    {customTheme?.name} has only a {modesFor(customTheme)[0]} version.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {waiting.length > 0 && <button type="button" className="browser-attention" onClick={onOpenBrowsers} title={waiting.map((b) => `${b.handoff!.agent}: ${b.handoff!.reason}`).join('\n')}>Browser · {waiting.length} waiting for you</button>}
      <div className="taskbar-windows">
        {windows.map((w) => {
          const agent =
            w.kind === 'chat' && w.agentName
              ? agents.find((a) => a.name === w.agentName)
              : undefined;
          const color = agent ? resolveAgentColor(agent) : undefined;
          const isFocused = focusedId === w.id && !w.minimized;
          // Render the label LIVE from (agentName, sessionId). The
          // window's `title` is cached at open-time and goes stale
          // when the user runs `/session <slug>` — we'd display the
          // old session name forever. Falling back to title only when
          // the window isn't a chat (no sessionId to show).
          // Label shows the human slug; the tooltip keeps the full
          // technical id (user request 2026-07-21 — taskbar: slug only,
          // chat header: both).
          const live =
            w.kind === 'chat' && w.agentName
              ? `${w.agentName} · ${sessionSlug(w.sessionId ?? 'main')}`
              : w.title;
          const tooltip =
            w.kind === 'chat' && w.agentName
              ? `${w.agentName} · ${w.sessionId ?? 'main'}`
              : w.title;
          return (
            <button
              key={w.id}
              type="button"
              className={[
                'taskbar-window',
                isFocused ? 'focused' : '',
                w.minimized ? 'minimized' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onFocus(w.id)}
              title={tooltip}
              style={color ? ({ '--row-color': color } as React.CSSProperties) : undefined}
            >
              <span
                className="taskbar-window-dot"
                style={
                  color
                    ? { background: color, boxShadow: `0 0 6px ${color}88` }
                    : undefined
                }
              />
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {agent && <span style={{ fontSize: 12 }}>{agent.icon ?? '🤖'}</span>}
                <span className="taskbar-window-title">{live}</span>
              </span>
            </button>
          );
        })}
      </div>

      {toastNode}

      <div className="taskbar-stat">
        <span title="1-min CPU load average / cores. >100% = overloaded.">
          <b>{hostStats ? `${Math.round(hostStats.cpuPct)}%` : '—'}</b> cpu
        </span>
        <span title="Host memory in use (MemAvailable on Linux, freemem fallback).">
          <b>{hostStats ? `${Math.round(hostStats.memPct)}%` : '—'}</b> mem
        </span>
      </div>

      <div className="taskbar-clock">
        <span>{time}</span>
        <small>{date}</small>
      </div>
    </div>
  );
}
