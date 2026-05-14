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
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              // `target="_blank"` alone *should* navigate, and the link
              // is in the DOM with the right attrs, but on 2026-05-14
              // tests "click does nothing" was reported even with the
              // anchor visible + cursor:pointer + no preventDefault on
              // any ancestor mousedown. Explicit window.open() is the
              // belt-and-suspenders fix: we stopPropagation so no
              // window-manager / chat-body handler can interfere, then
              // open the URL ourselves. Works in every browser and
              // around any CSP / popup-blocker edge case we missed.
              if (!href) return;
              e.stopPropagation();
              e.preventDefault();
              window.open(href, '_blank', 'noopener,noreferrer');
            }}
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
