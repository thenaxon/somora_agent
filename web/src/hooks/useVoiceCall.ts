// One call with an agent: the audio channel to somora and what it reports.
//
// Shared by the web client's voice window and the mobile app's call screen.
// It holds no provider knowledge, no key and never sees a tool call — the
// server owns all of that (the operator 2026-09-11: "logik soll im somora
// server stecken nicht im web client"). The browser opens
// /voice/attach?agent=…&session=…, sends microphone audio, plays what comes
// back and shows the server's state.
//
// Design: private/realtime-voice-design.md

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  VOICE_RATE_HZ,
  createVoicePlayer,
  startMicCapture,
  type MicCapture,
  type VoicePlayer,
} from '../lib/voice-audio';

export type CallState = 'idle' | 'connecting' | 'listening' | 'consulting' | 'speaking' | 'closed';

export interface VoiceStatus {
  enabled: boolean;
  agents: string[];
  model?: string;
  maxCallMinutes?: number;
}

export interface CallLine {
  who: 'you' | 'agent';
  text: string;
}

export interface CallIdentity {
  agent: string;
  session: string;
}

/** GET /voice/status: whether calls are on, and who can be called. */
export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  try {
    const r = await fetch('/voice/status');
    if (!r.ok) return { enabled: false, agents: [] };
    return (await r.json()) as VoiceStatus;
  } catch {
    return { enabled: false, agents: [] };
  }
}

export interface VoiceCall {
  state: CallState;
  error: string | null;
  muted: boolean;
  transcript: CallLine[];
  /** What is being said right now, before the sentence is final. */
  partial: CallLine | null;
  consults: number;
  /** The agent a move is putting the call through to, while it happens. */
  handoverTo: string | null;
  /** Who is on the line now: follows a move to another agent or session. */
  identity: CallIdentity | null;
  /** Seconds since the call started; 0 when there is none. */
  elapsed: number;
  live: boolean;
  connect: (agent: string, session: string) => Promise<void>;
  hangUp: (reason: string) => void;
  toggleMute: () => void;
  micLevel: () => number;
  agentLevel: () => number;
}

export function useVoiceCall(): VoiceCall {
  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState<CallLine[]>([]);
  const [partial, setPartial] = useState<CallLine | null>(null);
  const [consults, setConsults] = useState(0);
  const [handoverTo, setHandoverTo] = useState<string | null>(null);
  const [identity, setIdentity] = useState<CallIdentity | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<VoicePlayer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  /** Which connection attempt is current: a hang-up or a new call makes
   *  every earlier one stale, and a stale attempt touches nothing. */
  const attemptRef = useRef(0);
  /** Mute as asked, also before the microphone is up. */
  const mutedRef = useRef(false);
  /**
   * Who is shown, readable from inside the socket handler.
   *
   * The handler is built once, when the call is connected, and closes
   * over the identity of that moment forever. Comparing against that
   * value silently ignored a move BACK to the agent the call started
   * with: ada → bea → ada stayed on bea (the operator, 2026-09-12:
   * "es bleibt auf Bea aber man spricht dann schon mit Ada").
   */
  const shownRef = useRef<CallIdentity>({ agent: '', session: 'main' });
  /** A move not applied yet, because the previous agent is still heard. */
  const pendingIdentityRef = useRef<CallIdentity | null>(null);

  /**
   * Take on the identity the server reports — but not while the previous
   * agent is still being heard.
   *
   * Two clocks disagree here. The server knows when the new session is
   * live; the browser knows how much of the old agent's speech is still
   * queued. Applying the change on the server's word alone put the new
   * name and colour on the old agent's last sentence. So the call waits
   * for its own queue to run dry.
   */
  const applyIdentity = useCallback((next: CallIdentity) => {
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
      setIdentity(wanted);
    };
    settle();
  }, []);

  const release = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  }, []);

  const hangUp = useCallback((reason: string) => {
    attemptRef.current += 1;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hangup', reason }));
    ws?.close();
    wsRef.current = null;
    release();
    setState('closed');
    setStartedAt(null);
  }, [release]);

  // a call never outlives the screen that holds it
  useEffect(() => () => { if (wsRef.current) hangUp('window closed'); }, [hangUp]);

  // The meter runs while nobody speaks, so the clock belongs on screen.
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const connect = useCallback(async (agent: string, session: string) => {
    const attempt = ++attemptRef.current;
    const stale = () => attempt !== attemptRef.current;
    // a call still up (or connecting) is replaced, never left running
    wsRef.current?.close();
    wsRef.current = null;
    release();
    setError(null);
    setTranscript([]);
    setPartial(null);
    setConsults(0);
    setHandoverTo(null);
    setMuted(false);
    mutedRef.current = false;
    setState('connecting');
    setStartedAt(Date.now());
    setElapsed(0);
    shownRef.current = { agent, session };
    pendingIdentityRef.current = null;
    setIdentity({ agent, session });
    try {
      // One audio context for the call, created and resumed right here,
      // inside the tap that started it: a phone (iOS) starts audio only
      // from a user gesture, and the microphone joins it after the
      // connection is up, which is no longer inside that gesture.
      const ctx = new AudioContext({ sampleRate: VOICE_RATE_HZ });
      ctxRef.current = ctx;
      void ctx.resume().catch(() => undefined);
      const player = createVoicePlayer(ctx);
      playerRef.current = player;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(
        `${proto}://${window.location.host}/voice/attach?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`,
      );
      wsRef.current = ws;
      ws.onmessage = (evt) => {
        if (stale()) return;
        let msg: {
          type?: string;
          base64?: string;
          event?: { kind?: string; text?: string; final?: boolean; message?: string };
          call?: { consults?: number; state?: string; handoverTo?: string; target?: { agent?: string; slug?: string } };
        };
        try { msg = JSON.parse(String(evt.data)) as typeof msg; } catch { return; }
        if (msg.type === 'audio' && msg.base64) {
          playerRef.current?.play(msg.base64);
          return;
        }
        if (msg.type === 'ready') {
          setState('listening');
          return;
        }
        // The server's own state is the truth — "asking ada" is a
        // state no provider event announces.
        if (msg.type === 'state' && msg.call?.state) {
          setState(msg.call.state as CallState);
          if (typeof msg.call.consults === 'number') setConsults(msg.call.consults);
          setHandoverTo(msg.call.handoverTo ?? null);
          // The call can be moved to another agent or session
          // mid-conversation, so who is shown follows the server.
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
              // it feel like a conversation rather than a log that
              // updates once per sentence.
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
      ws.onerror = () => { if (!stale()) setError('connection failed'); };
      ws.onclose = (evt) => {
        if (stale()) return;
        setState('closed');
        setStartedAt(null);
        if (evt.reason && evt.code !== 1000) setError(evt.reason);
        micRef.current?.stop();
        micRef.current = null;
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), 10_000);
        ws.onopen = () => { clearTimeout(timer); resolve(); };
        ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('connection closed')); });
      });
      if (stale()) {
        ws.close();
        return;
      }
      // Keeps sending while nobody talks — the provider closes a turn
      // on silence, not on missing packets (measured 2026-09-11).
      const mic = await startMicCapture((base64) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio', base64 }));
      }, ctx);
      if (stale()) {
        // never into the refs: they belong to the call that replaced this one
        mic.stop();
        return;
      }
      micRef.current = mic;
      // a mute tapped while the call was still connecting applies now
      mic.setMuted(mutedRef.current);
    } catch (err) {
      // an attempt that was hung up or replaced leaves the current call alone
      if (stale()) return;
      const e = err as Error;
      setError(
        e.name === 'NotAllowedError'
          ? 'the microphone is not allowed — allow it for this site and try again'
          : e.message,
      );
      setState('idle');
      setStartedAt(null);
      release();
      wsRef.current?.close();
      wsRef.current = null;
    }
  }, [applyIdentity, release]);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    micRef.current?.setMuted(mutedRef.current);
    setMuted(mutedRef.current);
  }, []);

  const live = state === 'listening' || state === 'speaking' || state === 'consulting';
  return {
    state,
    error,
    muted,
    transcript,
    partial,
    consults,
    handoverTo,
    identity,
    elapsed,
    live,
    connect,
    hangUp,
    toggleMute,
    micLevel: () => micRef.current?.level() ?? 0,
    agentLevel: () => playerRef.current?.level() ?? 0,
  };
}
