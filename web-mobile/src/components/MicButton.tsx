// Mobile mic button — tap-to-record, tap-again-to-stop. Records via
// MediaRecorder, POSTs the audio blob to /stt/transcribe, hands the
// transcript back to the caller as a string. The caller decides what
// to do with it (we append to the textarea so the user can edit
// before sending — never an auto-send, that was the explicit UX
// decision per project_mobile_pwa_design memory).
//
// States:
//   idle ─► recording (button shows red pulse)
//   recording ─► transcribing (POSTs blob)
//   transcribing ─► idle (transcript text handed to onTranscript)
//
// Visibility-gated: hidden when the browser lacks getUserMedia /
// MediaRecorder, or when /stt/config returns enabled=false. No tease
// of a feature that wouldn't work.
//
// Adapted from web/src/components/MicCapture.tsx; same flow, mobile-
// scoped UI (no lucide-react, emoji + inline SVG instead).

import { useEffect, useRef, useState } from 'react';

interface Props {
  onTranscript: (text: string) => void;
}

type State = 'idle' | 'recording' | 'transcribing';

function isMicSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices) return false;
  if (typeof navigator.mediaDevices.getUserMedia !== 'function') return false;
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return false;
  return true;
}

export function MicButton({ onTranscript }: Props) {
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const [state, setState] = useState<State>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/stt/config')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d: { enabled?: boolean }) => {
        if (!cancelled) setServerEnabled(Boolean(d.enabled));
      })
      .catch(() => {
        if (!cancelled) setServerEnabled(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  if (!isMicSupported() || !serverEnabled) {
    // Render a disabled placeholder so the layout stays consistent with
    // when mic IS available — keeps the textarea + send-button positions
    // stable. Tooltip hints why.
    return (
      <button
        type="button"
        className="input-btn"
        disabled
        title={serverEnabled === false ? 'Speech-to-text is disabled on the server' : 'Voice not available in this browser'}
        aria-label="Voice (unavailable)"
      >
        🎙️
      </button>
    );
  }

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Browser picks the mimeType: Chromium → webm/opus, Safari → mp4/m4a.
      // oMLX/mlx-audio normalizes both via ffmpeg on /stt/transcribe.
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        await transcribe(blob);
      };
      recorder.start();
      setState('recording');
    } catch (err) {
      console.info('[somora-mobile] mic capture denied/failed:', (err as Error).message);
      cleanup();
    }
  }

  function stop() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      setState('transcribing');
      recorder.stop(); // triggers onstop → transcribe
    } else {
      cleanup();
    }
  }

  async function transcribe(blob: Blob) {
    try {
      const form = new FormData();
      const filename = filenameForMime(blob.type);
      form.append('file', new File([blob], filename, { type: blob.type }));
      const r = await fetch('/stt/transcribe', { method: 'POST', body: form });
      if (!r.ok) {
        console.warn('[somora-mobile] stt request failed:', r.status);
        return;
      }
      const data = (await r.json()) as { text?: string };
      const text = (data.text ?? '').trim();
      if (text) onTranscript(text);
    } catch (err) {
      console.warn('[somora-mobile] stt error:', (err as Error).message);
    } finally {
      cleanup();
    }
  }

  function cleanup() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setState('idle');
  }

  const onClick = () => {
    if (state === 'idle') void start();
    else if (state === 'recording') stop();
    // transcribing: no-op (button disabled below)
  };

  const label =
    state === 'idle' ? 'Aufnahme starten'
    : state === 'recording' ? 'Aufnahme stoppen'
    : 'Transkribiere…';

  return (
    <button
      type="button"
      className={`input-btn mic-btn ${state === 'recording' ? 'recording' : ''}`}
      onClick={onClick}
      disabled={state === 'transcribing'}
      aria-label={label}
      title={label}
    >
      {state === 'transcribing' ? <span className="mic-spinner" /> : '🎙️'}
    </button>
  );
}

function filenameForMime(mime: string): string {
  if (mime.includes('webm')) return 'recording.webm';
  if (mime.includes('ogg')) return 'recording.ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'recording.m4a';
  if (mime.includes('wav')) return 'recording.wav';
  if (mime.includes('mpeg')) return 'recording.mp3';
  return 'recording.bin';
}
