// A call with an agent, on the phone.
//
// The same call as the web client's voice window (one audio channel to
// somora; the server owns the provider, the tools and every decision),
// as a full-screen sheet: who is on the line, what is happening, what is
// being said, mute and hang up.
//
// Phone rules: the call starts from the tap (audio is only allowed from a
// gesture), the screen is kept awake while it runs, and when the app goes
// to the background the call ends with a note — a home-screen web app is
// paused there, and a call that silently stops listening is worse.

import { useEffect, useRef, useState } from 'react';
import type { VoiceCall } from '../../../web/src/hooks/useVoiceCall';
import { VoiceOrb } from '../../../web/src/components/VoiceOrb';

interface AgentLook {
  name: string;
  color?: string;
  icon?: string;
}

export function CallSheet({
  call,
  agent,
  session,
  agents,
  maxCallMinutes,
  onClose,
}: {
  /** The call, already started by the tap that opened the sheet. */
  call: VoiceCall;
  agent: string;
  session: string;
  agents: AgentLook[];
  maxCallMinutes: number;
  onClose: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // keep the screen awake for the length of the call
  const awake = call.live || call.state === 'connecting';
  useEffect(() => {
    if (!awake) return;
    let lock: { release: () => Promise<void> } | null = null;
    let done = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock
      ?.request('screen')
      .then((l) => {
        // the call may have ended while the lock was being granted
        if (done) void l.release().catch(() => undefined);
        else lock = l;
      })
      .catch(() => undefined);
    return () => {
      done = true;
      void lock?.release().catch(() => undefined);
    };
  }, [awake]);

  // a web app in the background is paused: end the call and say why
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && (call.live || call.state === 'connecting')) {
        call.hangUp('app went to the background');
        setNote('The call ended because the app went to the background or the screen locked.');
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [call]);

  useEffect(() => {
    const box = transcriptRef.current;
    if (!box) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) box.scrollTop = box.scrollHeight;
  }, [call.transcript, call.partial]);

  const who = call.identity ?? { agent, session };
  const look = agents.find((a) => a.name === who.agent);
  const color = look?.color ?? 'var(--accent, #5cf2d6)';
  const limit = maxCallMinutes * 60;
  const clock = `${Math.floor(call.elapsed / 60)}:${String(call.elapsed % 60).padStart(2, '0')}`;
  const clockColor =
    call.elapsed > limit * 0.92 ? 'var(--danger, #ff6b6b)' : call.elapsed > limit * 0.75 ? 'var(--warn, #f5b942)' : 'var(--text-2, #888)';
  const ended = call.state === 'closed' || (call.state === 'idle' && Boolean(call.error));

  let caption = '';
  if (call.handoverTo && !ended) caption = `putting you through to ${call.handoverTo}…`;
  else if (call.state === 'connecting') caption = 'calling…';
  else if (call.state === 'listening') caption = call.muted ? 'muted' : 'listening';
  else if (call.state === 'consulting') caption = 'looking it up…';
  else if (call.state === 'speaking') caption = `${who.agent} is talking`;
  else if (ended) caption = 'call ended';

  const lines = [...call.transcript, ...(call.partial && call.partial.text.trim() ? [call.partial] : [])];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`call with ${who.agent}`}
      data-testid="call-sheet"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'var(--bg-0, #07090d)',
        display: 'flex',
        flexDirection: 'column',
        padding: 'calc(env(safe-area-inset-top, 0px) + 14px) 16px calc(env(safe-area-inset-bottom, 0px) + 18px)',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 22 }} aria-hidden="true">{look?.icon ?? '🎙'}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ color, fontWeight: 600, fontSize: 17 }}>{who.agent}</div>
          <div style={{ color: 'var(--text-2, #888)', fontSize: 12 }}>{who.session}</div>
        </div>
        <span
          data-testid="call-clock"
          style={{ marginLeft: 'auto', fontFamily: '"JetBrains Mono", monospace', fontSize: 13, color: clockColor }}
        >
          {call.live ? clock : ''}
        </span>
      </div>

      <div style={{ flex: '0 0 34%', minHeight: 140, position: 'relative' }}>
        <VoiceOrb
          color={color}
          speaker={call.state === 'speaking' ? 'agent' : 'you'}
          active={call.live}
          muted={call.muted}
          micLevel={call.micLevel}
          agentLevel={call.agentLevel}
        />
      </div>

      <div data-testid="call-state" style={{ textAlign: 'center', color: 'var(--text-1, #aab6c6)', fontSize: 14, minHeight: 20 }}>
        {caption}
        {call.consults > 0 && !ended && (
          <span style={{ opacity: 0.6 }}>{call.consults === 1 ? ' · looked up once' : ` · looked up ${call.consults}×`}</span>
        )}
      </div>
      {(note || call.error) && (
        <div data-testid="call-error" style={{ textAlign: 'center', color: note ? 'var(--warn, #f5b942)' : 'var(--danger, #ff6b6b)', fontSize: 13 }}>
          {note ?? call.error}
        </div>
      )}

      <div
        ref={transcriptRef}
        data-testid="call-transcript"
        style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              alignSelf: line.who === 'you' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              padding: '6px 10px',
              borderRadius: 10,
              lineHeight: 1.45,
              overflowWrap: 'anywhere',
              background: line.who === 'you' ? 'var(--bg-3, #18202c)' : `color-mix(in srgb, ${color} 14%, transparent)`,
              color: line.who === 'you' ? 'var(--text-1, #aab6c6)' : 'var(--text-0, #e6edf6)',
              opacity: line === call.partial ? 0.65 : 1,
              borderLeft: line.who === 'you' ? undefined : `2px solid ${color}`,
            }}
          >
            {line.text}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 28, paddingTop: 6 }}>
        {!ended ? (
          <>
            <RoundButton
              testId="call-mute"
              label={call.muted ? 'unmute' : 'mute'}
              onClick={call.toggleMute}
              background={call.muted ? 'var(--warn, #f5b942)' : 'var(--bg-3, #18202c)'}
              color={call.muted ? '#111' : 'var(--text-0, #e6edf6)'}
            >
              {call.muted ? <MicOffIcon /> : <MicIcon />}
            </RoundButton>
            <RoundButton
              testId="call-hangup"
              label="hang up"
              onClick={() => {
                call.hangUp('user hung up');
                onClose();
              }}
              background="var(--danger, #ff6b6b)"
              color="#fff"
            >
              <PhoneOffIcon />
            </RoundButton>
          </>
        ) : (
          <>
            <RoundButton testId="call-again" label="call again" onClick={() => { setNote(null); void call.connect(who.agent, who.session); }} background={color} color="#0a1010">
              <PhoneIcon />
            </RoundButton>
            <RoundButton testId="call-close" label="close" onClick={() => { call.hangUp('closed'); onClose(); }} background="var(--bg-3, #18202c)" color="var(--text-0, #e6edf6)">
              <CloseIcon />
            </RoundButton>
          </>
        )}
      </div>
    </div>
  );
}

function RoundButton({
  children,
  label,
  onClick,
  background,
  color,
  testId,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  background: string;
  color: string;
  testId: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        onClick={onClick}
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          border: 'none',
          background,
          color,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        {children}
      </button>
      <span style={{ fontSize: 12, color: 'var(--text-2, #888)' }}>{label}</span>
    </div>
  );
}

// Inline line-art icons (lucide paths): the mobile bundle keeps the
// no-lucide-react rule.
const svg = { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export function PhoneIcon({ size = 26 }: { size?: number }) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function PhoneOffIcon() {
  return (
    <svg {...svg}>
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="22" y1="2" x2="2" y2="22" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg {...svg}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg {...svg}>
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M18.89 13.23A7 7 0 0 0 19 12v-2" />
      <path d="M5 10v2a7 7 0 0 0 12 5" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...svg}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
