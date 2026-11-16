// Desktop = the whole app surface. Background grid + radial
// gradients live in `.desktop` / `.desktop::before` / `::after` from
// the click-dummy CSS. Inside `.desktop-area` we mount: the agent
// dock (left), the live windows from the window manager, and the
// taskbar (bottom). Window manager state is owned here so dock
// clicks + taskbar focus + per-window drag/resize all coordinate.

import { AGENT_RENAMED_EVENT } from './RenameAgent';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, BookOpen, Globe, ImagePlus, MessagesSquare, Mic, ScrollText, Square, Terminal, Users, Wrench } from 'lucide-react';
import { DesktopIcons, type DesktopIcon } from './DesktopIcons';
import { AgentTile } from './AgentTile';
import { AgentContextMenu } from './AgentContextMenu';
import { StartMenu, type StartApp } from './StartMenu';
import { signOut } from './KeyGate';
import { readHidden, toggled, writeHidden } from '../lib/start-menu';
import { AppTile } from './AppTile';
import { Taskbar } from './Taskbar';
import { Window } from './Window';
import { ChatWindow } from './ChatWindow';
import { TmuxListWindow } from './TmuxListWindow';
import { TmuxTerminalWindow } from './TmuxTerminalWindow';
import { BrowserListWindow } from './BrowserListWindow';
import { LogsWindow } from './LogsWindow';
import { SettingsWindow } from './SettingsWindow';
import { BrowserWindow } from './BrowserWindow';
import { ShellTerminalWindow } from './ShellTerminalWindow';
import { SessionsWindow } from './SessionsWindow';
import { SentinelWindow } from './SentinelWindow';
import { WikiWindow } from './WikiWindow';
import { ToolsWindow } from './ToolsWindow';
import { TeamWindow } from './TeamWindow';
import { AgentConfigWindow } from './AgentConfigWindow';
import { ExternalAgentPanel } from './ExternalAgentPanel';
import { MediaWindow } from './MediaWindow';
import { PinNoteWindow } from './PinNoteWindow';
import { FileViewWindow } from './FileViewWindow';
import { FileViewProvider } from './FileViewContext';
import { useStreamingKeys } from './ChatProvider';
import { useAgents } from '../hooks/useAgents';
import { useDreamStates } from '../hooks/useDreamStates';
import { useLoopState } from '../hooks/useLoopState';
import { useWindowManager } from '../hooks/useWindowManager';
import { useActivityStream } from '../hooks/useActivityStream';
import { useWikiEnabled } from '../hooks/useWikiEnabled';
import { useMediaEnabled } from '../hooks/useMediaEnabled';
import { useBrowsers } from './BrowserProvider';
import { useVoiceEnabled } from '../hooks/useVoiceEnabled';
import { VoiceWindow } from './VoiceWindow';
import { ActivityProvider } from './ActivityProvider';
import type { AgentInfo } from '../lib/api';
import { resolveAgentColor } from '../lib/colors';

export function Desktop() {
  const { agents, loading, error } = useAgents();
  const loopState = useLoopState();
  const dreamStates = useDreamStates();
  const wm = useWindowManager();
  // An agent was renamed (RenameAgent): close its windows, then reload so
  // the agent list, tiles and saved layout use the new name.
  useEffect(() => {
    const onRenamed = (e: Event) => {
      const { from } = (e as CustomEvent<{ from: string; to: string }>).detail;
      for (const w of wm.windows) if (w.agentName === from) wm.close(w.id);
      setTimeout(() => window.location.reload(), 300);
    };
    window.addEventListener(AGENT_RENAMED_EVENT, onRenamed);
    return () => window.removeEventListener(AGENT_RENAMED_EVENT, onRenamed);
  }, [wm]);
  const streamingKeys = useStreamingKeys();
  const wikiEnabled = useWikiEnabled();
  const media = useMediaEnabled();
  const voice = useVoiceEnabled();
  const browserState = useBrowsers();
  const browserEnabled = browserState.enabled;
  const browserWaiting = browserState.browsers.filter((b) => b.handoff);
  // Saved layouts outlive the agents in them. Once the server has
  // actually answered (not loading, not offline), chat windows for
  // agents it does not serve are dropped — otherwise they linger
  // invisible, because the render below skips them, while still taking
  // up a slot in Arrange.
  const { dropOrphanChats } = wm;
  useEffect(() => {
    if (loading || error) return;
    dropOrphanChats(new Set(agents.map((a) => a.name)));
  }, [agents, loading, error, dropOrphanChats]);

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
    const own = streamingKeys.map((k) => k.split('::')[0]!);
    const merged = new Set<string>(own);
    for (const a of activity.streamingAgents) merged.add(a);
    return merged;
  }, [streamingKeys, activity.streamingAgents]);

  /** Chat + task panel side by side: the panel folds below 640 px. */
  const BUILDER_WINDOW_SIZE = { w: 960, h: 620 };
  function openAgentSession(agent: AgentInfo, sessionId: string, label: string) {
    wm.openChat({
      agentName: agent.name,
      sessionId,
      agentLabel: `${agent.name} · ${label}`,
      ...(agent.role ? { agentMeta: agent.role.toLowerCase() } : {}),
      ...(agent.icon ? { agentIcon: agent.icon } : {}),
      ...(agent.kind === 'builder' ? { size: BUILDER_WINDOW_SIZE } : {}),
    });
  }

  function handleAgentClick(agent: AgentInfo) {
    openAgentSession(agent, 'main', 'main');
  }

  // Right-click on an agent tile → its context menu (Open main / recent
  // sessions / New session… / All sessions…). One menu at a time; the
  // menu closes itself on outside press, Esc, resize.
  const [agentMenu, setAgentMenu] = useState<{ agent: AgentInfo; x: number; y: number } | null>(null);

  // Start menu (koala in the taskbar) and the tiles taken off the
  // desktop — per browser, like the tile positions.
  const [startOpen, setStartOpen] = useState(false);
  const [startAnchor, setStartAnchor] = useState<HTMLElement | null>(null);
  const [hiddenTiles, setHiddenTiles] = useState<Set<string>>(readHidden);
  function toggleDesktop(id: string) {
    setHiddenTiles((prev) => {
      const next = toggled(prev, id);
      writeHidden(next);
      return next;
    });
  }
  const closeStart = useCallback(() => setStartOpen(false), []);
  const closeAgentMenu = useCallback(() => setAgentMenu(null), []);

  function handleAgentContextMenu(agent: AgentInfo, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setAgentMenu({ agent, x: e.clientX, y: e.clientY });
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
      if (w.kind === 'browser-list' || w.kind === 'browser') return ['browser'];
      if (w.kind === 'sessions-list') return ['sessions'];
      if (w.kind === 'sentinel') return ['sentinel'];
      if (w.kind === 'wiki') return ['wiki'];
      if (w.kind === 'tools') return ['tools'];
      if (w.kind === 'images') return ['images'];
      if (w.kind === 'team') return ['team'];
      return [];
    }),
  );

  const lucidPending = dreamStates?.lucid.pendingFindings ?? 0;
  const lucidOldestPendingAt = dreamStates?.lucid.oldestPendingAt;

  // One flat icon list — agents first, then apps. That is only the
  // DEFAULT placement (fills the left column top-down, i.e. the old
  // dock); each icon keeps whatever cell the user drags it to, and
  // agents/apps are freely interleavable (see DesktopIcons.tsx).
  // Every app once, for the desktop tiles and the start menu alike — an
  // app added here shows up in both. Optional apps only when enabled.
  const lucidTitle =
    `${lucidPending} lucid finding${lucidPending === 1 ? '' : 's'} awaiting review` +
    (lucidOldestPendingAt ? ` (oldest run from ${lucidOldestPendingAt.slice(0, 10)})` : '') +
    ' — review with any agent via dream_review';
  const apps: Array<StartApp & { tileGlyph: React.ReactNode }> = [
    { id: 'app:tmux', label: 'tmux', glyph: <Terminal size={15} />, tileGlyph: <Terminal size={28} />, active: activeApps.has('tmux'), open: () => wm.openTmuxList() },
    // Non-singleton: every click spawns another independent terminal
    // window, so it never shows an active state.
    { id: 'app:terminal', label: 'terminal', glyph: <Square size={14} strokeWidth={1.5} />, tileGlyph: <Square size={26} strokeWidth={1.5} />, active: false, open: () => wm.openShellTerm() },
    { id: 'app:sessions', label: 'sessions', glyph: <MessagesSquare size={14} />, tileGlyph: <MessagesSquare size={26} />, active: activeApps.has('sessions'), open: () => wm.openSessionsList() },
    { id: 'app:sentinel', label: 'sentinel', glyph: <Bell size={14} />, tileGlyph: <Bell size={26} />, active: activeApps.has('sentinel'), open: () => wm.openSentinelList() },
    { id: 'app:tools', label: 'abilities', glyph: <Wrench size={14} />, tileGlyph: <Wrench size={26} />, active: activeApps.has('tools'), open: () => wm.openTools() },
    { id: 'app:team', label: 'team', glyph: <Users size={14} />, tileGlyph: <Users size={26} />, active: activeApps.has('team'), open: () => wm.openTeam() },
    { id: 'app:logs', label: 'log', glyph: <ScrollText size={14} />, tileGlyph: <ScrollText size={26} />, active: activeApps.has('logs'), open: () => wm.openLogs() },
    // Realtime voice — only when a provider is configured AND at least
    // one agent may be called.
    ...(voice.enabled
      ? [{ id: 'app:voice', label: 'voice', glyph: <Mic size={14} />, tileGlyph: <Mic size={26} />, active: activeApps.has('voice'), open: () => wm.openVoice() }]
      : []),
    // Shared browser (docs/browser.md) — only when browser.enabled.
    ...(browserEnabled
      ? [
          {
            id: 'app:browser',
            label: 'browser',
            glyph: <Globe size={14} color={browserWaiting.length ? 'var(--warn, #d29922)' : undefined} />,
            tileGlyph: <Globe size={26} color={browserWaiting.length ? 'var(--warn, #d29922)' : undefined} />,
            active: activeApps.has('browser'),
            open: () => wm.openBrowserList(),
          },
        ]
      : []),
    // Only when imageGen/videoGen is configured — probe-driven, like wiki.
    ...(media.any
      ? [{ id: 'app:images', label: 'media', glyph: <ImagePlus size={14} />, tileGlyph: <ImagePlus size={26} />, active: activeApps.has('images'), open: () => wm.openImages() }]
      : []),
    // Lucid is platform-wide wiki cleanup, so its pending-review badge
    // lives on the wiki and not on any single agent (2026-07-29
    // feedback: pending lucid runs were invisible in the UI).
    ...(wikiEnabled
      ? [
          {
            id: 'app:wiki',
            label: 'wiki',
            glyph: <BookOpen size={14} />,
            tileGlyph: <BookOpen size={26} />,
            active: activeApps.has('wiki'),
            open: () => wm.openWiki(),
            ...(lucidPending > 0 ? { badge: lucidPending } : {}),
          },
        ]
      : []),
  ];

  // One flat icon list — agents first, then apps. That is only the
  // DEFAULT placement (fills the left column top-down, i.e. the old
  // dock); each icon keeps whatever cell the user drags it to, and
  // agents/apps are freely interleavable (see DesktopIcons.tsx). Tiles
  // taken off the desktop (start menu, agent menu) are left out; their
  // cell is kept for when they come back.
  const desktopIcons: DesktopIcon[] = [
    ...agents.map((agent) => ({
      id: `agent:${agent.name}`,
      node: (
        <AgentTile
          agent={agent}
          onClick={handleAgentClick}
          onContextMenu={handleAgentContextMenu}
          offline={!!error}
          streaming={streamingAgents.has(agent.name)}
          unread={activity.unreadAgents.has(agent.name)}
          loopHolder={loopState.active ? loopState.agent : null}
          active={activeAgentIds.has(agent.name)}
          {...(dreamStates ? { dreamStates } : {})}
        />
      ),
    })),
    ...apps.map((app) => ({
      id: app.id,
      node: (
        <AppTile
          label={app.label}
          icon={app.tileGlyph}
          active={app.active}
          onClick={app.open}
          {...(app.badge
            ? {
                badge: (
                  <span className="rem-badge lucid" title={lucidTitle}>
                    {app.badge > 9 ? '9+' : app.badge}
                  </span>
                ),
              }
            : {})}
        />
      ),
    })),
  ].filter((icon) => !hiddenTiles.has(icon.id));

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
                onToggleMaximize={wm.toggleMaximize}
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
                  onOpenBrowser={wm.openBrowser}
                  onOpenSession={(agentName, sessionId) => {
                    const target = agents.find((a) => a.name === agentName);
                    if (!target) return;
                    openAgentSession(target, sessionId, sessionId === 'main' ? 'main' : sessionId);
                  }}
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
                onToggleMaximize={wm.toggleMaximize}
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
                onToggleMaximize={wm.toggleMaximize}
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
                onToggleMaximize={wm.toggleMaximize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <TmuxListWindow onAttach={(tmuxName) => wm.openTmuxTerm(tmuxName)} />
              </Window>
            );
          }
          if (win.kind === 'voice') {
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onToggleMaximize={wm.toggleMaximize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <VoiceWindow agents={agents} />
              </Window>
            );
          }
          if (win.kind === 'settings') {
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onToggleMaximize={wm.toggleMaximize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <SettingsWindow />
              </Window>
            );
          }
          if (win.kind === 'logs') {
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onToggleMaximize={wm.toggleMaximize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <LogsWindow />
              </Window>
            );
          }
          if (win.kind === 'browser-list') {
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onToggleMaximize={wm.toggleMaximize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <BrowserListWindow onOpen={(viewId, title) => wm.openBrowser(viewId, title)} />
              </Window>
            );
          }
          if (win.kind === 'browser' && win.browserViewId) {
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onToggleMaximize={wm.toggleMaximize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <BrowserWindow viewId={win.browserViewId} />
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
                onToggleMaximize={wm.toggleMaximize}
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
                onToggleMaximize={wm.toggleMaximize}
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
                onToggleMaximize={wm.toggleMaximize}
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
                      ...(agentInfo?.kind === 'builder' ? { size: BUILDER_WINDOW_SIZE } : {}),
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
                onToggleMaximize={wm.toggleMaximize}
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
                onToggleMaximize={wm.toggleMaximize}
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
                onToggleMaximize={wm.toggleMaximize}
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
                onToggleMaximize={wm.toggleMaximize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <ToolsWindow />
              </Window>
            );
          }
          if (win.kind === 'team') {
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onToggleMaximize={wm.toggleMaximize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                <TeamWindow />
              </Window>
            );
          }
          if (win.kind === 'agent-config' && win.agentName) {
            return (
              <Window
                key={win.id}
                win={win}
                focused={wm.focusedId === win.id}
                onFocus={wm.focus}
                onClose={wm.close}
                onMinimize={wm.minimize}
                onToggleMaximize={wm.toggleMaximize}
                onMove={wm.move}
                onResize={wm.resize}
              >
                {(() => {
                  const ext = agents.find((a) => a.name === win.agentName)?.external;
                  return ext ? <ExternalAgentPanel agentName={win.agentName} mark={ext} /> : <AgentConfigWindow agentName={win.agentName} />;
                })()}
              </Window>
            );
          }
          return null;
        })}
      </div>
      {agentMenu && (
        <AgentContextMenu
          agent={agentMenu.agent}
          x={agentMenu.x}
          y={agentMenu.y}
          onClose={closeAgentMenu}
          onOpenSession={(a, sessionId, label) => {
            openAgentSession(a, sessionId, label);
            setStartOpen(false);
          }}
          onOpenSessionsTool={() => {
            wm.openSessionsList();
            setStartOpen(false);
          }}
          onOpenConfig={(a) => {
            wm.openAgentConfig(a.name);
            setStartOpen(false);
          }}
          onDesktop={!hiddenTiles.has(`agent:${agentMenu.agent.name}`)}
          onToggleDesktop={() => toggleDesktop(`agent:${agentMenu.agent.name}`)}
        />
      )}
      {startOpen && (
        <StartMenu
          agents={agents.map((agent) => ({
            agent,
            working: streamingAgents.has(agent.name),
            unread: activity.unreadAgents.has(agent.name),
          }))}
          apps={apps}
          hidden={hiddenTiles}
          onToggleDesktop={toggleDesktop}
          onOpenAgent={handleAgentClick}
          onAgentMenu={(agent, x, y) => setAgentMenu({ agent, x, y })}
          onOpenSettings={wm.openSettings}
          onSignOut={() => void signOut()}
          onClose={closeStart}
          anchor={startAnchor}
        />
      )}
      <Taskbar
        onOpenBrowsers={wm.openBrowserList}
        windows={wm.windows}
        focusedId={wm.focusedId}
        agents={agents}
        onFocus={wm.focus}
        onAutoArrange={wm.autoArrange}
        onSaveLayout={wm.saveLayout}
        onRestoreLayout={wm.restoreLayout}
        onOpenSettings={wm.openSettings}
        startOpen={startOpen}
        onToggleStart={(anchor) => {
          setStartAnchor(anchor);
          setStartOpen((o) => !o);
        }}
        desktopShown={wm.desktopShown}
        onShowDesktop={wm.toggleShowDesktop}
      />
    </div>
    </FileViewProvider>
    </ActivityProvider>
  );
}
