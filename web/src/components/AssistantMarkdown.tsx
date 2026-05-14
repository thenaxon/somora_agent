// Markdown renderer for assistant messages. Mirrors orbit's
// react-markdown setup — remark-gfm for tables/strikethrough/task
// lists, rehype-highlight for code-block syntax highlighting. Image
// markdown opens the source on click for full-size view. Links open
// in a new tab.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface Props {
  content: string;
}

export function AssistantMarkdown({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        a: ({ href, children }) => (
          // `draggable={false}` is the critical one. HTML anchors are
          // draggable by default — if the browser interprets the mouse
          // gesture as the start of a drag (even 1px of trackpad
          // jitter can do it), the click event is silently suppressed
          // even though mousedown + mouseup fire on the anchor. Diag
          // 2026-05-14 (naxon): mouse logs showed exactly that
          // pattern. The actual navigation happens in App.tsx's
          // document-level mouseup capture handler — works in every
          // case because mouseup is fundamental and always fires.
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            draggable={false}
          >
            {children}
          </a>
        ),
        img: ({ src, alt }) => {
          const url = typeof src === 'string' ? src : undefined;
          return (
            <a href={url} target="_blank" rel="noopener noreferrer">
              <img
                src={url}
                alt={typeof alt === 'string' ? alt : ''}
                style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 6, cursor: 'pointer' }}
              />
            </a>
          );
        },
        pre: ({ children }) => (
          <pre style={{ maxWidth: '100%', overflowX: 'auto' }}>{children}</pre>
        ),
        table: ({ children }) => (
          <div style={{ overflowX: 'auto' }}>
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
