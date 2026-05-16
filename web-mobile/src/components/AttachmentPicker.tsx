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

import { useRef, useState } from 'react';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const trigger = () => {
    if (disabled || uploading > 0) return;
    inputRef.current?.click();
  };

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

  return (
    <>
      {/* The hidden native input. `accept` covers images + PDFs; the
          mobile file picker on iOS/Android exposes the right sources
          (Camera, Photo Library, Files) based on this list. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        style={{ display: 'none' }}
        onChange={onChange}
      />
      <button
        type="button"
        className="input-btn"
        onClick={trigger}
        disabled={disabled || uploading > 0}
        aria-label="Datei anhängen"
        title="Foto, Bild oder PDF anhängen"
      >
        {uploading > 0 ? <span className="mic-spinner" /> : '📎'}
      </button>
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
