// somora-mobile root. Single-page shell; no router. Renders MobileApp
// which owns the active-agent state + chat surface. Service-worker
// registration happens in main.tsx so it runs even if React fails to
// mount.
//
// The iOS-PWA --vh viewport bootstrap lives in index.html as an inline
// pre-React script — it has to set the custom property BEFORE the
// initial paint, which a React useEffect (runs post-mount) can't do
// in time.

import { MobileApp } from './components/MobileApp';

export default function App() {
  return <MobileApp />;
}
