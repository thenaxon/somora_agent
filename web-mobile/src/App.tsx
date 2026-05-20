// somora-mobile root. Single-page shell; no router. Renders MobileApp
// which owns the active-agent state + chat surface. Service-worker
// registration happens in main.tsx so it runs even if React fails to
// mount.

import { useEffect } from 'react';
import { MobileApp } from './components/MobileApp';

export default function App() {
  // iOS PWA bottom-space bug: standalone Safari mis-measures the
  // viewport on first paint, leaving a dead strip at the bottom until
  // the user rotates the device. Set --vh from window.innerHeight and
  // keep it in sync on every viewport-changing event. styles.css uses
  // var(--vh, 100dvh) so non-iOS browsers stay on dvh natively.
  useEffect(() => {
    const setVh = () => {
      document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`);
    };
    setVh();
    // resize covers most cases; orientationchange is iOS-flaky so we
    // also tick on visibilitychange (returning from home-screen) and
    // pageshow (BFCache restore).
    window.addEventListener('resize', setVh);
    window.addEventListener('orientationchange', setVh);
    document.addEventListener('visibilitychange', setVh);
    window.addEventListener('pageshow', setVh);
    return () => {
      window.removeEventListener('resize', setVh);
      window.removeEventListener('orientationchange', setVh);
      document.removeEventListener('visibilitychange', setVh);
      window.removeEventListener('pageshow', setVh);
    };
  }, []);

  return <MobileApp />;
}
