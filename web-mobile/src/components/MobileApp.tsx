// Root component of the somora mobile PWA. Owns the active-agent
// state AND the chat-stream hook so it's instantiated exactly once
// per active agent (no duplicate SSE subscriptions in children).

import { useEffect, useState } from 'react';
import { AvatarRow } from './AvatarRow';
import { ChatArea } from './ChatArea';
import { MessageInput } from './MessageInput';
import { useAgents } from '../hooks/useAgents';
import { useLastAgent } from '../hooks/useLastAgent';
import { useChatStream } from '../hooks/useChatStream';
import { useDreamStates } from '../hooks/useDreamStates';
import { useActivityStream } from '../hooks/useActivityStream';
import { Koala } from './Koala';

export function MobileApp() {
  const { agents, loading, error } = useAgents();
  const [lastAgent, setLastAgent] = useLastAgent();
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const chat = useChatStream(activeAgent);
  // Poll /dream-states every 30s for the avatar-row pulse + REM badge.
  // Empty defaults until the first response lands.
  const dreamStates = useDreamStates();
  // Cross-agent activity: streaming dots on inactive agents + unread
  // badges for any session with movement since the user last looked.
  const activity = useActivityStream(agents);

  // Auto-mark the active agent's main session as seen whenever the
  // user switches to it. Other clients will clear their badge live
  // via the broadcast. Dep is `postSeen` only (useCallback-stable),
  // not the whole `activity` object — its `unreadAgents` / `marks`
  // churn on every server tick.
  const postSeen = activity.postSeen;
  useEffect(() => {
    if (!activeAgent) return;
    postSeen(activeAgent, 'main');
  }, [activeAgent, postSeen]);

  // Foreground/visibility change: tapping back into the app counts as
  // "looking" — re-fire seen on the active session so a desktop sibling
  // that handled a turn while phone was backgrounded doesn't keep
  // showing the badge on the mobile side.
  useEffect(() => {
    if (!activeAgent) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        postSeen(activeAgent, 'main');
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [activeAgent, postSeen]);

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

  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <span className="mobile-header-mark">
          <Koala size={26} />
        </span>
        <span className="mobile-header-title">
          {activeAgent ?? 'somora'}
        </span>
        <span className="mobile-header-meta">main</span>
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
              marginLeft: 'auto',
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

      {error && <div className="banner error">{error}</div>}
      {loading && agents.length === 0 && (
        <div className="banner info">Lade agents…</div>
      )}

      <AvatarRow
        agents={agents}
        activeAgent={activeAgent}
        onSelect={switchAgent}
        streamingAgents={mergeStreaming(activity.streamingAgents, chat.streaming ? activeAgent : null)}
        unreadAgents={activity.unreadAgents}
        dreamStates={dreamStates}
      />

      {activeAgent ? (
        <>
          <ChatArea
            agent={activeAgent}
            agents={agents}
            messages={chat.messages}
            connectionError={chat.connectionError}
            streaming={chat.streaming}
            onAbort={() => void chat.abort()}
          />
          <MessageInput
            agent={activeAgent}
            onSend={chat.send}
            autoPlayEnabled={autoPlay}
          />
        </>
      ) : (
        <div className="chat-empty">
          {agents.length === 0 && !loading
            ? 'Keine agents auf diesem somora konfiguriert.'
            : 'Wähle einen agent oben.'}
        </div>
      )}
    </div>
  );
}
