// Screenshot button + capture flow. Browser API:
//   navigator.mediaDevices.getDisplayMedia({video:{...}})
// triggers the browser's own picker (Tab/Window/Screen — user
// chooses), returns a MediaStream with one video track. We grab a
// single frame off that track via a hidden canvas, stop the stream
// immediately (no continuous recording), and hand the resulting PNG
// straight into the staging tray. The tray already supports remove/
// cancel via the ✕ on each chip — a separate preview modal added
// nothing but a UX hop and broke at high resolutions where its
// buttons fell off-screen.
//
// Capability gate: getDisplayMedia is undefined on iPadOS Safari
// (and a handful of older browsers). The button renders only when
// the API is present, so the icon doesn't tease a feature that'd
// fail on click. Also requires a secure context (HTTPS) — somora
// is HTTPS-only via Tailscale, so that's already satisfied.

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
      const blob = await grabFrame(stream, width, height);
      const ts = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\..+$/, '')
        .replace('T', '-');
      const file = new File([blob], `screenshot-${ts}.png`, { type: 'image/png' });
      onCaptured(file);
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

  return (
    <button
      type="button"
      className="chat-icon-btn"
      title="Screenshot a window / tab / screen"
      onClick={capture}
      disabled={busy}
    >
      <Camera size={14} />
    </button>
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
