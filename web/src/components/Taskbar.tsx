// Bottom taskbar. Replicates the click-dummy `.taskbar` —
// somora-logo + window-list (placeholder for now) + tools (auto-
// arrange / save / restore are stubs in Phase 1, will wire to the
// window manager in Phase 1c) + cpu-mem stub + clock.
//
// No logout button: somora is LAN-only, no auth, no session to
// terminate.

import { useEffect, useState } from 'react';
import { Zap, Grid3x3, Pin, Sparkles } from 'lucide-react';

export function Taskbar() {
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
          <Zap size={16} strokeWidth={2.5} color="#0a0e15" />
        </div>
        <div>
          <div className="taskbar-logo-text">somora</div>
          <div className="taskbar-logo-sub">web · phase 1</div>
        </div>
      </div>

      <div className="taskbar-windows">
        {/* window list — wired in Phase 1c */}
      </div>

      <div className="taskbar-tools">
        <button className="taskbar-tool" type="button" title="Auto-arrange windows" disabled>
          <Grid3x3 size={14} />
          <span>Arrange</span>
        </button>
        <button className="taskbar-tool" type="button" title="Save layout" disabled>
          <Pin size={14} />
          <span>Save</span>
        </button>
        <button className="taskbar-tool" type="button" title="Restore layout" disabled>
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
