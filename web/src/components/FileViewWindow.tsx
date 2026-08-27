// FileView — read-only viewer for filesystem artefacts that agents
// reference by absolute path in chat messages (feedback reports,
// generated docs, logs, ...). Reads the content from /files/view; the
// server enforces the same allowlist as the file_read tool.
//
// Three render modes driven by the server-reported `kind`:
//   markdown → rendered with the same react-markdown setup as chat
//   text     → monospace pre, no highlighting (logs, plain .txt)
//   code     → monospace pre + rehype-highlight (json / yaml / toml)
//   image    → <img>, click for full size
//   video    → <video controls>, seeking served by Range on /files/raw
//   audio    → <audio controls>
//   pdf      → the browser's own viewer in an <iframe>
//   binary   → name, type, size and a download button
//
// Bytes for the media kinds come from /files/raw rather than through
// this JSON — that route streams and honours Range, which is what makes
// scrubbing a video work. Every kind, binary included, offers a
// download: a file the user can see referenced in chat should never be
// a dead end.
//
// Designed to coexist with chat in parallel windows — open from a
// Markdown link, leave it alongside the conversation.

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { AssistantMarkdown } from './AssistantMarkdown';

export type FileKind = 'markdown' | 'text' | 'code' | 'image' | 'video' | 'audio' | 'pdf' | 'binary';

export interface FileViewResponse {
  path: string;
  kind: FileKind;
  ext: string;
  bytes: number;
  /** Text kinds only. */
  content?: string;
  truncated?: boolean;
  truncated_reason?: string;
  /** Non-text kinds: where the bytes live. */
  url?: string;
  mime?: string;
  downloadUrl?: string;
}

interface Props {
  path: string;
}

export function FileViewWindow({ path }: Props) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ok'; data: FileViewResponse }
    | { status: 'error'; message: string; httpStatus: number }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    const url = `/files/view?path=${encodeURIComponent(path)}`;
    fetch(url)
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as FileViewResponse;
          setState({ status: 'ok', data });
          return;
        }
        let msg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body && typeof body.error === 'string') msg = body.error;
        } catch {
          /* keep HTTP fallback */
        }
        setState({ status: 'error', message: msg, httpStatus: res.status });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: `network error: ${String(err)}`,
          httpStatus: 0,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-1)',
      }}
    >
      <FileViewHeader path={path} state={state} />
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 14px',
          fontSize: 13,
          lineHeight: 1.5,
          userSelect: 'text',
        }}
      >
        {state.status === 'loading' && (
          <div style={{ color: 'var(--text-3)' }}>loading…</div>
        )}
        {state.status === 'error' && (
          <ErrorBody message={state.message} httpStatus={state.httpStatus} />
        )}
        {state.status === 'ok' && <Body data={state.data} />}
      </div>
    </div>
  );
}

function FileViewHeader({
  path,
  state,
}: {
  path: string;
  state:
    | { status: 'loading' }
    | { status: 'ok'; data: FileViewResponse }
    | { status: 'error'; message: string; httpStatus: number };
}) {
  const size =
    state.status === 'ok' ? humanBytes(state.data.bytes) : null;
  return (
    <div
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--line-2)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        fontSize: 11,
        fontFamily: '"JetBrains Mono", monospace',
        color: 'var(--text-3)',
      }}
      title={path}
    >
      <span style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        {path}
      </span>
      {state.status === 'ok' && state.data.mime && (
        <span style={{ flexShrink: 0 }}>{state.data.mime}</span>
      )}
      {size && <span style={{ flexShrink: 0 }}>{size}</span>}
      {state.status === 'ok' && state.data.truncated && (
        <span style={{ flexShrink: 0, color: 'var(--warn)' }} title={state.data.truncated_reason}>
          truncated
        </span>
      )}
      {state.status === 'ok' && state.data.downloadUrl && (
        <a
          href={state.data.downloadUrl}
          download
          // An <a> is draggable by default, and a pixel of movement
          // between mousedown and mouseup silently swallows the click —
          // easy to hit inside a window the user drags around.
          draggable={false}
          style={{
            flexShrink: 0,
            color: 'var(--text-2)',
            textDecoration: 'none',
            border: '1px solid var(--line-2)',
            borderRadius: 4,
            padding: '1px 6px',
          }}
          title="Download this file"
        >
          download
        </a>
      )}
    </div>
  );
}

/** Exported for the render test — it is the part with a branch per
 *  file kind, and that is what regresses. */
export function Body({ data }: { data: FileViewResponse }) {
  if (data.kind === 'image' && data.url) {
    return (
      <a href={data.url} target="_blank" rel="noreferrer" draggable={false}
         style={{ display: 'block', lineHeight: 0 }} title="Open at full size">
        <img
          src={data.url}
          alt={data.path}
          style={{ maxWidth: '100%', height: 'auto', borderRadius: 4, display: 'block' }}
        />
      </a>
    );
  }
  if (data.kind === 'video' && data.url) {
    return (
      // `preload="metadata"` so opening the window doesn't pull a 50 MB
      // file the user may not play; seeking then works off Range.
      <video
        controls
        preload="metadata"
        src={data.url}
        style={{ maxWidth: '100%', borderRadius: 4, display: 'block' }}
      />
    );
  }
  if (data.kind === 'audio' && data.url) {
    return <audio controls preload="metadata" src={data.url} style={{ width: '100%' }} />;
  }
  if (data.kind === 'pdf' && data.url) {
    return (
      <iframe
        src={data.url}
        title={data.path}
        style={{ width: '100%', height: '100%', minHeight: 480, border: 0, borderRadius: 4 }}
      />
    );
  }
  if (data.kind === 'binary' || data.content === undefined) {
    // Nothing to render, but the file is real and reachable — say what
    // it is instead of showing an error.
    return (
      <div style={{ color: 'var(--text-2)', fontSize: 12 }}>
        <div style={{ marginBottom: 6 }}>
          No preview for this file type{data.mime ? ` (${data.mime})` : ''}.
        </div>
        {data.downloadUrl && (
          <a href={data.downloadUrl} download draggable={false} style={{ color: 'var(--accent)' }}>
            Download {data.path.slice(data.path.lastIndexOf('/') + 1)}
          </a>
        )}
      </div>
    );
  }
  if (data.kind === 'markdown') {
    return <AssistantMarkdown content={data.content} />;
  }
  if (data.kind === 'code') {
    // Wrap in a fenced code block so rehype-highlight picks up the
    // language from the file extension.
    const lang = data.ext.replace(/^\./, '');
    const fenced = `\`\`\`${lang}\n${data.content}\n\`\`\``;
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {fenced}
      </ReactMarkdown>
    );
  }
  // Plain text — no highlighting, just monospace + preserve whitespace.
  return (
    <pre
      style={{
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 12,
        color: 'var(--text-1)',
      }}
    >
      {data.content}
    </pre>
  );
}

function ErrorBody({ message, httpStatus }: { message: string; httpStatus: number }) {
  const label = useMemo(() => {
    if (httpStatus === 403) return 'Access denied';
    if (httpStatus === 404) return 'File not found';
    if (httpStatus === 400) return 'Bad request';
    if (httpStatus === 0) return 'Network error';
    return `Error ${httpStatus}`;
  }, [httpStatus]);
  return (
    <div>
      <div style={{ color: 'var(--danger)', fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ color: 'var(--text-2)', fontSize: 12, fontFamily: '"JetBrains Mono", monospace' }}>{message}</div>
    </div>
  );
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
