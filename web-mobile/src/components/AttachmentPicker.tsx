// Mobile attachment picker. Paperclip button next to the textarea
// opens the native mobile file picker (which on iOS / Android lets
// the user pick "Camera" / "Photo Library" / "File"). Each picked
// file is uploaded to /attachments and added to a thumb-strip above
// the textarea. On chat-send, the parent collects the staged refs
// and includes them in the body.attachments array.
//
// Server contract (matches web/api.ts):
//   POST /attachments
//     Content-Type: <mime>
//     X-Somora-Filename: <url-encoded filename>
//     Body: raw bytes (NOT multipart — server streams the body to
//           keep the per-kind size cap honest)
//   Response: { hash, name, mime, kind, size }
//
// We render image thumbnails via `/attachments/<hash>` for instant
// preview; non-image files just show a generic icon + filename.

import { useState } from 'react';

export interface AttachmentRef {
  hash: string;
  name: string;
  mime: string;
  kind: 'image' | 'pdf' | 'text';
  size: number;
}

interface Props {
  staged: AttachmentRef[];
  onStage: (ref: AttachmentRef) => void;
  onRemove: (hash: string) => void;
  /** Disabled while a chat send is in flight, to prevent attaching
   *  files that wouldn't make it into the current turn. */
  disabled?: boolean;
}

export function AttachmentPicker({ staged, onStage, onRemove, disabled }: Props) {
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const busy = Boolean(disabled) || uploading > 0;

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setErr(null);
    // Reset the input so the same file can be re-picked after removal.
    e.target.value = '';
    for (const file of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const ref = await uploadAttachment(file);
        onStage(ref);
      } catch (uploadErr) {
        setErr(`Upload fehlgeschlagen: ${(uploadErr as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  // iOS PWAs in standalone mode have long-standing trouble with
  // `<input type="file">` opening the picker when triggered by a
  // programmatic `.click()` on a `display:none` input. The reliable
  // cross-platform pattern is a `<label>` that visually styles like
  // a button and wraps the input — the label's native semantics
  // proxy the tap to the input without any JS involvement, which
  // works in Safari standalone mode where button.onClick → ref.click
  // sometimes silently does nothing.
  //
  // `accept` covers images + PDFs; on iOS / Android the picker
  // shows Camera / Photo Library / Files based on this list.
  // The input is positioned off-screen-but-in-layout (instead of
  // display:none) — iOS Safari treats display:none inputs as
  // "not really there" and skips them.
  return (
    <>
      <label
        className={`input-btn attach-btn ${busy ? 'disabled' : ''}`}
        aria-label="Datei anhängen"
        title="Foto, Bild oder PDF anhängen"
      >
        {uploading > 0 ? <span className="mic-spinner" /> : '📎'}
        <input
          type="file"
          accept="image/*,application/pdf"
          multiple
          disabled={busy}
          onChange={onChange}
          className="attach-input"
        />
      </label>
      {err && <div className="attach-err">{err}</div>}
      {staged.length > 0 && (
        <AttachmentStrip staged={staged} onRemove={onRemove} />
      )}
    </>
  );
}

function AttachmentStrip({
  staged,
  onRemove,
}: {
  staged: AttachmentRef[];
  onRemove: (hash: string) => void;
}) {
  return (
    <div className="attach-strip" role="list">
      {staged.map((a) => (
        <div key={a.hash} className="attach-chip" role="listitem">
          {a.kind === 'image' ? (
            <img
              className="attach-thumb"
              src={`/attachments/${a.hash}`}
              alt={a.name}
            />
          ) : (
            <span className="attach-icon">{a.kind === 'pdf' ? '📄' : '📋'}</span>
          )}
          <span className="attach-name" title={a.name}>
            {a.name}
          </span>
          <button
            type="button"
            className="attach-remove"
            onClick={() => onRemove(a.hash)}
            aria-label={`${a.name} entfernen`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

async function uploadAttachment(file: File): Promise<AttachmentRef> {
  const res = await fetch('/attachments', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Somora-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.text();
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      /* keep raw */
    }
    throw new Error(msg);
  }
  return (await res.json()) as AttachmentRef;
}
