// Desktop = the whole app surface. Background grid + radial
// gradients live in `.desktop` / `.desktop::before` / `::after` from
// the click-dummy CSS. Inside `.desktop-area` we mount: the agent
// dock (left), the live windows from the window manager, and the
// taskbar (bottom). Window manager state is owned here so dock
// clicks + taskbar focus + per-window drag/resize all coordinate.

import { useMemo } from 'react';
import { Bell, BookOpen, ImagePlus, MessagesSquare, Square, Terminal, Wrench } from 'lucide-react';
import { DesktopIcons, type DesktopIcon } from './DesktopIcons';
import { AgentTile } from './AgentTile';
import { AppTile } from './AppTile';
import { Taskbar } from './Taskbar';
import { Window } from './Window';
import { ChatWindow } from './ChatWindow';
import { TmuxListWindow } from './TmuxListWindow';
import { TmuxTerminalWindow } from './TmuxTerminalWindow';
import { ShellTerminalWindow } from './ShellTerminalWindow';
import { SessionsWindow } from './SessionsWindow';
import { SentinelWindow } from './SentinelWindow';
import { WikiWindow } from './WikiWindow';
import { ToolsWindow } from './ToolsWindow';
import { MediaWindow } from './MediaWindow';
import { PinNoteWindow } from './PinNoteWindow';
import { FileViewWindow } from './FileViewWindow';
import { FileViewProvider } from './FileViewContext';
import { useChatContext } from './ChatProvider';
import { useAgents } from '../hooks/useAgents';
import { useDreamStates } from '../hooks/useDreamStates';
import { useLoopState } from '../hooks/useLoopState';
import { useWindowManager } from '../hooks/useWindowManager';
import { useActivityStream } from '../hooks/useActivityStream';
import { useWikiEnabled } from '../hooks/useWikiEnabled';
import { useMediaEnabled } from '../hooks/useMediaEnabled';
import { ActivityProvider } from './ActivityProvider';
import type { AgentInfo } from '../lib/api';
import { resolveAgentColor } from '../lib/colors';

export function Desktop() {
  const { agents, loading, error } = useAgents();
  const loopState = useLoopState();
  const dreamStates = useDreamStates();
  const wm = useWindowManager();
  const chatCtx = useChatContext();
  const wikiEnabled = useWikiEnabled();
  const media = useMediaEnabled();

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

  // Apps whose window is open — drives the .active highlight, same as
  // activeAgentIds does for agents.
  const activeApps = new Set(
    wm.windows.flatMap((w) => {
      if (w.kind === 'tmux-list') return ['tmux'];
      if (w.kind === 'sessions-list') return ['sessions'];
      if (w.kind === 'sentinel') return ['sentinel'];
      if (w.kind === 'wiki') return ['wiki'];
      if (w.kind === 'tools') return ['tools'];
      if (w.kind === 'images') return ['images'];
      return [];
    }),
  );

  const lucidPending = dreamStates?.lucid.pendingFindings ?? 0;
  const lucidOldestPendingAt = dreamStates?.lucid.oldestPendingAt;

  // One flat icon list — agents first, then apps. That is only the
  // DEFAULT placement (fills the left column top-down, i.e. the old
  // dock); each icon keeps whatever cell the user drags it to, and
  // agents/apps are freely interleavable (see DesktopIcons.tsx).
  const desktopIcons: DesktopIcon[] = [
    ...agents.map((agent) => ({
      id: `agent:${agent.name}`,
      node: (
        <AgentTile
          agent={agent}
          onClick={handleAgentClick}
          offline={!!error}
          streaming={streamingAgents.has(agent.name)}
          unread={activity.unreadAgents.has(agent.name)}
          loopHolder={loopState.active ? loopState.agent : null}
          active={activeAgentIds.has(agent.name)}
          {...(dreamStates ? { dreamStates } : {})}
        />
      ),
    })),
    {
      id: 'app:tmux',
      node: (
        <AppTile
          label="tmux"
          icon={<Terminal size={28} />}
          active={activeApps.has('tmux')}
          onClick={() => wm.openTmuxList()}
        />
      ),
    },
    {
      id: 'app:terminal',
      node: (
        <AppTile
          label="terminal"
          icon={<Square size={26} strokeWidth={1.5} />}
          // Non-singleton: every click spawns another independent
          // terminal window, so the tile never shows an active state.
          active={false}
          onClick={() => wm.openShellTerm()}
        />
      ),
    },
    {
      id: 'app:sessions',
      node: (
        <AppTile
          label="sessions"
          icon={<MessagesSquare size={26} />}
          active={activeApps.has('sessions')}
          onClick={() => wm.openSessionsList()}
        />
      ),
    },
    {
      id: 'app:sentinel',
      node: (
        <AppTile
          label="sentinel"
          icon={<Bell size={26} />}
          active={activeApps.has('sentinel')}
          onClick={() => wm.openSentinelList()}
        />
      ),
    },
    {
      id: 'app:tools',
      node: (
        <AppTile
          label="tools"
          icon={<Wrench size={26} />}
          active={activeApps.has('tools')}
          onClick={() => wm.openTools()}
        />
      ),
    },
    // Hidden unless imageGen is configured — same probe-driven gate as
    // the wiki tile below.
    ...(media.any
      ? [
          {
            id: 'app:images',
            node: (
              <AppTile
                label="media"
                icon={<ImagePlus size={26} />}
                active={activeApps.has('images')}
                onClick={() => wm.openImages()}
              />
            ),
          },
        ]
      : []),
    // Lucid is platform-wide wiki cleanup, so its pending-review badge
    // lives on the wiki tile and not on any single agent (2026-07-29
    // feedback: pending lucid runs were invisible in the UI).
    ...(wikiEnabled
      ? [
          {
            id: 'app:wiki',
            node: (
              <AppTile
                label="wiki"
                icon={<BookOpen size={26} />}
                active={activeApps.has('wiki')}
                onClick={() => wm.openWiki()}
                {...(lucidPending > 0
                  ? {
                      badge: (
                        <span
                          className="rem-badge lucid"
                          title={
                            `${lucidPending} lucid finding${lucidPending === 1 ? '' : 's'} ` +
                            `awaiting review${
                              lucidOldestPendingAt
                                ? ` (oldest run from ${lucidOldestPendingAt.slice(0, 10)})`
                                : ''
                            } — review with any agent via dream_review`
                          }
                        >
                          {lucidPending > 9 ? '9+' : lucidPending}
                        </span>
                      ),
                    }
                  : {})}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <ActivityProvider value={activity}>
    <FileViewProvider open={wm.openFileView}>
    <div className="desktop">
      <div className="desktop-area">
        <DesktopIcons icons={desktopIcons} loading={loading} error={error} />

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
          if (win.kind === 'images') {
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
                <MediaWindow />
              </Window>
            );
          }
          if (win.kind === 'tools') {
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
                <ToolsWindow />
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
