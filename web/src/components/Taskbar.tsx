// Bottom taskbar. Layout: somora-logo + window-list (one button per
// open window, color-tinted per agent) + tools (auto-arrange / save /
// restore) + live host CPU/mem from `/host-stats` + clock.
//
// No logout button: somora is LAN-only, no auth, no session to
// terminate.

import { useEffect, useState } from 'react';
import { Grid3x3, Maximize, Minimize, Pin, Sparkles } from 'lucide-react';
import { Koala } from './Koala';
import type { WindowState } from '../types/window';
import { api, type AgentInfo } from '../lib/api';
import { resolveAgentColor } from '../lib/colors';

interface Props {
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
  focusedId,
  agents,
  onFocus,
  onAutoArrange,
  onSaveLayout,
  onRestoreLayout,
}: Props) {
  const [clock, setClock] = useState(new Date());
  const [version, setVersion] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hostStats, setHostStats] = useState<{ cpuPct: number; memPct: number } | null>(null);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000 * 30);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // Fetched once at mount — server version doesn't change without a
    // restart, and a restart drops every SSE anyway.
    api
      .version()
      .then((r) => setVersion(r.version))
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

  return (
    <div className="taskbar">
      <div className="taskbar-logo">
        <div className="taskbar-logo-mark">
          <Koala size={18} color="#0a0e15" strokeWidth={1.8} />
        </div>
        <div>
          <div className="taskbar-logo-text">somora</div>
          <div className="taskbar-logo-sub">{version ? `v${version}` : '—'}</div>
        </div>
      </div>

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
          const live =
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
              title={live}
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

      <div className="taskbar-tools">
        <button
          className="taskbar-tool"
          type="button"
          title="Auto-arrange windows"
          onClick={onAutoArrange}
        >
          <Grid3x3 size={14} />
          <span>Arrange</span>
        </button>
        <button
          className="taskbar-tool"
          type="button"
          title="Save current layout"
          onClick={onSaveLayout}
        >
          <Pin size={14} />
          <span>Save</span>
        </button>
        <button
          className="taskbar-tool"
          type="button"
          title="Restore saved layout"
          onClick={onRestoreLayout}
        >
          <Sparkles size={14} />
          <span>Restore</span>
        </button>
        {fullscreenSupported && (
          <button
            className="taskbar-tool"
            type="button"
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            <span>{isFullscreen ? 'Windowed' : 'Fullscreen'}</span>
          </button>
        )}
      </div>

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
