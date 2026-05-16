// somora-mobile root. Single-page shell; no router. Renders MobileApp
// which owns the active-agent state + chat surface. Service-worker
// registration happens in main.tsx so it runs even if React fails to
// mount.

import { MobileApp } from './components/MobileApp';

export default function App() {
  return <MobileApp />;
}
