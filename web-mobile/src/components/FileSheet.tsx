// A local file an agent linked in chat, full screen over the chat
// (docs/mobile.md "Files in chat"). The desktop client opens such a link
// in a FileView window; the phone has no windows, so the file takes the
// whole screen and a back button (or the phone's own back gesture, see
// MobileApp) returns to the conversation where it was.
//
// Content comes from /files/view, the same route and the same read policy
// as the desktop FileView: what the agent may read, the user may view.
// Markdown renders with the chat's own renderers, so a link in the file
// to another local file opens that one here too. Every other kind
// (code, text, image, video, audio, PDF, anything else) uses the desktop
// viewer's body, which already handles each kind.

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Body, type FileViewResponse } from '../../../web/src/components/FileViewWindow';
import { MARKDOWN_COMPONENTS } from './markdown';

type State =
  | { status: 'loading' }
  | { status: 'ok'; data: FileViewResponse }
  | { status: 'error'; message: string; httpStatus: number };

const REMARK = [remarkGfm];
const REHYPE = [rehypeHighlight];

export function errorLabel(httpStatus: number): string {
  if (httpStatus === 403) return 'Access denied';
  if (httpStatus === 404) return 'File not found';
  if (httpStatus === 400) return 'Cannot open this path';
  if (httpStatus === 0) return 'Network error';
  return `Error ${httpStatus}`;
}

export function FileSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(`/files/view?path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          setState({ status: 'ok', data: (await res.json()) as FileViewResponse });
          return;
        }
        let message = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body && typeof body.error === 'string') message = body.error;
        } catch {
          /* keep the status line */
        }
        setState({ status: 'error', message, httpStatus: res.status });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', message: String(err), httpStatus: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const name = path.slice(path.lastIndexOf('/') + 1) || path;
  const data = state.status === 'ok' ? state.data : null;

  return (
    <div className="file-sheet" role="dialog" aria-label={`file ${name}`} data-testid="file-sheet">
      <header className="file-sheet-header">
        <button type="button" className="file-sheet-back" data-testid="file-sheet-back" onClick={onClose} aria-label="back to the chat">
          ‹ Back
        </button>
        <span className="file-sheet-name" title={path}>{name}</span>
        {data?.downloadUrl && (
          <a className="file-sheet-download" href={data.downloadUrl} download draggable={false} aria-label={`download ${name}`}>
            ↓
          </a>
        )}
      </header>
      <div className="file-sheet-path">{path}</div>
      <div className="file-sheet-body" data-testid="file-sheet-body">
        {state.status === 'loading' && <div className="file-sheet-note">loading…</div>}
        {state.status === 'error' && (
          <div className="file-sheet-error" role="alert">
            <div className="file-sheet-error-title">{errorLabel(state.httpStatus)}</div>
            <div className="file-sheet-error-detail">{state.message}</div>
          </div>
        )}
        {data && data.truncated && (
          <div className="file-sheet-note">Only the beginning of this file is shown ({data.truncated_reason ?? 'too large'}).</div>
        )}
        {data && data.kind === 'markdown' && data.content !== undefined ? (
          <div className="msg-bubble file-doc">
            <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={MARKDOWN_COMPONENTS}>
              {data.content}
            </ReactMarkdown>
          </div>
        ) : data ? (
          <div className="msg-bubble file-doc">
            <Body data={data} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
