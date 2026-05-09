// somora-web entry. Phase 1 mounts the Desktop directly — no login
// (LAN-only-by-design), no router (single-page desktop, all
// navigation happens through the window manager). The ChatProvider
// owns per-session SSE subscriptions + message state so multiple
// chat windows for different agents can stream independently
// without leaking events between sessions.

import { ChatProvider } from './components/ChatProvider';
import { Desktop } from './components/Desktop';

export default function App() {
  return (
    <ChatProvider>
      <Desktop />
    </ChatProvider>
  );
}
