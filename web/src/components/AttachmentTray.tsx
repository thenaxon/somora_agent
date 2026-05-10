// Pending-attachments tray. Sits between the textarea and the message
// list, shows one row per file the user has staged for the next turn.
// Each row covers an upload's lifecycle:
//
//   uploading  — POST /attachments in flight; thin progress bar dimmed
//                thumb, ✕ aborts the upload (drops the row, never sent)
//   ready      — server returned hash; ✕ removes from the staged set
//   error      — upload rejected (oversized, bad mime); red border +
//                tooltip; ✕ dismisses, send is unblocked for siblings
//
// The component is presentation only — the parent (ChatWindow) owns
// the staged list state, fires uploads via api.uploadAttachment, and
// passes the resolved AttachmentRef[] into chat.send when the user
// sends.

import { File as FileIcon, FileText, Image as ImageIcon, X } from 'lucide-react';
import type { AttachmentRef } from '../lib/api';

export interface PendingAttachment {
  /** Stable client-side id so React can key consistently across the
   *  upload-state changes. Independent of the eventual server hash. */
  id: string;
  /** Original File so we can render an in-memory thumbnail before the
   *  server response arrives. We hold the URL in `previewUrl`. */
  previewUrl?: string;
  state: 'uploading' | 'ready' | 'error';
  /** Original filename (for display in non-image rows). */
  name: string;
  /** Bytes — for the size badge. */
  size: number;
  /** Detected by the browser at file-pick time; final server-detected
   *  mime arrives in `ref.mime` once the upload resolves. Used only
   *  for the icon while uploading. */
  mimeHint?: string;
  /** Resolved server-side metadata once upload completes. */
  ref?: AttachmentRef;
  /** Error message when state==='error'. */
  error?: string;
}

interface Props {
  items: PendingAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentTray({ items, onRemove }: Props) {
  if (items.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '6px 8px',
        borderTop: '1px solid var(--line)',
        background: 'var(--bg-2)',
      }}
    >
      {items.map((it) => (
        <AttachmentChip key={it.id} item={it} onRemove={() => onRemove(it.id)} />
      ))}
    </div>
  );
}

function AttachmentChip({
  item,
  onRemove,
}: {
  item: PendingAttachment;
  onRemove: () => void;
}) {
  const isImage =
    item.ref?.kind === 'image' || (item.mimeHint && item.mimeHint.startsWith('image/'));
  const isPdf =
    item.ref?.kind === 'pdf' || item.mimeHint === 'application/pdf';
  const isError = item.state === 'error';
  const isUploading = item.state === 'uploading';

  return (
    <div
      title={isError ? item.error : `${item.name} (${formatBytes(item.size)})`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px 4px 4px',
        borderRadius: 6,
        border: `1px solid ${isError ? 'var(--danger)' : 'var(--line-2)'}`,
        background: 'var(--bg-3)',
        opacity: isUploading ? 0.65 : 1,
        maxWidth: 220,
        position: 'relative',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 4,
          background: 'var(--bg-1)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 auto',
        }}
      >
        {isImage && item.previewUrl ? (
          <img
            src={item.previewUrl}
            alt={item.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : isImage ? (
          <ImageIcon size={16} />
        ) : isPdf ? (
          <FileText size={16} />
        ) : (
          <FileIcon size={16} />
        )}
      </div>
      <div style={{ overflow: 'hidden', minWidth: 0, flex: 1 }}>
        <div
          style={{
            color: isError ? 'var(--danger)' : 'var(--text-1)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.name}
        </div>
        <div style={{ color: 'var(--text-3)', fontSize: 10 }}>
          {isError ? 'failed' : isUploading ? 'uploading…' : formatBytes(item.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        title={isUploading ? 'cancel upload' : 'remove attachment'}
        style={{
          all: 'unset',
          cursor: 'pointer',
          padding: 2,
          color: 'var(--text-3)',
          flex: '0 0 auto',
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
