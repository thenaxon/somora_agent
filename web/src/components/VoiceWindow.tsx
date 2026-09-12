// Talking to an agent.
//
// The window picks an agent and a session, opens one audio channel to
// somora and shows what is happening. It holds no provider knowledge,
// no key and never sees a tool call — the server owns all of that
// (Rene 2026-09-11: "logik soll im somora server stecken nicht im web
// client").
//
// Design: private/realtime-voice-design.md

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, Phone } from 'lucide-react';
import { api, type AgentInfo } from '../lib/api';
import {
  createVoicePlayer,
  startMicCapture,
  type MicCapture,
  type VoicePlayer,
} from '../lib/voice-audio';
import { VoiceOrb } from './VoiceOrb';

type CallState = 'idle' | 'connecting' | 'listening' | 'consulting' | 'speaking' | 'closed';

interface VoiceStatus {
  enabled: boolean;
  agents: string[];
  model?: string;
  maxCallMinutes?: number;
}

interface SessionOption {
  id: string;
  slug: string;
}

export function VoiceWindow({ agents }: { agents: AgentInfo[] }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [agent, setAgent] = useState<string>('');
  const [session, setSession] = useState<string>('main');
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState<Array<{ who: 'you' | 'agent'; text: string }>>([]);
  /** What is being said right now, before the sentence is final. */
  const [partial, setPartial] = useState<{ who: 'you' | 'agent'; text: string } | null>(null);
  const [consults, setConsults] = useState(0);

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<VoicePlayer | null>(null);
  /**
   * Who the window is showing, readable from inside the socket handler.
   *
   * The handler is built once, when the call is connected, and closes
   * over the `agent` of that render forever. Comparing against that
   * value silently ignored a move BACK to the agent the call started
   * with: hans → lisa → hans left the window on lisa (Rene, 2026-09-12:
   * "es bleibt auf Lisa aber man spricht dann schon mit Hans").
   */
  const shownRef = useRef<{ agent: string; session: string }>({ agent: '', session: 'main' });
  /** A handover the window has not applied yet, because the previous
   *  agent is still being heard. */
  const pendingIdentityRef = useRef<{ agent: string; session: string } | null>(null);
  const [handoverTo, setHandoverTo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/voice/status')
      .then((r) => (r.ok ? r.json() : { enabled: false, agents: [] }))
      .then((s: VoiceStatus) => {
        if (cancelled) return;
        setStatus(s);
        if (s.agents.length > 0) setAgent((a) => a || (s.agents[0] ?? ''));
      })
      .catch(() => { if (!cancelled) setStatus({ enabled: false, agents: [] }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    void api
      .sessions(agent)
      .then((list) => {
        if (cancelled) return;
        const opts = list.map((s) => ({ id: s.id, slug: s.slug || s.id }));
        setSessions(opts);
        setSession((cur) => (opts.some((o) => o.slug === cur) ? cur : (opts[0]?.slug ?? 'main')));
      })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => { cancelled = true; };
  }, [agent]);

  const hangUp = useCallback((reason: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'hangup', reason }));
    wsRef.current?.close();
    wsRef.current = null;
    micRef.current?.stop();
    micRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    setState('closed');
    setStartedAt(null);
  }, []);

  useEffect(() => () => { if (wsRef.current) hangUp('window closed'); }, [hangUp]);

  // Follow the conversation: the newest line is the one you want while
  // you are talking. Scrolling up to read stops the follow, the way it
  // does in the chat window — being yanked back mid-sentence is worse
  // than pressing End.
  useEffect(() => {
    shownRef.current = { agent, session };
  }, [agent, session]);

  useEffect(() => {
    const box = transcriptRef.current;
    if (!box) return;
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (distanceFromBottom < 80) box.scrollTop = box.scrollHeight;
  }, [transcript, partial]);

  // The meter runs while nobody speaks, so the clock belongs on screen
  // — and it turns warning-coloured well before the cap cuts the call.
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  /**
   * Take on the identity the server reports — but not while the previous
   * agent is still being heard.
   *
   * Two clocks disagree here. The server knows when the new session is
   * live; the browser knows how much of the old agent's speech is still
   * queued. Applying the change on the server's word alone put the new
   * name and colour on the old agent's last sentence. So the window
   * waits for its own queue to run dry, and shows "connecting" in the
   * meantime.
   */
  const applyIdentity = useCallback((next: { agent: string; session: string }) => {
    const shown = shownRef.current;
    if (next.agent === shown.agent && next.session === shown.session) {
      pendingIdentityRef.current = null;
      return;
    }
    pendingIdentityRef.current = next;
    const settle = () => {
      const wanted = pendingIdentityRef.current;
      if (!wanted) return;
      const left = playerRef.current?.pendingMs() ?? 0;
      if (left > 120) {
        window.setTimeout(settle, Math.min(left, 400));
        return;
      }
      pendingIdentityRef.current = null;
      shownRef.current = wanted;
      setAgent(wanted.agent);
      setSession(wanted.session);
    };
    settle();
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setTranscript([]);
    setPartial(null);
    setConsults(0);
    setState('connecting');
    setStartedAt(Date.now());
    setElapsed(0);
    try {
      // The microphone is asked for FIRST: a refused permission must
      // not leave a paid connection standing.
      const player = createVoicePlayer();
      playerRef.current = player;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${window.location.host}/voice/attach?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`,
      );
      wsRef.current = ws;
      ws.onmessage = (evt) => {
        let msg: { type?: string; base64?: string; event?: { kind?: string; text?: string; final?: boolean; message?: string }; call?: { consults?: number; state?: string; handoverTo?: string; target?: { agent?: string; slug?: string } } };
        try { msg = JSON.parse(String(evt.data)) as typeof msg; } catch { return; }
        if (msg.type === 'audio' && msg.base64) {
          playerRef.current?.play(msg.base64);
          return;
        }
        if (msg.type === 'ready') {
          setState('listening');
          return;
        }
        // The server's own state is the truth — "asking hans" is a
        // state no provider event announces.
        if (msg.type === 'state' && msg.call?.state) {
          setState(msg.call.state as CallState);
          if (typeof msg.call.consults === 'number') setConsults(msg.call.consults);
          setHandoverTo(msg.call.handoverTo ?? null);
          // The call can be moved to another agent or another session
          // mid-conversation, so the header follows the server rather
          // than the picker. Applied against a ref: the value captured
          // when this handler was built goes stale after the first move.
          const t = msg.call.target;
          if (t?.agent && t?.slug) applyIdentity({ agent: t.agent, session: t.slug });
          return;
        }
        if (msg.call && typeof msg.call.consults === 'number') setConsults(msg.call.consults);
        const ev = msg.event;
        if (!ev) return;
        switch (ev.kind) {
          case 'model_speech':
            setState((s) => (s === 'consulting' ? s : 'speaking'));
            break;
          case 'user_transcript':
            if (ev.final && ev.text) {
              setPartial(null);
              setTranscript((t) => [...t, { who: 'you', text: ev.text! }]);
            } else if (ev.text) setPartial({ who: 'you', text: ev.text });
            break;
          case 'model_transcript':
            if (ev.final && ev.text) {
              setPartial(null);
              setTranscript((t) => [...t, { who: 'agent', text: ev.text! }]);
            } else if (ev.text) {
              // Deltas arrive word by word; showing them is what makes
              // the window feel like a conversation rather than a log
              // that updates once per sentence.
              setPartial((cur) => ({ who: 'agent', text: cur?.who === 'agent' ? cur.text + ev.text! : ev.text! }));
            }
            break;
          case 'tool_call':
            setState('consulting');
            break;
          case 'interrupted':
            // What was not heard must not be played later.
            playerRef.current?.stop();
            setState('listening');
            break;
          case 'error':
            setError(ev.message ?? 'provider error');
            break;
          case 'closed':
            setState('closed');
            break;
          default:
            break;
        }
      };
      ws.onerror = () => setError('connection failed');
      ws.onclose = (evt) => {
        setState('closed');
        if (evt.reason && evt.code !== 1000) setError(evt.reason);
        micRef.current?.stop();
        micRef.current = null;
      };
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        setTimeout(() => reject(new Error('timed out')), 10_000);
      });
      // Keeps sending while nobody talks — the provider closes a turn
      // on silence, not on missing packets (measured 2026-09-11).
      micRef.current = await startMicCapture((base64) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio', base64 }));
      });
    } catch (err) {
      setError((err as Error).message);
      setState('idle');
      micRef.current?.stop();
      micRef.current = null;
      playerRef.current?.close();
      playerRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
    }
  }, [agent, session]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      micRef.current?.setMuted(!m);
      return !m;
    });
  }, []);

  const color = agents.find((a) => a.name === agent)?.color ?? 'var(--accent, #6cf)';
  const live = state === 'listening' || state === 'speaking' || state === 'consulting';
  const limitSeconds = (status?.maxCallMinutes ?? 20) * 60;
  const nearLimit = elapsed > limitSeconds * 0.75;
  const overtime = elapsed > limitSeconds * 0.92;
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  if (status && !status.enabled) {
    return (
      <div style={{ padding: 16, color: 'var(--text-2)' }}>
        Realtime voice is off. Set <code>realtimeVoice.enabled</code> in <code>config.yaml</code>.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 12, gap: 10 }}>
      {live ? (
        // Target and session are bound for the length of a call, so
        // during one they are a statement, not a choice.
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ fontSize: 18 }}>{agents.find((a) => a.name === agent)?.icon ?? '🎙'}</span>
          <span style={{ color, fontWeight: 600 }}>{agent}</span>
          <span style={{ color: 'var(--text-3)' }}>·</span>
          <span style={{ color: 'var(--text-2)' }}>{session}</span>
          <span
            data-testid="voice-clock"
            style={{
              marginLeft: 'auto',
              fontFamily: '"JetBrains Mono", monospace',
              color: overtime ? 'var(--danger, #e5534b)' : nearLimit ? 'var(--warn, #d29922)' : 'var(--text-3)',
            }}
            title={`${status?.maxCallMinutes ?? 20} minute limit — the meter runs while nobody speaks`}
          >
            {clock}
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            data-testid="voice-agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            style={{ background: 'var(--bg-2)', color: 'var(--text-1)', border: '1px solid var(--bg-3)', borderRadius: 6, padding: '4px 6px' }}
          >
            {(status?.agents ?? []).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <select
            data-testid="voice-session"
            value={session}
            onChange={(e) => setSession(e.target.value)}
            style={{ background: 'var(--bg-2)', color: 'var(--text-1)', border: '1px solid var(--bg-3)', borderRadius: 6, padding: '4px 6px', flex: 1 }}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.slug}>{s.slug}</option>
            ))}
          </select>
        </div>
      )}

      <div style={{ flex: '0 0 46%', minHeight: 150, position: 'relative' }}>
        <VoiceOrb
          color={color}
          speaker={state === 'speaking' ? 'agent' : 'you'}
          active={live}
          muted={muted}
          micLevel={() => micRef.current?.level() ?? 0}
          agentLevel={() => playerRef.current?.level() ?? 0}
        />
        {muted && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--warn, #d29922)',
              pointerEvents: 'none',
            }}
          >
            <MicOff size={26} />
          </span>
        )}
      </div>

      <div data-testid="voice-state" style={{ textAlign: 'center', color: 'var(--text-2)', fontSize: 12, minHeight: 18 }}>
        {/* A move in progress is its own caption: the header still shows
            who is talking, so the only place to say where the call is
            going is here. */}
        {handoverTo && state !== 'closed' ? (
          `putting you through to ${handoverTo}…`
        ) : (
          <>
            {state === 'idle' && 'ready to talk'}
            {state === 'connecting' && 'connecting…'}
            {state === 'listening' && 'listening'}
            {state === 'consulting' && 'looking it up…'}
            {state === 'speaking' && `${agent} is talking`}
            {state === 'closed' && 'ended'}
          </>
        )}
        {consults > 0 && (
          <span style={{ opacity: 0.6 }} title={`${agent} looked something up ${consults} time(s) during this call`}>
            {' · '}
            {consults === 1 ? 'looked up once' : `looked up ${consults}×`}
          </span>
        )}
      </div>

      {error && (
        <div data-testid="voice-error" style={{ color: 'var(--danger, #e5534b)', fontSize: 12, textAlign: 'center' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        {!live ? (
          <button
            data-testid="voice-connect"
            type="button"
            onClick={() => void connect()}
            disabled={!agent || state === 'connecting'}
            style={{ background: color, color: '#000', border: 'none', borderRadius: 20, padding: '8px 18px', display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}
          >
            <Phone size={14} /> talk
          </button>
        ) : (
          <>
            <button
              data-testid="voice-mute"
              type="button"
              onClick={toggleMute}
              style={{ background: 'transparent', color: muted ? 'var(--warn, #d29922)' : 'var(--text-2)', border: '1px solid var(--bg-3)', borderRadius: 20, padding: '8px 14px', cursor: 'pointer' }}
            >
              {muted ? <MicOff size={14} /> : <Mic size={14} />}
            </button>
            <button
              data-testid="voice-hangup"
              type="button"
              onClick={() => hangUp('user hung up')}
              style={{ background: 'var(--danger, #e5534b)', color: '#fff', border: 'none', borderRadius: 20, padding: '8px 18px', display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}
            >
              <PhoneOff size={14} /> end
            </button>
          </>
        )}
      </div>

      <div
        data-testid="voice-transcript"
        ref={transcriptRef}
        className="voice-transcript"
        // minHeight 0 is the whole trick: without it a flex child never
        // shrinks below its content, so the list grew instead of
        // scrolling and the newest line sat below the window edge
        // (Rene, 2026-09-12: "scrollt noch immer nicht schön weiter").
        style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 2 }}
      >
        {[...transcript, ...(partial && partial.text.trim() ? [partial] : [])].map((line, i) => (
          <div
            key={i}
            style={{
              alignSelf: line.who === 'you' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              padding: '4px 8px',
              borderRadius: 8,
              lineHeight: 1.45,
              overflowWrap: 'anywhere',
              background: line.who === 'you' ? 'var(--bg-3)' : `color-mix(in srgb, ${color} 14%, transparent)`,
              color: line.who === 'you' ? 'var(--text-2)' : 'var(--text-1)',
              opacity: line === partial ? 0.65 : 1,
              borderLeft: line.who === 'you' ? undefined : `2px solid ${color}`,
            }}
          >
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
