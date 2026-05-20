// TEMPORARY DEBUG OVERLAY — shows live viewport measurements so we
// can diagnose the iOS-PWA bottom-strip bug. Remove this component
// (and its mount in App.tsx) once the underlying bug is fixed.
//
// Why so many values: the bug is that .mobile-shell doesn't fill the
// screen on first paint after iOS settles the layout viewport. Each
// measurement comes from a different API; comparing them tells us
// which one iOS is mis-reporting and when.

import { useEffect, useState } from 'react';

interface Vp {
  innerH: number;
  innerW: number;
  visualH: number;
  visualW: number;
  visualOffsetTop: number;
  docH: number;
  screenH: number;
  safeT: string;
  safeB: string;
  shellH: string;
  shellTop: string;
  shellBottom: string;
  ts: number;
}

function measure(): Vp {
  const cs = getComputedStyle(document.documentElement);
  const shell = document.querySelector('.mobile-shell') as HTMLElement | null;
  const shellCs = shell ? getComputedStyle(shell) : null;
  const shellRect = shell?.getBoundingClientRect();
  return {
    innerH: window.innerHeight,
    innerW: window.innerWidth,
    visualH: Math.round(window.visualViewport?.height ?? -1),
    visualW: Math.round(window.visualViewport?.width ?? -1),
    visualOffsetTop: Math.round(window.visualViewport?.offsetTop ?? -1),
    docH: document.documentElement.clientHeight,
    screenH: window.screen.height,
    safeT: cs.getPropertyValue('--safe-top').trim() || '?',
    safeB: cs.getPropertyValue('--safe-bottom').trim() || '?',
    shellH: shellCs?.height ?? '?',
    shellTop: shellRect ? String(Math.round(shellRect.top)) : '?',
    shellBottom: shellRect ? String(Math.round(shellRect.bottom)) : '?',
    ts: Math.round(performance.now()),
  };
}

export function ViewportDebug() {
  const [vp, setVp] = useState<Vp>(() => measure());
  const [history, setHistory] = useState<Vp[]>(() => [measure()]);

  useEffect(() => {
    const update = () => {
      const m = measure();
      setVp(m);
      setHistory((prev) => {
        // Only record meaningful changes (innerHeight diff > 4px) to
        // avoid spam, but always keep latest.
        const last = prev[prev.length - 1];
        if (!last || Math.abs(m.innerH - last.innerH) > 4 || Math.abs(m.visualH - last.visualH) > 4) {
          return [...prev.slice(-5), m];
        }
        return prev;
      });
    };
    // Sample shortly after mount to catch the "settle" event the user
    // described ("passt für den bruchteil einer sekunde, dann springt").
    const delays = [0, 16, 32, 64, 100, 200, 400, 800, 1500, 3000];
    const timers = delays.map((d) => setTimeout(update, d));
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    document.addEventListener('visibilitychange', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      document.removeEventListener('visibilitychange', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        top: 4,
        right: 4,
        zIndex: 99999,
        background: 'rgba(220, 38, 38, 0.92)',
        color: 'white',
        fontSize: 9,
        padding: '6px 8px',
        fontFamily: 'JetBrains Mono, monospace',
        pointerEvents: 'none',
        lineHeight: 1.35,
        borderRadius: 4,
        whiteSpace: 'pre',
        maxWidth: '46vw',
      }}
    >
      {`v.20.05 | ${vp.ts}ms
inner   ${vp.innerW}×${vp.innerH}
visual  ${vp.visualW}×${vp.visualH} off${vp.visualOffsetTop}
doc.h   ${vp.docH}
scr.h   ${vp.screenH}
safe-t  ${vp.safeT}
safe-b  ${vp.safeB}
shell.h ${vp.shellH}
shell-y ${vp.shellTop}→${vp.shellBottom}
─── changes (innerH) ───
${history.map((h) => `${h.ts}ms i:${h.innerH} v:${h.visualH} s:${h.shellBottom}`).join('\n')}`}
    </div>
  );
}
