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
import { ShellTerminalWindow } from './ShellTerminalWindow';
import { SessionsWindow } from './SessionsWindow';
import { SentinelWindow } from './SentinelWindow';
import { WikiWindow } from './WikiWindow';
import { PinNoteWindow } from './PinNoteWindow';
import { FileViewWindow } from './FileViewWindow';
import { FileViewProvider } from './FileViewContext';
import { useChatContext } from './ChatProvider';
import { useAgents } from '../hooks/useAgents';
import { useDreamStates } from '../hooks/useDreamStates';
import { useLoopState } from '../hooks/useLoopState';
import { useWindowManager } from '../hooks/useWindowManager';
import { useActivityStream } from '../hooks/useActivityStream';
import { ActivityProvider } from './ActivityProvider';
import type { AgentInfo } from '../lib/api';
import { resolveAgentColor } from '../lib/colors';

export function Desktop() {
  const { agents, loading, error } = useAgents();
  const loopState = useLoopState();
  const dreamStates = useDreamStates();
  const wm = useWindowManager();
  const chatCtx = useChatContext();

  // Cross-agent activity feed: covers streaming-dots for agents whose
  // chat window the user has NOT opened (ChatProvider only knows about
  // sessions with active subscribers), plus unread-state cross-client
  // sync. See src/hooks/useActivityStream.ts.
  const activity = useActivityStream(agents);

  // Streaming agents — union of (a) ChatProvider's own session
  // EventSources (windows the user has open) and (b) the cross-agent
  // activity SSE (covers sentinel-fired turns on closed-window
  // sessions). Either signal lights the dock dot.
  const streamingAgents = useMemo(() => {
    const own = chatCtx.streamingKeys.map((k) => k.split('::')[0]!);
    const merged = new Set<string>(own);
    for (const a of activity.streamingAgents) merged.add(a);
    return merged;
  }, [chatCtx.streamingKeys, activity.streamingAgents]);

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
    <ActivityProvider value={activity}>
    <FileViewProvider open={wm.openFileView}>
    <div className="desktop">
      <div className="desktop-area">
        <div className="agent-dock">
          <AgentDock
            agents={agents}
            loading={loading}
            error={error}
            onAgentClick={handleAgentClick}
            loopHolder={loopState.active ? loopState.agent : null}
            activeAgentIds={activeAgentIds}
            streamingAgents={streamingAgents}
            unreadAgents={activity.unreadAgents}
            dreamStates={dreamStates}
          />
          <AppDock
            activeApps={
              new Set(
                wm.windows.flatMap((w) => {
                  if (w.kind === 'tmux-list') return ['tmux'];
                  if (w.kind === 'sessions-list') return ['sessions'];
                  if (w.kind === 'sentinel') return ['sentinel'];
                  if (w.kind === 'wiki') return ['wiki'];
                  return [];
                }),
              )
            }
            onTmuxClick={() => wm.openTmuxList()}
            onTerminalClick={() => wm.openShellTerm()}
            onSessionsClick={() => wm.openSessionsList()}
            onSentinelClick={() => wm.openSentinelList()}
            onWikiClick={() => wm.openWiki()}
          />
        </div>

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
                  pinnedMsgIds={wm.pinnedMsgIds}
                  onPin={wm.openPinNote}
                  onUnpin={wm.unpinMessage}
                />
              </Window>
            );
          }
          if (win.kind === 'pin-note' && win.pinNote) {
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
                <PinNoteWindow note={win.pinNote} />
              </Window>
            );
          }
          if (win.kind === 'file-view' && win.filePath) {
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
                <FileViewWindow path={win.filePath} />
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
          if (win.kind === 'shell-term') {
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
                <ShellTerminalWindow />
              </Window>
            );
          }
          if (win.kind === 'sessions-list') {
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
                <SessionsWindow
                  onOpenChat={({ agent, sessionId, agentLabel }) => {
                    const agentInfo = agents.find((a) => a.name === agent);
                    wm.openChat({
                      agentName: agent,
                      sessionId,
                      agentLabel,
                      ...(agentInfo?.role ? { agentMeta: agentInfo.role.toLowerCase() } : {}),
                      ...(agentInfo?.icon ? { agentIcon: agentInfo.icon } : {}),
                    });
                  }}
                />
              </Window>
            );
          }
          if (win.kind === 'sentinel') {
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
                <SentinelWindow />
              </Window>
            );
          }
          if (win.kind === 'wiki') {
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
                <WikiWindow
                  slug={win.wikiSlug}
                  onSlugChange={(slug) => wm.setWikiSlug(win.id, slug)}
                />
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
    </FileViewProvider>
    </ActivityProvider>
  );
}
