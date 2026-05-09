// somora-web entry. Phase 1 mounts the Desktop directly — no login
// (LAN-only-by-design), no router (single-page desktop, all
// navigation happens through the window manager). Future phases
// add: window manager state, ChatWindow, drag&drop attachments,
// slash-commands, memory-inject banner.

import { Desktop } from './components/Desktop';

export default function App() {
  return <Desktop />;
}
