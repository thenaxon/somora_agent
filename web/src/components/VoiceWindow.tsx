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
  const [consults, setConsults] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<VoicePlayer | null>(null);

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
  }, []);

  useEffect(() => () => { if (wsRef.current) hangUp('window closed'); }, [hangUp]);

  const connect = useCallback(async () => {
    setError(null);
    setTranscript([]);
    setConsults(0);
    setState('connecting');
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
        let msg: { type?: string; base64?: string; event?: { kind?: string; text?: string; final?: boolean; message?: string }; call?: { consults?: number; state?: string } };
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
            if (ev.final && ev.text) setTranscript((t) => [...t, { who: 'you', text: ev.text! }]);
            break;
          case 'model_transcript':
            if (ev.final && ev.text) setTranscript((t) => [...t, { who: 'agent', text: ev.text! }]);
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

  if (status && !status.enabled) {
    return (
      <div style={{ padding: 16, color: 'var(--text-2)' }}>
        Realtime voice is off. Set <code>realtimeVoice.enabled</code> in <code>config.yaml</code>.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 12, gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          data-testid="voice-agent"
          value={agent}
          disabled={live}
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
          disabled={live}
          onChange={(e) => setSession(e.target.value)}
          style={{ background: 'var(--bg-2)', color: 'var(--text-1)', border: '1px solid var(--bg-3)', borderRadius: 6, padding: '4px 6px', flex: 1 }}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.slug}>{s.slug}</option>
          ))}
        </select>
      </div>

      <VoiceOrb
        color={color}
        speaker={state === 'speaking' ? 'agent' : 'you'}
        active={live}
        micLevel={() => micRef.current?.level() ?? 0}
        agentLevel={() => playerRef.current?.level() ?? 0}
      />

      <div data-testid="voice-state" style={{ textAlign: 'center', color: 'var(--text-2)', fontSize: 12, minHeight: 18 }}>
        {state === 'idle' && 'ready'}
        {state === 'connecting' && 'connecting…'}
        {state === 'listening' && 'listening'}
        {state === 'consulting' && `asking ${agent}…`}
        {state === 'speaking' && `${agent} is speaking`}
        {state === 'closed' && 'call ended'}
        {consults > 0 && <span style={{ opacity: 0.6 }}> · {consults} asked</span>}
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
            <Phone size={14} /> call
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
              <PhoneOff size={14} /> hang up
            </button>
          </>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {transcript.map((line, i) => (
          <div key={i} style={{ color: line.who === 'you' ? 'var(--text-2)' : 'var(--text-1)' }}>
            <span style={{ opacity: 0.6 }}>{line.who === 'you' ? 'you' : agent}:</span> {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
