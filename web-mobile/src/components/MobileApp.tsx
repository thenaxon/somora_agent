// Root component of the somora mobile PWA. Owns the active-agent
// state AND the chat-stream hook so it's instantiated exactly once
// per active agent (no duplicate SSE subscriptions in children).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AvatarRow } from './AvatarRow';
import { ChatArea } from './ChatArea';
import { MessageInput } from './MessageInput';
import { useAgents } from '../hooks/useAgents';
import { useLastAgent } from '../hooks/useLastAgent';
import { useChatStream } from '../hooks/useChatStream';
import { useDreamStates } from '../hooks/useDreamStates';
import { useActivityStream } from '../hooks/useActivityStream';
import { Koala } from './Koala';
import { useWakeLock } from '../hooks/useWakeLock';
import { WorkBadge, WorkSheet } from './WorkSheet';
import { useSessionWork, type WorkItemDto } from '../hooks/useSessionWork';
import { useSessionModel } from '../hooks/useSessionModel';
import { SessionSheet } from './SessionSheet';
import { sessionKey } from '../hooks/useActivityStream';
import { MAIN_SESSION, labelForRef, modelLabel, readLastSession, writeLastSession, type OpenSession } from '../hooks/session-pick';
import type { SessionSummary } from '../../../web/src/lib/api';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function MobileApp() {
  const { agents, loading, error } = useAgents();
  const [lastAgent, setLastAgent] = useLastAgent();
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  // The session each agent is open in. An agent opens where it was
  // left on this phone (localStorage), main otherwise.
  const [openSessions, setOpenSessions] = useState<Record<string, OpenSession>>({});
  const session = useMemo<OpenSession>(
    () => (activeAgent ? openSessions[activeAgent] ?? readLastSession(storage(), activeAgent) : MAIN_SESSION),
    [activeAgent, openSessions],
  );
  const pickSession = useCallback((agentName: string, next: OpenSession) => {
    setOpenSessions((prev) => ({ ...prev, [agentName]: next }));
    writeLastSession(storage(), agentName, next);
  }, []);
  const chat = useChatStream(activeAgent, session.id);
  const sessionModel = useSessionModel(activeAgent, session.id, chat.subscribeModelEvents);
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);

  // A remembered session may be gone (archived from the desktop), and a
  // jump from the work sheet knows the session only by its reference:
  // check against the agent's list, fall back to main, settle the name.
  useEffect(() => {
    if (!activeAgent || session.id === 'main') return;
    let cancelled = false;
    const agentName = activeAgent;
    const ref = session.id;
    fetch(`/agents/${encodeURIComponent(agentName)}/sessions`)
      .then((r) => (r.ok ? (r.json() as Promise<SessionSummary[]>) : null))
      .then((list) => {
        // No answer = no verdict; the session stays as it is.
        if (cancelled || !list) return;
        const hit = list.find((s) => s.id === ref) ?? list.find((s) => s.slug === ref);
        if (!hit) pickSession(agentName, MAIN_SESSION);
        else if (hit.id !== ref || hit.slug !== session.slug) pickSession(agentName, { id: hit.id, slug: hit.slug });
      })
      .catch(() => {
        /* offline — keep showing what we have */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgent, session.id]);
  // A recalled queued message travels ChatArea → recall() → here → the
  // composer. MessageInput owns its draft state, so the hand-over is a
  // nonce'd prop rather than lifting the whole draft up.
  const [draftInject, setDraftInject] = useState<{ text: string; nonce: number } | null>(null);
  // Work queue (header badge + bottom sheet): the /work snapshot of the
  // open session, refetched on queue-moving SSE events
  // and every 3 s while the sheet is open.
  const [workOpen, setWorkOpen] = useState(false);
  const { work, refresh: refreshWork } = useSessionWork(activeAgent, session.id, chat.subscribeTurnEvents, workOpen);
  useEffect(() => {
    setWorkOpen(false);
    setSessionSheetOpen(false);
  }, [activeAgent, session.id]);
  // × on a waiting entry: any kind, by ledger id. A person's text goes
  // back into the composer, as the bubble's "↩ edit" does.
  const removeWorkItem = async (item: WorkItemDto): Promise<string | null> => {
    if (!item.id) return 'This entry has no id — an older server queued it';
    const r = await chat.dequeueWork(item.id);
    refreshWork();
    if (!r.ok) return r.note;
    if (item.kind === 'human' && r.text) setDraftInject({ text: r.text, nonce: Date.now() });
    return null;
  };
  // ■ on a running "From here" entry: a sub-agent task through
  // /spawn-cancel (no requesting_agent = the person; cascades), an
  // agent_ask through the abort of its target's turn.
  const stopChildItem = async (item: WorkItemDto): Promise<string | null> => {
    if (!item.id) return 'This entry has no id — an older server queued it';
    try {
      if (item.kind === 'subagent') {
        const res = await fetch('/spawn-cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: item.id }),
        });
        refreshWork();
        if (res.ok) return null;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return body.error ?? `Could not stop it (HTTP ${res.status})`;
      }
      if (!item.target) return 'This entry has no target session to stop';
      const res = await fetch(
        `/chat/abort?agent=${encodeURIComponent(item.target.agent)}&session=${encodeURIComponent(item.target.session)}`,
        { method: 'POST' },
      );
      refreshWork();
      if (!res.ok) return `Could not stop it (HTTP ${res.status})`;
      const body = (await res.json().catch(() => ({}))) as { aborted?: boolean };
      return body.aborted ? null : 'Nothing was running there any more';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  // Poll /dream-states every 30s for the avatar-row pulse + REM badge.
  // Empty defaults until the first response lands.
  const dreamStates = useDreamStates();
  // Cross-agent activity: streaming dots on inactive agents + unread
  // badges for any session with movement since the user last looked.
  const activity = useActivityStream(agents);

  // Auto-mark the open session as seen whenever the user switches to
  // it. Other clients will clear their badge live
  // via the broadcast. Dep is `postSeen` only (useCallback-stable),
  // not the whole `activity` object — its `unreadAgents` / `marks`
  // churn on every server tick.
  const postSeen = activity.postSeen;
  useEffect(() => {
    if (!activeAgent) return;
    postSeen(activeAgent, session.id);
  }, [activeAgent, session.id, postSeen]);

  // An answer that lands while the session is on screen has been seen.
  const subscribeTurnEvents = chat.subscribeTurnEvents;
  useEffect(() => {
    if (!activeAgent) return;
    return subscribeTurnEvents((event) => {
      if (event === 'turn_end' && document.visibilityState === 'visible') postSeen(activeAgent, session.id);
    });
  }, [activeAgent, session.id, postSeen, subscribeTurnEvents]);

  // Foreground/visibility change: tapping back into the app counts as
  // "looking" — re-fire seen on the active session so a desktop sibling
  // that handled a turn while phone was backgrounded doesn't keep
  // showing the badge on the mobile side.
  useEffect(() => {
    if (!activeAgent) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        postSeen(activeAgent, session.id);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [activeAgent, session.id, postSeen]);

  // Voice: TTS availability + per-agent (== per "main" session) auto-
  // play toggle. Sticky in localStorage; seeded from /tts/config the
  // first time the agent is opened.
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(false);
  const [autoPlayAllowOverride, setAutoPlayAllowOverride] = useState<boolean>(true);
  const [autoPlayDefault, setAutoPlayDefault] = useState<boolean>(false);
  const [autoPlay, setAutoPlay] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/tts/config')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d: {
        enabled?: boolean;
        clients?: {
          mobile?: { autoPlayVoiceReplies?: boolean; allowUserOverride?: boolean };
        };
      }) => {
        if (cancelled) return;
        const enabled = Boolean(d.enabled);
        setTtsEnabled(enabled);
        if (!enabled) return;
        const policy = d.clients?.mobile ?? {};
        setAutoPlayAllowOverride(policy.allowUserOverride !== false);
        setAutoPlayDefault(Boolean(policy.autoPlayVoiceReplies));
      })
      .catch(() => {
        if (!cancelled) setTtsEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-agent sticky toggle: read whenever active agent changes.
  useEffect(() => {
    if (!ttsEnabled || !activeAgent) return;
    const key = `somora.mobile.voice.autoPlay.${activeAgent}`;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === '1' || stored === '0') setAutoPlay(stored === '1');
      else setAutoPlay(autoPlayDefault);
    } catch {
      setAutoPlay(autoPlayDefault);
    }
  }, [activeAgent, ttsEnabled, autoPlayDefault]);
  useEffect(() => {
    if (!ttsEnabled || !activeAgent) return;
    const key = `somora.mobile.voice.autoPlay.${activeAgent}`;
    try {
      window.localStorage.setItem(key, autoPlay ? '1' : '0');
    } catch {
      /* localStorage unavailable — drop silently */
    }
  }, [autoPlay, activeAgent, ttsEnabled]);

  // Auto-play hook: assistant_audio arrives + toggle on ⇒ play.
  useEffect(() => {
    if (!ttsEnabled) return;
    const unsub = chat.subscribeAudio((url) => {
      if (!autoPlay) return;
      try {
        const audio = new Audio(url);
        void audio.play();
      } catch {
        /* autoplay blocked / audio init fail — silent */
      }
    });
    return unsub;
  }, [ttsEnabled, autoPlay, chat]);

  useEffect(() => {
    if (activeAgent || agents.length === 0) return;
    const fromLast = lastAgent && agents.find((a) => a.name === lastAgent)
      ? lastAgent
      : null;
    setActiveAgent(fromLast ?? agents[0]!.name);
  }, [agents, lastAgent, activeAgent]);

  const switchAgent = (name: string) => {
    setActiveAgent(name);
    setLastAgent(name);
  };

  // Local-only union: activity SSE knows about turns started server-
  // wide; the optimistic `chat.streaming` from the active session may
  // toggle on a fraction of a millisecond before the activity event
  // round-trips. Union ensures the active agent's dot lights instantly.
  function mergeStreaming(serverSet: Set<string>, localActive: string | null): Set<string> {
    if (!localActive) return serverSet;
    if (serverSet.has(localActive)) return serverSet;
    const out = new Set(serverSet);
    out.add(localActive);
    return out;
  }

  // The dot on an avatar: something unread in any session of that agent
  // — except the one on screen right now.
  const openKey = activeAgent ? sessionKey(activeAgent, session.id) : null;
  const unreadAgentsShown = useMemo(() => {
    const out = new Set<string>();
    for (const k of activity.unreadSessions) {
      if (k === openKey) continue;
      out.add(k.slice(0, k.indexOf('::')));
    }
    return out;
  }, [activity.unreadSessions, openKey]);

  // Header model: what the session is set to — or, when a backup model
  // answered the last turn, that one (in the warning colour).
  const lastAgentMessage = [...chat.messages].reverse().find((m) => m.role === 'agent');
  // Only while it still says something about the model in use: after a
  // switch to another model the last turn's stand-in is history.
  const info = sessionModel.info;
  const lastFallback = lastAgentMessage?.fallback ?? null;
  const fallback =
    lastFallback && (!info || lastFallback.requested === `${info.provider}/${info.modelId}` || lastFallback.requested === info.alias)
      ? lastFallback
      : null;
  const headerModel = fallback ? labelForRef(fallback.actual, []) : modelLabel(sessionModel.info);

  // Keep the screen awake while the app is open. Sticky per browser;
  // the hook re-acquires the lock every time the app comes back to the
  // foreground, because the browser drops it whenever the page hides.
  const wakeLock = useWakeLock();

  // A broken config.yaml: the server keeps the last valid version and
  // edits do nothing — say so on the phone too. Checked on start, when
  // the app comes back to the front, and every minute.
  const [configProblem, setConfigProblem] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch('/config/status')
        .then((r) => (r.ok ? (r.json() as Promise<{ invalid?: unknown }>) : null))
        .then((d) => {
          if (alive && d) setConfigProblem(Boolean(d.invalid));
        })
        .catch(() => undefined);
    void check();
    const t = setInterval(check, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <span className="mobile-header-mark">
          <Koala size={24} />
        </span>
        {activeAgent ? (
          <button
            type="button"
            className="mobile-header-pick"
            onClick={() => {
              setWorkOpen(false);
              setSessionSheetOpen((v) => !v);
            }}
            aria-haspopup="dialog"
            aria-expanded={sessionSheetOpen}
            aria-label={`${activeAgent}, session ${session.slug}${headerModel ? `, model ${headerModel}` : ''} — switch session or model`}
          >
            <span className="mobile-header-title">
              {activeAgent}
              <span className="mobile-header-session"> · {session.slug}</span>
            </span>
            <span className="mobile-header-caret" aria-hidden="true">▾</span>
            {headerModel && (
              <span
                className={`mobile-header-model ${fallback ? 'fallback' : ''}`}
                title={fallback ? `${fallback.requested} did not answer — ${fallback.actual} stepped in` : undefined}
              >
                {fallback ? `⇄ ${headerModel}` : headerModel}
              </span>
            )}
          </button>
        ) : (
          <span className="mobile-header-title">somora</span>
        )}
        <WorkBadge work={work} open={workOpen} onToggle={() => {
          if (!workOpen) refreshWork();
          setSessionSheetOpen(false);
          setWorkOpen((v) => !v);
        }} />
        {!wakeLock.unsupported && (
          <button
            type="button"
            onClick={() => wakeLock.setEnabled(!wakeLock.enabled)}
            aria-label={wakeLock.enabled ? 'keep screen awake: on' : 'keep screen awake: off'}
            title={
              wakeLock.unreliable
                ? 'keep the screen awake — your iOS is older than 18.4, where Apple fixed this for home-screen web apps, so it may sleep anyway'
                : wakeLock.enabled
                  ? wakeLock.active
                    ? 'screen stays awake while this app is open'
                    : 'screen stays awake once you touch the app'
                  : 'screen sleeps as usual'
            }
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid var(--border-2, #444)',
              borderRadius: 6,
              padding: '4px 8px',
              color: wakeLock.enabled ? 'var(--accent, #6cf)' : 'var(--text-2, #888)',
              opacity: wakeLock.enabled && wakeLock.unreliable ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
            }}
          >
            <span aria-hidden="true">{wakeLock.enabled ? '☀️' : '🌙'}</span>
          </button>
        )}
        {ttsEnabled && autoPlayAllowOverride && activeAgent && (
          <button
            type="button"
            onClick={() => setAutoPlay((v) => !v)}
            aria-label={autoPlay ? 'voice auto-play on' : 'voice auto-play off'}
            title={
              autoPlay
                ? 'voice auto-play on (mic input ⇒ spoken reply)'
                : 'voice auto-play off (mic input ⇒ text only)'
            }
            style={{
              marginLeft: wakeLock.unsupported ? 'auto' : 6,
              background: 'transparent',
              border: '1px solid var(--border-2, #444)',
              borderRadius: 6,
              padding: '4px 8px',
              color: autoPlay ? 'var(--accent, #6cf)' : 'var(--text-2, #888)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
            }}
          >
            <span aria-hidden="true">{autoPlay ? '🔊' : '🔇'}</span>
          </button>
        )}
      </header>

      <WorkSheet
        open={workOpen}
        onClose={() => setWorkOpen(false)}
        work={work}
        onStop={() => void chat.abort()}
        onRemove={removeWorkItem}
        onStopChild={stopChildItem}
        canOpenSession={(agentName) => agents.some((a) => a.name === agentName)}
        onOpenSession={(agentName, sessionRef) => {
          // A child in any session of an agent this phone knows is one
          // tap away. The reference may be an id or a name — the check
          // against the agent's list settles which.
          if (!agents.some((a) => a.name === agentName)) return false;
          pickSession(agentName, sessionRef === 'main' ? MAIN_SESSION : { id: sessionRef, slug: sessionRef });
          switchAgent(agentName);
          return true;
        }}
      />

      {activeAgent && (
        <SessionSheet
          open={sessionSheetOpen}
          onClose={() => setSessionSheetOpen(false)}
          agent={activeAgent}
          session={session}
          unreadSessions={activity.unreadSessions}
          streamingSessions={activity.streamingSessions}
          onPick={(next) => pickSession(activeAgent, next)}
          modelInfo={sessionModel.info}
          onSetModel={sessionModel.setModel}
          streaming={chat.streaming}
        />
      )}

      {error && <div className="banner error">{error}</div>}
      {configProblem && (
        <div className="banner error" role="alert">
          config.yaml does not validate — somora keeps running on the last valid version. Fix the file (somora config check).
        </div>
      )}
      {loading && agents.length === 0 && (
        <div className="banner info">Loading agents…</div>
      )}

      <AvatarRow
        agents={agents}
        activeAgent={activeAgent}
        onSelect={switchAgent}
        streamingAgents={mergeStreaming(activity.streamingAgents, chat.streaming ? activeAgent : null)}
        unreadAgents={unreadAgentsShown}
        dreamStates={dreamStates}
      />

      {activeAgent ? (
        <>
          <ChatArea
            agent={activeAgent}
            agents={agents}
            messages={chat.messages}
            connectionError={chat.connectionError}
            statusNotice={chat.statusNotice}
            streaming={chat.streaming}
            onAbort={() => void chat.abort()}
            onRecall={(id) => {
              void chat.recall(id).then((r) => {
                if (r) setDraftInject({ text: r.text, nonce: Date.now() });
              });
            }}
          />
          <MessageInput
            agent={activeAgent}
            onSend={chat.send}
            autoPlayEnabled={autoPlay}
            streaming={chat.streaming}
            onAbort={() => void chat.abort()}
            draftInject={draftInject}
          />
        </>
      ) : (
        <div className="chat-empty">
          {agents.length === 0 && !loading
            ? 'No agents are configured on this somora.'
            : 'Pick an agent above.'}
        </div>
      )}
    </div>
  );
}
