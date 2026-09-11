// Is realtime voice configured on this server?
//
// The tile only exists when it is — the third gate of an opt-in
// feature, next to the 503 on the route and the empty agent list
// (Rene 2026-09-11: "voice icon im /web soll natürlich nur erscheinen
// wenn voice konfiguriert ist das selbe muster wie bei den anderen").
import { useEffect, useState } from 'react';

export interface VoiceAvailability {
  enabled: boolean;
  /** Agents that may be called; empty means nothing to call. */
  agents: string[];
}

export function useVoiceEnabled(): VoiceAvailability {
  const [state, setState] = useState<VoiceAvailability>({ enabled: false, agents: [] });
  useEffect(() => {
    let cancelled = false;
    void fetch('/voice/status')
      .then((r) => (r.ok ? r.json() : { enabled: false, agents: [] }))
      .then((s: VoiceAvailability) => {
        if (cancelled) return;
        // Enabled but nobody callable is the same thing to a user as
        // off: a tile that opens onto an empty picker is a dead end.
        setState({ enabled: Boolean(s.enabled) && (s.agents?.length ?? 0) > 0, agents: s.agents ?? [] });
      })
      .catch(() => { if (!cancelled) setState({ enabled: false, agents: [] }); });
    return () => { cancelled = true; };
  }, []);
  return state;
}
