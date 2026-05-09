// Bottom taskbar. Click-dummy layout: somora-logo + window-list
// (one button per open window, color-tinted per agent) + tools
// (auto-arrange / save / restore) + cpu/mem stub + clock.
//
// No logout button: somora is LAN-only, no auth, no session to
// terminate.

import { useEffect, useState } from 'react';
import { Grid3x3, Pin, Sparkles } from 'lucide-react';
import { Koala } from './Koala';
import type { WindowState } from '../types/window';
import type { AgentInfo } from '../lib/api';
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

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000 * 30);
    return () => clearInterval(t);
  }, []);

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
          <div className="taskbar-logo-sub">web · phase 1</div>
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
              title={w.title}
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
                <span className="taskbar-window-title">{w.title}</span>
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
      </div>

      <div className="taskbar-stat">
        <span>
          <b>—</b> cpu
        </span>
        <span>
          <b>—</b> mem
        </span>
      </div>

      <div className="taskbar-clock">
        <span>{time}</span>
        <small>{date}</small>
      </div>
    </div>
  );
}
