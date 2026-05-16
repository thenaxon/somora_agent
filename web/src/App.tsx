// somora-web entry. Phase 1 mounts the Desktop directly — no login
// (LAN-only-by-design), no router (single-page desktop, all
// navigation happens through the window manager). The ChatProvider
// owns per-session SSE subscriptions + message state so multiple
// chat windows for different agents can stream independently
// without leaking events between sessions.

import { useEffect } from 'react';
import { ChatProvider } from './components/ChatProvider';
import { Desktop } from './components/Desktop';

// Document-level mouseup-capture handler for Markdown links in chat
// bubbles. We listen on `mouseup` rather than `click` because the
// real-world failure mode on 2026-05-14 (naxon) was: mousedown +
// mouseup fired on the anchor as expected, but no click event ever
// followed — the browser had interpreted the gesture as a (cancelled)
// drag-start on the anchor (HTML's `<a>` is draggable by default),
// which silently suppresses the subsequent click. Per-anchor
// `draggable={false}` is also set in AssistantMarkdown to neutralize
// that path; this listener is the belt-and-suspenders fix that opens
// the link from `mouseup` directly, before any drag detection has a
// chance to interfere.
//
// Capture phase + `document` puts us at the very top of the dispatch
// order so we run before any component-tree handler. Narrowed to
// `<a target="_blank">` with http(s) href and primary-button
// unmodified release, so modifier-mouseups + non-blank anchors stay
// native.
function useGlobalMarkdownLinkOpener(): void {
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // Bail out if the user just finished selecting text. Without this
      // check we hijack every mouseup landing on a link — including the
      // release-after-drag that committed a selection across the link's
      // text. preventDefault + window.open would then dump the just-
      // selected text and pop a tab the user did not want. Report:
      // 2026-05-15_web-client-text-selection-broken.md
      const sel = window.getSelection?.();
      if (sel && sel.toString().length > 0) return;
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.closest !== 'function') return;
      const anchor = target.closest('a');
      if (!anchor) return;
      // FileView-bound anchors don't have target=_blank — they navigate
      // via the React onClick handler in AssistantMarkdown. Skip them
      // here so we don't double-fire or hijack the window-manager path.
      if (anchor.getAttribute('target') !== '_blank') return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (!/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      event.stopPropagation();
      window.open(href, '_blank', 'noopener,noreferrer');
    };
    document.addEventListener('mouseup', handler, { capture: true });
    return () => document.removeEventListener('mouseup', handler, { capture: true });
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
