// Talking to an agent.
//
// The window picks an agent and a session, opens one audio channel to
// somora and shows what is happening. It holds no provider knowledge,
// no key and never sees a tool call — the server owns all of that
// (the operator 2026-09-11: "logik soll im somora server stecken nicht im web
// client").
//
// Design: private/realtime-voice-design.md

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, Phone } from 'lucide-react';
import { api, type AgentInfo } from '../lib/api';
import { fetchVoiceStatus, useVoiceCall, type VoiceStatus } from '../hooks/useVoiceCall';
import { VoiceOrb } from './VoiceOrb';

interface SessionOption {
  id: string;
  slug: string;
}

export function VoiceWindow({ agents }: { agents: AgentInfo[] }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [agent, setAgent] = useState<string>('');
  const [session, setSession] = useState<string>('main');
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const call = useVoiceCall();
  const { state, error, muted, transcript, partial, consults, handoverTo, elapsed, live } = call;
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchVoiceStatus().then((s) => {
      if (cancelled) return;
      setStatus(s);
      if (s.agents.length > 0) setAgent((a) => a || (s.agents[0] ?? ''));
    });
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

  // The call can be moved to another agent or session mid-conversation:
  // the header follows the server rather than the picker.
  useEffect(() => {
    if (!call.identity) return;
    setAgent(call.identity.agent);
    setSession(call.identity.session);
  }, [call.identity]);

  // Follow the conversation: the newest line is the one you want while
  // you are talking. Scrolling up to read stops the follow, the way it
  // does in the chat window — being yanked back mid-sentence is worse
  // than pressing End.
  useEffect(() => {
    const box = transcriptRef.current;
    if (!box) return;
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (distanceFromBottom < 80) box.scrollTop = box.scrollHeight;
  }, [transcript, partial]);

  const connect = () => call.connect(agent, session);
  const hangUp = call.hangUp;
  const toggleMute = call.toggleMute;

  const color = agents.find((a) => a.name === agent)?.color ?? 'var(--accent, #6cf)';
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
          micLevel={call.micLevel}
          agentLevel={call.agentLevel}
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
        // (the operator, 2026-09-12: "scrollt noch immer nicht schön weiter").
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
