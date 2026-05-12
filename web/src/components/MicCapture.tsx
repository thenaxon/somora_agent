// Mic button next to send. Click-to-toggle:
//   idle ─► recording (MediaRecorder runs, button shows red square)
//   recording ─► transcribing (POSTs blob to /stt/transcribe)
//   transcribing ─► idle (text handed to onTranscript callback)
//
// Capability gate matches ScreenshotCapture: button only renders when
//   1. browser supplies getUserMedia + MediaRecorder, AND
//   2. somora's /stt/config returns enabled=true.
// Either missing ⇒ button hidden (no tease of a feature that'd fail).

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';

interface Props {
  /** Called with the transcript string when the upstream returns. The
   *  caller appends/replaces the textarea draft as it sees fit. */
  onTranscript: (text: string) => void;
}

type State = 'idle' | 'recording' | 'transcribing';

export function isMicSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices) return false;
  if (typeof navigator.mediaDevices.getUserMedia !== 'function') return false;
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return false;
  return true;
}

export function MicCapture({ onTranscript }: Props) {
  // null = still probing /stt/config; false = disabled in server config
  // or probe failed; true = enabled upstream.
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
    return () => {
      cancelled = true;
    };
  }, []);

  // Component-unmount cleanup: stop any live mic stream.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  if (!isMicSupported() || !serverEnabled) return null;

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Let the browser pick a supported mimeType. Chromium → webm/opus,
      // Safari → mp4/m4a. oMLX/mlx-audio routes both via ffmpeg.
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
      // NotAllowedError, NotFoundError, security context — silent fail
      // and reset. (No toast system yet; console for debugging.)
      // eslint-disable-next-line no-console
      console.info('[somora-web] mic capture denied/failed:', (err as Error).message);
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
        const errBody = await r.text().catch(() => '');
        // eslint-disable-next-line no-console
        console.warn('[somora-web] stt request failed:', r.status, errBody);
        return;
      }
      const data = (await r.json()) as { text?: string };
      const text = (data.text ?? '').trim();
      if (text) onTranscript(text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[somora-web] stt error:', (err as Error).message);
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
    if (state === 'idle') start();
    else if (state === 'recording') stop();
    // transcribing: no-op, button is disabled
  };

  const title =
    state === 'idle' ? 'Voice input (click to record)'
    : state === 'recording' ? 'Stop recording'
    : 'Transcribing…';

  const icon =
    state === 'recording' ? <Square size={14} />
    : state === 'transcribing' ? <Loader2 size={14} className="somora-spin" />
    : <Mic size={14} />;

  return (
    <button
      type="button"
      className="chat-icon-btn"
      title={title}
      onClick={onClick}
      disabled={state === 'transcribing'}
      style={state === 'recording' ? { color: 'var(--danger)' } : undefined}
    >
      {icon}
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
