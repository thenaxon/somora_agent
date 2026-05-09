// Desktop = the whole app surface. Background grid + radial
// gradients live in `.desktop` / `.desktop::before` / `::after` from
// the click-dummy CSS; we just mount the chrome (dock + taskbar)
// inside the `.desktop-area` container.
//
// Phase 1: dock fetches agents and renders. Click on agent is a
// no-op for now (Phase 1c will wire it to open a chat window).
// Window manager state will land in this same component.

import { AgentDock } from './AgentDock';
import { Taskbar } from './Taskbar';
import { useAgents } from '../hooks/useAgents';
import type { AgentInfo } from '../lib/api';

export function Desktop() {
  const { agents, loading, error } = useAgents();

  function handleAgentClick(agent: AgentInfo) {
    // Phase 1c will replace this with: open / focus chat window for
    // this agent's main session. Logging keeps the wiring obvious
    // when you click around in the empty scaffold.
    // eslint-disable-next-line no-console
    console.log('[somora-web] agent click:', agent.name);
  }

  return (
    <div className="desktop">
      <div className="desktop-area">
        <AgentDock
          agents={agents}
          loading={loading}
          error={error}
          onAgentClick={handleAgentClick}
        />
        {/* Window-manager + chat windows mount here in Phase 1c. */}
      </div>
      <Taskbar />
    </div>
  );
}
