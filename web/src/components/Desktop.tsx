// Desktop = the whole app surface. Background grid + radial
// gradients live in `.desktop` / `.desktop::before` / `::after` from
// the click-dummy CSS. Inside `.desktop-area` we mount: the agent
// dock (left), the live windows from the window manager, and the
// taskbar (bottom). Window manager state is owned here so dock
// clicks + taskbar focus + per-window drag/resize all coordinate.

import { useMemo } from 'react';
import { AgentDock } from './AgentDock';
import { AppDock } from './AppDock';
import { Taskbar } from './Taskbar';
import { Window } from './Window';
import { ChatWindow } from './ChatWindow';
import { TmuxListWindow } from './TmuxListWindow';
import { TmuxTerminalWindow } from './TmuxTerminalWindow';
import { useChatContext } from './ChatProvider';
import { useAgents } from '../hooks/useAgents';
import { useLoopState } from '../hooks/useLoopState';
import { useWindowManager } from '../hooks/useWindowManager';
import type { AgentInfo } from '../lib/api';
import { resolveAgentColor } from '../lib/colors';

export function Desktop() {
  const { agents, loading, error } = useAgents();
  const loopState = useLoopState();
  const wm = useWindowManager();
  const chatCtx = useChatContext();

  // Streaming agents — derive from the live session-key snapshot in
  // ChatProvider. Each key is `agent::session`; we strip the session
  // suffix so the dock's status-dot reflects "this agent has any
  // session currently streaming".
  const streamingAgents = useMemo(
    () => new Set(chatCtx.streamingKeys.map((k) => k.split('::')[0]!)),
    [chatCtx.streamingKeys],
  );

  function handleAgentClick(agent: AgentInfo) {
    wm.openChat({
      agentName: agent.name,
      sessionId: 'main',
      agentLabel: `${agent.name} · main`,
      ...(agent.role ? { agentMeta: agent.role.toLowerCase() } : {}),
      ...(agent.icon ? { agentIcon: agent.icon } : {}),
    });
  }

  // Names of agents whose chat is currently open as a window —
  // drives the .active highlight on the dock tile.
  const activeAgentIds = new Set(
    wm.windows
      .filter((w) => w.kind === 'chat' && w.agentName)
      .map((w) => w.agentName as string),
  );

  return (
    <div className="desktop">
      <div className="desktop-area">
        <AgentDock
          agents={agents}
          loading={loading}
          error={error}
          onAgentClick={handleAgentClick}
          loopHolder={loopState.active ? loopState.agent : null}
          activeAgentIds={activeAgentIds}
          streamingAgents={streamingAgents}
        />
        <AppDock
          activeApps={
            new Set(
              wm.windows.filter((w) => w.kind === 'tmux-list').map(() => 'tmux'),
            )
          }
          onTmuxClick={() => wm.openTmuxList()}
        />

        {wm.windows.map((win) => {
          if (win.kind === 'chat') {
            const agent = agents.find((a) => a.name === win.agentName);
            if (!agent) return null;
            const color = resolveAgentColor(agent);
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onMove={wm.move}
                onResize={wm.resize}
                agentColor={color}
              >
                <ChatWindow
                  agent={agent}
                  sessionId={win.sessionId ?? 'main'}
                  windowFocused={wm.focusedId === win.id}
                  onSwitchSession={(sessionId) => wm.setWindowSession(win.id, sessionId)}
                />
              </Window>
            );
          }
          if (win.kind === 'tmux-list') {
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <TmuxListWindow onAttach={(tmuxName) => wm.openTmuxTerm(tmuxName)} />
              </Window>
            );
          }
          if (win.kind === 'tmux-term' && win.tmuxName) {
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <TmuxTerminalWindow tmuxName={win.tmuxName} />
              </Window>
            );
          }
          return null;
        })}
      </div>
      <Taskbar
        windows={wm.windows}
        focusedId={wm.focusedId}
        agents={agents}
        onFocus={wm.focus}
        onAutoArrange={wm.autoArrange}
        onSaveLayout={wm.saveLayout}
        onRestoreLayout={wm.restoreLayout}
      />
    </div>
  );
}
