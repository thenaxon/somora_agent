// FileView — read-only viewer for filesystem artefacts that agents
// reference by absolute path in chat messages (feedback reports,
// generated docs, logs, ...). Reads the content from /files/view; the
// server enforces the same allowlist as the file_read tool.
//
// Three render modes driven by the server-reported `kind`:
//   markdown → rendered with the same react-markdown setup as chat
//   text     → monospace pre, no highlighting (logs, plain .txt)
//   code     → monospace pre + rehype-highlight (json / yaml / toml)
//
// Designed to coexist with chat in parallel windows — open from a
// Markdown link, leave it alongside the conversation.

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { AssistantMarkdown } from './AssistantMarkdown';

interface FileViewResponse {
  path: string;
  kind: 'markdown' | 'text' | 'code';
  ext: string;
  bytes: number;
  content: string;
  truncated: boolean;
  truncated_reason?: string;
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
      {size && <span style={{ flexShrink: 0 }}>{size}</span>}
      {state.status === 'ok' && state.data.truncated && (
        <span style={{ flexShrink: 0, color: 'var(--warn)' }} title={state.data.truncated_reason}>
          truncated
        </span>
      )}
    </div>
  );
}

function Body({ data }: { data: FileViewResponse }) {
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
    if (httpStatus === 415) return 'Unsupported file type';
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
