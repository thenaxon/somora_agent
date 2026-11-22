// Markdown renderers shared by the chat bubbles and the file sheet.
//
// Agents reference local files by bare absolute path (FileView convention
// on the desktop client). A link to such a path opens the file sheet
// (FileSheet) through the opener MobileApp provides (FileOpenProvider); a tap
// used to open /files/raw in a new tab, which hands a Markdown or text
// file over as a download and looked like nothing happened (2026-11-22).
// The href still points at /files/raw, so "open in new tab" from the
// long-press menu keeps working. Inline images to such paths load
// through /files/raw too, which applies the file_read policy.
//
// Module-level so ReactMarkdown keeps component identity across renders.

import { createContext, useContext, type ReactNode, type MouseEvent } from 'react';
import { ChatImage, chatImageUrl, FILESYSTEM_PATH_RE } from '../../../web/src/components/ChatImage';

const FileOpenContext = createContext<((path: string) => void) | null>(null);
/** Without a provider (tests) a local link falls back to its href. */
export const FileOpenProvider = FileOpenContext.Provider;

function ChatLink({ href, children }: { href?: string; children?: ReactNode }) {
  const openFile = useContext(FileOpenContext);
  const local = typeof href === 'string' && FILESYSTEM_PATH_RE.test(href);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!local || !openFile) return;
    e.preventDefault();
    e.stopPropagation();
    openFile(href as string);
  };
  return (
    <a
      href={chatImageUrl(href)}
      target="_blank"
      rel="noopener noreferrer"
      draggable={false}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

export const MARKDOWN_COMPONENTS = {
  a: ChatLink,
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <ChatImage src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} maxHeight={320} />
  ),
  // A wide table scrolls inside the bubble instead of widening it —
  // the phone viewport has no room to spare (styles: .msg-table-scroll).
  table: ({ children }: { children?: ReactNode }) => (
    <div className="msg-table-scroll">
      <table>{children}</table>
    </div>
  ),
};
