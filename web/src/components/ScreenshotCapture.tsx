// Screenshot button + capture flow. Browser API:
//   navigator.mediaDevices.getDisplayMedia({video:{...}})
// triggers the browser's own picker (Tab/Window/Screen — user
// chooses), returns a MediaStream with one video track. We grab a
// single frame off that track via a hidden canvas, stop the stream
// immediately (no continuous recording), and hand the resulting PNG
// File to the parent.
//
// Capability gate: getDisplayMedia is undefined on iPadOS Safari
// (and a handful of older browsers). The button renders only when
// the API is present, so the icon doesn't tease a feature that'd
// fail on click. Also requires a secure context (HTTPS) — somora
// is HTTPS-only via Tailscale, so that's already satisfied.
//
// Workflow:
//   1. Click → getDisplayMedia (browser picker)
//   2. User picks → grab a single frame via canvas → stop stream
//   3. Show preview modal (the bytes are not in the attachment tray
//      yet — user gets to confirm or cancel)
//   4. On "Use" → blob → File → parent's stageFiles()
//   5. On "Cancel" → throw the bytes away

import { useState } from 'react';
import { Camera } from 'lucide-react';

interface Props {
  /** Same hook the paperclip + drop + paste path uses to stage a
   *  file for upload through /attachments. */
  onCaptured: (file: File) => void;
}

export function isScreenshotSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices) return false;
  // getDisplayMedia is non-enumerable on some implementations —
  // explicit lookup, no key-presence check.
  return typeof navigator.mediaDevices.getDisplayMedia === 'function';
}

export function ScreenshotCapture({ onCaptured }: Props) {
  const [pendingPreview, setPendingPreview] = useState<{ url: string; blob: Blob } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  if (!isScreenshotSupported()) return null;

  async function capture() {
    if (busy) return;
    setBusy(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('no video track');
      const settings = track.getSettings();
      const width = settings.width ?? 1280;
      const height = settings.height ?? 720;
      // ImageCapture is the cleanest path but isn't supported in Safari.
      // Fall back to drawing a video-element-frame on a canvas — works
      // everywhere getDisplayMedia exists.
      const blob = await grabFrame(stream, width, height);
      const url = URL.createObjectURL(blob);
      setPendingPreview({ url, blob });
    } catch (err) {
      // User cancelled the picker → InvalidStateError / NotAllowedError.
      // Either way, no preview to show, no error to surface.
      // eslint-disable-next-line no-console
      console.info('[somora-web] screenshot cancelled or failed:', (err as Error).message);
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setBusy(false);
    }
  }

  function confirm() {
    if (!pendingPreview) return;
    const ts = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-');
    const file = new File([pendingPreview.blob], `screenshot-${ts}.png`, {
      type: 'image/png',
    });
    URL.revokeObjectURL(pendingPreview.url);
    setPendingPreview(null);
    onCaptured(file);
  }

  function cancel() {
    if (pendingPreview) URL.revokeObjectURL(pendingPreview.url);
    setPendingPreview(null);
  }

  return (
    <>
      <button
        type="button"
        className="chat-icon-btn"
        title="Screenshot a window / tab / screen"
        onClick={capture}
        disabled={busy}
      >
        <Camera size={14} />
      </button>
      {pendingPreview && (
        <PreviewModal
          url={pendingPreview.url}
          onConfirm={confirm}
          onCancel={cancel}
        />
      )}
    </>
  );
}

async function grabFrame(stream: MediaStream, w: number, h: number): Promise<Blob> {
  // Pipe the stream into a hidden <video>, wait for the first frame
  // to render, then draw onto a canvas of the same dimensions.
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  // Some browsers report 0×0 dimensions immediately after play; let
  // one rAF pass before reading.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || w;
  canvas.height = video.videoHeight || h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

function PreviewModal({
  url,
  onConfirm,
  onCancel,
}: {
  url: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          padding: 16,
          maxWidth: '80vw',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
          fontFamily: '"JetBrains Mono", monospace',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Screenshot preview</div>
        <img
          src={url}
          alt="screenshot preview"
          style={{
            maxWidth: '100%',
            maxHeight: '60vh',
            objectFit: 'contain',
            border: '1px solid var(--line-2)',
            borderRadius: 4,
            background: 'var(--bg-1)',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '6px 14px',
              borderRadius: 4,
              border: '1px solid var(--line-2)',
              fontSize: 12,
              color: 'var(--text-2)',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '6px 14px',
              borderRadius: 4,
              background: 'var(--accent)',
              color: 'var(--bg-1)',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Use
          </button>
        </div>
      </div>
    </div>
  );
}
