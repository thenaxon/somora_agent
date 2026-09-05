// Markdown renderer for assistant messages. Mirrors orbit's
// react-markdown setup — remark-gfm for tables/strikethrough/task
// lists, rehype-highlight for code-block syntax highlighting. Image
// markdown opens the source on click for full-size view. Links open
// in a new tab — except absolute filesystem-paths emitted by agents,
// which open in a FileView window (see useFileViewOpener).

import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useFileViewOpener } from './FileViewContext';

interface Props {
  content: string;
}

// Detect hrefs that look like absolute filesystem paths under common
// system roots. Anything matching is treated as a candidate for the
// FileView window; the server then enforces the actual file_read
// policy (workspace + somora-home + sensible blocks). We intentionally
// match on the path *prefix* family rather than the user's specific
// home dir so this works for any user (homedir() resolves at runtime
// server-side, not at web build time).
const FILESYSTEM_PATH_RE = /^(~|\/(home|Users|var|opt|tmp|etc|mnt|root))(\/|$)/;

// Module-level remark/rehype plugin arrays. ReactMarkdown re-runs its
// processor when the prop reference changes — fresh inline `[remarkGfm]`
// arrays were forcing a rebuild on every parent render.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

// Module-level renderer overrides that don't depend on context. Same
// reasoning as the plugin arrays: stable function identity prevents
// ReactMarkdown from creating fresh component types per render. Without
// this, a parent re-render (e.g. the 2-second useLoopState tick) caused
// React to unmount and remount each <pre>/<img>/<table>, resetting any
// horizontal scroll the user had set inside a code block (Luca
// 2026-05-16 report).
const STATIC_COMPONENTS = {
  pre: ({ children }) => (
    <pre style={{ maxWidth: '100%', overflowX: 'auto' }}>{children}</pre>
  ),
  img: ({ src, alt }) => {
    // `![…](/abs/path.png)` — agents reference generated files by their
    // absolute path (same convention as FileView links). The browser
    // cannot load a filesystem path, so route it through /files/raw,
    // which applies the file_read policy (2026-09-05 report).
    const raw = typeof src === 'string' ? src : undefined;
    const url =
      raw && FILESYSTEM_PATH_RE.test(raw) ? `/files/raw?path=${encodeURIComponent(raw)}` : raw;
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
  table: ({ children }) => (
    <div style={{ overflowX: 'auto' }}>
      <table>{children}</table>
    </div>
  ),
} satisfies Partial<Components>;

function AssistantMarkdownImpl({ content }: Props) {
  const openFileView = useFileViewOpener();
  // Anchor-handler depends on the FileView opener from context, so it
  // can't move to module scope. useMemo with a stable openFileView ref
  // (the context value is itself memoized in FileViewContext) keeps
  // the components object identity stable across re-renders.
  const components = useMemo<Partial<Components>>(
    () => ({
      ...STATIC_COMPONENTS,
        a: ({ href, children }) => {
          const isLocalFile =
            typeof href === 'string' && FILESYSTEM_PATH_RE.test(href);
          if (isLocalFile) {
            // Hand off to the FileView window manager instead of
            // letting the browser try (and fail) to dereference a
            // VM-local path.
            //
            // Why onMouseUp instead of onClick: same root cause as the
            // 2026-05-14 anchor-drag-suppression bug. Even with
            // `draggable={false}`, real-mouse-click on an anchor with
            // a same-origin href intermittently fails to fire the
            // click event — the browser tracks 1-2px of pointer
            // movement between mousedown and mouseup and suppresses
            // click. mouseup is fundamental and always fires; that's
            // why the document-level external-link handler in App.tsx
            // also lives on mouseup. The on-anchor mouseup gives us
            // the same reliability locally. Dedup is handled by
            // openFileView itself (re-opening the same path just
            // focuses the existing window).
            const handleOpen = (e: React.MouseEvent<HTMLAnchorElement>) => {
              if (e.button !== 0) return;
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              // If the user just finished a text selection, the
              // mouseup-release lands on the anchor too — don't
              // hijack that.
              const sel = window.getSelection?.();
              if (sel && sel.toString().length > 0) return;
              e.preventDefault();
              e.stopPropagation();
              if (openFileView) {
                openFileView(href as string);
              } else {
                console.warn('[somora] FileView opener unavailable:', href);
              }
            };
            return (
              <a
                href={href}
                draggable={false}
                onMouseUp={handleOpen}
                onClick={(e) => {
                  // Belt-and-suspenders: when click DOES fire (most
                  // browsers most of the time), preventDefault keeps
                  // the browser from navigating the tab to a 404. The
                  // mouseup handler above already opened the window
                  // (or queued the same path; openFileView dedups).
                  e.preventDefault();
                  e.stopPropagation();
                }}
                title={`open ${href} in FileView`}
              >
                {children}
              </a>
            );
          }
          // External / regular links: same behavior as before.
          // `draggable={false}` is the critical one. HTML anchors are
          // draggable by default — if the browser interprets the mouse
          // gesture as the start of a drag (even 1px of trackpad
          // jitter can do it), the click event is silently suppressed
          // even though mousedown + mouseup fire on the anchor. Diag
          // 2026-05-14 (naxon): mouse logs showed exactly that
          // pattern. The actual navigation happens in App.tsx's
          // document-level mouseup capture handler — works in every
          // case because mouseup is fundamental and always fires.
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              draggable={false}
            >
              {children}
            </a>
          );
        },
    }),
    [openFileView],
  );
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}

// Memoize on `content` only — when the same message string re-passes
// through (parent re-rendered for unrelated reasons), skip the
// react-markdown re-parse entirely so the rendered DOM keeps its
// identity (and code-block scrollLeft survives).
export const AssistantMarkdown = memo(AssistantMarkdownImpl);
