// somora-web entry. Phase 1 mounts the Desktop directly — no login
// (LAN-only-by-design), no router (single-page desktop, all
// navigation happens through the window manager). The ChatProvider
// owns per-session SSE subscriptions + message state so multiple
// chat windows for different agents can stream independently
// without leaking events between sessions.

import { useEffect } from 'react';
import { ChatProvider } from './components/ChatProvider';
import { Desktop } from './components/Desktop';

// Document-level capture-phase handler for Markdown links in chat
// bubbles. Even after restoring CSS link affordance + per-anchor
// onClick + target=_blank, real-world clicks were silently doing
// nothing — `window.open(...)` from the console worked, so the
// browser was fine; some upstream React event interceptor was eating
// the click before it reached the anchor's bound onClick handler.
// Listening on `document` with `capture: true` puts us at the very
// top of the dispatch order so we see the click before any other
// handler can stopPropagation / preventDefault it. We narrow to
// `<a target="_blank">` so we don't hijack any other anchor.
function useGlobalMarkdownLinkOpener(): void {
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      // Only intercept primary (left) clicks. Middle/right click and
      // modifier-clicks (Ctrl/Cmd/Shift) carry their own native
      // browser semantics that we shouldn't override.
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.closest !== 'function') return;
      const anchor = target.closest('a');
      if (!anchor) return;
      if (anchor.getAttribute('target') !== '_blank') return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      // Only http(s) — let mailto:, tel:, etc. follow native handling.
      if (!/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      event.stopPropagation();
      window.open(href, '_blank', 'noopener,noreferrer');
    };
    document.addEventListener('click', handler, { capture: true });
    return () => document.removeEventListener('click', handler, { capture: true });
  }, []);
}

export default function App() {
  useGlobalMarkdownLinkOpener();
  return (
    <ChatProvider>
      <Desktop />
    </ChatProvider>
  );
}
